/**
 * Dashboard info tiles (WI-24): runs the scripts of `dashboard.yaml` in the
 * background and keeps the last value per tile in memory.
 *
 * - A tile is fetched when its value expired (`cache`), once at start, and
 *   after a reload for new or changed tiles. Reading the values (API, page
 *   views) never starts a script; only {@link DashboardInfoService.refresh}
 *   (the throttled "refresh" button) does.
 * - At most one execution per tile; at most `maxParallel` (default 2) in total,
 *   further due tiles wait in a FIFO queue.
 * - Execution like conditions (ShellCheckRunner): argument list without a
 *   shell, minimal environment + `env` + context, timeout, process-group kill,
 *   bounded output; working directory is the config dir.
 * - Exit ≠ 0, timeout or unparsable output → error state with a short
 *   (redacted) message; the last valid value stays visible (`stale`). Errors
 *   are retried after `min(cache, 60s)`.
 */
import path from 'node:path';
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type Logger,
  type Redactor,
  type TimerHandle,
  type Timers,
} from '../core/index.js';
import type { DashboardConfig, DashboardInfoConfig, DashboardInfoThresholds, DashboardInfoType } from '../config/index.js';
import { ShellCheckRunner, type ShellCheckResult, type ShellCheckSpec } from '../filters/index.js';
import { firstNonEmptyLine, infoValueStatus, parseInfoOutput } from './parse.js';

/** Default max. parallel executions over all tiles. */
export const DEFAULT_INFO_MAX_PARALLEL = 2;
/** Default min. distance between two manual refreshes of the same tile. */
export const DEFAULT_INFO_MANUAL_MIN_INTERVAL_MS = 10_000;
/** Default max. manual refreshes over all tiles per minute. */
export const DEFAULT_INFO_MANUAL_PER_MINUTE = 20;
/** Upper bound of the retry delay after an error. */
export const INFO_ERROR_RETRY_MAX_MS = 60_000;
/** Output limit per stream of an info script. */
export const INFO_MAX_OUTPUT_BYTES = 4 * 1024;
/** Max. length of an error message. */
const MAX_ERROR_LENGTH = 300;
/** Cap of a single timer delay (re-armed afterwards). */
const MAX_TIMER_DELAY_MS = 60 * 60_000;

/** Environment variables set for every info script (besides `ADISPATCH_CHECK_CONTEXT_FILE`). */
export const INFO_ENV = {
  id: 'ADISPATCH_INFO_ID',
  configDir: 'ADISPATCH_CONFIG_DIR',
  dataDir: 'ADISPATCH_DATA_DIR',
} as const;

/** Status of a tile in the API. */
export type InfoTileStatus = 'ok' | 'warn' | 'critical' | 'error' | 'pending';

/** One tile as returned by the API and the SSE event `dashboard.info`. Contains no secrets (redacted). */
export interface InfoTileView {
  id: string;
  title: string;
  type: DashboardInfoType;
  /** Last valid value (`null` = none yet); kept while `status` is `error` (`stale: true`). */
  value: string | number | null;
  unit: string | null;
  status: InfoTileStatus;
  /** Time of the last valid value. */
  updatedAt: string | null;
  /** When the value expires and is fetched again (background). */
  expiresAt: string | null;
  /** Error of the last attempt (redacted, short). */
  error?: string;
  /** True if `value` is older than the last (failed) attempt. */
  stale: boolean;
  /** A fetch is running or queued. */
  refreshing: boolean;
  lastAttemptAt: string | null;
  durationMs: number | null;
  thresholds: DashboardInfoThresholds;
}

/** Context file content of an info script (`ADISPATCH_CHECK_CONTEXT_FILE`). */
export interface InfoScriptContext {
  schema_version: 1;
  kind: 'dashboard_info';
  info: { id: string; type: DashboardInfoType };
  config_dir: string;
  data_dir: string;
}

/** Executes one info script (default: a {@link ShellCheckRunner}). Must not throw. */
export type InfoExecutor = (spec: ShellCheckSpec, context: InfoScriptContext, signal: AbortSignal) => Promise<ShellCheckResult>;

/** Options of {@link DashboardInfoService}. */
export interface DashboardInfoServiceOptions {
  /** Current dashboard configuration (`null` = no `dashboard.yaml`). */
  dashboard: () => DashboardConfig | null;
  configDir: () => string;
  dataDir: string;
  executor?: InfoExecutor;
  clock?: Clock;
  /** Scheduling timers (FakeClock in tests). */
  timers?: Timers;
  logger?: Logger;
  redact?: Redactor;
  hostEnv?: Readonly<Record<string, string | undefined>>;
  maxParallel?: number;
  manualMinIntervalMs?: number;
  manualPerMinute?: number;
  /** Called with the new view whenever a tile changed (value, status, refreshing). */
  onChange?: (tile: InfoTileView) => void;
}

/** Result of {@link DashboardInfoService.refresh}. */
export type RefreshResult =
  | { ok: true; tile: InfoTileView; alreadyRunning: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number };

interface TileState {
  config: DashboardInfoConfig;
  key: string;
  value: string | number | null;
  updatedAt: number | null;
  expiresAt: number | null;
  /** Next background fetch (ms); `null` while running/queued. */
  dueAt: number | null;
  error: string | null;
  lastAttemptAt: number | null;
  durationMs: number | null;
  running: boolean;
  queued: boolean;
  /** Bumped when the tile is replaced/removed: results of older executions are discarded. */
  generation: number;
  abort: AbortController | null;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** See module docs. */
export class DashboardInfoService {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly redact: Redactor;
  private readonly executor: InfoExecutor;
  private readonly maxParallel: number;
  private readonly manualMinIntervalMs: number;
  private readonly manualPerMinute: number;
  private readonly tiles = new Map<string, TileState>();
  private readonly queue: string[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly manualTimes: number[] = [];
  private running = 0;
  private timer: TimerHandle | undefined;
  private started = false;
  private stopped = false;
  private nextGeneration = 1;

  constructor(private readonly options: DashboardInfoServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'dashboard' });
    this.redact = options.redact ?? ((s: string) => s);
    this.maxParallel = Math.max(1, options.maxParallel ?? DEFAULT_INFO_MAX_PARALLEL);
    this.manualMinIntervalMs = options.manualMinIntervalMs ?? DEFAULT_INFO_MANUAL_MIN_INTERVAL_MS;
    this.manualPerMinute = options.manualPerMinute ?? DEFAULT_INFO_MANUAL_PER_MINUTE;
    if (options.executor) this.executor = options.executor;
    else {
      // Script timeouts use real timers (like conditions); the clock only stamps results.
      const runner = new ShellCheckRunner({
        clock: this.clock,
        logger: this.logger,
        maxOutputBytes: INFO_MAX_OUTPUT_BYTES,
        ...(options.hostEnv ? { hostEnv: options.hostEnv } : {}),
      });
      this.executor = (spec, context, signal) => runner.run(spec, context, { signal });
    }
    this.sync();
  }

  /** True if `dashboard.yaml` exists. */
  get configured(): boolean {
    return this.options.dashboard() !== null;
  }

  /** Fetch every tile once and keep them fresh in the background. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const now = this.now();
    for (const t of this.tiles.values()) if (!t.running && !t.queued) t.dueAt = now;
    this.enqueueDue();
  }

  /** Stop the timer, kill running scripts and wait for them. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    for (const t of this.tiles.values()) {
      t.queued = false;
      t.abort?.abort();
    }
    await this.whenIdle();
  }

  /** Resolves once no script is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Reconcile the tiles with the current configuration (start, `config
   * reload`): unchanged tiles keep their value; new and changed tiles are
   * fetched at once; removed tiles are dropped (a running script is killed).
   */
  sync(): void {
    const dashboard = this.options.dashboard();
    const wanted = new Map((dashboard?.info ?? []).map((c) => [c.id, c]));
    for (const [id, state] of [...this.tiles]) {
      if (!wanted.has(id)) {
        state.generation = 0;
        state.abort?.abort();
        this.tiles.delete(id);
      }
    }
    const now = this.now();
    const ordered = new Map<string, TileState>();
    for (const [id, config] of wanted) {
      const key = JSON.stringify(config);
      const existing = this.tiles.get(id);
      if (existing && existing.key === key) {
        ordered.set(id, existing);
        continue;
      }
      if (existing) {
        existing.generation = 0;
        existing.abort?.abort();
      }
      ordered.set(id, {
        config,
        key,
        value: null,
        updatedAt: null,
        expiresAt: null,
        dueAt: now,
        error: null,
        lastAttemptAt: null,
        durationMs: null,
        running: false,
        queued: false,
        generation: this.nextGeneration++,
        abort: null,
      });
    }
    this.tiles.clear();
    for (const [id, state] of ordered) this.tiles.set(id, state);
    for (let i = this.queue.length - 1; i >= 0; i--) if (!this.tiles.has(this.queue[i] as string)) this.queue.splice(i, 1);
    if (this.started && !this.stopped) this.enqueueDue();
  }

  /** All tiles in configuration order. */
  list(): InfoTileView[] {
    return [...this.tiles.values()].map((t) => this.view(t));
  }

  /** One tile, `undefined` if unknown. */
  get(id: string): InfoTileView | undefined {
    const t = this.tiles.get(id);
    return t ? this.view(t) : undefined;
  }

  /**
   * Manual refresh (UI button): starts a fetch now unless one is running or
   * queued. Throttled per tile ({@link DEFAULT_INFO_MANUAL_MIN_INTERVAL_MS}
   * since the last attempt) and globally (per minute).
   */
  refresh(id: string): RefreshResult {
    const t = this.tiles.get(id);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.running || t.queued) return { ok: true, tile: this.view(t), alreadyRunning: true };
    const now = this.now();
    if (t.lastAttemptAt !== null && now - t.lastAttemptAt < this.manualMinIntervalMs) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: this.manualMinIntervalMs - (now - t.lastAttemptAt) };
    }
    while (this.manualTimes.length > 0 && now - (this.manualTimes[0] as number) >= 60_000) this.manualTimes.shift();
    if (this.manualTimes.length >= this.manualPerMinute) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: 60_000 - (now - (this.manualTimes[0] as number)) };
    }
    if (this.stopped) return { ok: false, reason: 'rate_limited', retryAfterMs: 60_000 };
    this.manualTimes.push(now);
    this.enqueue(t);
    this.pump();
    return { ok: true, tile: this.view(t), alreadyRunning: false };
  }

  // ---------------------------------------------------------------------------

  private now(): number {
    return this.clock.now().getTime();
  }

  private iso(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
  }

  private view(t: TileState): InfoTileView {
    const c = t.config;
    const status: InfoTileStatus = t.error !== null ? 'error' : t.value === null ? 'pending' : infoValueStatus(t.value, c.thresholds);
    return {
      id: c.id,
      title: c.title,
      type: c.type,
      value: t.value,
      unit: c.type === 'percent' ? '%' : c.unit,
      status,
      updatedAt: this.iso(t.updatedAt),
      expiresAt: this.iso(t.expiresAt),
      ...(t.error !== null ? { error: t.error } : {}),
      stale: t.error !== null && t.value !== null,
      refreshing: t.running || t.queued,
      lastAttemptAt: this.iso(t.lastAttemptAt),
      durationMs: t.durationMs,
      thresholds: c.thresholds,
    };
  }

  private emit(t: TileState): void {
    if (this.tiles.get(t.config.id) !== t) return;
    try {
      this.options.onChange?.(this.view(t));
    } catch (err) {
      this.logger.debug('dashboard change listener failed', { error: errorMessage(err) });
    }
  }

  private enqueue(t: TileState): void {
    if (t.running || t.queued) return;
    t.queued = true;
    t.dueAt = null;
    this.queue.push(t.config.id);
    this.emit(t);
  }

  /** Queue every tile whose `dueAt` has passed, start what fits, arm the timer for the next one. */
  private enqueueDue(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const t of this.tiles.values()) if (t.dueAt !== null && t.dueAt <= now) this.enqueue(t);
    this.pump();
    this.arm();
  }

  private arm(): void {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.started) return;
    let next: number | null = null;
    for (const t of this.tiles.values()) if (t.dueAt !== null && (next === null || t.dueAt < next)) next = t.dueAt;
    if (next === null) return;
    const delay = Math.min(Math.max(0, next - this.now()), MAX_TIMER_DELAY_MS);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.enqueueDue();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private pump(): void {
    while (!this.stopped && this.running < this.maxParallel && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const t = this.tiles.get(id);
      if (!t || !t.queued) continue;
      t.queued = false;
      const p = this.execute(t);
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    }
  }

  private async execute(t: TileState): Promise<void> {
    const generation = t.generation;
    const c = t.config;
    const abort = new AbortController();
    t.abort = abort;
    t.running = true;
    this.running++;
    const started = this.now();
    t.lastAttemptAt = started;
    const configDir = this.options.configDir();
    const dataDir = path.resolve(this.options.dataDir);
    const spec: ShellCheckSpec = {
      command: c.command,
      args: c.args,
      timeoutMs: c.timeoutMs,
      cwd: configDir,
      env: { ...c.env, [INFO_ENV.id]: c.id, [INFO_ENV.configDir]: configDir, [INFO_ENV.dataDir]: dataDir },
    };
    const context: InfoScriptContext = { schema_version: 1, kind: 'dashboard_info', info: { id: c.id, type: c.type }, config_dir: configDir, data_dir: dataDir };
    let result: ShellCheckResult | null = null;
    let failure: string | null = null;
    try {
      result = await this.executor(spec, context, abort.signal);
    } catch (err) {
      failure = `execution failed: ${errorMessage(err)}`;
    }
    this.running--;
    t.running = false;
    t.abort = null;
    try {
      if (t.generation !== generation || this.tiles.get(c.id) !== t) return; // replaced/removed meanwhile
      if (this.stopped && abort.signal.aborted) return; // killed by stop(): keep the last state
      const now = this.now();
      t.durationMs = result?.durationMs ?? now - started;
      let error = failure;
      if (result && error === null) {
        if (result.exitCode === 0 && result.value === true) {
          const parsed = parseInfoOutput(c.type, result.stdout, c.unit);
          if (parsed.ok) {
            t.value = typeof parsed.value === 'string' ? this.redact(parsed.value) : parsed.value;
            t.updatedAt = now;
            t.expiresAt = now + c.cacheMs;
            t.error = null;
            t.dueAt = this.stopped ? null : now + c.cacheMs;
            return;
          }
          error = parsed.error;
        } else {
          const base = result.error ?? `exit code ${String(result.exitCode)}`;
          const stderr = firstNonEmptyLine(result.stderr);
          error = stderr ? `${base}: ${stderr}` : base;
        }
      }
      t.error = shorten(this.redact(error ?? 'unknown error'), MAX_ERROR_LENGTH);
      t.dueAt = this.stopped ? null : now + Math.min(c.cacheMs, INFO_ERROR_RETRY_MAX_MS);
      this.logger.warn('dashboard info script failed', { id: c.id, error: t.error });
    } finally {
      this.emit(t);
      this.pump();
      this.arm();
    }
  }
}
