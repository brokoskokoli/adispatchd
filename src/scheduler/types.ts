/**
 * Diagnostic types of the scheduler (Spec §7, §19): planning diagnosis per
 * workflow (kept in memory for GUI/API), dry-run results and cron status.
 * All types are plain JSON-serializable data.
 */
import type { FieldResolution, FilterNode } from '../core/index.js';
import type { TriggerConfig, WorkflowSecretInfo } from '../config/index.js';
import type { CronFiringRecord } from '../persistence/index.js';
import type { FilterTrace, TraceValue } from '../filters/index.js';

/**
 * Decision for one source candidate in a planning step or dry-run.
 *
 * - `started` – reserved and handed to the run controller (planning step only).
 * - `would_start` – dry-run: every check passed and a slot is free.
 * - `pending_checks` – dry-run: declaratively eligible and a slot is free, but
 *   shell filter / conditions were not executed (`not_evaluated`).
 * - `filtered` – the declarative filter is `false`.
 * - `filter_unknown` – the declarative filter is `unknown` (not startable, Spec §6).
 * - `shell_filter_rejected` / `shell_filter_unknown` – shell filter exit 1 / check error.
 * - `condition_failed` / `condition_unknown` – a workflow or item condition is false / unknown.
 * - `locked` – an active run of the same workflow holds the item lock.
 * - `blocked` – an active retry block exists for the workflow/item.
 * - `workflow_limit` / `global_limit` – no free slot.
 * - `workflow_unavailable` – the workflow was disabled/removed/changed during the planning step.
 * - `gate_closed` – automatic starts were paused/stopped during the planning step.
 * - `start_failed` – reservation or controller start failed unexpectedly.
 */
export type CandidateDecision =
  | 'started'
  | 'would_start'
  | 'pending_checks'
  | 'filtered'
  | 'filter_unknown'
  | 'shell_filter_rejected'
  | 'shell_filter_unknown'
  | 'condition_failed'
  | 'condition_unknown'
  | 'locked'
  | 'blocked'
  | 'workflow_limit'
  | 'global_limit'
  | 'workflow_unavailable'
  | 'gate_closed'
  | 'start_failed';

/** Kind of a shell check. */
export type CheckKind = 'workflow_condition' | 'item_condition' | 'shell_filter';

/** Diagnosis of one shell check (shell filter or condition). */
export interface CheckDiagnosis {
  kind: CheckKind;
  /** Index in `conditions.workflow` / `conditions.item` (0 for the shell filter). */
  index: number;
  command: string;
  /** `not_evaluated` = not executed (dry-run, or skipped because an earlier check already decided). */
  value: TraceValue;
  /** Served from the workflow-condition cache. */
  cached: boolean;
  exitCode: number | null;
  /** Error detail when `value` is `unknown`. */
  error: string | null;
  durationMs: number | null;
}

/** Diagnosis of one source candidate. */
export interface CandidateDiagnosis {
  workflowId: string;
  sourceId: string;
  itemId: string;
  itemKey: string;
  url: string;
  title: string | null;
  createdAt: string | null;
  /** Effective workflow priority (overrides applied). */
  workflowPriority: number;
  itemPriority: number;
  /** Index of the matching `item_priority` rule, `null` = default. */
  matchedPriorityRule: number | null;
  decision: CandidateDecision;
  /** Human-readable explanation. */
  reason: string | null;
  /** Trace of the declarative filter (`null` if the workflow has none). */
  filter: FilterTrace | null;
  shellFilter: CheckDiagnosis | null;
  itemConditions: CheckDiagnosis[];
  /** Started run (`started`) or lock holder (`locked`). */
  runId: string | null;
  /** Active block (`blocked`). */
  blockId: number | null;
  /**
   * Values (or unknown reasons) of the source's GitHub Projects fields
   * `project.*` for this item; absent when the source declares none.
   */
  projectFields?: Record<string, FieldResolution>;
}

/** Status of a workflow in the last planning step. */
export type WorkflowPlanningStatus = 'ok' | 'disabled' | 'source_error';

/** Last planning diagnosis of one source workflow (in memory, Spec §7). */
export interface WorkflowPlanningDiagnosis {
  workflowId: string;
  /** Planning step start (ISO-8601). */
  at: string;
  status: WorkflowPlanningStatus;
  /** Source problem (`source_error`), e.g. API failure or missing adapter. */
  error: string | null;
  sourceId: string;
  /** Number of items returned by the source (after de-duplication). */
  polled: number;
  /** Pushed-down part of the filter (informational). */
  pushdown: FilterNode | null;
  /** Workflow conditions, evaluated at most once per planning step (`not_evaluated` if no candidate needed them). */
  conditions: CheckDiagnosis[];
  /** Candidates in planning order (startable order first, rejected-by-cheap-filter last). */
  candidates: CandidateDiagnosis[];
  /** Candidate entries dropped because of {@link MAX_DIAGNOSED_CANDIDATES}. */
  omittedCandidates: number;
  /** Runs started for this workflow in the step. */
  startedRunIds: string[];
}

/** Why a planning step (or cron slot) could not start anything automatically. */
export type GateReason = 'not_ready' | 'paused' | 'draining';

/** Summary of one planning step. */
export interface PlanningStepReport {
  startedAt: string;
  finishedAt: string;
  /** Set when the step was skipped as a whole (controller gate). */
  skipped: GateReason | null;
  /** Runs started in this step. */
  startedRunIds: string[];
  /** Diagnoses of the source workflows considered in this step. */
  workflows: WorkflowPlanningDiagnosis[];
}

/**
 * Decision vocabulary of `cron_firings.decision` (Spec §5.5, §7):
 * - `started` – a run was reserved for the slot (`run_id` set);
 * - `skipped_missed` – slot passed while the orchestrator was down or the
 *   slot was handled too late (beyond the misfire tolerance); never caught up;
 * - `skipped_disabled` – workflow disabled (config or override);
 * - `skipped_paused` / `skipped_not_ready` / `skipped_draining` – controller gate;
 * - `skipped_limit` – global or workflow limit reached;
 * - `skipped_blocked` – active workflow-scope retry block;
 * - `skipped_condition` / `skipped_condition_unknown` – a workflow condition is false / unknown;
 * - `skipped_lock` – the slot's lock is held (defensive, should not happen);
 * - `start_failed` – reservation/start failed unexpectedly.
 */
export type CronSlotDecision =
  | 'started'
  | 'skipped_missed'
  | 'skipped_disabled'
  | 'skipped_paused'
  | 'skipped_not_ready'
  | 'skipped_draining'
  | 'skipped_limit'
  | 'skipped_blocked'
  | 'skipped_condition'
  | 'skipped_condition_unknown'
  | 'skipped_lock'
  | 'start_failed';

/** Cron status of one schedule workflow (for GUI/API). */
export interface CronWorkflowStatus {
  workflowId: string;
  cron: string;
  timezone: string;
  /** Effective `enabled` (slots of disabled workflows are recorded as `skipped_disabled`). */
  enabled: boolean;
  /** Next slot the timer is armed for (ISO-8601 UTC), `null` if none. */
  nextSlot: string | null;
  /** Latest persisted firing (any decision). */
  lastFiring: CronFiringRecord | null;
  /** Diagnosis of the workflow conditions at the last slot that evaluated them. */
  lastConditions: CheckDiagnosis[];
}

/** Capacity numbers (active = all active runs incl. manual and `recovery_pending`). */
export interface CapacityInfo {
  global: { active: number; max: number };
  workflow: { active: number; max: number };
}

/** Controller gate as seen by a dry-run (`null` when no controller is available, e.g. CLI). */
export interface GateInfo {
  canStartAutomatically: boolean;
  reason: GateReason | null;
}

/** Dry-run decision for the next cron slot. */
export type CronSlotForecast =
  | 'would_start'
  | 'pending_checks'
  | 'skipped_disabled'
  | 'skipped_limit'
  | 'skipped_blocked'
  | 'skipped_paused'
  | 'skipped_not_ready'
  | 'skipped_draining';

/** Structured dry-run result (CLI / API / GUI), Spec §19. */
export interface DryRunResult {
  workflowId: string;
  name: string;
  trigger: TriggerConfig;
  generatedAt: string;
  /** Effective values (overrides applied). */
  enabled: boolean;
  workflowPriority: number;
  capacity: CapacityInfo;
  gate: GateInfo | null;
  /** Workflow conditions – never executed in a dry-run (`not_evaluated`). */
  conditions: CheckDiagnosis[];
  /**
   * Source workflows only. `filter` is the declarative filter as evaluated: references to named
   * filters (WI-15) are already expanded.
   */
  source: { sourceId: string; polled: number; filter: FilterNode | null; pushdown: FilterNode | null; error: string | null } | null;
  /** Source workflows only; planning order, cheap-filter rejections last. */
  candidates: CandidateDiagnosis[];
  /** Schedule workflows only. */
  cron: {
    cron: string;
    timezone: string;
    nextSlots: string[];
    nextSlotForecast: CronSlotForecast;
    forecastReason: string | null;
    recentFirings: CronFiringRecord[];
    blockId: number | null;
  } | null;
  /**
   * Declared secrets of `execute` and `shell` actions (WI-18): names, identity, delivery – never values.
   * Missing in results of older instances.
   */
  secrets?: WorkflowSecretInfo[];
  /** Notes about the limits of this dry-run (e.g. no database, no controller). */
  notes: string[];
  summary: { candidates: number; wouldStart: number; pendingChecks: number; notStartable: number };
}

/** Upper bound of candidate entries kept per workflow diagnosis. */
export const MAX_DIAGNOSED_CANDIDATES = 500;
