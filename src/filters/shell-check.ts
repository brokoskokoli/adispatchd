/**
 * Shell check runner for shell filters and conditions (Spec §6, §20.3, §20.6).
 *
 * - Command as argument list (no shell), unless `shell: true` is configured
 *   explicitly (then `/bin/sh -c <command> sh <args...>`).
 * - Minimal environment (PATH, HOME, LANG, TZ, USER, LOGNAME, TMPDIR) plus
 *   explicit `env` plus `ORCH_CHECK_CONTEXT_FILE` pointing to a JSON file with
 *   the check context (written with mode 0600, removed afterwards).
 * - Exit 0 = `true`, exit 1 = `false`; exit ≥ 2, signal, timeout, spawn error
 *   or abort = `unknown` with error detail.
 * - Output (stdout/stderr) is captured up to a limit, the rest is discarded.
 * - The process runs in its own process group; on timeout/abort the whole
 *   group gets SIGTERM, then SIGKILL after a grace period.
 * - Optional TTL cache (Clock based) for workflow conditions; item checks run
 *   uncached by default.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type Logger,
  type SourceItem,
  type Timers,
  type TriValue,
} from '../core/index.js';

/** Environment variable holding the path of the check context JSON file. */
export const CHECK_CONTEXT_ENV = 'ORCH_CHECK_CONTEXT_FILE';

/** Variables copied from the controller environment into every check process. */
export const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TZ', 'USER', 'LOGNAME', 'TMPDIR'] as const;

/** Default per-stream output limit in bytes. */
export const DEFAULT_MAX_CHECK_OUTPUT_BYTES = 16 * 1024;

/** Default grace period between SIGTERM and SIGKILL. */
export const DEFAULT_CHECK_KILL_GRACE_MS = 2000;

/** One configured shell check (shell filter or condition). */
export interface ShellCheckSpec {
  /** Executable (or, with `shell: true`, a shell command string). */
  command: string;
  args?: readonly string[];
  /** Run `command` through `/bin/sh -c`. Only if explicitly configured. */
  shell?: boolean;
  /** Timeout in milliseconds. */
  timeoutMs: number;
  /** Explicit additional environment variables. */
  env?: Readonly<Record<string, string>>;
  /** Working directory (default: the runner's temp directory for this check). */
  cwd?: string;
}

/** Kind of check, part of the context file. */
export type ShellCheckKind = 'shell_filter' | 'workflow_condition' | 'item_condition';

/** Content of the file at `ORCH_CHECK_CONTEXT_FILE`. Never contains secrets. */
export interface ShellCheckContext {
  schema_version: 1;
  kind: ShellCheckKind;
  workflow: { id: string };
  /** Present for item-bound checks (shell filter, item conditions). */
  source?: {
    id: string;
    type: string;
    item_id: string;
    item_key: string;
    url: string;
    item_type: string;
    created_at?: string;
    /** Cheap item fields (as in `SourceItem.fields`). */
    attributes: Record<string, unknown>;
  };
}

/** Build a {@link ShellCheckContext}. `sourceType` is the adapter type (e.g. `github`). */
export function buildCheckContext(
  kind: ShellCheckKind,
  workflowId: string,
  item?: SourceItem,
  sourceType?: string,
): ShellCheckContext {
  const ctx: ShellCheckContext = { schema_version: 1, kind, workflow: { id: workflowId } };
  if (item) {
    ctx.source = {
      id: item.sourceId,
      type: sourceType ?? '',
      item_id: item.itemId,
      item_key: item.key,
      url: item.url,
      item_type: item.type,
      ...(item.createdAt !== undefined ? { created_at: item.createdAt } : {}),
      attributes: { ...item.fields },
    };
  }
  return ctx;
}

/** Result of one shell check. */
export interface ShellCheckResult {
  value: TriValue;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Error detail when `value` is `unknown`. */
  error?: string;
  stdout: string;
  stderr: string;
  /** True if stdout or stderr exceeded the limit and was cut. */
  outputTruncated: boolean;
  /** ISO-8601 start time (from the injected clock). */
  startedAt: string;
  durationMs: number;
  /** True if served from the cache ({@link ShellCheckRunner.runCached}). */
  cached: boolean;
}

/** Dependencies/options of {@link ShellCheckRunner}. */
export interface ShellCheckRunnerOptions {
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** Source of the minimal environment (default: `process.env`). */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Directory for temporary context files (default: OS temp dir). */
  tempDir?: string;
  /** Per-stream output limit in bytes. */
  maxOutputBytes?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

interface CacheEntry {
  storedAt: number;
  ttlMs: number;
  result: ShellCheckResult;
}

class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      if (chunk.length > 0) this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Runs shell checks; one instance per orchestrator (holds the workflow-condition cache). */
export class ShellCheckRunner {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly hostEnv: Readonly<Record<string, string | undefined>>;
  private readonly tempDir: string;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ShellCheckResult>>();

  constructor(options: ShellCheckRunnerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = options.logger ?? noopLogger;
    this.hostEnv = options.hostEnv ?? process.env;
    this.tempDir = options.tempDir ?? tmpdir();
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_CHECK_OUTPUT_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_CHECK_KILL_GRACE_MS;
  }

  /** Environment for a check process (minimal env + explicit env + context file). */
  buildEnv(spec: ShellCheckSpec, contextFile: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of MINIMAL_ENV_KEYS) {
      const v = this.hostEnv[key];
      if (v !== undefined) env[key] = v;
    }
    Object.assign(env, spec.env ?? {});
    env[CHECK_CONTEXT_ENV] = contextFile;
    return env;
  }

  /** Run a check without caching. Never throws. */
  async run(spec: ShellCheckSpec, context: unknown, options: { signal?: AbortSignal } = {}): Promise<ShellCheckResult> {
    const startedAt = this.clock.now();
    const t = spec.timeoutMs as unknown;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
      return this.failure(startedAt, `invalid timeout: ${String(t)}`);
    }
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(this.tempDir, 'orch-check-'));
      const contextFile = join(dir, 'context.json');
      await writeFile(contextFile, JSON.stringify(context ?? null), { mode: 0o600 });
      return await this.spawnCheck(spec, this.buildEnv(spec, contextFile), spec.cwd ?? dir, startedAt, options.signal);
    } catch (err) {
      return this.failure(startedAt, `check preparation failed: ${errorMessage(err)}`);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Run a check with a TTL cache under `cacheKey` (e.g. `<workflowId>:condition:<index>`).
   * Only definitive results (`true`/`false`) are cached; concurrent calls for
   * the same key share one execution. `ttlMs <= 0` disables caching.
   */
  async runCached(
    cacheKey: string,
    ttlMs: number,
    spec: ShellCheckSpec,
    context: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ShellCheckResult> {
    if (ttlMs <= 0) return this.run(spec, context, options);
    const now = this.clock.now().getTime();
    const entry = this.cache.get(cacheKey);
    if (entry && now - entry.storedAt < entry.ttlMs) return { ...entry.result, cached: true };
    if (entry) this.cache.delete(cacheKey);
    const running = this.inflight.get(cacheKey);
    if (running) return { ...(await running), cached: true };
    const p = this.run(spec, context, options).then((result) => {
      if (result.value !== 'unknown') this.cache.set(cacheKey, { storedAt: this.clock.now().getTime(), ttlMs, result });
      return result;
    });
    this.inflight.set(cacheKey, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /** Drop one cache entry, or all (e.g. after a config reload). */
  invalidate(cacheKey?: string): void {
    if (cacheKey === undefined) this.cache.clear();
    else this.cache.delete(cacheKey);
  }

  private failure(startedAt: Date, error: string): ShellCheckResult {
    return {
      value: 'unknown',
      exitCode: null,
      signal: null,
      timedOut: false,
      error,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      startedAt: startedAt.toISOString(),
      durationMs: Math.max(0, this.clock.now().getTime() - startedAt.getTime()),
      cached: false,
    };
  }

  private spawnCheck(
    spec: ShellCheckSpec,
    env: Record<string, string>,
    cwd: string,
    startedAt: Date,
    signal: AbortSignal | undefined,
  ): Promise<ShellCheckResult> {
    const [file, args] = spec.shell
      ? ['/bin/sh', ['-c', spec.command, 'sh', ...(spec.args ?? [])]]
      : [spec.command, [...(spec.args ?? [])]];
    const stdout = new OutputBuffer(this.maxOutputBytes);
    const stderr = new OutputBuffer(this.maxOutputBytes);

    return new Promise<ShellCheckResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let spawnError: string | undefined;
      const handles: ReturnType<Timers['setTimeout']>[] = [];

      const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      child.stdout.on('data', (c: Buffer) => stdout.push(c));
      child.stderr.on('data', (c: Buffer) => stderr.push(c));

      const killGroup = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };

      const finish = (exitCode: number | null, sig: string | null): void => {
        if (settled) return;
        settled = true;
        for (const h of handles) this.timers.clearTimeout(h);
        signal?.removeEventListener('abort', onAbort);
        // Make sure no stray process of the group survives (e.g. background children).
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* group already gone */
          }
        }
        let value: TriValue = 'unknown';
        let error: string | undefined;
        if (spawnError !== undefined) error = `spawn failed: ${spawnError}`;
        else if (timedOut) error = `timed out after ${spec.timeoutMs}ms`;
        else if (aborted) error = 'aborted';
        else if (sig !== null) error = `terminated by signal ${sig}`;
        else if (exitCode === 0) value = true;
        else if (exitCode === 1) value = false;
        else error = `check error: exit code ${String(exitCode)}`;
        if (error !== undefined) this.logger.warn('shell check failed', { command: spec.command, error });
        resolve({
          value,
          exitCode,
          signal: sig,
          timedOut,
          ...(error !== undefined ? { error } : {}),
          stdout: stdout.text(),
          stderr: stderr.text(),
          outputTruncated: stdout.truncated || stderr.truncated,
          startedAt: startedAt.toISOString(),
          durationMs: Math.max(0, this.clock.now().getTime() - startedAt.getTime()),
          cached: false,
        });
      };

      const terminate = (): void => {
        killGroup('SIGTERM');
        handles.push(
          this.timers.setTimeout(() => {
            killGroup('SIGKILL');
            // Last resort if pipes are held open by an escaped process.
            handles.push(
              this.timers.setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
                finish(child.exitCode, child.signalCode);
              }, this.killGraceMs),
            );
          }, this.killGraceMs),
        );
      };

      const onAbort = (): void => {
        if (settled || timedOut) return;
        aborted = true;
        terminate();
      };

      child.on('error', (err) => {
        spawnError = err.message;
        // 'close' may not follow a failed spawn.
        if (child.pid === undefined) finish(null, null);
      });
      child.on('close', (code, sig) => finish(code, sig));
      child.on('exit', (code, sig) => {
        // Pipes may be held open by background children; do not wait for them forever.
        handles.push(
          this.timers.setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(code, sig);
          }, this.killGraceMs),
        );
      });

      handles.push(
        this.timers.setTimeout(() => {
          if (settled || aborted) return;
          timedOut = true;
          terminate();
        }, spec.timeoutMs),
      );
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
