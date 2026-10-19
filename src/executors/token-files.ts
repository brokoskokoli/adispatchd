/**
 * Token files (WI-18): secrets with `delivery: file` are written to a file in
 * a private directory below the run directory (outside the workspace) and
 * handed to the process as `<NAME>_FILE`. While the session is open, every
 * file is replaced atomically (temp file + rename in the same directory)
 * before its token expires; closing the session deletes the directory.
 *
 * Tokens are never logged: log entries name the variable and identity only.
 * Every issued token is registered with the session's {@link SecretValues}
 * (→ executor redaction) BEFORE it is written to the file.
 */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type AccessToken,
  type Clock,
  type CredentialProvider,
  type IdentityRef,
  type Logger,
  type SecretValues,
  type TimerHandle,
  type Timers,
  type Unsubscribe,
} from '../core/index.js';

/** Suffix of the variable that carries the path of a token file (`GH_TOKEN` → `GH_TOKEN_FILE`). */
export const TOKEN_FILE_ENV_SUFFIX = '_FILE';

/** Name of the token directory below a run (or action attempt) directory. */
export const TOKEN_DIR_NAME = 'secrets';

/** Token files are renewed at the latest this long before the token expires (WI-18). */
export const TOKEN_RENEW_BEFORE_MS = 10 * 60_000;

/** First retry delay after a failed renewal; doubles per failure up to {@link TOKEN_RENEW_MAX_RETRY_MS}. */
export const TOKEN_RENEW_RETRY_MS = 30_000;

/** Upper bound of the renewal retry delay. */
export const TOKEN_RENEW_MAX_RETRY_MS = 5 * 60_000;

/** Lower bound of any renewal delay (protects against tight loops with very short-lived tokens). */
const MIN_RENEW_DELAY_MS = 1_000;

/** Tokens whose renewal would be due later than this are treated as non-expiring (written once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Name of the variable carrying the path of the token file for secret `name`. */
export function tokenFileEnvName(name: string): string {
  return `${name}${TOKEN_FILE_ENV_SUFFIX}`;
}

/** One secret delivered as a file. */
export interface TokenFileRequest {
  /** Secret name as configured (e.g. `GH_TOKEN`); also the file name. */
  name: string;
  identity: IdentityRef;
}

/** Dependencies and tuning of a {@link TokenFileSession}. */
export interface TokenFileSessionOptions {
  /** Private directory for the files (created with mode 0700, removed on close). */
  dir: string;
  requests: readonly TokenFileRequest[];
  credentials: CredentialProvider;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** Default {@link TOKEN_RENEW_BEFORE_MS}. */
  renewBeforeMs?: number;
  /** Default {@link TOKEN_RENEW_RETRY_MS}. */
  retryDelayMs?: number;
  /** Default {@link TOKEN_RENEW_MAX_RETRY_MS}. */
  maxRetryDelayMs?: number;
}

interface FileEntry {
  request: TokenFileRequest;
  file: string;
  token: AccessToken | undefined;
  timer: TimerHandle | undefined;
  failures: number;
}

/** See module docs. One session per execution (main worker or action attempt). */
export class TokenFileSession implements SecretValues {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly renewBeforeMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly entries: FileEntry[];
  private readonly issued: string[] = [];
  private readonly listeners = new Set<(value: string) => void>();
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: TokenFileSessionOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'token-files' });
    this.renewBeforeMs = options.renewBeforeMs ?? TOKEN_RENEW_BEFORE_MS;
    this.retryDelayMs = options.retryDelayMs ?? TOKEN_RENEW_RETRY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? TOKEN_RENEW_MAX_RETRY_MS;
    this.entries = options.requests.map((request) => ({
      request,
      file: path.join(options.dir, request.name),
      token: undefined,
      timer: undefined,
      failures: 0,
    }));
  }

  /** Directory holding the token files. */
  get dir(): string {
    return this.options.dir;
  }

  /** All tokens issued by this session so far (for redaction). */
  values(): readonly string[] {
    return [...this.issued];
  }

  onAdd(listener: (value: string) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Create the directory, fetch every token and write the files; schedule
   * renewals. Returns the variables to add to the environment
   * (`<NAME>_FILE` → absolute path). On failure everything written so far is
   * removed and the error (never containing a token) is thrown.
   */
  async open(signal?: AbortSignal): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    try {
      await prepareDirectory(this.options.dir);
      for (const entry of this.entries) {
        const token = await this.options.credentials.getToken(entry.request.identity, {
          ...(signal ? { signal } : {}),
          minValidityMs: this.renewBeforeMs + MIN_RENEW_DELAY_MS,
        });
        if (this.closed) throw new Error('token file session closed');
        await this.write(entry, token);
        env[tokenFileEnvName(entry.request.name)] = entry.file;
      }
    } catch (err) {
      await this.close();
      throw err;
    }
    for (const entry of this.entries) this.schedule(entry);
    return env;
  }

  /** Resolves once no renewal is in flight (tests, shutdown diagnostics). */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Stop renewals and delete the directory (idempotent; never throws). */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    this.abort.abort(new Error('token file session closed'));
    for (const entry of this.entries) {
      if (entry.timer) this.timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    // A renewal in flight must not write after the directory is gone.
    await Promise.allSettled([...this.inflight]);
    try {
      await rm(this.options.dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.error('token files could not be removed', { dir: this.options.dir, error: errorMessage(err) });
    }
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------

  private register(value: string): void {
    if (this.issued.includes(value)) return;
    this.issued.push(value);
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (err) {
        this.logger.warn('token redaction listener failed', { error: errorMessage(err) });
      }
    }
  }

  /** Register the token for redaction, then replace the file atomically. */
  private async write(entry: FileEntry, token: AccessToken): Promise<void> {
    this.register(token.token);
    const tmp = path.join(this.options.dir, `.${entry.request.name}.tmp-${randomUUID()}`);
    try {
      await writeFile(tmp, token.token, { mode: 0o600, flag: 'wx' });
      await rename(tmp, entry.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    entry.token = token;
  }

  private schedule(entry: FileEntry): void {
    if (this.closed || !entry.token) return;
    const remaining = entry.token.expiresAt.getTime() - this.clock.now().getTime();
    let delay = remaining - this.renewBeforeMs;
    if (delay > MAX_TIMER_MS) return; // non-expiring identity (e.g. github_token): written once
    // Lifetime shorter than the renewal margin: renew halfway through the remaining lifetime.
    if (delay < MIN_RENEW_DELAY_MS) delay = Math.max(MIN_RENEW_DELAY_MS, Math.floor(remaining / 2));
    this.arm(entry, delay);
  }

  private arm(entry: FileEntry, delay: number): void {
    if (this.closed) return;
    if (entry.timer) this.timers.clearTimeout(entry.timer);
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = undefined;
      const job = this.renew(entry).finally(() => this.inflight.delete(job));
      this.inflight.add(job);
    }, delay);
  }

  private async renew(entry: FileEntry): Promise<void> {
    if (this.closed) return;
    const { name, identity } = entry.request;
    try {
      const token = await this.options.credentials.getToken(identity, {
        signal: this.abort.signal,
        minValidityMs: this.renewBeforeMs + MIN_RENEW_DELAY_MS,
      });
      if (this.closed) return;
      const previous = entry.token;
      if (previous && token.expiresAt.getTime() <= previous.expiresAt.getTime() && token.token === previous.token) {
        throw new Error('identity returned the same token again');
      }
      await this.write(entry, token);
      entry.failures = 0;
      this.logger.info('token file renewed', { variable: name, identity, expiresAt: token.expiresAt.toISOString() });
      this.schedule(entry);
    } catch (err) {
      if (this.closed) return;
      entry.failures++;
      const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** (entry.failures - 1));
      // The current file stays in place until its token expires; the process keeps running.
      this.logger.warn('token file renewal failed; retrying', {
        variable: name,
        identity,
        attempt: entry.failures,
        retryInMs: delay,
        currentExpiresAt: entry.token?.expiresAt.toISOString(),
        error: errorMessage(err),
      });
      this.arm(entry, delay);
    }
  }
}

/** Create `dir` fresh with mode 0700 (stale content of an earlier attempt is removed). */
async function prepareDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.dirname(dir), { recursive: true });
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`token directory is not a plain directory: ${dir}`);
}

/**
 * Remove left-over token directories of one run: `runs/<id>/secrets` and
 * `runs/<id>/actions/<action>/attempt-<n>/secrets` (recovery after a restart,
 * retention). Returns the number of removed directories; errors are thrown.
 */
export async function removeTokenDirs(runDir: string): Promise<number> {
  const candidates = [path.join(runDir, TOKEN_DIR_NAME)];
  for (const action of await listDirs(path.join(runDir, 'actions'))) {
    for (const attempt of await listDirs(action)) candidates.push(path.join(attempt, TOKEN_DIR_NAME));
  }
  let removed = 0;
  for (const dir of candidates) {
    try {
      await lstat(dir);
    } catch {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}
