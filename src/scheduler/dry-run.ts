/**
 * Workflow dry-run (Spec §19): source query, declarative filter analysis
 * (incl. dependencies), priorities, locks/blocks and capacity – without
 * workers, lifecycle actions, reservations or shell filters/conditions
 * (reported as `not_evaluated`). Read-only.
 *
 * Differences to a real planning step (documented in the handoff):
 * - Eligibility is evaluated before capacity, so every candidate shows its
 *   filter/lock/block status even when the limits are exhausted; capacity is
 *   then simulated in priority order (`pending_checks` candidates consume a
 *   slot, assuming their checks pass).
 * - Eligible candidates of a disabled workflow / with closed controller gate
 *   are reported as `workflow_unavailable` / `gate_closed`, never `would_start`.
 * - Only the given workflow is considered; higher-priority workflows that
 *   would take global slots first are not simulated.
 */
import { selectCompletionHook, systemClock, TECHNICAL_OUTCOME_HOOKS, type Clock } from '../core/index.js';
import { resultHookOutcomes, UnknownWorkflowError, workflowSecrets, type ConfigManager, type WorkflowConfig } from '../config/index.js';
import { sortCandidates } from '../filters/index.js';
import { notEvaluatedConditions } from './checks.js';
import { nextSlots, parseCron } from './cron.js';
import { checkEligibility, prepareSourceWorkflow, type SourceLookup } from './planner.js';
import type { SchedulingState } from './state.js';
import type { CandidateDiagnosis, CronSlotForecast, DryRunResult, GateInfo, HookRouting } from './types.js';

/** Dependencies of {@link dryRunWorkflow}. */
export interface DryRunDeps {
  config: ConfigManager;
  sources: SourceLookup;
  state: SchedulingState;
  clock?: Clock;
  /** Controller gate; omit when no controller runs (local CLI dry-run). */
  gate?: () => GateInfo;
  /** Additional notes (e.g. "no database"). */
  notes?: readonly string[];
  signal?: AbortSignal;
}

/** Number of upcoming cron slots shown. */
export const DRY_RUN_CRON_SLOTS = 5;
/** Number of recent cron firings shown. */
export const DRY_RUN_RECENT_FIRINGS = 10;

/**
 * Dry-run one workflow.
 * @throws UnknownWorkflowError
 */
export async function dryRunWorkflow(deps: DryRunDeps, workflowId: string): Promise<DryRunResult> {
  const eff = deps.config.getWorkflow(workflowId);
  if (!eff) throw new UnknownWorkflowError(workflowId);
  const workflow = eff.config;
  const now = (deps.clock ?? systemClock).now();
  const gate = deps.gate ? deps.gate() : null;
  const notes = [...(deps.notes ?? [])];
  if (!eff.enabled) notes.push('workflow is disabled: no automatic starts (manual starts remain possible)');
  if (gate === null) notes.push('controller state unknown (no running instance): pause/drain/readiness not considered');
  else if (!gate.canStartAutomatically) notes.push(`automatic starts are currently not possible: ${gate.reason ?? 'unknown'}`);
  notes.push('shell filters and conditions are never executed in a dry-run (not_evaluated)');
  if (workflow.execute.keep.length > 0) {
    const mb = Math.round((workflow.execute.keepMaxSizeBytes / 1024 ** 2) * 100) / 100;
    notes.push(`files kept after each run (execute.keep, max ${mb} MB per run): ${workflow.execute.keep.join(', ')}`);
  }

  const globalActive = deps.state.countActive();
  const workflowActive = deps.state.countActive(workflowId);
  const capacity = {
    global: { active: globalActive, max: deps.config.maxConcurrent },
    workflow: { active: workflowActive, max: eff.maxConcurrent },
  };
  const result: DryRunResult = {
    workflowId,
    name: workflow.name,
    trigger: workflow.trigger,
    generatedAt: now.toISOString(),
    enabled: eff.enabled,
    workflowPriority: eff.priority,
    capacity,
    gate,
    conditions: notEvaluatedConditions(workflow, 'workflow_condition'),
    source: null,
    candidates: [],
    cron: null,
    secrets: workflowSecrets(workflow),
    notes,
    summary: { candidates: 0, wouldStart: 0, pendingChecks: 0, notStartable: 0 },
    hooks: hookRouting(workflow),
  };

  const trigger = workflow.trigger;
  if (trigger.type === 'source') {
    const prepared = await prepareSourceWorkflow(workflow, eff.priority, {
      sources: deps.sources,
      at: result.generatedAt,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    result.source = {
      sourceId: trigger.source,
      polled: prepared.diagnosis.polled,
      filter: workflow.filter,
      pushdown: prepared.diagnosis.pushdown,
      error: prepared.diagnosis.error,
    };
    let simGlobal = globalActive;
    let simWorkflow = workflowActive;
    const ordered: CandidateDiagnosis[] = [];
    for (const candidate of sortCandidates(prepared.candidates)) {
      const eligibility = await checkEligibility(candidate, {
        state: deps.state,
        checks: null,
        workflowConditions: () => Promise.reject(new Error('shell checks are not executed in a dry-run')),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      const diag = candidate.diagnosis;
      ordered.push(diag);
      if (!eligibility.eligible) continue;
      if (!eff.enabled) {
        diag.decision = 'workflow_unavailable';
        diag.reason = 'eligible, but the workflow is disabled (no automatic starts)';
      } else if (gate && !gate.canStartAutomatically) {
        diag.decision = 'gate_closed';
        diag.reason = `eligible, but automatic starts are currently not possible (${gate.reason ?? 'unknown'})`;
      } else if (simGlobal >= capacity.global.max) {
        diag.decision = 'global_limit';
        diag.reason = `global limit reached (${simGlobal}/${capacity.global.max}, incl. candidates above)`;
      } else if (simWorkflow >= capacity.workflow.max) {
        diag.decision = 'workflow_limit';
        diag.reason = `workflow limit reached (${simWorkflow}/${capacity.workflow.max}, incl. candidates above)`;
      } else {
        simGlobal++;
        simWorkflow++;
        diag.decision = eligibility.pendingChecks ? 'pending_checks' : 'would_start';
        diag.reason = eligibility.pendingChecks
          ? 'declaratively eligible; would start if the shell filter/conditions pass'
          : 'eligible; would start';
      }
    }
    result.candidates = [...ordered, ...prepared.rejected];
  } else if (trigger.type === 'schedule') {
    const schedule = parseCron(trigger.cron, trigger.timezone);
    const block = deps.state.activeBlock(workflowId, null);
    let forecast: CronSlotForecast;
    let reason: string | null = null;
    if (!eff.enabled) forecast = 'skipped_disabled';
    else if (gate && !gate.canStartAutomatically && gate.reason) forecast = `skipped_${gate.reason}`;
    else if (globalActive >= capacity.global.max || workflowActive >= capacity.workflow.max) {
      forecast = 'skipped_limit';
      reason = `active runs: global ${globalActive}/${capacity.global.max}, workflow ${workflowActive}/${capacity.workflow.max}`;
    } else if (block) {
      forecast = 'skipped_blocked';
      reason = `retry block ${block.id}: ${block.reason}`;
    } else if (workflow.conditions.workflow.length > 0) {
      forecast = 'pending_checks';
      reason = 'would start if the workflow conditions pass';
    } else forecast = 'would_start';
    result.cron = {
      cron: trigger.cron,
      timezone: trigger.timezone,
      nextSlots: nextSlots(schedule, now, DRY_RUN_CRON_SLOTS).map((d) => d.toISOString()),
      nextSlotForecast: forecast,
      forecastReason: reason,
      recentFirings: deps.state.recentCronFirings(workflowId, DRY_RUN_RECENT_FIRINGS),
      blockId: block?.id ?? null,
    };
  } else {
    notes.push('manual workflow: runs only start manually (filters, conditions, blocks and limits do not apply)');
  }

  const counted = result.candidates;
  result.summary = {
    candidates: counted.length,
    wouldStart: counted.filter((c) => c.decision === 'would_start').length,
    pendingChecks: counted.filter((c) => c.decision === 'pending_checks').length,
    notStartable: counted.filter((c) => c.decision !== 'would_start' && c.decision !== 'pending_checks').length,
  };
  return result;
}

/** Completion hook routing of a workflow (WI-17): named outcomes and the hook per technical outcome. */
export function hookRouting(workflow: WorkflowConfig): HookRouting {
  const technical = {} as HookRouting['technical'];
  for (const status of Object.keys(TECHNICAL_OUTCOME_HOOKS) as Array<keyof typeof TECHNICAL_OUTCOME_HOOKS>) {
    technical[status] = selectCompletionHook(workflow.hooks, status, null);
  }
  return { onResult: resultHookOutcomes(workflow.hooks), technical };
}
