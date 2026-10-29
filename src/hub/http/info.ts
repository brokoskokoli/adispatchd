/**
 * Activity of the workspaces for the overview (WI-36): the hub asks every
 * running workspace instance for `GET /api/v1/status` now and then, with the
 * identity channel (see `api/auth.ts`, role `viewer`), and keeps a small
 * summary (runs, blocks, failed actions, scheduler state). Nothing of it is
 * persisted; a workspace that is not running has no summary.
 */
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type FetchLike,
  type Logger,
  type TimerHandle,
  type Timers,
} from '../../core/index.js';
import { HUB_ROLE_HEADER, HUB_TOKEN_HEADER } from '../../api/index.js';

/** What the overview shows about a running workspace. */
export interface WorkspaceActivity {
  /** Version of the instance. */
  version: string;
  /** Runs that are active (running, starting, recovery pending, …). */
  activeRuns: number;
  /** Runs this instance supervises right now. */
  supervisedRuns: number;
  recoveryPending: number;
  /** Active retry blocks. */
  activeBlocks: number;
  /** Lifecycle actions that failed and wait for a decision. */
  failedActions: number;
  /** Notifications that could not be delivered. */
  failedNotifications: number;
  scheduler: { state: string; paused: boolean; draining: boolean };
  /** The workspace's own `scheduler.max_concurrent` (the hub limit is an additional bound). */
  ownLimit: number;
  /** When the hub read this (ISO). */
  at: string;
}

/** Options of {@link WorkspaceInfoPoller}. */
export interface WorkspaceInfoPollerOptions {
  /** Workspaces to ask: ID → loopback port, only those that currently run. */
  running(): Array<{ id: string; port: number }>;
  /** Secret of the workspace's current child process. */
  token(id: string): string | null;
  /** Called when a summary appeared, changed or vanished. */
  onChange(id: string): void;
  fetch?: FetchLike;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  intervalMs?: number;
  timeoutMs?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reduce an instance's `/api/v1/status` to {@link WorkspaceActivity} (defensive: the body comes from another process). */
export function parseActivity(body: unknown, at: string): WorkspaceActivity | null {
  const b = obj(body);
  if (typeof b.version !== 'string') return null;
  const scheduler = obj(b.scheduler);
  const usage = obj(b.usage);
  const counts = obj(b.counts);
  const notifications = obj(counts.notifications);
  const limits = obj(b.limits);
  return {
    version: b.version.slice(0, 40),
    activeRuns: num(usage.activeRuns),
    supervisedRuns: num(usage.supervisedRuns),
    recoveryPending: num(usage.recoveryPending),
    activeBlocks: num(counts.activeBlocks),
    failedActions: num(counts.failedActions),
    failedNotifications: num(notifications.failed),
    scheduler: {
      state: typeof scheduler.state === 'string' ? scheduler.state.slice(0, 20) : 'unknown',
      paused: scheduler.paused === true,
      draining: scheduler.draining === true,
    },
    ownLimit: num(limits.maxConcurrent),
    at,
  };
}

/** See module docs. */
export class WorkspaceInfoPoller {
  private readonly activities = new Map<string, WorkspaceActivity>();
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly log: Logger;
  private readonly fetchFn: FetchLike;
  private timer: TimerHandle | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: WorkspaceInfoPollerOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.log = (options.logger ?? noopLogger).child({ component: 'hub-info' });
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get(id: string): WorkspaceActivity | null {
    return this.activities.get(id) ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  /** Ask the running workspaces now (also used by the timer; never two rounds at once). */
  poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const p = this.round().finally(() => {
      if (this.inFlight === p) this.inFlight = undefined;
    });
    this.inFlight = p;
    return p;
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (!this.running) return;
    await this.poll().catch(() => undefined);
    if (this.running) {
      this.timer = this.timers.setTimeout(() => void this.tick(), this.options.intervalMs ?? 3_000);
      (this.timer as { unref?: () => void } | undefined)?.unref?.();
    }
  }

  private async round(): Promise<void> {
    const running = this.options.running();
    const ids = new Set(running.map((r) => r.id));
    for (const id of [...this.activities.keys()]) {
      if (!ids.has(id)) {
        this.activities.delete(id);
        this.options.onChange(id);
      }
    }
    await Promise.all(running.map((r) => this.pollOne(r.id, r.port)));
  }

  private async pollOne(id: string, port: number): Promise<void> {
    const token = this.options.token(id);
    if (!token) return;
    let next: WorkspaceActivity | null = null;
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${port}/api/v1/status`, {
        headers: { accept: 'application/json', [HUB_TOKEN_HEADER]: token, [HUB_ROLE_HEADER]: 'viewer' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
      });
      if (res.status === 200) next = parseActivity(await res.json(), this.clock.now().toISOString());
      else {
        this.log.debug('workspace status not available', { workspace: id, status: res.status });
        await res.body?.cancel().catch(() => undefined);
      }
    } catch (err) {
      this.log.debug('workspace status request failed', { workspace: id, error: errorMessage(err) });
    }
    const prev = this.activities.get(id);
    if (!next) {
      if (prev) {
        this.activities.delete(id);
        this.options.onChange(id);
      }
      return;
    }
    this.activities.set(id, next);
    if (!prev || JSON.stringify({ ...prev, at: '' }) !== JSON.stringify({ ...next, at: '' })) this.options.onChange(id);
  }
}
