/**
 * Candidate discovery and eligibility for source workflows (Spec §7 steps
 * 1–5), shared by the planning step and the dry-run.
 *
 * - Step 1: poll the source with the pushed-down part of the filter and
 *   evaluate the filter with CHEAP fields only. Strong Kleene logic is
 *   monotonic, so a cheap `false` is final (item dropped) and a cheap `true`
 *   is final; only a cheap `unknown` needs the expensive fields (step 5).
 * - Step 2: de-duplicate by `(source, item, workflow)`.
 * - Step 3: item priority (same field source → one batch of expensive fields).
 * - Step 4: active lock / retry block of the workflow+item.
 * - Step 5 (lazy): workflow conditions (once per step), expensive declarative
 *   filter, shell filter, item conditions. The dry-run never executes shell
 *   checks: they are reported as `not_evaluated`.
 */
import {
  errorMessage,
  type FieldResolution,
  type FilterNode,
  type SourceAdapter,
  type SourceItem,
} from '../core/index.js';
import type { WorkflowConfig } from '../config/index.js';
import {
  collectFields,
  createItemFieldSource,
  evaluateFilter,
  resolveItemPriority,
  splitForPushdown,
  type FieldSource,
  type FilterEvaluation,
  type PrioritizedCandidate,
} from '../filters/index.js';
import { notEvaluatedCheck, notEvaluatedConditions, type ChecksOutcome, type SchedulerChecks } from './checks.js';
import type { SchedulingState } from './state.js';
import type { CandidateDiagnosis, CheckDiagnosis, WorkflowPlanningDiagnosis } from './types.js';

/** Resolves a configured source ID to its adapter. */
export type SourceLookup = (sourceId: string) => SourceAdapter | undefined;

/** A candidate that passed the cheap filter (or whose filter needs expensive fields). */
export interface PreparedCandidate extends PrioritizedCandidate {
  itemKey: string;
  workflow: WorkflowConfig;
  adapter: SourceAdapter;
  item: SourceItem;
  /** Memoizing field source of this planning step (expensive fields fetched at most once). */
  fields: FieldSource;
  /** Cheap-only filter evaluation; `null` if the workflow has no filter. */
  cheap: FilterEvaluation | null;
  diagnosis: CandidateDiagnosis;
}

/** Result of {@link prepareSourceWorkflow}. */
export interface PreparedWorkflow {
  diagnosis: WorkflowPlanningDiagnosis;
  /** Candidates to consider, unsorted. */
  candidates: PreparedCandidate[];
  /** Items rejected by the cheap filter (diagnosis only). */
  rejected: CandidateDiagnosis[];
}

/** Field source that treats expensive fields as unknown without resolving them. */
export function cheapOnly(fields: FieldSource): FieldSource {
  return {
    isExpensive: (f) => fields.isExpensive?.(f) ?? false,
    fieldType: (f) => fields.fieldType?.(f),
    resolve(field: string): Promise<FieldResolution> | FieldResolution {
      if (fields.isExpensive?.(field)) return { known: false, reason: 'expensive field, evaluated later' };
      return fields.resolve(field);
    },
  };
}

/** Cache of `listCandidates` calls within one planning step: `(source, pushdown) → items`. */
export type ListCache = Map<string, Promise<SourceItem[]>>;

function emptyDiagnosis(workflow: WorkflowConfig, at: string, sourceId: string): WorkflowPlanningDiagnosis {
  return {
    workflowId: workflow.id,
    at,
    status: 'ok',
    error: null,
    sourceId,
    polled: 0,
    pushdown: null,
    conditions: notEvaluatedConditions(workflow, 'workflow_condition'),
    candidates: [],
    omittedCandidates: 0,
    startedRunIds: [],
  };
}

/**
 * Steps 1–3 for one source workflow: poll, de-duplicate, cheap filter, item
 * priority. Never throws; source problems end up in the diagnosis
 * (`status: 'source_error'`) without affecting other workflows.
 */
export async function prepareSourceWorkflow(
  workflow: WorkflowConfig,
  workflowPriority: number,
  options: { sources: SourceLookup; at: string; listCache?: ListCache; signal?: AbortSignal },
): Promise<PreparedWorkflow> {
  if (workflow.trigger.type !== 'source') throw new TypeError(`Workflow ${workflow.id} is not source-triggered`);
  const sourceId = workflow.trigger.source;
  const diagnosis = emptyDiagnosis(workflow, options.at, sourceId);
  const adapter = options.sources(sourceId);
  if (!adapter) {
    diagnosis.status = 'source_error';
    diagnosis.error = `source '${sourceId}' is not available`;
    return { diagnosis, candidates: [], rejected: [] };
  }
  const filter = workflow.filter;
  const definitions = adapter.fieldDefinitions();
  let pushdown: FilterNode | null = null;
  if (filter) pushdown = splitForPushdown(filter, definitions).pushdown;
  diagnosis.pushdown = pushdown;

  let items: SourceItem[];
  try {
    const key = `${sourceId}\u0000${JSON.stringify(pushdown)}`;
    let listing = options.listCache?.get(key);
    if (!listing) {
      listing = adapter.listCandidates({
        ...(pushdown ? { filter: pushdown } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.listCache?.set(key, listing);
    }
    items = await listing;
  } catch (err) {
    diagnosis.status = 'source_error';
    diagnosis.error = `polling source '${sourceId}' failed: ${errorMessage(err)}`;
    return { diagnosis, candidates: [], rejected: [] };
  }

  // Step 2: normalize (source-id, item-id, workflow-id).
  const unique = new Map<string, SourceItem>();
  for (const item of items) if (!unique.has(item.key)) unique.set(item.key, item);
  diagnosis.polled = unique.size;

  const wanted = new Set<string>(filter ? collectFields(filter) : []);
  for (const rule of workflow.itemPriority?.rules ?? []) for (const f of collectFields(rule.when)) wanted.add(f);
  const wantedFields = [...wanted];

  const candidates: PreparedCandidate[] = [];
  const rejected: CandidateDiagnosis[] = [];
  for (const item of unique.values()) {
    const fields = createItemFieldSource(item, {
      definitions,
      resolveFields: (i, f) => adapter.resolveFields(i, f, options.signal ? { signal: options.signal } : {}),
      wantedFields,
    });
    const cheap = filter ? await evaluateFilter(filter, cheapOnly(fields)) : null;
    const title = item.fields.title;
    const diag: CandidateDiagnosis = {
      workflowId: workflow.id,
      sourceId,
      itemId: item.itemId,
      itemKey: item.key,
      url: item.url,
      title: typeof title === 'string' ? title : null,
      createdAt: item.createdAt ?? null,
      workflowPriority,
      itemPriority: 0,
      matchedPriorityRule: null,
      decision: 'filtered',
      reason: null,
      filter: cheap?.trace ?? null,
      shellFilter: null,
      itemConditions: [],
      runId: null,
      blockId: null,
    };
    if (cheap?.value === false) {
      diag.reason = 'declarative filter does not match';
      rejected.push(diag);
      continue;
    }
    // Step 3: item priority (rules may need expensive fields: same memoized batch).
    const priority = await resolveItemPriority(workflow.itemPriority, fields);
    diag.itemPriority = priority.priority;
    diag.matchedPriorityRule = priority.matchedRule;
    candidates.push({
      workflowId: workflow.id,
      workflowPriority,
      itemPriority: priority.priority,
      createdAt: item.createdAt,
      itemKey: item.key,
      workflow,
      adapter,
      item,
      fields,
      cheap,
      diagnosis: diag,
    });
  }
  return { diagnosis, candidates, rejected };
}

/** Outcome of {@link checkEligibility}. */
export type Eligibility =
  /** Startable now; `pendingChecks` = shell checks were skipped (dry-run). */
  | { eligible: true; pendingChecks: boolean }
  | { eligible: false };

/** How {@link checkEligibility} treats shell checks. */
export interface EligibilityContext {
  state: SchedulingState;
  /** `null` = dry-run: shell filter and conditions are not executed. */
  checks: SchedulerChecks | null;
  /** Workflow conditions of the current step (memoized by the caller); only called in live mode. */
  workflowConditions(workflow: WorkflowConfig): Promise<ChecksOutcome>;
  signal?: AbortSignal;
}

/**
 * Steps 4–5 for one candidate (lock, block, workflow conditions, expensive
 * filter, shell filter, item conditions). Updates `candidate.diagnosis` with
 * decision/reason for rejected candidates. Capacity is checked by the caller.
 */
export async function checkEligibility(candidate: PreparedCandidate, ctx: EligibilityContext): Promise<Eligibility> {
  const { workflow, diagnosis: diag } = candidate;
  const reject = (decision: CandidateDiagnosis['decision'], reason: string): Eligibility => {
    diag.decision = decision;
    diag.reason = reason;
    return { eligible: false };
  };

  // Step 4: active lock / retry block.
  const holder = ctx.state.activeRunForItem(workflow.id, candidate.itemKey);
  if (holder) {
    diag.runId = holder.id;
    return reject('locked', `run ${holder.id} of this workflow is active for the item`);
  }
  const block = ctx.state.activeBlock(workflow.id, candidate.itemKey);
  if (block) {
    diag.blockId = block.id;
    return reject('blocked', `retry block ${block.id}: ${block.reason}`);
  }

  let pending = false;
  // Step 5a: workflow conditions (once per planning step).
  if (workflow.conditions.workflow.length > 0) {
    if (ctx.checks) {
      const outcome = await ctx.workflowConditions(workflow);
      if (outcome.value !== true) {
        const f = outcome.failed;
        return outcome.value === false
          ? reject('condition_failed', `workflow condition ${f?.index ?? '?'} (${f?.command ?? ''}) is false`)
          : reject('condition_unknown', `workflow condition ${f?.index ?? '?'} (${f?.command ?? ''}) is unknown: ${f?.error ?? 'check error'}`);
      }
    } else {
      pending = true;
    }
  }

  // Step 5b: expensive declarative filter (only if the cheap pass could not decide).
  if (workflow.filter && candidate.cheap && candidate.cheap.value !== true) {
    const full = await evaluateFilter(workflow.filter, candidate.fields);
    diag.filter = full.trace;
    if (full.value === false) return reject('filtered', 'declarative filter does not match');
    if (full.value === 'unknown') return reject('filter_unknown', 'declarative filter is unknown (see trace)');
  }

  const target = {
    item: candidate.item,
    sourceType: candidate.adapter.type,
    ...(candidate.adapter.repository !== undefined ? { repository: candidate.adapter.repository } : {}),
  };
  // Step 5c: shell filter.
  if (workflow.shellFilter) {
    if (ctx.checks) {
      const sf = await ctx.checks.shellFilter(workflow, workflow.shellFilter, target, ctx.signal);
      diag.shellFilter = sf;
      if (sf.value === false) return reject('shell_filter_rejected', 'shell filter exited with 1');
      if (sf.value !== true) return reject('shell_filter_unknown', `shell filter check error: ${sf.error ?? 'unknown'}`);
    } else {
      diag.shellFilter = notEvaluatedCheck('shell_filter', 0, workflow.shellFilter.command);
      pending = true;
    }
  }

  // Step 5d: item conditions.
  if (workflow.conditions.item.length > 0) {
    if (ctx.checks) {
      const outcome = await ctx.checks.itemConditions(workflow, target, ctx.signal);
      diag.itemConditions = outcome.checks;
      if (outcome.value !== true) {
        const f = outcome.failed as CheckDiagnosis;
        return outcome.value === false
          ? reject('condition_failed', `item condition ${f.index} (${f.command}) is false`)
          : reject('condition_unknown', `item condition ${f.index} (${f.command}) is unknown: ${f.error ?? 'check error'}`);
      }
    } else {
      diag.itemConditions = notEvaluatedConditions(workflow, 'item_condition');
      pending = true;
    }
  }
  return { eligible: true, pendingChecks: pending };
}

/**
 * Re-check for the item re-read by the run controller right before `on_start`
 * (Spec §7 races): the cheap part of the filter on the fresh item. `false`
 * cancels the run without hooks; `unknown` (expensive fields) does not.
 */
export function verifyItemFor(workflow: WorkflowConfig, adapter: SourceAdapter): ((item: SourceItem) => Promise<boolean>) | undefined {
  const filter = workflow.filter;
  if (!filter) return undefined;
  const definitions = adapter.fieldDefinitions();
  return async (item) => {
    const fields = createItemFieldSource(item, { definitions });
    const result = await evaluateFilter(filter, cheapOnly(fields));
    return result.value !== false;
  };
}
