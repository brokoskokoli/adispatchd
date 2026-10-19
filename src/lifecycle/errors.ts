/**
 * Error model of lifecycle actions: every failed attempt is persisted as an
 * {@link ActionErrorInfo} (`action_attempts.error_json`, `run_actions.last_error_json`).
 * The `retryable` flag decides whether further automatic attempts are made.
 */
import {
  OrchestratorError,
  SourceError,
  TemplateError,
  errorMessage,
  redactValue,
  type Redactor,
  type SourceErrorKind,
} from '../core/index.js';

/** Persisted, secret-free description of a failed attempt. */
export interface ActionErrorInfo {
  /** Machine-readable code, e.g. `source_transient`, `template_unknown_placeholder`, `shell_exit`. */
  code: string;
  message: string;
  /** Whether another automatic attempt may help. */
  retryable: boolean;
  /** A mutating call may have taken effect although it failed (reconcile before repeating). */
  outcomeUnknown?: boolean;
  /** `SourceError.kind` for source failures. */
  kind?: SourceErrorKind;
  /** HTTP status of the failed source call, if any. */
  status?: number;
  /** Suggested wait (rate limits); the retry delay is at least this long. */
  retryAfterMs?: number;
  /** Additional diagnostics (exit code, log paths, ...). */
  details?: Record<string, unknown>;
}

/** Error raised by the lifecycle engine itself (action execution, invalid input). */
export class LifecycleError extends OrchestratorError {
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; outcomeUnknown?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(`lifecycle_${code}`, message, {
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

/** Thrown when a chain of the same run is already being executed in this process. */
export class LifecycleBusyError extends LifecycleError {
  constructor(runId: string) {
    super('busy', `Lifecycle actions of run ${runId} are already being executed`, { details: { runId } });
  }
}

/**
 * Convert any thrown value into an {@link ActionErrorInfo}.
 *
 * - `SourceError`: keeps `kind`, `retryable`, `outcomeUnknown`, `status`, `retryAfterMs` and
 *   `details.applied` (changes made before the failure).
 * - `TemplateError` and other `OrchestratorError`s: not retryable (configuration problem).
 * - {@link LifecycleError}: its own flags.
 * - Anything else (unexpected exception): retryable, so the configured attempts apply.
 */
export function describeActionError(err: unknown, redact: Redactor = (s) => s): ActionErrorInfo {
  const message = redact(errorMessage(err));
  if (err instanceof SourceError) {
    // What a partially successful `source.update` applied before failing (journal, WI-16 review).
    const applied = err.details?.applied;
    return compact({
      code: err.code,
      message,
      retryable: err.retryable,
      outcomeUnknown: err.outcomeUnknown || undefined,
      kind: err.kind,
      status: err.status,
      retryAfterMs: err.retryAfterMs,
      details: applied !== undefined ? { applied: redactValue(applied, redact) } : undefined,
    });
  }
  if (err instanceof LifecycleError) {
    return compact({
      code: err.code,
      message,
      retryable: err.retryable,
      outcomeUnknown: err.outcomeUnknown || undefined,
      details: err.details ? (redactValue(err.details, redact) as Record<string, unknown>) : undefined,
    });
  }
  if (err instanceof TemplateError) {
    return compact({ code: err.code, message, retryable: false, details: err.details });
  }
  if (err instanceof OrchestratorError) {
    return compact({ code: err.code, message, retryable: false });
  }
  return { code: 'lifecycle_unexpected_error', message, retryable: true };
}

function compact(info: ActionErrorInfo): ActionErrorInfo {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) if (value !== undefined) out[key] = value;
  return out as unknown as ActionErrorInfo;
}
