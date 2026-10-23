/**
 * Scheduler (Spec §5.5, §7, §14, §19): polling loop for source workflows,
 * cron trigger, manual start and dry-run.
 *
 * Invariants:
 * - Planning steps never overlap (serialized chain); the next poll is armed
 *   only after the previous step finished.
 * - No persistent candidate queue: every step reads the sources again.
 * - The final capacity check and the reservation run synchronously (no
 *   `await` in between), so concurrent cron firings / manual starts in the
 *   same process cannot overcommit the limits. Active runs of all triggers
 *   (incl. manual and `recovery_pending`) count towards the limits.
 * - Automatic starts only when the run controller allows them (ready after
 *   recovery, not paused, not draining/stopping).
 * - Cron: at most one run per slot (`cron_firings` primary key + slot lock);
 *   every handled slot gets exactly one `cron_firings` record; missed slots
 *   are recorded as `skipped_missed` and never caught up.
 */
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type Logger,
  type Redactor,
  type SourceAdapter,
  type TimerHandle,
  type Timers,
  type Unsubscribe,
} from '../core/index.js';
import {
  UnknownWorkflowError,
  automaticParameterValues,
  triggerSourceIds,
  type ConfigManager,
  type LoadedConfig,
  type ParameterValue,
  type WorkflowConfig,
} from '../config/index.js';
import { ShellCheckRunner, sortCandidates } from '../filters/index.js';
import {
  BlockedError,
  UnblockRunActiveError,
  LockConflictError,
  type CronFiringRecord,
  type Repositories,
  type RunRecord,
} from '../persistence/index.js';
import type { ControllerStatus, RunHandle, StartRunOptions } from '../runs/index.js';
import { checkReason, SchedulerChecks, type ChecksOutcome } from './checks.js';
import { ConditionStatusStore, summarizeItemChecks, type WorkflowConditionStatus } from './condition-status.js';
import { dueSlots, parseCron, type CronSchedule } from './cron.js';
import { dryRunWorkflow } from './dry-run.js';
import { SchedulerError } from './errors.js';
import { candidateLinkedFields, checkEligibility, prepareSourceWorkflow, verifyItemFor, type ListCache, type PreparedCandidate, type PreparedWorkflow, type SourceLookup } from './planner.js';
import { repositoryState, type SchedulingState } from './state.js';
import {
  MAX_DIAGNOSED_CANDIDATES,
  type CandidateDecision,
  type CheckDiagnosis,
  type CronSlotDecision,
  type CronWorkflowStatus,
  type DryRunResult,
  type GateInfo,
  type GateReason,
  type PlanningStepReport,
  type WorkflowPlanningDiagnosis,
} from './types.js';

/** The part of the run controller (WI-08) the scheduler needs. */
export interface SchedulerRunController {
  readonly status: ControllerStatus;
  canStartAutomatically(): boolean;
  canStartManually(): boolean;
  startRun(run: RunRecord, options?: StartRunOptions): RunHandle;
}

/** Dependencies and tuning of the {@link Scheduler}. */
export interface SchedulerOptions {
  /** Live configuration incl. runtime overrides (effective values). */
  config: ConfigManager;
  repositories: Repositories;
  controller: SchedulerRunController;
  /** Source adapters by configured source ID. */
  sources: SourceLookup;
  /** Runner for shell filters/conditions (holds the workflow-condition cache). Default: a new one. */
  shellChecks?: ShellCheckRunner;
  clock?: Clock;
  /** Timers for the polling loop and cron (FakeClock in tests). */
  timers?: Timers;
  logger?: Logger;
  /**
   * A cron slot is still started if it is handled at most this late (timer
   * latency, short restart); later slots are `skipped_missed`. Default 60 s.
   */
  cronMisfireToleranceMs?: number;
  /** Max. `skipped_missed` records written per catch-up (older ones are only counted). Default 100. */
  maxRecordedMissedSlots?: number;
  /**
   * Called when the status of a workflow condition or the item-check summary
   * of a workflow changed (WI-24, e.g. for the SSE event `workflow.conditions`).
   */
  onConditionStatusChange?: (workflowId: string) => void;
  /** Redaction of stderr lines/errors in the condition status (WI-24). */
  redact?: Redactor;
  /**
   * Check of manual-start values against the current options of parameters
   * with `options_from` (WI-31); absent = no list check.
   */
  parameterOptions?: ManualParameterOptionsCheck;
}

/** Check of manual-start parameter values against run-time options (WI-31, see `parameter-options`). */
export interface ManualParameterOptionsCheck {
  check(
    workflow: WorkflowConfig,
    values: Readonly<Record<string, ParameterValue>>,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'invalid'; errors: Array<{ parameter: string; message: string }> }
    | { ok: false; reason: 'unavailable'; parameter: string; error: { code: string; message: string } }
  >;
}

/** Request of {@link Scheduler.startManual}. */
export interface ManualStartRequest {
  /** Item reference (URL or ID) – required for source workflows, rejected otherwise. */
  itemRef?: string;
  /** Parameter values (validated against the workflow's `parameters`). */
  parameters?: Readonly<Record<string, unknown>>;
}

/** Result of {@link Scheduler.startManual}. */
export interface ManualStartResult {
  /** The reserved run (status `reserved` at return time). */
  run: RunRecord;
  /** Resolves when the controller finished supervising the run. */
  done: Promise<RunRecord>;
}

/** Cap of a single timer delay; longer waits are re-armed (also absorbs wall-clock jumps). */
const MAX_TIMER_DELAY_MS = 60 * 60_000;
/** Skip decisions recorded only once per series (state change), not per slot. */
const QUIET_DECISIONS: ReadonlySet<CronSlotDecision> = new Set<CronSlotDecision>([
  'skipped_disabled',
  'skipped_paused',
  'skipped_not_ready',
  'skipped_draining',
]);
/** Bound for scanning missed cron slots. */
const MAX_CRON_SCAN = 100_000;

interface CronState {
  workflowId: string;
  expression: string;
  timezone: string;
  schedule: CronSchedule;
  timer: TimerHandle | undefined;
  nextSlot: Date | null;
  /** Latest slot that was handled (or deliberately not considered). */
  lastHandled: Date;
  /** True until the first due-check after arming from a persisted firing (downtime catch-up). */
  catchUp: boolean;
  /**
   * Decision of the current series of "quiet" skips (disabled / gate closed):
   * only the first slot of a series gets a `cron_firings` row.
   */
  quietDecision: CronSlotDecision | null;
  chain: Promise<void>;
  lastConditions: CheckDiagnosis[];
  removed: boolean;
}

/** See module docs. One instance per process, created after the run controller's recovery. */
export class Scheduler {
  private readonly config: ConfigManager;
  private readonly repos: Repositories;
  private readonly controller: SchedulerRunController;
  private readonly sources: SourceLookup;
  private readonly state: SchedulingState;
  private readonly shellChecks: ShellCheckRunner;
  private readonly checks: SchedulerChecks;
  private readonly conditionStatusStore: ConditionStatusStore;
  /** Hashes of workflow definitions of earlier configurations (planning steps that overlap a reload). */
  private readonly previousHashes = new WeakMap<WorkflowConfig, string>();
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly misfireToleranceMs: number;
  private readonly parameterOptions: ManualParameterOptionsCheck | undefined;
  private readonly maxRecordedMissed: number;

  private started = false;
  private stopped = false;
  private pollTimer: TimerHandle | undefined;
  private stepChain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly diagnoses = new Map<string, WorkflowPlanningDiagnosis>();
  private lastReport: PlanningStepReport | null = null;
  private readonly cron = new Map<string, CronState>();
  private unsubscribeConfig: Unsubscribe | undefined;

  constructor(options: SchedulerOptions) {
    this.config = options.config;
    this.repos = options.repositories;
    this.controller = options.controller;
    this.sources = options.sources;
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'scheduler' });
    this.state = repositoryState(this.repos);
    // Check timeouts use real timers; the clock drives the condition cache TTL.
    this.shellChecks = options.shellChecks ?? new ShellCheckRunner({ clock: this.clock, logger: this.logger });
    this.conditionStatusStore = new ConditionStatusStore(() => this.clock.now(), options.onConditionStatusChange, options.redact);
    this.checks = new SchedulerChecks(this.shellChecks, () => this.clock.now(), (wf, diag, result) => {
      // A result of a workflow definition that a reload replaced meanwhile must not become its status.
      if (this.isCurrentDefinition(wf)) this.conditionStatusStore.recordWorkflowCondition(wf.id, wf.conditions.workflow.length, diag, result);
    });
    this.parameterOptions = options.parameterOptions;
    this.misfireToleranceMs = options.cronMisfireToleranceMs ?? 60_000;
    this.maxRecordedMissed = options.maxRecordedMissedSlots ?? 100;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /**
   * Start the polling loop (first step immediately) and arm the cron timers
   * (missed slots since the last persisted firing are recorded as
   * `skipped_missed`). Call after `RunController.recover()`.
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribeConfig = this.config.onChange((event) => {
      if (event.kind !== 'reload') return;
      // Changed commands/TTLs must not be served from the old cache.
      this.shellChecks.invalidate();
      // Definitions of the previous configuration stay "current" if their hash did not change (unchanged workflows).
      for (const [id, wf] of Object.entries(event.previous.workflows)) {
        const hash = event.previous.workflowHashes[id];
        if (hash !== undefined) this.previousHashes.set(wf, hash);
      }
      // The last condition status (WI-24) of changed/removed workflows no longer matches their definition.
      this.conditionStatusStore.forget([...event.diff.changedWorkflows, ...event.diff.removedWorkflows]);
      this.syncCron();
      for (const id of [...this.diagnoses.keys()]) {
        const wf = event.config.workflows[id];
        if (!wf || wf.trigger.type !== 'source') this.diagnoses.delete(id);
      }
    });
    this.syncCron();
    this.loopStep();
    this.logger.info('scheduler started', { pollingIntervalMs: this.config.current.global.scheduler.pollingIntervalMs });
  }

  /** Stop polling and cron timers; waits for running planning steps / cron handlers. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    for (const state of this.cron.values()) this.disarm(state);
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = undefined;
    await this.whenIdle();
  }

  /** Resolves once no planning step and no cron handler is in flight (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const remove = (): void => {
      this.inflight.delete(p);
    };
    p.then(remove, remove);
    return p;
  }

  /** One loop iteration: planning step, then arm the next poll (never overlapping). */
  private loopStep(): void {
    this.planOnce()
      .catch((err: unknown) => this.logger.error('planning step failed', { error: errorMessage(err) }))
      .finally(() => this.armPoll(this.config.current.global.scheduler.pollingIntervalMs));
  }

  private armPoll(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      this.loopStep();
    }, delayMs);
  }

  // ---------------------------------------------------------------------------
  // Gate / capacity

  private gateReason(): GateReason | null {
    if (this.controller.canStartAutomatically()) return null;
    const s = this.controller.status;
    if (!s.ready) return 'not_ready';
    if (s.draining || s.stopping) return 'draining';
    if (s.paused) return 'paused';
    return 'not_ready';
  }

  private gateInfo(): GateInfo {
    const reason = this.gateReason();
    return { canStartAutomatically: reason === null, reason };
  }

  /**
   * Limit check with live effective values (overrides apply immediately).
   * `sourceId` (source candidates) also checks `max_concurrent_per_source` (WI-20).
   */
  private capacityProblem(
    workflowId: string,
    sourceId?: string,
  ): { decision: 'global_limit' | 'workflow_limit' | 'source_limit'; reason: string } | null {
    const globalMax = this.config.maxConcurrent;
    const globalActive = this.state.countActive();
    if (globalActive >= globalMax) {
      return { decision: 'global_limit', reason: `global limit reached (${globalActive}/${globalMax} active)` };
    }
    const eff = this.config.getWorkflow(workflowId);
    const max = eff?.maxConcurrent ?? 1;
    const active = this.state.countActive(workflowId);
    if (active >= max) return { decision: 'workflow_limit', reason: `workflow limit reached (${active}/${max} active)` };
    const perSource = eff?.config.maxConcurrentPerSource;
    if (sourceId !== undefined && perSource !== undefined) {
      const fromSource = this.state.countActive(workflowId, sourceId);
      if (fromSource >= perSource) {
        return { decision: 'source_limit', reason: `limit per source reached for '${sourceId}' (${fromSource}/${perSource} active)` };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Planning step (Spec §7)

  /**
   * Run one planning step for all source workflows. Steps are serialized
   * (a call during a running step runs after it). Never rejects for source
   * or check problems – they are part of the diagnosis.
   */
  planOnce(): Promise<PlanningStepReport> {
    const step = this.stepChain.then(() => this.planningStep());
    this.stepChain = step.catch(() => undefined);
    return this.track(step);
  }

  private async planningStep(): Promise<PlanningStepReport> {
    const startedAt = this.clock.now().toISOString();
    const gate = this.stopped ? 'draining' : this.gateReason();
    if (gate) {
      const report: PlanningStepReport = { startedAt, finishedAt: startedAt, skipped: gate, startedRunIds: [], workflows: [] };
      this.lastReport = report;
      return report;
    }
    const cfg = this.config.current;
    const workflows = this.config.listWorkflows().filter((w) => w.config.trigger.type === 'source');
    const listCache: ListCache = new Map();
    const conditionMemo = new Map<string, Promise<ChecksOutcome>>();

    // Steps 1–3 per workflow in parallel; a failing source only affects its workflows.
    const prepared: PreparedWorkflow[] = await Promise.all(
      workflows.map(async (w): Promise<PreparedWorkflow> => {
        if (!w.enabled) {
          const sourceIds = w.config.trigger.type === 'source' ? triggerSourceIds(w.config.trigger) : [];
          return {
            diagnosis: {
              workflowId: w.config.id,
              at: startedAt,
              status: 'disabled',
              error: null,
              sourceId: sourceIds[0] ?? '',
              polled: 0,
              pushdown: null,
              sources: sourceIds.map((sourceId) => ({ sourceId, status: 'ok', error: null, polled: 0, pushdown: null })),
              conditions: [],
              candidates: [],
              omittedCandidates: 0,
              startedRunIds: [],
            },
            candidates: [],
            rejected: [],
          };
        }
        // Never rejects: source problems are part of the diagnosis.
        return prepareSourceWorkflow(w.config, w.priority, {
          sources: this.sources,
          at: startedAt,
          listCache,
          sourceVars: (id) => cfg.sources[id]?.vars,
        });
      }),
    );

    // Step 3: deterministic order across all workflows; steps 4–7 per candidate.
    const ordered = sortCandidates(prepared.flatMap((p) => p.candidates));
    const startedRunIds: string[] = [];
    for (const candidate of ordered) {
      try {
        const runId = await this.considerCandidate(candidate, cfg, conditionMemo);
        if (runId) startedRunIds.push(runId);
      } catch (err) {
        candidate.diagnosis.decision = 'start_failed';
        candidate.diagnosis.reason = errorMessage(err);
        this.logger.error('candidate failed unexpectedly', { workflowId: candidate.workflowId, item: candidate.itemKey, error: errorMessage(err) });
      }
    }

    // Diagnoses (last planning step per workflow, in memory).
    const byWorkflow = new Map(prepared.map((p) => [p.diagnosis.workflowId, p]));
    for (const p of prepared) {
      const diag = p.diagnosis;
      const memo = conditionMemo.get(diag.workflowId);
      if (memo) diag.conditions = (await memo).checks;
      const all = [...ordered.filter((c) => c.workflowId === diag.workflowId).map((c) => c.diagnosis), ...p.rejected];
      if (diag.status !== 'disabled' && this.config.current.workflowHashes[diag.workflowId] === cfg.workflowHashes[diag.workflowId]) {
        const wf = cfg.workflows[diag.workflowId];
        if (wf && (wf.conditions.item.length > 0 || wf.shellFilter)) {
          this.conditionStatusStore.recordItemSummary(
            diag.workflowId,
            summarizeItemChecks(startedAt, wf.conditions.item.length, wf.shellFilter !== null, all),
          );
        }
      }
      diag.candidates = all.slice(0, MAX_DIAGNOSED_CANDIDATES);
      diag.omittedCandidates = all.length - diag.candidates.length;
      diag.startedRunIds = all.filter((c) => c.decision === 'started' && c.runId).map((c) => c.runId as string);
      this.diagnoses.set(diag.workflowId, diag);
    }
    for (const id of [...this.diagnoses.keys()]) if (!byWorkflow.has(id)) this.diagnoses.delete(id);

    const report: PlanningStepReport = {
      startedAt,
      finishedAt: this.clock.now().toISOString(),
      skipped: null,
      startedRunIds,
      workflows: prepared.map((p) => p.diagnosis),
    };
    this.lastReport = report;
    if (startedRunIds.length > 0) this.logger.info('planning step started runs', { runs: startedRunIds });
    return report;
  }

  /** Steps 4–7 for one candidate; returns the started run ID. */
  private async considerCandidate(
    candidate: PreparedCandidate,
    cfg: LoadedConfig,
    conditionMemo: Map<string, Promise<ChecksOutcome>>,
  ): Promise<string | null> {
    const diag = candidate.diagnosis;
    const set = (decision: CandidateDecision, reason: string): null => {
      diag.decision = decision;
      diag.reason = reason;
      return null;
    };
    // Free slot? (checked first so that a full limit costs no API calls / checks)
    const early = this.capacityProblem(candidate.workflowId, candidate.item.sourceId);
    if (early) return set(early.decision, early.reason);

    const eligibility = await checkEligibility(candidate, {
      state: this.state,
      checks: this.checks,
      configDir: cfg.configDir,
      workflowConditions: (wf: WorkflowConfig) => {
        let memo = conditionMemo.get(wf.id);
        if (!memo) {
          memo = this.checks.workflowConditions(wf);
          conditionMemo.set(wf.id, memo);
        }
        return memo;
      },
    });
    if (!eligibility.eligible) return null;
    // Linked fields already fetched for the filter are handed to the start (no second identical query).
    const linkedFields = await candidateLinkedFields(candidate, 'start');

    // --- synchronous section: re-validate and reserve atomically -------------
    if (this.stopped) return set('gate_closed', 'scheduler is stopping');
    const gate = this.gateReason();
    if (gate) return set('gate_closed', `automatic starts not possible: ${gate}`);
    const eff = this.config.getWorkflow(candidate.workflowId);
    if (!eff || !eff.enabled || this.config.current.workflowHashes[candidate.workflowId] !== cfg.workflowHashes[candidate.workflowId]) {
      return set('workflow_unavailable', 'workflow was disabled, removed or changed during the planning step');
    }
    const capacity = this.capacityProblem(candidate.workflowId, candidate.item.sourceId);
    if (capacity) return set(capacity.decision, capacity.reason);
    let run: RunRecord;
    try {
      run = this.repos.runs.reserve({
        workflowId: candidate.workflowId,
        triggerType: 'source',
        sourceId: candidate.item.sourceId,
        sourceItemKey: candidate.itemKey,
        sourceUrl: candidate.item.url,
        configSnapshot: this.config.snapshotWorkflow(candidate.workflowId, candidate.item.sourceId),
        parameters: automaticParameterValues(eff.config),
        failIfBlocked: true,
      });
    } catch (err) {
      if (err instanceof LockConflictError) {
        diag.runId = err.holderRunId;
        return set('locked', `run ${err.holderRunId} of this workflow is active for the item`);
      }
      if (err instanceof BlockedError) {
        diag.blockId = err.blockId;
        return set('blocked', `retry block ${err.blockId}`);
      }
      throw err;
    }
    // --- end of synchronous section ------------------------------------------
    diag.runId = run.id;
    try {
      const verifyItem = verifyItemFor(candidate.workflow, candidate.adapter);
      this.controller.startRun(run, { ...(verifyItem ? { verifyItem } : {}), ...(linkedFields ? { linkedFields } : {}) });
    } catch (err) {
      // The controller finalizes a refused reserved run itself (lock released).
      return set('start_failed', `run ${run.id} could not be started: ${errorMessage(err)}`);
    }
    set('started', `run ${run.id} started`);
    return run.id;
  }

  // ---------------------------------------------------------------------------
  // Cron (Spec §5.5, §7)

  /** Arm/re-arm cron timers for the schedule workflows of the active configuration. */
  private syncCron(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const seen = new Set<string>();
    for (const wf of Object.values(this.config.current.workflows)) {
      if (wf.trigger.type !== 'schedule') continue;
      seen.add(wf.id);
      const existing = this.cron.get(wf.id);
      if (existing && existing.expression === wf.trigger.cron && existing.timezone === wf.trigger.timezone) continue;
      let schedule: CronSchedule;
      try {
        schedule = parseCron(wf.trigger.cron, wf.trigger.timezone);
      } catch (err) {
        this.logger.error('invalid cron expression', { workflowId: wf.id, error: errorMessage(err) });
        continue;
      }
      if (existing) this.disarm(existing);
      // A changed schedule starts fresh at "now"; a newly seen workflow catches
      // up from its latest persisted firing (slots missed during downtime).
      const latest = existing ? null : this.repos.cronFirings.latest(wf.id);
      const state: CronState = {
        workflowId: wf.id,
        expression: wf.trigger.cron,
        timezone: wf.trigger.timezone,
        schedule,
        timer: undefined,
        nextSlot: null,
        lastHandled: latest ? new Date(latest.scheduledFor) : now,
        catchUp: latest !== null,
        quietDecision: latest && QUIET_DECISIONS.has(latest.decision as CronSlotDecision) ? (latest.decision as CronSlotDecision) : null,
        chain: Promise.resolve(),
        lastConditions: [],
        removed: false,
      };
      this.cron.set(wf.id, state);
      this.enqueueCron(state);
    }
    for (const [id, state] of [...this.cron]) {
      if (seen.has(id)) continue;
      this.disarm(state);
      state.removed = true;
      this.cron.delete(id);
    }
  }

  private disarm(state: CronState): void {
    if (state.timer) this.timers.clearTimeout(state.timer);
    state.timer = undefined;
  }

  private enqueueCron(state: CronState): void {
    const next = state.chain.then(() => this.processDue(state));
    state.chain = next.catch((err: unknown) => {
      this.logger.error('cron handling failed', { workflowId: state.workflowId, error: errorMessage(err) });
    });
    void this.track(state.chain);
  }

  private armCronTimer(state: CronState): void {
    if (this.stopped || state.removed) return;
    const now = this.clock.now();
    const from = state.lastHandled.getTime() > now.getTime() ? state.lastHandled : now;
    const next = state.schedule.next(from);
    state.nextSlot = next;
    if (!next) return;
    const delay = Math.min(Math.max(0, next.getTime() - now.getTime()), MAX_TIMER_DELAY_MS);
    state.timer = this.timers.setTimeout(() => {
      state.timer = undefined;
      this.enqueueCron(state);
    }, delay);
  }

  /** Handle all slots in `(lastHandled, now]`: the latest within tolerance fires, the rest are missed. */
  private async processDue(state: CronState): Promise<void> {
    if (this.stopped || state.removed) return;
    this.disarm(state);
    try {
      await this.decideDue(state);
    } finally {
      // Always re-arm: one failing slot (e.g. a DB error) must not stop the schedule.
      this.armCronTimer(state);
    }
  }

  private async decideDue(state: CronState): Promise<void> {
    const now = this.clock.now();
    const due = dueSlots(state.schedule, state.lastHandled, now, { keep: this.maxRecordedMissed + 1, maxScan: MAX_CRON_SCAN });
    const catchUp = state.catchUp;
    state.catchUp = false;
    if (due.slots.length > 0) {
      const latest = due.slots[due.slots.length - 1] as Date;
      const fire = now.getTime() - latest.getTime() <= this.misfireToleranceMs;
      const missed = fire ? due.slots.slice(0, -1) : due.slots;
      const notRecorded = due.total - due.slots.length;
      missed.forEach((slot, i) => {
        let reason = catchUp
          ? state.quietDecision
            ? `slot passed while the orchestrator was not running (or while still ${state.quietDecision})`
            : 'slot passed while the orchestrator was not running'
          : `slot handled ${Math.round((now.getTime() - slot.getTime()) / 1000)}s late (tolerance ${Math.round(this.misfireToleranceMs / 1000)}s)`;
        if (i === 0 && (notRecorded > 0 || due.scanLimited)) reason += ` (+${due.scanLimited ? 'at least ' : ''}${notRecorded} older missed slot(s) not recorded)`;
        this.recordFiring(state, slot, 'skipped_missed', reason);
      });
      if (missed.length > 0) {
        this.logger.warn('cron slots missed (not caught up)', { workflowId: state.workflowId, missed: missed.length + notRecorded });
      }
      state.lastHandled = latest;
      if (fire) await this.handleSlot(state, latest);
    }
  }

  /**
   * Persist a slot decision. Quiet skips (disabled / gate closed) are written
   * only for the first slot of a series; later slots of the same series only
   * advance `lastHandled` (no row flood for frequent schedules).
   */
  private recordFiring(state: CronState, slot: Date, decision: CronSlotDecision, reason: string | null): void {
    const workflowId = state.workflowId;
    const quiet = QUIET_DECISIONS.has(decision);
    if (quiet && state.quietDecision === decision) {
      this.logger.debug('cron slot (series continues, not recorded)', { workflowId, slot: slot.toISOString(), decision });
      return;
    }
    const text = quiet ? `${reason ?? decision}; further slots are not recorded while this state lasts` : reason;
    const { inserted } = this.repos.cronFirings.record({ workflowId, scheduledFor: slot, decision, reason: text });
    state.quietDecision = quiet ? decision : null;
    if (inserted) this.logger.info('cron slot', { workflowId, slot: slot.toISOString(), decision, reason: text });
  }

  /** Decide one due slot: start a run or record why not. */
  private async handleSlot(state: CronState, slot: Date): Promise<void> {
    const workflowId = state.workflowId;
    if (this.repos.cronFirings.get(workflowId, slot)) return; // already handled (e.g. before a restart)
    const pre = this.slotPrecondition(workflowId);
    if (pre) return this.recordFiring(state, slot, pre.decision, pre.reason);

    const eff = this.config.getWorkflow(workflowId) as NonNullable<ReturnType<ConfigManager['getWorkflow']>>;
    if (eff.config.conditions.workflow.length > 0) {
      const outcome = await this.checks.workflowConditions(eff.config);
      state.lastConditions = outcome.checks;
      if (outcome.value !== true) {
        const f = outcome.failed;
        const what = `workflow condition ${checkReason(f, this.config.current.configDir)}`;
        return outcome.value === false
          ? this.recordFiring(state, slot, 'skipped_condition', `${what} is false`)
          : this.recordFiring(state, slot, 'skipped_condition_unknown', `${what} is unknown: ${f?.error ?? 'check error'}`);
      }
      if (this.stopped) return;
      const again = this.slotPrecondition(workflowId);
      if (again) return this.recordFiring(state, slot, again.decision, again.reason);
    }

    // Synchronous: record + reserve in one transaction (at most one run per slot).
    let run: RunRecord | null;
    try {
      run = this.repos.transaction(() => {
        const { inserted } = this.repos.cronFirings.record({ workflowId, scheduledFor: slot, decision: 'started', reason: null });
        if (!inserted) return null;
        const reserved = this.repos.runs.reserve({
          workflowId,
          triggerType: 'schedule',
          scheduledFor: slot,
          configSnapshot: this.config.snapshotWorkflow(workflowId),
          parameters: automaticParameterValues(eff.config),
          failIfBlocked: true,
        });
        this.repos.cronFirings.update(workflowId, slot, { runId: reserved.id });
        return reserved;
      });
    } catch (err) {
      if (err instanceof BlockedError) return this.recordFiring(state, slot, 'skipped_blocked', `retry block ${err.blockId}`);
      if (err instanceof UnblockRunActiveError) return this.recordFiring(state, slot, 'skipped_blocked', `unblock run ${err.runId} active`);
      if (err instanceof LockConflictError) return this.recordFiring(state, slot, 'skipped_lock', `slot lock held by run ${err.holderRunId}`);
      this.logger.error('cron reservation failed', { workflowId, slot: slot.toISOString(), error: errorMessage(err) });
      return this.recordFiring(state, slot, 'start_failed', errorMessage(err));
    }
    if (!run) return;
    state.quietDecision = null;
    this.logger.info('cron slot', { workflowId, slot: slot.toISOString(), decision: 'started', runId: run.id });
    try {
      this.controller.startRun(run);
    } catch (err) {
      this.repos.cronFirings.update(workflowId, slot, { decision: 'start_failed', reason: errorMessage(err) });
    }
  }

  /** Synchronous checks before a slot may start (enabled, gate, limits, block). */
  private slotPrecondition(workflowId: string): { decision: CronSlotDecision; reason: string } | null {
    const eff = this.config.getWorkflow(workflowId);
    if (!eff || eff.config.trigger.type !== 'schedule') return { decision: 'skipped_disabled', reason: 'workflow no longer scheduled' };
    if (!eff.enabled) return { decision: 'skipped_disabled', reason: 'workflow is disabled' };
    const gate = this.stopped ? 'draining' : this.gateReason();
    if (gate) return { decision: `skipped_${gate}`, reason: `automatic starts not possible (${gate})` };
    const capacity = this.capacityProblem(workflowId);
    if (capacity) return { decision: 'skipped_limit', reason: capacity.reason };
    const block = this.state.activeBlock(workflowId, null);
    if (block) return { decision: 'skipped_blocked', reason: `retry block ${block.id}: ${block.reason}` };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Manual start (Spec §5.5, §7)

  /**
   * Start a workflow manually. Bypasses filters, conditions, retry blocks,
   * priorities and limits (and `enabled`/pause), but never the active lock of
   * the workflow+item (`LockConflictError`, HTTP 409). The run counts towards
   * the limits of automatic starts.
   *
   * @throws UnknownWorkflowError, SchedulerError, LockConflictError, UnblockRunActiveError (WI-30: workflow without item while its unblock run is active)
   */
  async startManual(workflowId: string, request: ManualStartRequest = {}): Promise<ManualStartResult> {
    const eff = this.config.getWorkflow(workflowId);
    if (!eff) throw new UnknownWorkflowError(workflowId);
    this.assertAcceptsManual();
    const workflow = eff.config;
    const ref = request.itemRef?.trim() ?? '';
    if (workflow.trigger.type !== 'source' && ref) {
      throw new SchedulerError('manual_item_not_supported', `Workflow '${workflowId}' (${workflow.trigger.type}) has no source items`);
    }
    const params = this.config.validateParameters(workflowId, request.parameters);
    if (!params.ok) {
      throw new SchedulerError('invalid_parameters', `Invalid parameters for workflow '${workflowId}'`, { errors: params.errors });
    }
    // WI-31: values of `options_from` parameters must be in the current options (no list check with `allow_custom`).
    if (this.parameterOptions) {
      const checked = await this.parameterOptions.check(workflow, params.values);
      if (!checked.ok && checked.reason === 'invalid') {
        throw new SchedulerError('invalid_parameters', `Invalid parameters for workflow '${workflowId}'`, { errors: checked.errors });
      }
      if (!checked.ok) {
        throw new SchedulerError(
          'parameter_options_unavailable',
          `Options of parameter '${checked.parameter}' could not be fetched: ${checked.error.message}`,
          { parameter: checked.parameter, error: checked.error },
        );
      }
    }
    let item: { sourceId: string; key: string; url: string } | null = null;
    if (workflow.trigger.type === 'source') {
      if (!ref) throw new SchedulerError('manual_item_required', `Workflow '${workflowId}' needs an item reference (URL or ID)`);
      const { sourceId, adapter, itemId } = this.resolveManualRef(workflowId, triggerSourceIds(workflow.trigger), ref);
      let found;
      try {
        found = await adapter.getItem(itemId);
      } catch (err) {
        throw new SchedulerError('source_unavailable', `Reading item ${itemId} from '${sourceId}' failed: ${errorMessage(err)}`, { sourceId, itemId }, err);
      }
      if (!found) throw new SchedulerError('manual_item_not_found', `Item ${itemId} not found in source '${sourceId}'`, { sourceId, itemId });
      item = { sourceId, key: found.key, url: found.url };
    }
    // Synchronous from here: re-check acceptance, reserve (lock only, no block/limit check), start.
    this.assertAcceptsManual();
    const values: Record<string, ParameterValue> = params.values;
    const run = this.repos.runs.reserve({
      workflowId,
      triggerType: 'manual',
      sourceId: item?.sourceId ?? null,
      sourceItemKey: item?.key ?? null,
      sourceUrl: item?.url ?? null,
      configSnapshot: this.config.snapshotWorkflow(workflowId, item?.sourceId),
      parameters: Object.keys(values).length > 0 ? values : null,
      failIfBlocked: false,
    });
    this.logger.info('manual run reserved', { workflowId, runId: run.id, item: item?.key ?? null });
    const handle = this.controller.startRun(run);
    return { run, done: handle.done };
  }

  /**
   * Source and item ID of a manual item reference. Accepted: `<source>:<ref>`
   * with one of the workflow's sources (WI-20), or a reference that exactly one
   * source accepts (URL, `owner/repo#n`; a bare number only for single-source
   * workflows or when it is unambiguous).
   *
   * @throws SchedulerError (`manual_item_invalid_ref`, `source_unavailable`)
   */
  private resolveManualRef(
    workflowId: string,
    sourceIds: readonly string[],
    ref: string,
  ): { sourceId: string; adapter: SourceAdapter; itemId: string } {
    const prefixed = /^([^:/\s]+):(.+)$/.exec(ref);
    const explicit = prefixed && sourceIds.includes(prefixed[1] as string) ? (prefixed[1] as string) : undefined;
    const lookup = (sourceId: string): SourceAdapter => {
      const adapter = this.sources(sourceId);
      if (!adapter) throw new SchedulerError('source_unavailable', `Source '${sourceId}' is not available`, { sourceId });
      return adapter;
    };
    if (explicit !== undefined || sourceIds.length === 1) {
      const sourceId = explicit ?? (sourceIds[0] as string);
      const adapter = lookup(sourceId);
      const inner = explicit !== undefined ? (prefixed?.[2] as string) : ref;
      const itemId = adapter.parseItemRef(inner);
      if (itemId === null) {
        throw new SchedulerError('manual_item_invalid_ref', `'${ref}' is not an item reference of source '${sourceId}'`, { sourceId, itemRef: ref });
      }
      return { sourceId, adapter, itemId };
    }
    const matches: Array<{ sourceId: string; adapter: SourceAdapter; itemId: string }> = [];
    for (const sourceId of sourceIds) {
      const adapter = this.sources(sourceId);
      const itemId = adapter?.parseItemRef(ref) ?? null;
      if (adapter && itemId !== null) matches.push({ sourceId, adapter, itemId });
    }
    const list = sourceIds.map((id) => `'${id}'`).join(', ');
    const hint = `use a URL or "<source>:<number>" with one of the workflow's sources (${list}), e.g. "${sourceIds[0] ?? 'source'}:12"`;
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) return only;
    if (matches.length > 1) {
      throw new SchedulerError(
        'manual_item_invalid_ref',
        `'${ref}' is ambiguous for workflow '${workflowId}' with several sources: ${hint}`,
        { sourceIds: [...sourceIds], itemRef: ref },
      );
    }
    throw new SchedulerError('manual_item_invalid_ref', `'${ref}' is not an item reference of any source of workflow '${workflowId}': ${hint}`, {
      sourceIds: [...sourceIds],
      itemRef: ref,
    });
  }

  private assertAcceptsManual(): void {
    if (this.stopped || !this.controller.canStartManually()) {
      const s = this.controller.status;
      const reason = this.stopped ? 'scheduler stopped' : !s.ready ? 'recovery not finished' : 'draining / shutting down';
      throw new SchedulerError('scheduler_not_accepting', `Manual starts are currently not possible: ${reason}`, { reason });
    }
  }

  // ---------------------------------------------------------------------------
  // Dry-run and diagnostics (GUI/API)

  /** Dry-run a workflow (no reservation, no actions, no shell checks). @throws UnknownWorkflowError */
  dryRun(workflowId: string, options: { signal?: AbortSignal } = {}): Promise<DryRunResult> {
    return dryRunWorkflow(
      {
        config: this.config,
        sources: this.sources,
        state: this.state,
        clock: this.clock,
        gate: () => this.gateInfo(),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      workflowId,
    );
  }

  /** Last planning diagnosis of a source workflow (`undefined` before its first step). */
  lastDiagnosis(workflowId: string): WorkflowPlanningDiagnosis | undefined {
    return this.diagnoses.get(workflowId);
  }

  /** Last planning diagnoses of all source workflows, sorted by workflow ID. */
  listDiagnoses(): WorkflowPlanningDiagnosis[] {
    return [...this.diagnoses.values()].sort((a, b) => (a.workflowId < b.workflowId ? -1 : a.workflowId > b.workflowId ? 1 : 0));
  }

  /** True if `wf` is (or has the same hash as) the active definition of its workflow. */
  private isCurrentDefinition(wf: WorkflowConfig): boolean {
    const current = this.config.current;
    if (current.workflows[wf.id] === wf) return true;
    const hash = this.previousHashes.get(wf);
    return hash !== undefined && hash === current.workflowHashes[wf.id];
  }

  /**
   * Last status of the shell checks of a workflow (WI-24): every workflow
   * condition (planning step or cron slot) and the item-check summary of the
   * last planning step. `undefined` for an unknown workflow.
   */
  conditionStatus(workflowId: string): WorkflowConditionStatus | undefined {
    const wf = this.config.current.workflows[workflowId];
    if (!wf) return undefined;
    return this.conditionStatusStore.get(workflowId, wf.conditions.workflow.length);
  }

  /** Summary of the last planning step (`null` before the first one). */
  lastPlanningStep(): PlanningStepReport | null {
    return this.lastReport;
  }

  /** Cron status of all schedule workflows, sorted by workflow ID. */
  cronStatus(): CronWorkflowStatus[] {
    return [...this.cron.values()]
      .map((s): CronWorkflowStatus => {
        const latest: CronFiringRecord | null = this.repos.cronFirings.latest(s.workflowId);
        return {
          workflowId: s.workflowId,
          cron: s.expression,
          timezone: s.timezone,
          enabled: this.config.getWorkflow(s.workflowId)?.enabled ?? false,
          nextSlot: s.nextSlot?.toISOString() ?? null,
          lastFiring: latest,
          lastConditions: s.lastConditions,
        };
      })
      .sort((a, b) => (a.workflowId < b.workflowId ? -1 : a.workflowId > b.workflowId ? 1 : 0));
  }
}
