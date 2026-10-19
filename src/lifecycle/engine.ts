/**
 * Lifecycle engine (Spec §10): journaled, sequential hook chains with
 * per-action retries, manual retry/skip, chain continuation and recovery.
 *
 * Invariants:
 * - Every action state change is persisted before work continues
 *   (journal = `run_actions`, every attempt = `action_attempts`).
 * - `succeeded`/`skipped` actions are never executed again.
 * - Hooks always use the run's configuration snapshot (journal
 *   `action_config_json` + `runs.config_snapshot`), never the live config.
 * - Notifications and change callbacks are published only after commit.
 */
import {
  commentMarker,
  noopLogger,
  sleep,
  systemClock,
  systemTimers,
  type Clock,
  type CredentialProvider,
  type Executor,
  type HookName,
  type LifecycleStatus,
  type Logger,
  type Notifier,
  type SourceItem,
  type Timers,
  type Redactor,
} from '../core/index.js';
import type { LifecycleActionConfig, RetryPolicy, WorkflowSnapshot } from '../config/index.js';
import { ShellExecutor } from '../executors/index.js';
import type { Repositories, RunActionRecord, RunRecord } from '../persistence/index.js';
import { parseRunSnapshot, resolveActionIdentity } from './context.js';
import { LifecycleBusyError, LifecycleError, describeActionError, type ActionErrorInfo } from './errors.js';
import {
  performShell,
  performSourceComment,
  performSourceUpdate,
  resolveSourceTarget,
  type AttemptInput,
  type AttemptResult,
  type PerformerDeps,
  type SourceResolver,
} from './performers.js';

/** Event type persisted in `run_events` for every action state change. */
export const LIFECYCLE_ACTION_EVENT = 'lifecycle.action';
/** Event type persisted in `run_events` when a hook chain starts/ends. */
export const LIFECYCLE_CHAIN_EVENT = 'lifecycle.chain';

/** Default retry policy if a journaled action carries none (Spec §5.1: 3 × 30 s). */
export const DEFAULT_ACTION_RETRY: RetryPolicy = { maxAttempts: 3, delayMs: 30_000 };

/** Outcome of executing (or continuing) one hook chain. */
export interface HookResult {
  runId: string;
  hook: HookName;
  /**
   * - `succeeded`: every action is `succeeded`/`skipped` or failed with `continue_on_error`.
   * - `failed`: the chain stopped at {@link HookResult.failedAction}; later actions stay `pending`.
   * - `interrupted`: aborted via signal; the current action was reset to `pending` (resumable).
   */
  status: 'succeeded' | 'failed' | 'interrupted';
  /** Final journal state of the hook (ordinal order). */
  actions: RunActionRecord[];
  /** Action that stopped the chain (`status === 'failed'`). */
  failedAction: RunActionRecord | null;
}

/** Per-call options. */
export interface HookContext {
  /**
   * Freshly read source item (WI-08 re-reads it before starting, Spec §7).
   * Optional: if missing, source actions read the item via the adapter.
   */
  item?: SourceItem;
  /** Aborts retry delays and running shell actions (shutdown). */
  signal?: AbortSignal;
  /**
   * If another chain of the same run is executing: `true` = queue behind it
   * (internal callers, e.g. WI-08 `runHook` while a manual retry runs);
   * default `false` = reject immediately with {@link LifecycleBusyError} (API calls).
   */
  wait?: boolean;
}

/** Payload of the `lifecycle_action_failed` notification. */
export interface LifecycleActionFailedPayload extends Record<string, unknown> {
  runId: string;
  workflowId: string;
  hook: HookName;
  actionId: number;
  actionName: string | null;
  actionType: string;
  ordinal: number;
  attempts: number;
  error: ActionErrorInfo | null;
  sourceItemKey: string | null;
  sourceUrl: string | null;
}

/** Dependencies of {@link LifecycleEngine}. */
export interface LifecycleEngineOptions {
  /** Persistence (WI-03). */
  repositories: Pick<Repositories, 'runs' | 'actions' | 'events' | 'transaction' | 'afterCommit'>;
  /** Source adapters by configured source ID. */
  sources: SourceResolver;
  /** Data directory (context/log files of `shell` actions below `runs/<id>/actions`, `logs/<id>/actions`). */
  dataDir: string;
  /** Executor for `shell` actions; default `new ShellExecutor({ clock, logger })` (minimal env, no controller env). */
  executor?: Executor;
  clock?: Clock;
  /** Timers for retry delays (FakeClock in tests). */
  timers?: Timers;
  logger?: Logger;
  /** Receives `lifecycle_action_failed` after commit (delivery: WI-10). Must not throw/block. */
  notifier?: Notifier;
  /** Called after commit for every persisted action change (event bus / SSE in WI-08/WI-10). */
  onActionChange?: (action: RunActionRecord) => void;
  /** Best-effort redaction of persisted error texts (e.g. `SecretRedactor.asRedactor`). */
  redact?: Redactor;
  /** SIGTERM → SIGKILL grace for `shell` actions. Default 5 s. */
  shellCancelGraceMs?: number;
  /** Log limit per `shell` action attempt (stdout + stderr). Default 10 MiB. */
  maxShellLogBytes?: number;
  /** Token source for `secrets` of `shell` actions (WI-18). */
  credentials?: CredentialProvider;
  /** Tuning of token files of `shell` actions (`delivery: file`, WI-18); tests only. */
  tokenFiles?: { renewBeforeMs?: number; retryDelayMs?: number; maxRetryDelayMs?: number };
}

interface ChainOptions {
  item: SourceItem | undefined;
  signal: AbortSignal | undefined;
  snapshot: WorkflowSnapshot;
}

type ActionOutcome = 'succeeded' | 'failed' | 'interrupted';

/** See module docs. One instance per process; chains of one run never execute concurrently. */
export class LifecycleEngine {
  private readonly repos: LifecycleEngineOptions['repositories'];
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly redact: Redactor;
  private readonly performerDeps: PerformerDeps;
  /** Tail of the per-run execution queue (present while a chain of the run runs or waits). */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly options: LifecycleEngineOptions) {
    this.repos = options.repositories;
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = options.logger ?? noopLogger;
    this.redact = options.redact ?? ((s) => s);
    this.performerDeps = {
      sources: options.sources,
      executor: options.executor ?? new ShellExecutor({ clock: this.clock, logger: this.logger }),
      dataDir: options.dataDir,
      shellCancelGraceMs: options.shellCancelGraceMs ?? 5_000,
      maxShellLogBytes: options.maxShellLogBytes ?? 10 * 1024 * 1024,
      credentials: options.credentials,
      clock: this.clock,
      timers: this.timers,
      logger: this.logger,
      tokenFiles: options.tokenFiles ?? {},
    };
  }

  /** True while a chain of `runId` is executing in this process. */
  isBusy(runId: string): boolean {
    return this.tails.has(runId);
  }

  /**
   * Run hook `hook` of a run: creates the journal for all actions of the hook
   * from the snapshot (stable IDs, ordinals, `action_config_json`) and
   * executes them sequentially. Idempotent/resumable: an existing journal is
   * reused and only `pending` actions run (a `failed` action without
   * `continue_on_error` keeps the chain stopped — use {@link retryAction}).
   *
   * @param snapshot defaults to `run.configSnapshot` (must be the run's snapshot, never the live config)
   * @throws LifecycleBusyError if a chain of this run is already executing
   */
  async runHook(
    run: RunRecord | string,
    hook: HookName,
    snapshot?: WorkflowSnapshot,
    context: HookContext = {},
  ): Promise<HookResult> {
    const runId = typeof run === 'string' ? run : run.id;
    return this.exclusive(runId, async () => {
      const current = this.repos.runs.require(runId);
      const snap = snapshot ?? parseRunSnapshot(current.configSnapshot, runId);
      const configs = snap.workflow.hooks[hook] ?? [];
      this.repos.actions.createJournal(
        runId,
        hook,
        configs.map((config) => ({ type: config.type, name: config.id, config })),
      );
      return this.executeChain(runId, hook, { item: context.item, signal: context.signal, snapshot: snap });
    }, context.wait);
  }

  /**
   * Manual retry (GUI "Retry Action"): the `failed` action gets a fresh round
   * of attempts (its retry policy), then the chain continues from there. The
   * main worker is not involved; `succeeded` actions are never repeated.
   *
   * @throws LifecycleError `lifecycle_not_retryable` if the action is not `failed`
   */
  async retryAction(actionId: number, context: HookContext = {}): Promise<HookResult> {
    const action = this.repos.actions.require(actionId);
    return this.exclusive(action.runId, async () => {
      const current = this.repos.actions.require(actionId);
      if (current.status !== 'failed') {
        throw new LifecycleError('not_retryable', `Action ${actionId} is '${current.status}', only failed actions can be retried`, {
          details: { actionId, status: current.status },
        });
      }
      const owner = this.repos.runs.require(current.runId);
      if (current.hook === 'on_start' && owner.status !== 'starting') {
        // The run moved on (e.g. start_error → on_start_error); replaying on_start now would
        // re-apply start labels to a finished run. Only skip/abandon are allowed.
        throw new LifecycleError(
          'not_retryable',
          `on_start action ${actionId} cannot be retried: run ${owner.id} is '${owner.status}', not 'starting' (skip it instead)`,
          { details: { actionId, hook: current.hook, runStatus: owner.status } },
        );
      }
      this.persistActionStatus(current, 'pending', { manual: 'retry' });
      const run = this.repos.runs.require(current.runId);
      const snapshot = parseRunSnapshot(run.configSnapshot, run.id);
      return this.executeChain(current.runId, current.hook, { item: context.item, signal: context.signal, snapshot });
    }, context.wait);
  }

  /**
   * Operator skips a `failed` (or `pending`) action; the chain then continues
   * after it (e.g. the operator fixed the item manually).
   */
  async skipAction(actionId: number, context: HookContext = {}): Promise<HookResult> {
    const action = this.repos.actions.require(actionId);
    return this.exclusive(action.runId, async () => {
      const current = this.repos.actions.require(actionId);
      if (current.status !== 'failed' && current.status !== 'pending') {
        throw new LifecycleError('not_skippable', `Action ${actionId} is '${current.status}' and cannot be skipped`, {
          details: { actionId, status: current.status },
        });
      }
      this.persistActionStatus(current, 'skipped', { manual: 'skip' });
      const run = this.repos.runs.require(current.runId);
      const snapshot = parseRunSnapshot(run.configSnapshot, run.id);
      return this.executeChain(current.runId, current.hook, { item: context.item, signal: context.signal, snapshot });
    }, context.wait);
  }

  /**
   * Recovery after a controller restart (WI-08, Spec §14): actions left
   * `running` are brought into a safe state, then every incomplete chain of
   * the run is continued (in journal order). Safe state:
   * - `source.comment`: marker lookup; found → `succeeded` (no duplicate), else `pending`
   *   (the next attempt looks up the marker again before posting).
   * - `source.update`: `pending` (re-applied idempotently after re-reading the item).
   * - `shell`: with an unfinished attempt the outcome is unknown and the old process
   *   may still run → `failed` (chain stops, manual retry); otherwise `pending`.
   *
   * @param options.hooks only continue these hooks (others are only made safe)
   */
  async resumeIncomplete(
    run: RunRecord | string,
    options: HookContext & { hooks?: readonly HookName[] } = {},
  ): Promise<HookResult[]> {
    const runId = typeof run === 'string' ? run : run.id;
    return this.exclusive(runId, async () => {
      const current = this.repos.runs.require(runId);
      const snapshot = parseRunSnapshot(current.configSnapshot, runId);
      for (const action of this.repos.actions.listForRun(runId)) {
        if (action.status === 'running') await this.makeSafe(action, current, snapshot, options.item);
      }
      const results: HookResult[] = [];
      for (const hook of this.hooksInOrder(runId)) {
        if (options.hooks && !options.hooks.includes(hook)) continue;
        const journal = this.repos.actions.listForHook(runId, hook);
        if (!journal.some((a) => a.status === 'pending')) continue;
        if (stoppedAt(journal)) continue; // stopped chains wait for a manual retry
        results.push(await this.executeChain(runId, hook, { item: options.item, signal: options.signal, snapshot }));
      }
      if (results.length === 0) this.refreshLifecycleStatus(runId);
      return results;
    }, options.wait);
  }

  /**
   * Abandon the rest of a hook chain (WI-08 recovery, e.g. an interrupted
   * `on_start` of a run that is now finalized as `crashed`): interrupted
   * actions are made safe (comment marker lookup), all `pending` ones become `skipped`.
   */
  async abandonHook(run: RunRecord | string, hook: HookName, context: Pick<HookContext, 'item' | 'wait'> = {}): Promise<HookResult> {
    const runId = typeof run === 'string' ? run : run.id;
    return this.exclusive(runId, async () => {
      const current = this.repos.runs.require(runId);
      const snapshot = parseRunSnapshot(current.configSnapshot, runId);
      for (const action of this.repos.actions.listForHook(runId, hook)) {
        if (action.status === 'running') await this.makeSafe(action, current, snapshot, context.item, { notify: false });
      }
      for (const action of this.repos.actions.listForHook(runId, hook)) {
        if (action.status === 'pending') this.persistActionStatus(action, 'skipped', { abandoned: true });
      }
      this.refreshLifecycleStatus(runId);
      const journal = this.repos.actions.listForHook(runId, hook);
      const stop = stoppedAt(journal);
      return { runId, hook, status: stop ? 'failed' : 'succeeded', actions: journal, failedAction: stop };
    }, context.wait);
  }

  // -------------------------------------------------------------------------
  // Chain execution

  /**
   * Serialize chain executions per run. Without `wait` a busy run is rejected
   * immediately ({@link LifecycleBusyError}, API callers); with `wait` the call
   * is queued behind the running/queued ones (internal callers such as WI-08).
   */
  private async exclusive<T>(runId: string, fn: () => Promise<T>, wait = false): Promise<T> {
    const previous = this.tails.get(runId);
    if (previous && !wait) throw new LifecycleBusyError(runId);
    const execution = (async () => {
      if (previous) await previous;
      return fn();
    })();
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(runId, tail);
    try {
      return await execution;
    } finally {
      if (this.tails.get(runId) === tail) this.tails.delete(runId);
    }
  }

  private async executeChain(runId: string, hook: HookName, opts: ChainOptions): Promise<HookResult> {
    this.repos.transaction(() => {
      this.repos.runs.update(runId, { lifecycleStatus: 'running' });
      this.repos.events.append(runId, LIFECYCLE_CHAIN_EVENT, { hook, status: 'running' });
    });
    let result: HookResult | undefined;
    try {
      result = await this.executeActions(runId, hook, opts);
      return result;
    } finally {
      const status = result?.status ?? 'failed';
      this.repos.transaction(() => {
        this.refreshLifecycleStatus(runId);
        this.repos.events.append(runId, LIFECYCLE_CHAIN_EVENT, {
          hook,
          status,
          ...(result?.failedAction ? { failedActionId: result.failedAction.id } : {}),
        });
      });
    }
  }

  private async executeActions(runId: string, hook: HookName, opts: ChainOptions): Promise<HookResult> {
    const journal = this.repos.actions.listForHook(runId, hook);
    for (const entry of journal) {
      const action = this.repos.actions.require(entry.id);
      if (action.status === 'succeeded' || action.status === 'skipped') continue;
      const config = actionConfig(action);
      if (action.status === 'failed') {
        if (config.continueOnError) continue;
        return this.hookResult(runId, hook, 'failed', action.id);
      }
      if (opts.signal?.aborted) return this.hookResult(runId, hook, 'interrupted');
      if (action.status === 'running') {
        // Left running without recovery (should not happen in-process): make it safe first.
        await this.makeSafe(action, this.repos.runs.require(runId), opts.snapshot, opts.item);
        const safe = this.repos.actions.require(action.id);
        if (safe.status === 'succeeded') continue;
        if (safe.status === 'failed') {
          if (config.continueOnError) continue;
          return this.hookResult(runId, hook, 'failed', action.id);
        }
      }
      const outcome = await this.executeAction(this.repos.actions.require(action.id), config, opts);
      if (outcome === 'interrupted') return this.hookResult(runId, hook, 'interrupted');
      if (outcome === 'failed' && !config.continueOnError) return this.hookResult(runId, hook, 'failed', action.id);
    }
    return this.hookResult(runId, hook, 'succeeded');
  }

  private hookResult(runId: string, hook: HookName, status: HookResult['status'], failedActionId?: number): HookResult {
    const actions = this.repos.actions.listForHook(runId, hook);
    return {
      runId,
      hook,
      status,
      actions,
      failedAction: failedActionId !== undefined ? (actions.find((a) => a.id === failedActionId) ?? null) : null,
    };
  }

  /** Execute one action with its retry policy. The action is `pending` on entry. */
  private async executeAction(action: RunActionRecord, config: LifecycleActionConfig, opts: ChainOptions): Promise<ActionOutcome> {
    const policy = retryPolicy(config);
    let roundAttempts = 0;
    let current = action;
    for (;;) {
      roundAttempts += 1;
      const hadPriorAttempts = current.attempts > 0;
      const attempt = this.repos.transaction(() => {
        const a = this.repos.actions.startAttempt(current.id);
        this.appendActionEvent(this.repos.actions.require(current.id), { attempt: a.attempt });
        return a;
      });
      this.publishChange(current.id);
      const run = this.repos.runs.require(current.runId);
      const input: AttemptInput = {
        run,
        snapshot: opts.snapshot,
        hook: current.hook,
        action: this.repos.actions.require(current.id),
        attempt: attempt.attempt,
        hadPriorAttempts,
        item: opts.item,
        signal: opts.signal,
        now: this.clock.now(),
      };
      let result: AttemptResult;
      try {
        result = await this.perform(input, config);
      } catch (err) {
        const info = describeActionError(err, this.redact);
        if (opts.signal?.aborted) {
          // Shutdown/abort is not a failure of the action: close the attempt, keep the action resumable.
          this.repos.transaction(() => {
            this.repos.actions.finishAttempt(attempt.id, 'failed', { error: info });
            const reset = this.repos.actions.setStatus(current.id, 'pending');
            this.appendActionEvent(reset, { attempt: attempt.attempt, error: info, interrupted: true });
          });
          this.publishChange(current.id);
          return 'interrupted';
        }
        const giveUp = !info.retryable || roundAttempts >= policy.maxAttempts;
        current = this.repos.transaction(() => {
          this.repos.actions.finishAttempt(attempt.id, 'failed', { error: info });
          if (giveUp) {
            const failed = this.repos.actions.setStatus(current.id, 'failed', { error: info });
            this.appendActionEvent(failed, { attempt: attempt.attempt, error: info });
            if (!config.continueOnError) this.queueFailureNotification(failed, info);
            return failed;
          }
          const a = this.repos.actions.require(current.id);
          this.appendActionEvent(a, { attempt: attempt.attempt, error: info, retryInMs: retryDelay(policy, info) });
          return a;
        });
        this.publishChange(current.id);
        this.logger.warn('lifecycle action attempt failed', {
          runId: current.runId,
          hook: current.hook,
          actionId: current.id,
          attempt: attempt.attempt,
          error: info,
          giveUp,
        });
        if (giveUp) return 'failed';
        try {
          await sleep(this.timers, retryDelay(policy, info), opts.signal);
        } catch {
          this.persistActionStatus(this.repos.actions.require(current.id), 'pending', { interrupted: true });
          return 'interrupted';
        }
        continue;
      }
      this.repos.transaction(() => {
        this.repos.actions.finishAttempt(attempt.id, 'succeeded', { externalKey: result.externalKey });
        const done = this.repos.actions.setStatus(current.id, 'succeeded', {
          ...(result.externalKey !== null ? { externalKey: result.externalKey } : {}),
        });
        this.appendActionEvent(done, { attempt: attempt.attempt, details: result.details });
      });
      this.publishChange(current.id);
      return 'succeeded';
    }
  }

  private perform(input: AttemptInput, config: LifecycleActionConfig): Promise<AttemptResult> {
    switch (config.type) {
      case 'source.update':
        return performSourceUpdate(this.performerDeps, input, config);
      case 'source.comment':
        return performSourceComment(this.performerDeps, input, config);
      case 'shell':
        return performShell(this.performerDeps, input, config);
    }
  }

  /** Bring an action left `running` (crash/restart) into a safe state, see {@link resumeIncomplete}. */
  private async makeSafe(
    action: RunActionRecord,
    run: RunRecord,
    snapshot: WorkflowSnapshot,
    item: SourceItem | undefined,
    options: { notify?: boolean } = {},
  ): Promise<void> {
    const config = actionConfig(action);
    const open = this.repos.actions.listAttempts(action.id).find((a) => a.finishedAt === null);
    const interrupted: ActionErrorInfo = {
      code: 'lifecycle_interrupted',
      message: 'Attempt interrupted by a controller restart; outcome unknown',
      retryable: true,
      outcomeUnknown: true,
    };

    if (config.type === 'source.comment' && open) {
      try {
        const identity = resolveActionIdentity(config, snapshot);
        const { adapter, item: target } = await resolveSourceTarget(this.performerDeps, run, snapshot, item);
        const found = identity ? await adapter.findCommentByMarker(target, commentMarker(run.id, action.id), identity) : null;
        if (found) {
          this.repos.transaction(() => {
            this.repos.actions.finishAttempt(open.id, 'succeeded', { externalKey: found.id });
            const done = this.repos.actions.setStatus(action.id, 'succeeded', { externalKey: found.id });
            this.appendActionEvent(done, { attempt: open.attempt, details: { reconciled: true, recovery: true } });
          });
          this.publishChange(action.id);
          return;
        }
      } catch (err) {
        // Lookup failed: stay safe — the next attempt looks up the marker again before posting.
        this.logger.warn('lifecycle recovery: marker lookup failed', { runId: run.id, actionId: action.id, error: err });
      }
    }

    if (config.type === 'shell' && open) {
      const info: ActionErrorInfo = { ...interrupted, retryable: false, message: `${interrupted.message} (shell action is not repeated automatically)` };
      this.repos.transaction(() => {
        this.repos.actions.finishAttempt(open.id, 'failed', { error: info });
        const failed = this.repos.actions.setStatus(action.id, 'failed', { error: info });
        this.appendActionEvent(failed, { attempt: open.attempt, error: info, recovery: true });
        if (options.notify !== false && !config.continueOnError) this.queueFailureNotification(failed, info);
      });
      this.publishChange(action.id);
      return;
    }

    this.repos.transaction(() => {
      if (open) this.repos.actions.finishAttempt(open.id, 'failed', { error: interrupted });
      const reset = this.repos.actions.setStatus(action.id, 'pending');
      this.appendActionEvent(reset, { recovery: true });
    });
    this.publishChange(action.id);
  }

  // -------------------------------------------------------------------------
  // Persistence helpers

  private persistActionStatus(action: RunActionRecord, status: 'pending' | 'skipped', extra: Record<string, unknown>): void {
    this.repos.transaction(() => {
      const updated = this.repos.actions.setStatus(action.id, status);
      this.appendActionEvent(updated, extra);
      this.refreshLifecycleStatus(action.runId);
    });
    this.publishChange(action.id);
  }

  private appendActionEvent(action: RunActionRecord, extra: Record<string, unknown>): void {
    this.repos.events.append(action.runId, LIFECYCLE_ACTION_EVENT, {
      actionId: action.id,
      hook: action.hook,
      ordinal: action.ordinal,
      type: action.type,
      name: action.name,
      status: action.status,
      ...(action.externalKey !== null ? { externalKey: action.externalKey } : {}),
      ...extra,
    });
  }

  private publishChange(actionId: number): void {
    const listener = this.options.onActionChange;
    if (!listener) return;
    this.repos.afterCommit(() => {
      try {
        listener(this.repos.actions.require(actionId));
      } catch (err) {
        this.logger.warn('lifecycle onActionChange listener failed', { actionId, error: err });
      }
    });
  }

  private queueFailureNotification(action: RunActionRecord, error: ActionErrorInfo): void {
    const notifier = this.options.notifier;
    if (!notifier) return;
    const run = this.repos.runs.require(action.runId);
    const payload: LifecycleActionFailedPayload = {
      runId: run.id,
      workflowId: run.workflowId,
      hook: action.hook,
      actionId: action.id,
      actionName: action.name,
      actionType: action.type,
      ordinal: action.ordinal,
      attempts: action.attempts,
      error,
      sourceItemKey: run.sourceItemKey,
      sourceUrl: run.sourceUrl,
    };
    this.repos.afterCommit(() => {
      try {
        notifier.notify('lifecycle_action_failed', payload);
      } catch (err) {
        this.logger.error('lifecycle notification failed', { runId: run.id, actionId: action.id, error: err });
      }
    });
  }

  /** Recompute `runs.lifecycle_status` from the whole journal of the run. */
  private refreshLifecycleStatus(runId: string): void {
    const status = aggregateLifecycleStatus(this.repos.actions.listForRun(runId));
    if (status !== null) this.repos.runs.update(runId, { lifecycleStatus: status });
  }

  /** Hooks of a run in journal order. */
  private hooksInOrder(runId: string): HookName[] {
    const hooks: HookName[] = [];
    for (const a of this.repos.actions.listForRun(runId)) if (!hooks.includes(a.hook)) hooks.push(a.hook);
    return hooks;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Action config persisted in the journal (`action_config_json`). */
export function actionConfig(action: RunActionRecord): LifecycleActionConfig {
  const config = action.config as LifecycleActionConfig | null;
  if (!config || typeof config !== 'object' || config.type !== action.type) {
    throw new LifecycleError('invalid_action_config', `Journal entry ${action.id} has no valid action configuration`, {
      details: { actionId: action.id },
    });
  }
  return config;
}

function retryPolicy(config: LifecycleActionConfig): RetryPolicy {
  const r = config.retry as Partial<RetryPolicy> | undefined;
  return {
    maxAttempts: Math.max(1, Math.floor(r?.maxAttempts ?? DEFAULT_ACTION_RETRY.maxAttempts)),
    delayMs: Math.max(0, r?.delayMs ?? DEFAULT_ACTION_RETRY.delayMs),
  };
}

function retryDelay(policy: RetryPolicy, error: ActionErrorInfo): number {
  return Math.max(policy.delayMs, error.retryAfterMs ?? 0);
}

/** First `failed` action without `continue_on_error` (the chain stops there), else `null`. */
export function stoppedAt(journal: readonly RunActionRecord[]): RunActionRecord | null {
  for (const a of journal) {
    if (a.status !== 'failed') continue;
    const cfg = a.config as Partial<LifecycleActionConfig> | null;
    if (!cfg?.continueOnError) return a;
  }
  return null;
}

/**
 * Aggregate `runs.lifecycle_status` over all hook chains of a run:
 * `running` if an action runs, else `failed` if any chain stopped at a failed
 * action, else `pending` if actions wait, else `succeeded`; `null` without journal.
 */
export function aggregateLifecycleStatus(actions: readonly RunActionRecord[]): LifecycleStatus | null {
  if (actions.length === 0) return null;
  if (actions.some((a) => a.status === 'running')) return 'running';
  const byHook = new Map<HookName, RunActionRecord[]>();
  for (const a of actions) byHook.set(a.hook, [...(byHook.get(a.hook) ?? []), a]);
  const chains = [...byHook.values()].map((j) => [...j].sort((x, y) => x.ordinal - y.ordinal));
  if (chains.some((j) => stoppedAt(j))) return 'failed';
  if (actions.some((a) => a.status === 'pending')) return 'pending';
  return 'succeeded';
}
