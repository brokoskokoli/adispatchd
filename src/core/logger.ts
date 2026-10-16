/**
 * Minimal structured logging with secret redaction (Spec §20.4).
 *
 * Log records are JSON lines: `{ time, level, msg, ...bindings, ...fields }`.
 * Every record passes through a redaction hook before it is written, so known
 * secret values and secret-looking keys never reach the sink.
 */
import { systemClock, type Clock } from './clock.js';

/** Supported log levels in ascending severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured, JSON-serialisable context attached to a log record. */
export type LogFields = Record<string, unknown>;

/** Structured logger used by all components (injected, never global). */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that adds `bindings` to every record (e.g. `{ component: 'scheduler' }`). */
  child(bindings: LogFields): Logger;
}

/** Hook that removes secrets from a string. Must be pure and cheap. */
export type Redactor = (text: string) => string;

/** Replacement text for redacted values. */
export const REDACTED = '[REDACTED]';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always redacted, regardless of content. */
const SECRET_KEY_PATTERN = /(pass(word)?|secret|token|private[_-]?key|authorization|api[_-]?key|credential|cookie)/i;

/** Minimum length of a registered secret; shorter values would cause excessive false positives. */
const MIN_SECRET_LENGTH = 4;

/**
 * Registry of known secret values (tokens, keys) that are replaced by
 * {@link REDACTED} in any text passed through {@link SecretRedactor.redact}.
 * Best-effort only: a secret that is transformed (e.g. base64) is not detected (Spec §24.8).
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();

  /** Register a secret value. Values shorter than 4 characters are ignored. */
  add(secret: string | undefined | null): void {
    if (!secret || secret.length < MIN_SECRET_LENGTH) return;
    this.secrets.add(secret);
    // PEM keys are often passed with literal "\n" escapes; register both forms.
    if (secret.includes('\n')) this.secrets.add(secret.replace(/\n/g, '\\n'));
  }

  /** Forget a secret value (e.g. after token expiry). */
  remove(secret: string): void {
    this.secrets.delete(secret);
    this.secrets.delete(secret.replace(/\n/g, '\\n'));
  }

  /** Number of registered secrets. */
  get size(): number {
    return this.secrets.size;
  }

  /** Replace every registered secret occurring in `text`. Longest secrets are replaced first. */
  redact(text: string): string {
    if (this.secrets.size === 0 || text.length === 0) return text;
    let out = text;
    const ordered = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }

  /** The redactor as a plain function, suitable for {@link ConsoleLoggerOptions.redact}. */
  readonly asRedactor: Redactor = (text) => this.redact(text);
}

/**
 * Deep-copy `value`, replacing values under secret-looking keys and applying
 * `redact` to every string. Handles cycles and Error objects.
 */
export function redactValue(value: unknown, redact: Redactor = (s) => s, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: redact(value.message) };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    if (value.stack) out.stack = redact(value.stack);
    if (value.cause !== undefined) out.cause = redactValue(value.cause, redact, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) && v !== null && v !== undefined && typeof v !== 'boolean'
      ? REDACTED
      : redactValue(v, redact, seen);
  }
  return out;
}

/** Options for {@link ConsoleLogger}. */
export interface ConsoleLoggerOptions {
  /** Minimum level written. Default `info`. */
  level?: LogLevel;
  /** Time source for the `time` field. Default {@link systemClock}. */
  clock?: Clock;
  /** Secret redaction hook applied to every string in the record. */
  redact?: Redactor;
  /** Line sink. Default writes to `process.stderr`. */
  sink?: (line: string) => void;
  /** Fields added to every record. */
  bindings?: LogFields;
}

/** Logger writing one JSON object per line (default: stderr). */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly clock: Clock;
  private readonly redact: Redactor;
  private readonly sink: (line: string) => void;
  private readonly bindings: LogFields;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.clock = options.clock ?? systemClock;
    this.redact = options.redact ?? ((s) => s);
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
    this.bindings = options.bindings ?? {};
  }

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  child(bindings: LogFields): Logger {
    return new ConsoleLogger({
      level: this.level,
      clock: this.clock,
      redact: this.redact,
      sink: this.sink,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record = {
      time: this.clock.now().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(fields ?? {}),
    };
    let line: string;
    try {
      line = JSON.stringify(redactValue(record, this.redact));
    } catch {
      line = JSON.stringify({ time: record.time, level, msg: this.redact(msg), logError: 'unserialisable fields' });
    }
    this.sink(line);
  }
}

/** A log record captured by {@link MemoryLogger}. */
export interface CapturedLogRecord {
  level: LogLevel;
  msg: string;
  fields: LogFields;
}

/** Logger that keeps (redacted) records in memory; intended for tests. */
export class MemoryLogger implements Logger {
  /** Shared record list (children append to the root's list). */
  readonly records: CapturedLogRecord[];

  constructor(
    private readonly redact: Redactor = (s) => s,
    private readonly bindings: LogFields = {},
    records?: CapturedLogRecord[],
  ) {
    this.records = records ?? [];
  }

  debug(msg: string, fields?: LogFields): void {
    this.push('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.push('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.push('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.push('error', msg, fields);
  }

  child(bindings: LogFields): Logger {
    return new MemoryLogger(this.redact, { ...this.bindings, ...bindings }, this.records);
  }

  private push(level: LogLevel, msg: string, fields?: LogFields): void {
    this.records.push({
      level,
      msg: this.redact(msg),
      fields: redactValue({ ...this.bindings, ...(fields ?? {}) }, this.redact) as LogFields,
    });
  }
}

/** Logger that discards everything. */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};
