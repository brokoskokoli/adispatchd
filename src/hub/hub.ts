/**
 * The hub (WI-35): one process that starts every workspace of `hub.yaml` as a
 * child process, shares a run limit between them through the slot server and
 * offers a local control socket.
 *
 * Start order: instance lock (hub data dir) → slot socket → control socket →
 * workspaces. Stop order (`shutdown`): workspaces (SIGTERM = drain with their
 * own timeouts; a repeated call with `cancel` = their second signal) → control
 * socket → slot socket → lock. The hub never leaves child processes behind
 * unless it is killed with SIGKILL itself.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  ConsoleLogger,
  SecretRedactor,
  errorMessage,
  systemClock,
  systemTimers,
  type Clock,
  type Logger,
  type LogLevel,
  type Timers,
} from '../core/index.js';
import type { HubConfig } from '../config/index.js';
import { acquireInstanceLock, type InstanceLock } from '../persistence/index.js';
import { ControlServer, type HubControl } from './control-server.js';
import { HubError } from './errors.js';
import { SlotLedger } from './ledger.js';
import { SlotServer } from './slot-server.js';
import { processSpawner, type WorkspaceSpawner } from './spawner.js';
import { WorkspaceSupervisor, type BackoffPolicy, type WorkspaceControl, type WorkspaceProbe, type WorkspaceStatus } from './supervisor.js';
import { httpWorkspaceControl, httpWorkspaceProbe } from './workspace-control.js';

/** Default drain timeout of the workspaces (same as `adispatch start`). */
export const HUB_DEFAULT_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Default time for cancelled runs (same as `adispatch start`). */
export const HUB_DEFAULT_CANCEL_TIMEOUT_MS = 2 * 60_000;
/** File names inside the hub data dir. */
export const HUB_SLOT_SOCKET = 'slots.sock';
export const HUB_CONTROL_SOCKET = 'hub.sock';

/** One workspace in {@link HubStatus}. */
export interface HubWorkspaceStatus extends WorkspaceStatus {
  /** Loopback URL of the workspace instance. */
  url: string;
  /** Slots the workspace holds right now. */
  slots: number;
  /** The workspace's slot connection is established. */
  connected: boolean;
}

/** Everything `hub status` shows (and WI-36 serves). */
export interface HubStatus {
  version: string;
  pid: number;
  startedAt: string;
  time: string;
  state: 'running' | 'paused' | 'stopping';
  paused: boolean;
  slots: { max: number; active: number; byWorkspace: Record<string, number> };
  server: { host: string; port: number };
  workspaces: HubWorkspaceStatus[];
}

/** Options of {@link createHub}. */
export interface HubOptions {
  config: HubConfig;
  /** Data dir of the hub itself (lock, sockets). */
  dataDir: string;
  version: string;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  logLevel?: LogLevel;
  spawner?: WorkspaceSpawner;
  probe?: WorkspaceProbe;
  control?: WorkspaceControl;
  /** Output lines of the children (default: hub stdout/stderr with a `[workspace] ` prefix). */
  output?: (workspaceId: string, stream: 'stdout' | 'stderr', line: string) => void;
  /** Environment the children inherit (default `process.env`). */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  drainTimeoutMs?: number;
  cancelTimeoutMs?: number;
  backoff?: Partial<BackoffPolicy>;
  probeIntervalMs?: number;
  killGraceMs?: number;
  /** Heartbeat silence after which a workspace's slots expire. */
  leaseTtlMs?: number;
}

/** Options of {@link Hub.shutdown}. */
export interface HubShutdownOptions {
  mode?: 'drain' | 'cancel';
  /** Accepted for signal handler compatibility; the children apply their own timeouts. */
  drainTimeoutMs?: number;
  cancelTimeoutMs?: number;
  reason?: string;
}

/** Result of a completed hub shutdown. */
export interface HubStopResult {
  exitCode: number;
  error?: string;
}

/** A hub instance. */
export interface Hub extends HubControl {
  readonly logger: Logger;
  readonly slotSocketPath: string;
  readonly controlSocketPath: string;
  /** Resolves when the hub has fully stopped (children gone, sockets removed, lock released). */
  readonly stopped: Promise<HubStopResult>;
  /** Create the sockets and start the enabled workspaces. */
  start(): Promise<void>;
  /** Stop all workspaces and the hub. Repeated calls escalate (drain → cancel). */
  shutdown(options?: HubShutdownOptions): Promise<HubStopResult>;
  /** Third signal: terminate the children at once (SIGKILL after a short grace). */
  forceStop(): Promise<void>;
}

/**
 * Create a hub. Acquires the hub data dir's instance lock immediately
 * (`InstanceLockedError` if another hub uses it); nothing listens or starts
 * until {@link Hub.start}.
 */
export function createHub(options: HubOptions): Hub {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? systemTimers;
  const redactor = new SecretRedactor();
  const logger = options.logger ?? new ConsoleLogger({ level: options.logLevel ?? 'info', clock, redact: redactor.asRedactor });
  const log = logger.child({ component: 'hub' });
  const dataDir = path.resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock: InstanceLock = acquireInstanceLock(dataDir, { clock });
  const slotSocketPath = path.join(dataDir, HUB_SLOT_SOCKET);
  const controlSocketPath = path.join(dataDir, HUB_CONTROL_SOCKET);
  const startedAt = clock.now().toISOString();

  const ledger = new SlotLedger(config.maxConcurrent);
  const workspaceIds = new Set(config.workspaces.map((w) => w.id));
  const slots = new SlotServer({
    socketPath: slotSocketPath,
    ledger,
    workspaceIds: () => workspaceIds,
    clock,
    timers,
    logger,
    ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
  });
  const supervisor = new WorkspaceSupervisor({
    workspaces: config.workspaces,
    slotSocketPath,
    spawner: options.spawner ?? processSpawner(),
    probe: options.probe ?? httpWorkspaceProbe(),
    control: options.control ?? httpWorkspaceControl(),
    output:
      options.output ??
      ((id, stream, line) => {
        (stream === 'stderr' ? process.stderr : process.stdout).write(`[${id}] ${line}\n`);
      }),
    onExit: (id) => slots.dropWorkspace(id),
    clock,
    timers,
    logger,
    drainTimeoutMs: options.drainTimeoutMs ?? HUB_DEFAULT_DRAIN_TIMEOUT_MS,
    cancelTimeoutMs: options.cancelTimeoutMs ?? HUB_DEFAULT_CANCEL_TIMEOUT_MS,
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    ...(options.probeIntervalMs !== undefined ? { probeIntervalMs: options.probeIntervalMs } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
  });

  let shuttingDown = false;
  let started = false;
  let stopPromise: Promise<HubStopResult> | undefined;
  let resolveStopped!: (r: HubStopResult) => void;
  const stopped = new Promise<HubStopResult>((resolve) => {
    resolveStopped = resolve;
  });

  const status = (): HubStatus => {
    const connected = new Set(slots.connectedWorkspaces());
    const state = ledger.paused ? 'paused' : 'running';
    return {
      version: options.version,
      pid: process.pid,
      startedAt,
      time: clock.now().toISOString(),
      state: shuttingDown ? 'stopping' : state,
      paused: ledger.paused,
      slots: { max: ledger.max, active: ledger.active, byWorkspace: ledger.byWorkspace() },
      server: { host: config.server.host, port: config.server.port },
      workspaces: supervisor.status().map((w) => ({
        ...w,
        url: `http://127.0.0.1:${w.port}`,
        slots: ledger.activeOf(w.id),
        connected: connected.has(w.id),
      })),
    };
  };

  const control: HubControl = {
    status,
    pause: () => {
      slots.setPaused(true);
      log.info('hub paused: no new automatic runs');
      return status();
    },
    resume: () => {
      slots.setPaused(false);
      log.info('hub resumed');
      return status();
    },
    stopAll: async () => {
      log.info('stopping all workspaces');
      await supervisor.stopAll();
      return status();
    },
    drainAll: async () => {
      log.info('draining all workspaces');
      await supervisor.drainAll();
      return status();
    },
    workspace: async (id, action) => {
      if (!supervisor.has(id)) throw new HubError('unknown_workspace', `Unknown workspace "${id}"`, 404);
      log.info('workspace command', { workspace: id, action });
      if (action === 'start') supervisor.start(id);
      else if (action === 'stop') await supervisor.stop(id);
      else if (action === 'drain') await supervisor.drain(id);
      else await supervisor.restart(id);
      return status();
    },
  };
  const controlServer = new ControlServer({ socketPath: controlSocketPath, logger, control });

  const teardown = async (error?: string): Promise<HubStopResult> => {
    await controlServer.close().catch((err: unknown) => log.warn('closing the control socket failed', { error: errorMessage(err) }));
    await slots.close().catch((err: unknown) => log.warn('closing the slot socket failed', { error: errorMessage(err) }));
    lock.release();
    const result: HubStopResult = { exitCode: error ? 1 : 0, ...(error ? { error } : {}) };
    log.info('hub stopped', { exitCode: result.exitCode });
    resolveStopped(result);
    return result;
  };

  return {
    logger,
    slotSocketPath,
    controlSocketPath,
    stopped,
    status: control.status,
    pause: control.pause,
    resume: control.resume,
    stopAll: control.stopAll,
    drainAll: control.drainAll,
    workspace: control.workspace,
    async start() {
      if (started) throw new Error('hub already started');
      started = true;
      if (shuttingDown) return; // a signal arrived before the start
      try {
        await slots.listen();
        await controlServer.listen();
      } catch (err) {
        await teardown(errorMessage(err));
        throw err;
      }
      if (shuttingDown) {
        // A signal arrived while the sockets were created: nothing was started, finish the stop.
        await Promise.all([slots.close(), controlServer.close()]).catch(() => undefined);
        return;
      }
      log.info('hub started', { maxConcurrent: config.maxConcurrent, workspaces: config.workspaces.length, slotSocket: slotSocketPath });
      supervisor.startEnabled();
    },
    shutdown(shutdownOptions = {}) {
      const mode = shutdownOptions.mode ?? 'drain';
      if (stopPromise) {
        void supervisor.shutdown(mode);
        return stopPromise;
      }
      shuttingDown = true;
      log.info('hub shutting down', { mode });
      stopPromise = (async () => {
        let error: string | undefined;
        try {
          await supervisor.shutdown(mode);
        } catch (err) {
          error = errorMessage(err);
          log.error('shutdown failed', { error });
        }
        return teardown(error);
      })();
      return stopPromise;
    },
    async forceStop() {
      log.error('forcing all workspaces to stop');
      await supervisor.forceStop();
    },
  };
}
