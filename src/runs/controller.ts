/**
 * Run controller (Spec §8, §11, §13, §14): drives a reserved run through
 * `starting → running → finalizing → <terminal>`, classifies the outcome,
 * applies technical-failure counting and retry blocks, runs the completion
 * hook, cleans up the workspace, supervises cancel, recovers after a
 * controller crash and implements pause / drain / cancel-all shutdown.
 *
 * Invariants:
 * - Every status transition is persisted before work continues; terminal
 *   statuses are reached only via `finalizing` with a persisted
 *   {@link FinalizationTarget} (WI-01/WI-03).
 * - The retry block is created in the SAME transaction as `→ finalizing`,
 *   i.e. before the completion hook runs (Spec §11 "important order").
 * - Hooks always use the run's configuration snapshot, never the live config.
 * - Bus publication and notifications happen only after commit.
 * - A process is only ever signalled after verifying its start identity
 *   (recovery); on doubt the run becomes `recovery_pending` and keeps its lock.
 */
import {
  HOOK_NAMES,
  LINKED_ITEM_FIELDS,
  errorMessage,
  hookForOutcome,
  isOrchestratorError,
  isTerminalStatus,
  noopLogger,
  parseSourceItemKey,
  systemClock,
  systemTimers,
  type BusinessResult,
  type Clock,
  type CredentialProvider,
  type ExecutionOutcome,
  type Executor,
  type FieldResolution,
  type FinalizationTarget,
  type HookName,
  type Logger,
  type Notifier,
  type RunningProcess,
  type SourceAdapter,
  type SourceItem,
  type TechnicalStatus,
  type TerminalStatus,
  type Timers,
  unknownLinkedField,
} from '../core/index.js';
import type { WorkflowSnapshot } from '../config/index.js';
import {
  ShellExecutor,
  classifyOutcome,
  processGroupExists,
  terminateProcessGroupIfSame,
  type KillFn,
  type ProcessInspector,
} from '../executors/index.js';
import { parseRunSnapshot, type HookResult, type LifecycleEngine, type SourceResolver } from '../lifecycle/index.js';
import {
  RUN_STATUS_EVENT,
  finalizationTarget,
  type BlockRecord,
  type Repositories,
  type RunRecord,
  type RunUpdate,
} from '../persistence/index.js';
import { RunControllerError } from './errors.js';
import { PersistedEventPublisher, RunEventBus, type ControllerStatus } from './event-bus.js';
import { buildExecutionSpec, linkedFieldUsage } from './execution.js';
import { removeWorkspace, shouldCleanupWorkspace } from './workspace.js';

/** Orchestrator-side event types persisted by the controller (besides `run.status`). */
export const RUN_EVENTS = {
  /** Linked fields (WI-21) resolved before the start (`{known, unknown}` field names). */
  linkedResolved: 'run.linked_resolved',
  /** Worker spawn is about to happen (`{command, args, workingDirectory}`); recovery uses it. */
  spawn: 'run.spawn',
  /** Item re-read before `on_start` (Spec §7): `{found, matches?}`. */
  itemReread: 'run.item_reread',
  cancelRequested: 'run.cancel_requested',
  /** Process group could not be terminated; run stays `cancelling` (Spec §13). */
  cancelFailed: 'run.cancel_failed',
  /** A completion hook threw unexpectedly. */
  hookError: 'run.hook_error',
  /** Unexpected internal error while supervising a run (run left as is for recovery). */
  controllerError: 'run.controller_error',
  /** Recovery could not identify / stop the process → `recovery_pending`. */
  recoveryFailed: 'recovery.failed',
  /** Recovery decided the run's fate (`{action, detail}`). */
  recovered: 'recovery.recovered',
  /** Workspace cleanup result. */
  workspaceCleanup: 'workspace.cleanup',
} as const;

/** Optional per-start settings. */
export interface StartRunOptions {
  /**
   * Re-check of the freshly re-read item (Spec §7 race), e.g. the scheduler's
   * cheap filter. `false` → the run is not started and finalized as
   * `cancelled` (not counted, no hooks). Manual starts omit it.
   */
  verifyItem?: (item: SourceItem) => boolean | Promise<boolean>;
}

/** Handle returned by {@link RunController.startRun}. */
export interface RunHandle {
  runId: string;
  /**
   * Resolves with the run record once supervision ended (terminal, or left
   * in its state for recovery). Rejects only if the database itself fails.
   */
  done: Promise<RunRecord>;
}

/** Shutdown mode. */
export type ShutdownMode = 'drain' | 'cancel';

/** Options of {@link RunController.shutdown}. */
export interface ShutdownOptions {
  /** Default `drain`. */
  mode?: ShutdownMode;
  /** Max wait for active runs while draining; then cancel-all. `undefined` = wait forever. */
  drainTimeoutMs?: number;
  /**
   * Max wait for cancelled runs (incl. `on_cancel`); then running hooks are
   * interrupted (resumed by recovery at next start). `undefined` = wait forever.
   */
  cancelTimeoutMs?: number;
  /** Reason recorded on cancelled runs. */
  reason?: string;
}

/** Result of a shutdown. */
export interface ShutdownResult {
  /** `drained`: all runs finished normally; `cancelled`: cancel-all was needed. */
  outcome: 'drained' | 'cancelled';
  /** Runs still supervised when the stop callback ran (left for recovery). */
  leftActive: string[];
}

/** Report of {@link RunController.recover}. */
export interface RecoveryReport {
  /** Runs finalized by recovery, with their final status. */
  finalized: Array<{ runId: string; status: TechnicalStatus; detail: string }>;
  /** Runs that are `recovery_pending` after recovery (lock kept). */
  pending: Array<{ runId: string; reason: string }>;
  /** Terminal runs whose incomplete action chains were resumed. */
  resumedActions: string[];
  /** Unexpected per-run errors (logged; the run is left as is). */
  errors: Array<{ runId: string; message: string }>;
}

/** Dependencies and tuning of the {@link RunController}. */
export interface RunControllerOptions {
  repositories: Repositories;
  /** Lifecycle engine (WI-07); pass `publisher.actionListener()` as its `onActionChange`. */
  lifecycle: LifecycleEngine;
  /** Source adapters by configured source ID. */
  sources: SourceResolver;
  dataDir: string;
  /** Shared bus; default: a new one (see {@link RunController.bus}). */
  bus?: RunEventBus;
  /** Shared publisher of persisted events; default: a new one over `bus`. */
  publisher?: PersistedEventPublisher;
  /** Needed for `execute.secrets`. */
  credentials?: CredentialProvider;
  /** Receives `retry_block_created` and `recovery_failed` after commit. Must not block/throw. */
  notifier?: Notifier;
  /** Executor per run; default `new ShellExecutor({clock, logger, workspaceBaseDir})`. */
  createExecutor?: (options: { workspaceBaseDir: string | undefined }) => Executor;
  /** `retention.max_log_size_per_run` in bytes (value or getter for the live config). */
  maxLogBytesPerRun?: number | (() => number | undefined);
  clock?: Clock;
  /** Timers for shutdown timeouts and recovery polling. */
  timers?: Timers;
  logger?: Logger;
  /** Recovery: process inspector / signal sender (tests). */
  processInspector?: ProcessInspector;
  kill?: KillFn;
  /** Recovery: "does a process group with this ID exist?" (default `processGroupExists`; tests). */
  groupExists?: (pgid: number) => boolean;
  /** Recovery: wait after SIGKILL before giving up (default 5 s). */
  recoveryKillConfirmMs?: number;
  /** Recovery: SIGTERM→SIGKILL grace; default the run snapshot's `execute.cancel_grace`. */
  recoveryGraceMs?: number;
  /** Max wait for interrupted hooks after a forced stop (default 10 s). */
  abortSettleMs?: number;
  /** Called once when a shutdown completed (after drain or cancel-all). */
  onStop?: (result: ShutdownResult) => void | Promise<void>;
}

interface ActiveRun {
  runId: string;
  /** `run`: supervised execution; `recovery`: recovery / retryRecovery in progress (not cancellable). */
  kind: 'run' | 'recovery';
  /** Aborted on cancel (on_start chain, item re-read, secret resolution). */
  cancel: AbortController;
  cancelRequested: boolean;
  cancelReason: string;
  proc: RunningProcess | undefined;
  done: Promise<RunRecord>;
}

interface ShutdownState {
  mode: ShutdownMode;
  /** Absolute end of the drain phase (epoch ms), `undefined` = unlimited. */
  drainDeadline: number | undefined;
  /** Cancel-phase timeout (ms) and its absolute deadline once the phase started. */
  cancelTimeoutMs: number | undefined;
  cancelDeadline: number | undefined;
  reason: string | undefined;
}

type ProcessCheck = { gone: true; detail: string } | { gone: false; reason: string };

interface FinalizeOptions {
  /** Run the completion hook (only if the run reached `starting`). */
  hooks: boolean;
  item?: SourceItem | null;
  update?: RunUpdate;
}

const CANCELLABLE_TO_CANCELLING: readonly TechnicalStatus[] = ['reserved', 'starting', 'running'];
const CAN_BECOME_RECOVERY_PENDING: readonly TechnicalStatus[] = ['reserved', 'starting', 'running', 'cancelling'];

/** See module docs. One instance per process. */
export class RunController {
  /** In-process event bus (SSE source for WI-10). */
  readonly bus: RunEventBus;
  /** Publisher of persisted events (share with the lifecycle engine). */
  readonly publisher: PersistedEventPublisher;

  private readonly repos: Repositories;
  private readonly lifecycle: LifecycleEngine;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly active = new Map<string, ActiveRun>();
  private readonly idleWaiters = new Set<() => void>();
  /** Woken when a running shutdown is escalated (cancel mode / stricter timeouts). */
  private readonly shutdownWakeups = new Set<() => void>();
  private shutdownState: ShutdownState | undefined;
  /** Aborted on a forced stop: interrupts completion hooks (resumed by recovery). */
  private readonly hookAbort = new AbortController();

  private ready = false;
  private paused = false;
  private draining = false;
  private stopping = false;
  private recovering: Promise<RecoveryReport> | undefined;
  private shuttingDown: Promise<ShutdownResult> | undefined;

  constructor(private readonly options: RunControllerOptions) {
    this.repos = options.repositories;
    this.lifecycle = options.lifecycle;
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'run-controller' });
    this.bus = options.publisher?.bus ?? options.bus ?? new RunEventBus(this.logger);
    this.publisher = options.publisher ?? new PersistedEventPublisher(this.repos, this.bus);
  }

  // ---------------------------------------------------------------------------
  // Status / flags (WI-09 scheduler, WI-10 /ready)

  /** Current controller status. */
  get status(): ControllerStatus {
    return {
      ready: this.ready,
      paused: this.paused,
      draining: this.draining,
      stopping: this.stopping,
      activeRuns: this.active.size,
    };
  }

  /** Recovery finished (`/ready`). */
  isReady(): boolean {
    return this.ready;
  }

  /** Scheduler gate for automatic starts: ready, not paused, not draining/stopping. */
  canStartAutomatically(): boolean {
    return this.ready && !this.paused && !this.draining && !this.stopping;
  }

  /** Gate for manual starts: pause does not apply (Spec §14), drain/stop does. */
  canStartManually(): boolean {
    return this.ready && !this.draining && !this.stopping;
  }

  /** Run IDs currently supervised by this process. */
  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  /** Pause automatic starts (running runs are not touched). */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.publishStatus();
  }

  /** Resume automatic starts. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.publishStatus();
  }

  // ---------------------------------------------------------------------------
  // Blocks (Spec §11)

  /** True if an active retry block exists for the workflow/item (`itemKey = null` → workflow scope). */
  isBlocked(workflowId: string, itemKey: string | null): boolean {
    return this.repos.blocks.isBlocked(workflowId, itemKey);
  }

  /** Remove a block: starts a new counting period; runs/history stay (idempotent). */
  clearBlock(blockId: number, clearedBy: string | null = null): BlockRecord {
    const before = this.repos.blocks.get(blockId);
    const block = this.repos.blocks.clear(blockId, clearedBy);
    if (before && before.clearedAt === null) {
      this.repos.afterCommit(() => this.bus.publish({ type: 'block.cleared', block }));
    }
    return block;
  }

  // ---------------------------------------------------------------------------
  // Start

  /**
   * Start supervising a reserved run (from the scheduler or a manual start).
   * Returns immediately; the run proceeds asynchronously (`handle.done`).
   *
   * If the controller does not accept runs (not ready, draining, stopping),
   * the reserved run is finalized as `cancelled` (never started, not counted,
   * no hooks) so its lock is released, and a {@link RunControllerError} is thrown.
   */
  startRun(run: RunRecord | string, options: StartRunOptions = {}): RunHandle {
    const runId = typeof run === 'string' ? run : run.id;
    if (this.active.has(runId)) {
      throw new RunControllerError('run_already_started', `Run ${runId} is already being executed`, { runId });
    }
    const current = this.repos.runs.require(runId);
    if (current.status !== 'reserved') {
      throw new RunControllerError('run_not_reserved', `Run ${runId} is '${current.status}', expected 'reserved'`, {
        runId,
        status: current.status,
      });
    }
    if (!this.ready || this.draining || this.stopping) {
      const notReady = !this.ready;
      const reason = notReady ? 'controller not ready (recovery running)' : 'controller is draining / shutting down';
      this.finalizeUnstarted(runId, reason);
      throw new RunControllerError(
        notReady ? 'run_controller_not_ready' : 'run_controller_not_accepting',
        `Run ${runId} not started: ${reason}`,
        { runId },
      );
    }
    const entry: ActiveRun = {
      runId,
      kind: 'run',
      cancel: new AbortController(),
      cancelRequested: false,
      cancelReason: 'cancelled',
      proc: undefined,
      done: Promise.resolve(current),
    };
    this.active.set(runId, entry);
    entry.done = this.track(runId, this.execute(entry, options).catch((err: unknown) => this.onUnexpected(entry, err)));
    this.publishStatus();
    return { runId, done: entry.done };
  }

  // ---------------------------------------------------------------------------
  // Cancel (Spec §13)

  /**
   * Cancel a run: persist `cancelling`, stop the process group (SIGTERM →
   * grace → SIGKILL → confirmed), run `on_cancel`, end as `cancelled`.
   * Resolves with the final run. If the group cannot be terminated the run
   * stays `cancelling`, the failure is persisted and `kill_failed` is thrown
   * (calling again retries).
   */
  async cancelRun(runId: string, options: { reason?: string } = {}): Promise<RunRecord> {
    const entry = this.beginCancel(runId, options.reason ?? 'cancelled by user');
    if (!entry) return this.repos.runs.require(runId);
    if (entry.proc) await this.cancelProcess(entry);
    return entry.done;
  }

  /**
   * Synchronous variant for the API (HTTP 202/409): validates and persists the
   * cancel request (`cancelling`) and stops the process in the background.
   * Throws the same errors as {@link cancelRun}; a later kill failure is only
   * visible on the run (`run.cancel_failed`, `error.code = kill_failed`).
   */
  requestCancel(runId: string, options: { reason?: string } = {}): { runId: string; status: TechnicalStatus } {
    const entry = this.beginCancel(runId, options.reason ?? 'cancelled by user');
    if (entry?.proc) {
      this.cancelProcess(entry).catch(() => {
        /* persisted as run.cancel_failed */
      });
    }
    return { runId, status: this.repos.runs.require(runId).status };
  }

  /** Validate + persist a cancel request; `null` if the run was finalized directly (never started). */
  private beginCancel(runId: string, reason: string): ActiveRun | null {
    const run = this.repos.runs.require(runId);
    if (isTerminalStatus(run.status)) {
      throw new RunControllerError('run_not_active', `Run ${runId} already finished (${run.status})`, { runId, status: run.status });
    }
    const entry = this.active.get(runId);
    if (run.status === 'finalizing' || run.status === 'recovery_pending' || entry?.kind === 'recovery') {
      const what = entry?.kind === 'recovery' ? `'${run.status}' (being recovered)` : `'${run.status}'`;
      throw new RunControllerError('run_not_cancellable', `Run ${runId} is ${what} and cannot be cancelled`, {
        runId,
        status: run.status,
      });
    }
    if (!entry) {
      if (run.status === 'reserved') {
        // Reserved but never handed to startRun: nothing ran, nothing to undo.
        this.finalizeUnstarted(runId, reason);
        return null;
      }
      throw new RunControllerError('run_not_controlled', `Run ${runId} is '${run.status}' but not supervised by this controller`, {
        runId,
        status: run.status,
      });
    }
    if (!entry.cancelRequested) {
      entry.cancelRequested = true;
      entry.cancelReason = reason;
      this.repos.transaction(() => {
        const cur = this.repos.runs.require(runId);
        if (CANCELLABLE_TO_CANCELLING.includes(cur.status)) this.repos.runs.transition(runId, 'cancelling');
        this.repos.events.append(runId, RUN_EVENTS.cancelRequested, { reason });
      });
      this.publisher.flush();
      entry.cancel.abort(new Error(reason));
    }
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Shutdown (Spec §14)

  /** Drain: no new runs, wait for all active runs, then stop. */
  drain(): Promise<ShutdownResult> {
    return this.shutdown({ mode: 'drain' });
  }

  /** Cancel all runs (with `on_cancel`), then stop. */
  cancelAllAndShutdown(reason = 'cancelled by shutdown'): Promise<ShutdownResult> {
    return this.shutdown({ mode: 'cancel', reason });
  }

  /**
   * Shutdown. The first call starts it; later calls return the same promise
   * but ESCALATE a running shutdown: `mode: 'cancel'` turns a drain into
   * cancel-all, and stricter `drainTimeoutMs` / `cancelTimeoutMs` (counted
   * from the later call) replace looser ones – e.g. API drain followed by
   * SIGTERM with timeouts, or a second SIGTERM → `mode: 'cancel'`.
   *
   * SIGTERM recommendation (WI-10): `shutdown({mode: 'drain', drainTimeoutMs, cancelTimeoutMs})`
   * – drain with timeout, then cancel-all, then interrupt remaining hooks.
   * A running recovery is awaited before anything stops.
   */
  shutdown(options: ShutdownOptions = {}): Promise<ShutdownResult> {
    const now = this.clock.now().getTime();
    const st = this.shutdownState;
    if (!st || !this.shuttingDown) {
      const state: ShutdownState = {
        mode: options.mode ?? 'drain',
        drainDeadline: options.drainTimeoutMs !== undefined ? now + options.drainTimeoutMs : undefined,
        cancelTimeoutMs: options.cancelTimeoutMs,
        cancelDeadline: undefined,
        reason: options.reason,
      };
      this.shutdownState = state;
      this.shuttingDown = this.doShutdown(state);
      return this.shuttingDown;
    }
    if (options.mode === 'cancel' && st.mode === 'drain') {
      st.mode = 'cancel';
      if (options.reason !== undefined) st.reason = options.reason;
    }
    if (options.drainTimeoutMs !== undefined) st.drainDeadline = minDefined(st.drainDeadline, now + options.drainTimeoutMs);
    if (options.cancelTimeoutMs !== undefined) {
      st.cancelTimeoutMs = minDefined(st.cancelTimeoutMs, options.cancelTimeoutMs);
      if (st.cancelDeadline !== undefined) st.cancelDeadline = Math.min(st.cancelDeadline, now + options.cancelTimeoutMs);
    }
    for (const wake of [...this.shutdownWakeups]) wake();
    return this.shuttingDown;
  }

  private async doShutdown(st: ShutdownState): Promise<ShutdownResult> {
    this.draining = true;
    this.publishStatus();
    if (this.recovering) {
      // Recovery finalizes runs and runs their hooks: never stop underneath it.
      await this.recovering.catch(() => undefined);
    }
    let outcome: ShutdownResult['outcome'] = 'drained';
    while (st.mode === 'drain') {
      this.logger.info('draining: waiting for active runs', { activeRuns: this.active.size });
      const r = await this.waitIdle(this.remaining(st.drainDeadline), true);
      if (r === 'idle') break;
      if (r === 'timeout') {
        this.logger.warn('drain timeout exceeded, cancelling remaining runs', { activeRuns: this.active.size });
        st.mode = 'cancel';
      }
    }
    if (st.mode === 'cancel') {
      outcome = 'cancelled';
      this.stopping = true;
      this.publishStatus();
      if (st.cancelTimeoutMs !== undefined) st.cancelDeadline = this.clock.now().getTime() + st.cancelTimeoutMs;
      const reason = st.reason ?? 'cancelled by shutdown';
      for (const entry of [...this.active.values()]) {
        if (entry.kind !== 'run') continue;
        this.cancelRun(entry.runId, { reason }).catch((err: unknown) => {
          // finalizing runs just finish their hook; kill failures are persisted on the run.
          if (!isOrchestratorError(err, 'run_not_cancellable')) {
            this.logger.warn('cancel during shutdown failed', { runId: entry.runId, error: err });
          }
        });
      }
      for (;;) {
        const r = await this.waitIdle(this.remaining(st.cancelDeadline), true);
        if (r === 'idle') break;
        if (r === 'timeout') {
          this.logger.warn('cancel timeout exceeded, interrupting hooks (recovery resumes them)', { activeRuns: this.active.size });
          this.hookAbort.abort(new Error('controller stopping'));
          await this.waitIdle(this.options.abortSettleMs ?? 10_000);
          break;
        }
      }
    }
    this.stopping = true;
    this.publishStatus();
    const result: ShutdownResult = { outcome, leftActive: [...this.active.keys()] };
    try {
      await this.options.onStop?.(result);
    } catch (err) {
      this.logger.error('stop callback failed', { error: err });
    }
    return result;
  }

  private remaining(deadline: number | undefined): number | undefined {
    return deadline === undefined ? undefined : Math.max(0, deadline - this.clock.now().getTime());
  }

  // ---------------------------------------------------------------------------
  // Recovery (Spec §14, variant A)

  /**
   * Recover after a (crashed) previous controller. MUST run before the
   * scheduler starts; sets `ready` only at the end. Idempotent.
   */
  recover(): Promise<RecoveryReport> {
    this.recovering ??= this.doRecover();
    return this.recovering;
  }

  /**
   * Re-attempt the recovery of a `recovery_pending` run (e.g. after the
   * operator stopped the process). With `assumeGone: true` the operator
   * confirms the process is gone; nothing is signalled and the run is
   * finalized (`crashed`, or `cancelled` if it was being cancelled).
   * An unsupervised `finalizing` run (e.g. after an internal error) resumes
   * its completion hook and finishes.
   *
   * @throws RunControllerError `run_controller_not_ready` during recovery,
   *   `run_controller_not_accepting` while draining/stopping,
   *   `run_already_started` if the run is supervised, `run_not_recovery_pending`
   */
  async retryRecovery(runId: string, options: { assumeGone?: boolean } = {}): Promise<RunRecord> {
    if (!this.ready) {
      throw new RunControllerError('run_controller_not_ready', 'Recovery is still running', { runId });
    }
    if (this.draining || this.stopping) {
      throw new RunControllerError('run_controller_not_accepting', 'Controller is draining / shutting down', { runId });
    }
    const run = this.repos.runs.require(runId);
    if (this.active.has(runId)) {
      throw new RunControllerError('run_already_started', `Run ${runId} is already supervised or being recovered`, { runId });
    }
    if (run.status !== 'recovery_pending' && run.status !== 'finalizing') {
      throw new RunControllerError('run_not_recovery_pending', `Run ${runId} is '${run.status}', not 'recovery_pending'`, {
        runId,
        status: run.status,
      });
    }
    return this.trackRecovery(run, async () => {
      if (run.status === 'finalizing') await this.resumeFinalizing(run);
      else {
        await this.recoverProcessRun(run, options.assumeGone ? { gone: true, detail: 'operator confirmed the worker is gone' } : undefined);
      }
    });
  }

  /** Register a recovery job in `active`: drain waits for it, cancel refuses it, no double processing. */
  private trackRecovery(run: RunRecord, job: () => Promise<void>): Promise<RunRecord> {
    const entry: ActiveRun = {
      runId: run.id,
      kind: 'recovery',
      cancel: new AbortController(),
      cancelRequested: false,
      cancelReason: '',
      proc: undefined,
      done: Promise.resolve(run),
    };
    this.active.set(run.id, entry);
    this.publishStatus();
    entry.done = this.track(
      run.id,
      job().then(() => this.repos.runs.require(run.id)),
    );
    return entry.done;
  }

  private async doRecover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { finalized: [], pending: [], resumedActions: [], errors: [] };
    const activeRuns = this.repos.runs.listActive();
    this.logger.info('recovery started', { activeRuns: activeRuns.length });
    await Promise.all(
      activeRuns.map(async (run) => {
        try {
          await this.trackRecovery(run, () => this.recoverRun(run));
          const after = this.repos.runs.require(run.id);
          if (after.status === 'recovery_pending') {
            report.pending.push({ runId: run.id, reason: recoveryReason(after) });
          } else {
            report.finalized.push({ runId: run.id, status: after.status, detail: after.finalReason ?? '' });
          }
        } catch (err) {
          this.logger.error('recovery of run failed', { runId: run.id, error: err });
          report.errors.push({ runId: run.id, message: errorMessage(err) });
          this.appendEvent(run.id, RUN_EVENTS.controllerError, { phase: 'recovery', message: errorMessage(err) });
        }
      }),
    );
    // Finished runs with interrupted action chains (e.g. a manual retry during the crash).
    for (const runId of this.repos.actions.runIdsWithIncompleteActions()) {
      const run = this.repos.runs.get(runId);
      if (!run || !isTerminalStatus(run.status)) continue;
      try {
        await this.resumeTerminalRunActions(run);
        report.resumedActions.push(runId);
      } catch (err) {
        this.logger.error('resuming lifecycle actions failed', { runId, error: err });
        report.errors.push({ runId, message: errorMessage(err) });
      }
    }
    this.publisher.flush();
    this.ready = true;
    this.logger.info('recovery finished', {
      finalized: report.finalized.length,
      pending: report.pending.length,
      resumedActions: report.resumedActions.length,
      errors: report.errors.length,
    });
    this.publishStatus();
    return report;
  }

  private async recoverRun(run: RunRecord): Promise<void> {
    switch (run.status) {
      case 'finalizing':
        await this.resumeFinalizing(run);
        return;
      case 'reserved':
        // Never handed to a worker; nothing to undo – not a technical failure.
        this.finalizeUnstarted(run.id, 'controller restarted before the run was started');
        this.recordRecovered(run.id, 'finalized', 'reserved run was never started');
        return;
      case 'starting':
      case 'running':
      case 'cancelling':
      case 'recovery_pending':
        await this.recoverProcessRun(run);
        return;
      default:
        return;
    }
  }

  /** Runs that may have a worker process: verify/terminate it, then finalize or mark `recovery_pending`. */
  private async recoverProcessRun(run: RunRecord, forced?: ProcessCheck): Promise<void> {
    const snapshot = tryParseSnapshot(run);
    const previous = previousStatus(run);
    const check = forced ?? (await this.checkProcess(run, snapshot));
    if (!check.gone) {
      this.markRecoveryPending(run, previous, check.reason);
      return;
    }
    const started = this.reachedStarting(run.id);
    if (snapshot) await this.makeActionsSafe(run.id, { abandonOnStart: true });
    const neverStarted = previous === 'reserved' || (!started && previous === 'cancelling');
    const target: FinalizationTarget =
      previous === 'cancelling' || neverStarted
        ? { status: 'cancelled', businessResult: null, reason: `cancelled (recovery: ${check.detail})` }
        : { status: 'crashed', businessResult: null, reason: `controller restart: ${check.detail}` };
    this.recordRecovered(run.id, target.status, check.detail);
    await this.finalize(run.id, snapshot, target, {
      hooks: started && snapshot !== null,
      update: { error: { code: 'recovered', message: check.detail, previousStatus: previous } },
    });
  }

  private async checkProcess(run: RunRecord, snapshot: WorkflowSnapshot | null): Promise<ProcessCheck> {
    const identity = run.processStartIdentity;
    if (identity) {
      const grace = this.options.recoveryGraceMs ?? snapshot?.workflow.execute.cancelGraceMs ?? 10_000;
      const result = await terminateProcessGroupIfSame(identity, grace, {
        ...(this.options.processInspector ? { inspector: this.options.processInspector } : {}),
        ...(this.options.kill ? { kill: this.options.kill } : {}),
        timers: this.timers,
        killConfirmMs: this.options.recoveryKillConfirmMs ?? 5_000,
      });
      switch (result) {
        case 'terminated':
          return { gone: true, detail: `orphaned worker (pid ${identity.pid}) terminated after verifying its start identity` };
        case 'gone':
          return { gone: true, detail: `worker (pid ${identity.pid}) no longer running` };
        case 'not_same':
          // The PID belongs to another process now. If a group with the old PGID still
          // exists we cannot tell whose it is: never signal, never assume it is gone.
          return this.groupExists(identity.pgid)
            ? { gone: false, reason: `pid ${identity.pid} now belongs to a different process and process group ${identity.pgid} exists; identity cannot be verified` }
            : { gone: true, detail: `worker (pid ${identity.pid}) gone, pid reused by another process` };
        case 'group_alive_unverifiable':
          return { gone: false, reason: `worker leader (pid ${identity.pid}) is gone but members of process group ${identity.pgid} are alive and cannot be verified` };
        case 'kill_failed':
          return { gone: false, reason: `worker process group ${identity.pgid} could not be terminated` };
        case 'unknown':
          return { gone: false, reason: `start identity of pid ${identity.pid} could not be determined` };
      }
    }
    if (run.pid !== null) {
      return this.groupExists(run.pid)
        ? { gone: false, reason: `no start identity was persisted for pid ${run.pid} and its process group exists` }
        : { gone: true, detail: `worker (pid ${run.pid}) no longer running` };
    }
    if (this.spawnAttempted(run.id)) {
      return { gone: false, reason: 'the worker may have been spawned but its pid was not persisted' };
    }
    return { gone: true, detail: 'no worker process had been started' };
  }

  private markRecoveryPending(run: RunRecord, previous: TechnicalStatus, reason: string): void {
    const firstTime = run.status !== 'recovery_pending';
    const error = {
      code: 'recovery_failed',
      message: reason,
      previousStatus: previous,
      pid: run.pid,
      at: this.clock.now().toISOString(),
    };
    this.repos.transaction(() => {
      if (firstTime) this.repos.runs.transition(run.id, 'recovery_pending', { update: { error } });
      else this.repos.runs.update(run.id, { error });
      this.repos.events.append(run.id, RUN_EVENTS.recoveryFailed, { reason, previousStatus: previous, pid: run.pid, repeated: !firstTime });
      if (firstTime) {
        const payload = {
          runId: run.id,
          workflowId: run.workflowId,
          sourceItemKey: run.sourceItemKey,
          sourceUrl: run.sourceUrl,
          pid: run.pid,
          previousStatus: previous,
          reason,
        };
        this.repos.afterCommit(() => this.notify('recovery_failed', payload));
      }
    });
    this.publisher.flush();
    this.logger.error('recovery failed: run kept as recovery_pending (lock held)', { runId: run.id, reason });
  }

  private async resumeFinalizing(run: RunRecord): Promise<void> {
    const snapshot = tryParseSnapshot(run);
    const started = this.reachedStarting(run.id);
    if (snapshot) await this.makeActionsSafe(run.id, { abandonOnStart: true });
    this.recordRecovered(run.id, 'resumed', 'resuming finalization');
    await this.completeFinalization(run.id, snapshot, { hooks: started && snapshot !== null });
  }

  private async resumeTerminalRunActions(run: RunRecord): Promise<void> {
    if (!tryParseSnapshot(run)) return;
    await this.makeActionsSafe(run.id, { abandonOnStart: true });
    await this.lifecycle.resumeIncomplete(run.id, { hooks: HOOK_NAMES.filter((h) => h !== 'on_start'), wait: true });
    this.publisher.flush();
  }

  /** Actions left `running` → safe state (WI-07); optionally drop the rest of an interrupted `on_start`. */
  private async makeActionsSafe(runId: string, options: { abandonOnStart: boolean }): Promise<void> {
    const journal = this.repos.actions.listForRun(runId);
    if (journal.some((a) => a.status === 'running')) {
      await this.lifecycle.resumeIncomplete(runId, { hooks: [], wait: true });
    }
    if (options.abandonOnStart && journal.some((a) => a.hook === 'on_start' && (a.status === 'pending' || a.status === 'running'))) {
      await this.lifecycle.abandonHook(runId, 'on_start', { wait: true });
    }
    this.publisher.flush();
  }

  // ---------------------------------------------------------------------------
  // Run execution

  private async execute(entry: ActiveRun, options: StartRunOptions): Promise<RunRecord> {
    const { runId } = entry;
    const run = this.repos.runs.require(runId);
    let snapshot: WorkflowSnapshot;
    try {
      snapshot = parseRunSnapshot(run.configSnapshot, runId);
    } catch (err) {
      return this.finalize(runId, null, startError('invalid configuration snapshot'), { hooks: false, update: { error: errorInfo(err) } });
    }

    // 1. Re-read the item before on_start (Spec §7 race).
    let item: SourceItem | null = null;
    let adapter: SourceAdapter | undefined;
    if (run.sourceItemKey) {
      const { sourceId, itemId } = parseSourceItemKey(run.sourceItemKey);
      adapter = this.options.sources(run.sourceId ?? sourceId);
      if (!adapter) {
        return this.finalize(runId, snapshot, startError(`source '${run.sourceId ?? sourceId}' is not available`), { hooks: false });
      }
      try {
        item = await adapter.getItem(itemId, { signal: entry.cancel.signal });
      } catch (err) {
        if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: false });
        return this.finalize(runId, snapshot, startError(`item could not be re-read: ${errorMessage(err)}`), {
          hooks: false,
          update: { error: errorInfo(err) },
        });
      }
      if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: false });
      let matches = item !== null;
      if (item && options.verifyItem) {
        try {
          matches = await options.verifyItem(item);
        } catch (err) {
          this.logger.warn('item verification failed', { runId, error: err });
          matches = false;
        }
      }
      this.appendEvent(runId, RUN_EVENTS.itemReread, { found: item !== null, matches });
      if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: false });
      if (!item) return this.finalize(runId, snapshot, cancelled('item no longer available'), { hooks: false });
      if (!matches) return this.finalize(runId, snapshot, cancelled('item no longer matches the workflow'), { hooks: false });
    }
    if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: false });

    // 1b. Linked branch / PR (WI-21): resolved freshly when the workflow uses them; a used but unknown
    // placeholder ends the run as start_error BEFORE on_start (nothing was changed at the item yet).
    let linked: Record<string, FieldResolution> | undefined;
    const usage = linkedFieldUsage(snapshot);
    if (item && adapter && usage.resolve) {
      const provided = new Set(adapter.fieldDefinitions().map((d) => d.name));
      const names = LINKED_ITEM_FIELDS.filter((f) => provided.has(f));
      if (names.length > 0) {
        try {
          linked = await adapter.resolveFields(item, names, { signal: entry.cancel.signal });
        } catch (err) {
          if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: false });
          const reason = `linked fields could not be resolved: ${errorMessage(err)}`;
          linked = Object.fromEntries(names.map((n) => [n, { known: false, reason }]));
        }
        const known = names.filter((n) => linked?.[n]?.known === true);
        this.appendEvent(runId, RUN_EVENTS.linkedResolved, { known, unknown: names.filter((n) => !known.includes(n)) });
      }
      if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: false });
      const missing = unknownLinkedField(usage.templates, linked);
      if (missing) {
        const message = `{${missing.placeholder}} is unknown: ${missing.reason}`;
        return this.finalize(runId, snapshot, startError(message), {
          hooks: false,
          update: { error: { code: 'run_linked_field_unknown', message, field: missing.field } },
        });
      }
    }

    // 2. starting + on_start.
    this.repos.runs.transition(runId, 'starting', { expectedFrom: 'reserved' });
    this.publisher.flush();
    const startedAt = this.clock.now();
    const ctx = { item };
    if (hasActions(snapshot, 'on_start')) {
      let result: HookResult | undefined;
      let hookError: unknown;
      try {
        result = await this.lifecycle.runHook(runId, 'on_start', snapshot, {
          ...(item ? { item } : {}),
          signal: AbortSignal.any([entry.cancel.signal, this.hookAbort.signal]),
          wait: true,
        });
      } catch (err) {
        hookError = err;
      }
      this.publisher.flush();
      if (entry.cancelRequested || result?.status === 'interrupted') {
        await this.makeActionsSafe(runId, { abandonOnStart: true });
        return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: true, ...ctx });
      }
      if (hookError !== undefined || result?.status === 'failed') {
        // Decision (WI-08): a stopped on_start chain means the item was not (fully) claimed –
        // the worker is NOT started and the run ends as `start_error` (technical, counted) with on_start_error.
        // The remaining on_start actions must never run once the run moved on (a later manual
        // skip of the failed action would otherwise continue the chain on a finished run).
        await this.makeActionsSafe(runId, { abandonOnStart: true });
        const name = result?.failedAction ? (result.failedAction.name ?? String(result.failedAction.id)) : null;
        const reason = hookError !== undefined ? `on_start failed: ${errorMessage(hookError)}` : `on_start action '${name}' failed`;
        return this.finalize(runId, snapshot, startError(reason), {
          hooks: true,
          ...ctx,
          ...(hookError !== undefined ? { update: { error: errorInfo(hookError) } } : {}),
        });
      }
    }
    if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: true, ...ctx });

    // 3. Workspace, context, secrets.
    let prepared: Awaited<ReturnType<typeof buildExecutionSpec>>;
    try {
      prepared = await buildExecutionSpec({
        run: this.repos.runs.require(runId),
        snapshot,
        item,
        ...(adapter?.repository ? { repository: adapter.repository } : {}),
        dataDir: this.options.dataDir,
        startedAt,
        now: this.clock.now(),
        ...(this.options.credentials ? { credentials: this.options.credentials } : {}),
        ...(this.maxLogBytes() !== undefined ? { maxLogBytes: this.maxLogBytes() } : {}),
        signal: entry.cancel.signal,
        ...(linked ? { linked } : {}),
      });
    } catch (err) {
      if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: true, ...ctx });
      return this.finalize(runId, snapshot, startError(`worker could not be prepared: ${errorMessage(err)}`), {
        hooks: true,
        ...ctx,
        update: { error: errorInfo(err) },
      });
    }
    if (entry.cancelRequested) return this.finalize(runId, snapshot, cancelled(entry.cancelReason), { hooks: true, ...ctx });

    // 4. Spawn. Persist the intent first: recovery must know a process may exist.
    const { spec } = prepared;
    this.repos.transaction(() => {
      this.repos.runs.update(runId, { workspacePath: spec.workingDirectory, command: { command: spec.command, args: spec.args } });
      this.repos.events.append(runId, RUN_EVENTS.spawn, {
        command: spec.command,
        args: [...spec.args],
        workingDirectory: spec.workingDirectory,
      });
    });
    this.publisher.flush();
    const executor = this.options.createExecutor
      ? this.options.createExecutor({ workspaceBaseDir: prepared.workspaceBaseDir })
      : new ShellExecutor({
          clock: this.clock,
          logger: this.logger,
          ...(prepared.workspaceBaseDir !== undefined ? { workspaceBaseDir: prepared.workspaceBaseDir } : {}),
        });
    let proc: RunningProcess;
    try {
      proc = await executor.start(spec);
    } catch (err) {
      return this.finalize(runId, snapshot, startError(`worker could not be started: ${errorMessage(err)}`), {
        hooks: true,
        ...ctx,
        update: { error: errorInfo(err) },
      });
    }
    entry.proc = proc;
    // Subscribe before yielding to the event loop (no output is missed).
    proc.onOutput((chunk) =>
      this.bus.publish({ type: 'run.output', runId, stream: chunk.stream, data: chunk.data, at: chunk.at.toISOString() }),
    );
    proc.onEvent((event) => {
      try {
        this.repos.events.appendWorkerEvent(runId, event);
        this.publisher.flush();
      } catch (err) {
        this.logger.warn('persisting worker event failed', { runId, error: err });
      }
    });
    proc.onDiagnostic((diagnostic) => {
      try {
        this.repos.events.appendDiagnostic(runId, diagnostic);
        this.publisher.flush();
      } catch (err) {
        this.logger.warn('persisting executor diagnostic failed', { runId, error: err });
      }
    });
    if (proc.pid !== undefined) {
      const update: RunUpdate = { pid: proc.pid, processStartIdentity: proc.startIdentity ?? null };
      const cur = this.repos.runs.require(runId);
      if (cur.status === 'starting') this.repos.runs.transition(runId, 'running', { expectedFrom: 'starting', update });
      else this.repos.runs.update(runId, { ...update, startedAt: this.clock.now() });
      this.publisher.flush();
      if (!proc.startIdentity) this.logger.warn('worker start identity unavailable; recovery will not signal it', { runId, pid: proc.pid });
    }
    if (entry.cancelRequested) {
      this.cancelProcess(entry).catch(() => {
        /* persisted as run.cancel_failed */
      });
    }

    // 5. Outcome.
    const outcome = await proc.wait();
    const classification = classifyOutcome(outcome);
    const target: FinalizationTarget =
      classification.status === 'cancelled'
        ? cancelled(entry.cancelReason)
        : { status: classification.status, businessResult: classification.businessResult, reason: classification.reason };
    return this.finalize(runId, snapshot, target, {
      hooks: true,
      ...ctx,
      update: {
        exitCode: outcome.exitCode,
        result: classification.result,
        ...(classification.status !== 'completed' || outcome.logs.truncated ? { error: outcomeError(outcome, classification.reason) } : {}),
      },
    });
  }

  private async cancelProcess(entry: ActiveRun): Promise<void> {
    const proc = entry.proc;
    if (!proc) return;
    try {
      await proc.cancel();
    } catch (err) {
      const message = errorMessage(err);
      this.repos.transaction(() => {
        this.repos.events.append(entry.runId, RUN_EVENTS.cancelFailed, { message });
        this.repos.runs.update(entry.runId, { error: { code: 'kill_failed', message } });
      });
      this.publisher.flush();
      this.logger.error('cancel failed: process group could not be terminated', { runId: entry.runId, error: err });
      throw new RunControllerError('kill_failed', `Run ${entry.runId}: process group could not be terminated (${message})`, {
        runId: entry.runId,
      }, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Finalization

  /**
   * `→ finalizing` (target, counter and block in ONE transaction), then the
   * completion hook, workspace cleanup and `→ <terminal>` (lock released).
   */
  private async finalize(
    runId: string,
    snapshot: WorkflowSnapshot | null,
    target: FinalizationTarget,
    options: FinalizeOptions,
  ): Promise<RunRecord> {
    this.beginFinalization(runId, snapshot, target, options.update);
    return this.completeFinalization(runId, snapshot, options);
  }

  private beginFinalization(runId: string, snapshot: WorkflowSnapshot | null, target: FinalizationTarget, update?: RunUpdate): void {
    this.repos.transaction(() => {
      const res = this.repos.runs.beginFinalization(runId, target, {
        ...(update ? { update } : {}),
        ...(snapshot ? { blockPolicy: { maxTechnicalFailures: snapshot.workflow.retry.maxTechnicalFailures } } : {}),
      });
      const block = res.blockCreated;
      if (block) {
        const run = res.run;
        const payload = {
          blockId: block.id,
          workflowId: block.workflowId,
          itemKey: block.itemKey,
          reason: block.reason,
          failureCount: block.failureCount,
          runId: run.id,
          sourceUrl: run.sourceUrl,
          affectedRunIds: this.repos.blocks.affectedRunIds(block.id),
        };
        this.repos.afterCommit(() => {
          this.publisher.flush(); // the run's `→ finalizing` status event (with blockId) first
          this.bus.publish({ type: 'block.created', block });
          this.notify('retry_block_created', payload);
        });
      }
    });
    this.publisher.flush();
  }

  private async completeFinalization(runId: string, snapshot: WorkflowSnapshot | null, options: FinalizeOptions): Promise<RunRecord> {
    const run = this.repos.runs.require(runId);
    const target = finalizationTarget(run);
    if (run.status !== 'finalizing' || !target) return run;
    if (options.hooks && snapshot) {
      const hook = hookForOutcome(target.status, target.businessResult);
      if (hasActions(snapshot, hook)) {
        try {
          const result = await this.lifecycle.runHook(runId, hook, snapshot, {
            ...(options.item ? { item: options.item } : {}),
            signal: this.hookAbort.signal,
            wait: true,
          });
          this.publisher.flush();
          // Interrupted by a forced stop: stay `finalizing`, recovery resumes the chain.
          if (result.status === 'interrupted') return this.repos.runs.require(runId);
        } catch (err) {
          this.publisher.flush();
          if (this.hookAbort.signal.aborted) return this.repos.runs.require(runId);
          this.logger.error('completion hook failed unexpectedly', { runId, hook, error: err });
          this.appendEvent(runId, RUN_EVENTS.hookError, { hook, message: errorMessage(err) });
        }
      }
    }
    if (snapshot) await this.cleanupWorkspace(runId, snapshot, target.status, target.businessResult);
    const finished = this.repos.runs.finish(runId);
    this.publisher.flush();
    return finished;
  }

  /** Finalize a run that never reached `starting`: `cancelled`, not counted, no hooks (synchronous). */
  private finalizeUnstarted(runId: string, reason: string): void {
    this.repos.transaction(() => {
      this.repos.runs.beginFinalization(runId, cancelled(reason));
      this.repos.runs.finish(runId);
    });
    this.publisher.flush();
  }

  private async cleanupWorkspace(runId: string, snapshot: WorkflowSnapshot, status: TerminalStatus, result: BusinessResult): Promise<void> {
    const run = this.repos.runs.require(runId);
    if (!run.workspacePath || !shouldCleanupWorkspace(snapshot.workspace.cleanup, status, result)) return;
    const removal = await removeWorkspace(snapshot.workspace.baseDir, run.workspacePath);
    if (!removal.removed && removal.reason !== 'missing') {
      this.logger.warn('workspace not removed', { runId, ...removal });
    }
    this.appendEvent(runId, RUN_EVENTS.workspaceCleanup, { ...removal, policy: snapshot.workspace.cleanup });
  }

  // ---------------------------------------------------------------------------
  // Helpers

  private track(runId: string, promise: Promise<RunRecord>): Promise<RunRecord> {
    return promise.finally(() => {
      this.active.delete(runId);
      this.publishStatus();
      if (this.active.size === 0) {
        for (const resolve of [...this.idleWaiters]) resolve();
      }
    });
  }

  /**
   * `idle` once no run is supervised, `timeout` after `timeoutMs`, `woken`
   * (only with `wakeable`) when a running shutdown was escalated.
   */
  private waitIdle(timeoutMs?: number, wakeable = false): Promise<'idle' | 'timeout' | 'woken'> {
    if (this.active.size === 0) return Promise.resolve('idle');
    return new Promise((resolve) => {
      let timer: ReturnType<Timers['setTimeout']> | undefined;
      const finish = (value: 'idle' | 'timeout' | 'woken'): void => {
        this.idleWaiters.delete(onIdle);
        this.shutdownWakeups.delete(onWake);
        if (timer) this.timers.clearTimeout(timer);
        resolve(value);
      };
      const onIdle = (): void => finish('idle');
      const onWake = (): void => finish('woken');
      this.idleWaiters.add(onIdle);
      if (wakeable) this.shutdownWakeups.add(onWake);
      if (timeoutMs !== undefined) timer = this.timers.setTimeout(() => finish(this.active.size === 0 ? 'idle' : 'timeout'), timeoutMs);
    });
  }

  /**
   * Unexpected internal error while supervising a run: never finalize blindly
   * (the worker may still run). Where the state machine allows it the run
   * becomes `recovery_pending` (lock kept, error, `recovery_failed`
   * notification); a `finalizing` run stays as is. The entry stays supervised
   * until a started worker process ended; then `retryRecovery` resolves the run.
   */
  private async onUnexpected(entry: ActiveRun, err: unknown): Promise<RunRecord> {
    const runId = entry.runId;
    this.logger.error('unexpected error while supervising run', { runId, error: err });
    this.appendEvent(runId, RUN_EVENTS.controllerError, { message: errorMessage(err) });
    try {
      const run = this.repos.runs.require(runId);
      if (CAN_BECOME_RECOVERY_PENDING.includes(run.status)) {
        this.markRecoveryPending(run, run.status, `internal error while supervising the run: ${errorMessage(err)}`);
      }
    } catch (inner) {
      this.logger.error('could not mark run as recovery_pending', { runId, error: inner });
    }
    if (entry.proc) await entry.proc.wait().catch(() => undefined);
    return this.repos.runs.require(runId);
  }

  private appendEvent(runId: string, type: string, payload: Record<string, unknown>): void {
    try {
      this.repos.events.append(runId, type, payload);
      this.publisher.flush();
    } catch (err) {
      this.logger.warn('persisting run event failed', { runId, type, error: err });
    }
  }

  private recordRecovered(runId: string, action: string, detail: string): void {
    this.appendEvent(runId, RUN_EVENTS.recovered, { action, detail });
  }

  private reachedStarting(runId: string): boolean {
    return this.repos.events
      .listForRun(runId)
      .some((e) => e.type === RUN_STATUS_EVENT && e.payload.to === 'starting');
  }

  private spawnAttempted(runId: string): boolean {
    return this.repos.events.listForRun(runId).some((e) => e.type === RUN_EVENTS.spawn);
  }

  private groupExists(pgid: number): boolean {
    return (this.options.groupExists ?? processGroupExists)(pgid);
  }

  private maxLogBytes(): number | undefined {
    const v = this.options.maxLogBytesPerRun;
    return typeof v === 'function' ? v() : v;
  }

  private notify(type: 'retry_block_created' | 'recovery_failed', payload: Record<string, unknown>): void {
    try {
      this.options.notifier?.notify(type, payload);
    } catch (err) {
      this.logger.error('notification failed', { type, error: err });
    }
  }

  private publishStatus(): void {
    this.bus.publish({ type: 'system.status', status: this.status });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers

function minDefined(a: number | undefined, b: number): number {
  return a === undefined ? b : Math.min(a, b);
}

function hasActions(snapshot: WorkflowSnapshot, hook: HookName): boolean {
  return (snapshot.workflow.hooks[hook] ?? []).length > 0;
}

function startError(reason: string): FinalizationTarget {
  return { status: 'start_error', businessResult: null, reason };
}

function cancelled(reason: string): FinalizationTarget {
  return { status: 'cancelled', businessResult: null, reason };
}

function tryParseSnapshot(run: RunRecord): WorkflowSnapshot | null {
  try {
    return parseRunSnapshot(run.configSnapshot, run.id);
  } catch {
    return null;
  }
}

/** Status before `recovery_pending` (persisted in `error.previousStatus`). */
function previousStatus(run: RunRecord): TechnicalStatus {
  if (run.status !== 'recovery_pending') return run.status;
  const prev = (run.error as { previousStatus?: unknown } | null)?.previousStatus;
  return typeof prev === 'string' ? (prev as TechnicalStatus) : 'running';
}

function recoveryReason(run: RunRecord): string {
  const message = (run.error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'recovery failed';
}

function errorInfo(err: unknown): Record<string, unknown> {
  return {
    code: isOrchestratorError(err) ? err.code : 'error',
    message: errorMessage(err),
  };
}

function outcomeError(outcome: ExecutionOutcome, reason: string): Record<string, unknown> {
  return {
    code: 'worker_outcome',
    message: reason,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),
    logsTruncated: outcome.logs.truncated,
  };
}
