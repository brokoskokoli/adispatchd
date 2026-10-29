/**
 * Workspace supervision of the hub (WI-35): starts every workspace as a child
 * process (`adispatch start …`), keeps it running and reports its state.
 *
 * States: `starting` (spawned, not answering yet) → `running` (answers on its
 * port) → `backoff` (crashed, restart pending) / `stopped` (stopped on purpose
 * or exited on its own with code 0) / `failed` (exit code 78: the
 * configuration or the instance lock cannot be fixed by restarting, or the
 * process could not be started). While a stop/drain/restart is requested,
 * `transition` says so.
 *
 * Crash handling: restart with exponential backoff (1 s … 60 s); the counter
 * resets after the child stayed `running` for `stableAfterMs`. Output lines of
 * the children are forwarded with a workspace prefix by the hub (the children
 * redact their own secrets).
 */
import {
  errorMessage,
  formatDuration,
  noopLogger,
  systemClock,
  systemTimers,
  HUB_SOCKET_ENV,
  HUB_WORKSPACE_ENV,
  type Clock,
  type Logger,
  type TimerHandle,
  type Timers,
} from '../core/index.js';
import type { HubWorkspaceConfig } from '../config/index.js';
import { EXIT_CONFIG } from '../service/index.js';
import { HubError } from './errors.js';
import type { ChildHandle, WorkspaceSpawner } from './spawner.js';

export type WorkspaceState = 'starting' | 'running' | 'backoff' | 'stopped' | 'failed';
export type WorkspaceTransition = 'draining' | 'stopping' | 'restarting' | null;

/** Visible state of one workspace. */
export interface WorkspaceStatus {
  id: string;
  enabled: boolean;
  state: WorkspaceState;
  /** A requested stop/drain/restart that is not finished yet. */
  transition: WorkspaceTransition;
  pid: number | null;
  port: number;
  configDir: string;
  dataDir: string;
  /** When the current process started (`null` if none). */
  startedAt: string | null;
  /** Automatic restarts after crashes. */
  restarts: number;
  /** Crashes (unexpected exits) since the hub started. */
  crashes: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  /** When the next restart happens (state `backoff`). */
  nextRestartAt: string | null;
  /** Short explanation of `failed`/`backoff`. */
  message: string | null;
}

/** Restart policy after crashes. */
export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  /** Running this long resets the failure counter. */
  stableAfterMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000, stableAfterMs: 60_000 };

/** Asks a running workspace to drain or cancel through its control API; `false` if that did not work. */
export type WorkspaceControl = (workspace: HubWorkspaceConfig, action: 'drain' | 'cancel-all') => Promise<boolean>;

/** Readiness probe of a workspace (default in the hub: `GET /health` on its port). */
export type WorkspaceProbe = (workspace: HubWorkspaceConfig) => Promise<boolean>;

/** Options of {@link WorkspaceSupervisor}. */
export interface SupervisorOptions {
  workspaces: readonly HubWorkspaceConfig[];
  slotSocketPath: string;
  spawner: WorkspaceSpawner;
  probe: WorkspaceProbe;
  control: WorkspaceControl;
  /** Receives every complete output line of a child. */
  output: (workspaceId: string, stream: 'stdout' | 'stderr', line: string) => void;
  /** Called when a child process has exited (the hub frees its slots). */
  onExit?: (workspaceId: string) => void;
  /** Called after every state change (WI-36: live updates). */
  onChange?: () => void;
  /** Environment of the hub that the children inherit. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** `--drain-timeout` of the children (also bounds `restart` and hub shutdown). */
  drainTimeoutMs: number;
  /** `--cancel-timeout` of the children. */
  cancelTimeoutMs: number;
  backoff?: Partial<BackoffPolicy>;
  /** Interval of the readiness probe. */
  probeIntervalMs?: number;
  /** Extra time after the escalation deadline before a child is killed with SIGKILL. */
  killGraceMs?: number;
}

const MAX_OUTPUT_LINE = 16 * 1024;

interface Managed {
  config: HubWorkspaceConfig;
  state: WorkspaceState;
  transition: WorkspaceTransition;
  child: ChildHandle | null;
  startedAt: Date | null;
  restarts: number;
  crashes: number;
  consecutiveFailures: number;
  lastExit: WorkspaceStatus['lastExit'];
  nextRestartAt: Date | null;
  message: string | null;
  timers: { restart?: TimerHandle; probe?: TimerHandle; stable?: TimerHandle; kill?: TimerHandle };
  /** Incremented per spawn; callbacks of an older child are ignored. */
  generation: number;
  exited: Array<() => void>;
}

/** See module docs. */
export class WorkspaceSupervisor {
  private readonly managed = new Map<string, Managed>();
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly log: Logger;
  private readonly backoff: BackoffPolicy;
  private shuttingDown = false;
  private sentCancelSignal = false;

  constructor(private readonly options: SupervisorOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.log = (options.logger ?? noopLogger).child({ component: 'hub-supervisor' });
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    for (const config of options.workspaces) {
      this.managed.set(config.id, {
        config,
        state: 'stopped',
        transition: null,
        child: null,
        startedAt: null,
        restarts: 0,
        crashes: 0,
        consecutiveFailures: 0,
        lastExit: null,
        nextRestartAt: null,
        message: null,
        timers: {},
        generation: 0,
        exited: [],
      });
    }
  }

  // --- queries ----------------------------------------------------------------

  status(): WorkspaceStatus[] {
    return [...this.managed.values()].map((m) => this.statusOf(m));
  }

  statusOfWorkspace(id: string): WorkspaceStatus {
    return this.statusOf(this.get(id));
  }

  has(id: string): boolean {
    return this.managed.has(id);
  }

  /** Workspaces with a live child process. */
  runningCount(): number {
    let n = 0;
    for (const m of this.managed.values()) if (m.child) n++;
    return n;
  }

  private statusOf(m: Managed): WorkspaceStatus {
    return {
      id: m.config.id,
      enabled: m.config.enabled,
      state: m.state,
      transition: m.transition,
      pid: m.child?.pid ?? null,
      port: m.config.port,
      configDir: m.config.configDir,
      dataDir: m.config.dataDir,
      startedAt: m.startedAt?.toISOString() ?? null,
      restarts: m.restarts,
      crashes: m.crashes,
      lastExit: m.lastExit,
      nextRestartAt: m.nextRestartAt?.toISOString() ?? null,
      message: m.message,
    };
  }

  private get(id: string): Managed {
    const m = this.managed.get(id);
    if (!m) throw new HubError('unknown_workspace', `Unknown workspace "${id}"`, 404);
    return m;
  }

  // --- commands ---------------------------------------------------------------

  /** Start all workspaces with `enabled: true`. */
  startEnabled(): void {
    for (const m of this.managed.values()) if (m.config.enabled) this.spawn(m);
  }

  /** Start a stopped, failed or backing-off workspace (also a disabled one). */
  start(id: string): WorkspaceStatus {
    this.assertAccepting();
    const m = this.get(id);
    if (m.child) throw new HubError('invalid_state', `Workspace "${id}" is already ${m.state}`, 409);
    m.consecutiveFailures = 0;
    this.spawn(m);
    return this.statusOf(m);
  }

  /** Cancel the workspace's runs and stop it (`cancel-all`); it stays stopped. */
  async stop(id: string): Promise<WorkspaceStatus> {
    const m = this.get(id);
    this.markStopped(m);
    if (!m.child) return this.statusOf(m);
    await this.requestExit(m, 'stopping', 'cancel-all', this.options.cancelTimeoutMs);
    return this.statusOf(m);
  }

  /** Let active runs finish (no timeout), start nothing new, then stop; it stays stopped. */
  async drain(id: string): Promise<WorkspaceStatus> {
    const m = this.get(id);
    this.markStopped(m);
    if (!m.child) return this.statusOf(m);
    await this.requestExit(m, 'draining', 'drain', null);
    return this.statusOf(m);
  }

  /** Drain (bounded by the drain timeout, then cancel) and start again. */
  async restart(id: string): Promise<WorkspaceStatus> {
    this.assertAccepting();
    const m = this.get(id);
    m.consecutiveFailures = 0;
    this.clearTimer(m, 'restart');
    if (!m.child) {
      this.spawn(m);
      return this.statusOf(m);
    }
    m.transition = 'restarting';
    this.changed();
    this.signal(m, 'SIGTERM');
    this.armKill(m, this.options.drainTimeoutMs + this.options.cancelTimeoutMs);
    return this.statusOf(m);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managed.keys()].map((id) => this.stop(id)));
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.managed.keys()].map((id) => this.drain(id)));
  }

  /**
   * Hub shutdown: no restarts, every child gets SIGTERM (drain with the
   * children's own timeouts). A second call with `mode: 'cancel'` sends one more
   * SIGTERM (the children's second signal = cancel-all). Resolves when all
   * children have exited; stragglers are killed after the timeouts plus grace.
   */
  shutdown(mode: 'drain' | 'cancel'): Promise<void> {
    const first = !this.shuttingDown;
    this.shuttingDown = true;
    for (const m of this.managed.values()) {
      this.clearTimer(m, 'restart');
      this.clearTimer(m, 'probe');
      if (!m.child) {
        if (m.state === 'backoff') m.state = 'stopped';
        continue;
      }
      if (first) {
        m.transition = 'stopping';
        this.signal(m, 'SIGTERM');
        this.armKill(m, this.options.drainTimeoutMs + this.options.cancelTimeoutMs);
      } else if (mode === 'cancel' && !this.sentCancelSignal) {
        this.signal(m, 'SIGTERM');
      }
    }
    if (!first && mode === 'cancel') this.sentCancelSignal = true;
    this.changed();
    return this.whenAllExited();
  }

  /** Last resort (third signal): SIGTERM once more, SIGKILL after `graceMs`. Resolves when all children are gone. */
  async forceStop(graceMs = 3_000): Promise<void> {
    this.shuttingDown = true;
    for (const m of this.managed.values()) {
      this.clearTimer(m, 'restart');
      if (m.child) this.signal(m, 'SIGTERM');
    }
    const killer = this.timers.setTimeout(() => {
      for (const m of this.managed.values()) if (m.child) this.signal(m, 'SIGKILL');
    }, graceMs);
    await this.whenAllExited();
    this.timers.clearTimeout(killer);
  }

  whenAllExited(): Promise<void> {
    return Promise.all(
      [...this.managed.values()].map((m) => (m.child ? new Promise<void>((resolve) => m.exited.push(resolve)) : Promise.resolve())),
    ).then(() => undefined);
  }

  // --- internals --------------------------------------------------------------

  private assertAccepting(): void {
    if (this.shuttingDown) throw new HubError('shutting_down', 'The hub is shutting down', 409);
  }

  /** The workspace should not come back by itself (stop/drain). */
  private markStopped(m: Managed): void {
    this.clearTimer(m, 'restart');
    if (!m.child) {
      m.state = 'stopped';
      m.nextRestartAt = null;
      m.message = null;
      m.transition = null;
      this.changed();
    }
  }

  private spawn(m: Managed): void {
    const id = m.config.id;
    if (m.child) return;
    this.clearTimer(m, 'restart');
    const generation = ++m.generation;
    const { options } = this;
    const args = [
      'start',
      '--config-dir',
      m.config.configDir,
      '--data-dir',
      m.config.dataDir,
      '--host',
      '127.0.0.1',
      '--port',
      String(m.config.port),
      '--drain-timeout',
      formatDuration(options.drainTimeoutMs),
      '--cancel-timeout',
      formatDuration(options.cancelTimeoutMs),
    ];
    const env = { ...(options.baseEnv ?? process.env), [HUB_SOCKET_ENV]: options.slotSocketPath, [HUB_WORKSPACE_ENV]: id };
    let child: ChildHandle;
    try {
      child = options.spawner.spawn({ workspaceId: id, args, env });
    } catch (err) {
      m.state = 'failed';
      m.message = `cannot start the process: ${errorMessage(err)}`;
      this.log.error('workspace could not be started', { workspace: id, error: errorMessage(err) });
      this.changed();
      return;
    }
    m.child = child;
    m.state = 'starting';
    m.startedAt = this.clock.now();
    m.nextRestartAt = null;
    m.message = null;
    this.log.info('workspace starting', { workspace: id, pid: child.pid ?? null, port: m.config.port });
    const buffers = { stdout: '', stderr: '' };
    child.onOutput((stream, chunk) => {
      if (m.generation !== generation) return;
      const lines = (buffers[stream] + chunk).split('\n');
      buffers[stream] = lines.pop() ?? '';
      if (buffers[stream].length > MAX_OUTPUT_LINE) {
        lines.push(buffers[stream]);
        buffers[stream] = '';
      }
      for (const line of lines) if (line !== '') options.output(id, stream, line.length > MAX_OUTPUT_LINE ? `${line.slice(0, MAX_OUTPUT_LINE)} …` : line);
    });
    child.onExit((code, signal) => {
      if (m.generation !== generation) return;
      for (const stream of ['stdout', 'stderr'] as const) if (buffers[stream] !== '') options.output(id, stream, buffers[stream]);
      this.handleExit(m, code, signal);
    });
    this.changed();
    this.armProbe(m, generation);
  }

  private armProbe(m: Managed, generation: number): void {
    this.clearTimer(m, 'probe');
    m.timers.probe = this.timers.setTimeout(() => {
      m.timers.probe = undefined;
      if (m.generation !== generation || !m.child || m.state !== 'starting') return;
      this.options
        .probe(m.config)
        .catch(() => false)
        .then((ok) => {
          if (m.generation !== generation || !m.child || m.state !== 'starting') return;
          if (!ok) return this.armProbe(m, generation);
          m.state = 'running';
          this.log.info('workspace running', { workspace: m.config.id, pid: m.child.pid ?? null });
          m.timers.stable = this.timers.setTimeout(() => {
            m.timers.stable = undefined;
            m.consecutiveFailures = 0;
          }, this.backoff.stableAfterMs);
          this.changed();
        });
    }, this.options.probeIntervalMs ?? 500);
  }

  private handleExit(m: Managed, code: number | null, signal: NodeJS.Signals | null): void {
    const id = m.config.id;
    this.clearTimer(m, 'probe');
    this.clearTimer(m, 'stable');
    this.clearTimer(m, 'kill');
    m.child = null;
    m.lastExit = { code, signal, at: this.clock.now().toISOString() };
    const transition = m.transition;
    m.transition = null;
    this.options.onExit?.(id);
    const wake = m.exited.splice(0);
    const finish = (): void => {
      this.changed();
      for (const resolve of wake) resolve();
    };
    if (transition === 'restarting' && !this.shuttingDown) {
      this.log.info('workspace stopped for restart', { workspace: id, code, signal });
      m.state = 'stopped';
      this.spawn(m);
      return finish();
    }
    if (transition !== null || this.shuttingDown || code === 0) {
      this.log.info('workspace stopped', { workspace: id, code, signal, requested: transition !== null || this.shuttingDown });
      m.state = 'stopped';
      m.message = null;
      return finish();
    }
    if (code === EXIT_CONFIG) {
      m.state = 'failed';
      m.message = 'configuration error or instance lock held (exit code 78); fix it and start the workspace again';
      this.log.error('workspace failed: not restarting', { workspace: id, code });
      return finish();
    }
    // Crash: restart with backoff.
    m.crashes++;
    m.consecutiveFailures++;
    const delay = Math.min(this.backoff.maxMs, this.backoff.initialMs * 2 ** Math.min(m.consecutiveFailures - 1, 20));
    m.state = 'backoff';
    m.message = `exited unexpectedly (${signal ? `signal ${signal}` : `exit code ${code ?? '?'}`}); restarting in ${formatDuration(delay)}`;
    m.nextRestartAt = new Date(this.clock.now().getTime() + delay);
    this.log.warn('workspace crashed: restart scheduled', { workspace: id, code, signal, delayMs: delay, crashes: m.crashes });
    m.timers.restart = this.timers.setTimeout(() => {
      m.timers.restart = undefined;
      if (this.shuttingDown || m.child) return;
      m.restarts++;
      this.spawn(m);
    }, delay);
    finish();
  }

  /** Ask the child to end: control API first (SIGTERM as fallback), SIGKILL when it does not end in time. */
  private async requestExit(m: Managed, transition: 'draining' | 'stopping', action: 'drain' | 'cancel-all', boundMs: number | null): Promise<void> {
    const generation = m.generation;
    m.transition = transition;
    this.changed();
    const ok = await this.options.control(m.config, action).catch(() => false);
    if (m.generation !== generation || !m.child) return;
    if (!ok) {
      // The control API is not available (still starting, no token): the signal drains with the child's own timeouts.
      this.log.warn('control API not available: signalling the workspace instead', { workspace: m.config.id, action });
      this.signal(m, 'SIGTERM');
      if (action === 'cancel-all') this.signal(m, 'SIGTERM');
      boundMs = this.options.drainTimeoutMs + this.options.cancelTimeoutMs;
    }
    if (boundMs !== null) this.armKill(m, boundMs);
  }

  private signal(m: Managed, signal: NodeJS.Signals): void {
    if (m.child?.kill(signal)) this.log.info('signal sent to workspace', { workspace: m.config.id, signal });
  }

  /** SIGKILL a child that still lives `afterMs` + grace later. */
  private armKill(m: Managed, afterMs: number): void {
    this.clearTimer(m, 'kill');
    const generation = m.generation;
    m.timers.kill = this.timers.setTimeout(() => {
      m.timers.kill = undefined;
      if (m.generation === generation && m.child) {
        this.log.error('workspace did not stop in time: killing it', { workspace: m.config.id });
        this.signal(m, 'SIGKILL');
      }
    }, afterMs + (this.options.killGraceMs ?? 30_000));
  }

  private clearTimer(m: Managed, name: keyof Managed['timers']): void {
    const t = m.timers[name];
    if (t) this.timers.clearTimeout(t);
    m.timers[name] = undefined;
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
