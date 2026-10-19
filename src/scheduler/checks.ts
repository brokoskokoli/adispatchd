/**
 * Shell filter and conditions for the scheduler (Spec §6, §7 step 5):
 * argument templates, check context, workflow-condition cache, diagnoses.
 */
import { buildTemplateValues, errorMessage, renderTemplate, type SourceItem, type TemplateValues, type TriValue } from '../core/index.js';
import type { ShellCheckConfig, ShellFilterConfig, WorkflowConfig } from '../config/index.js';
import { buildCheckContext, type ShellCheckResult, type ShellCheckRunner, type ShellCheckSpec } from '../filters/index.js';
import type { CheckDiagnosis, CheckKind } from './types.js';

/** Combined result of a list of checks (all must be `true`). */
export interface ChecksOutcome {
  value: TriValue;
  checks: CheckDiagnosis[];
  /** First check that was not `true`. */
  failed: CheckDiagnosis | null;
}

/** Diagnosis entry for a check that was not executed. */
export function notEvaluatedCheck(kind: CheckKind, index: number, command: string): CheckDiagnosis {
  return { kind, index, command, value: 'not_evaluated', cached: false, exitCode: null, error: null, durationMs: null };
}

/** Diagnoses for all workflow conditions, none executed. */
export function notEvaluatedConditions(workflow: WorkflowConfig, kind: 'workflow_condition' | 'item_condition'): CheckDiagnosis[] {
  const list = kind === 'workflow_condition' ? workflow.conditions.workflow : workflow.conditions.item;
  return list.map((c, i) => notEvaluatedCheck(kind, i, c.command));
}

function fromResult(kind: CheckKind, index: number, command: string, r: ShellCheckResult): CheckDiagnosis {
  return {
    kind,
    index,
    command,
    value: r.value,
    cached: r.cached,
    exitCode: r.exitCode,
    error: r.value === 'unknown' ? (r.error ?? 'check error') : null,
    durationMs: r.durationMs,
  };
}

function templateValues(workflow: WorkflowConfig, now: Date, target?: CheckItem): TemplateValues {
  const item = target?.item;
  const title = item?.fields.title;
  const repository = target?.repository;
  return buildTemplateValues({
    workflow: { id: workflow.id, name: workflow.name },
    ...(item
      ? {
          source: {
            id: item.sourceId,
            type: target.sourceType,
            ...(repository !== undefined ? { repository } : {}),
            ...(target.vars ? { vars: target.vars } : {}),
          },
          item: {
            id: item.itemId,
            key: item.key,
            ...(/^\d+$/.test(item.itemId) ? { number: item.itemId } : {}),
            url: item.url,
            ...(typeof title === 'string' ? { title } : {}),
          },
        }
      : {}),
    now,
  });
}

/** Item context for item-bound checks. */
export interface CheckItem {
  item: SourceItem;
  sourceType: string;
  repository?: string;
  /** Variables of the item's source (`{source.vars.<name>}`, WI-20). */
  vars?: Readonly<Record<string, string>>;
}

/** Runs the scheduler's shell checks. */
export class SchedulerChecks {
  constructor(
    private readonly runner: ShellCheckRunner,
    private readonly now: () => Date,
  ) {}

  /** Cache key of a workflow condition (WI-04 proposal). */
  static conditionCacheKey(workflowId: string, index: number): string {
    return `${workflowId}:condition:${index}`;
  }

  /** Workflow conditions in order; stops at the first non-`true` (rest `not_evaluated`). Cached per `cache` TTL. */
  async workflowConditions(workflow: WorkflowConfig, signal?: AbortSignal): Promise<ChecksOutcome> {
    return this.runList(workflow, 'workflow_condition', workflow.conditions.workflow, undefined, signal);
  }

  /** Item conditions in order (never cached). */
  async itemConditions(workflow: WorkflowConfig, target: CheckItem, signal?: AbortSignal): Promise<ChecksOutcome> {
    return this.runList(workflow, 'item_condition', workflow.conditions.item, target, signal);
  }

  /** Shell filter of a workflow for one item (never cached). */
  async shellFilter(workflow: WorkflowConfig, filter: ShellFilterConfig, target: CheckItem, signal?: AbortSignal): Promise<CheckDiagnosis> {
    const spec: ShellCheckSpec = { command: filter.command, timeoutMs: filter.timeoutMs };
    const ctx = buildCheckContext('shell_filter', workflow.id, target.item, target.sourceType);
    const result = await this.runner.run(spec, ctx, signal ? { signal } : {});
    return fromResult('shell_filter', 0, filter.command, result);
  }

  private async runList(
    workflow: WorkflowConfig,
    kind: 'workflow_condition' | 'item_condition',
    list: readonly ShellCheckConfig[],
    target: CheckItem | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ChecksOutcome> {
    const checks: CheckDiagnosis[] = [];
    let failed: CheckDiagnosis | null = null;
    for (const [index, condition] of list.entries()) {
      if (failed) {
        checks.push(notEvaluatedCheck(kind, index, condition.command));
        continue;
      }
      const diag = await this.runOne(workflow, kind, index, condition, target, signal);
      checks.push(diag);
      if (diag.value !== true) failed = diag;
    }
    const value: TriValue = failed === null ? true : failed.value === false ? false : 'unknown';
    return { value, checks, failed };
  }

  private async runOne(
    workflow: WorkflowConfig,
    kind: 'workflow_condition' | 'item_condition',
    index: number,
    condition: ShellCheckConfig,
    target: CheckItem | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CheckDiagnosis> {
    let args: string[];
    try {
      const values = templateValues(workflow, this.now(), target);
      const scope = kind === 'item_condition' ? { source: true } : {};
      args = condition.args.map((a) => renderTemplate(a, values, { mode: 'text', scope }));
    } catch (err) {
      return { ...notEvaluatedCheck(kind, index, condition.command), value: 'unknown', error: `argument template: ${errorMessage(err)}` };
    }
    const spec: ShellCheckSpec = { command: condition.command, args, timeoutMs: condition.timeoutMs };
    const ctx =
      kind === 'item_condition' && target
        ? buildCheckContext('item_condition', workflow.id, target.item, target.sourceType)
        : buildCheckContext('workflow_condition', workflow.id);
    const opts = signal ? { signal } : {};
    const result =
      kind === 'workflow_condition' && condition.cacheMs !== null && condition.cacheMs > 0
        ? await this.runner.runCached(SchedulerChecks.conditionCacheKey(workflow.id, index), condition.cacheMs, spec, ctx, opts)
        : await this.runner.run(spec, ctx, opts);
    return fromResult(kind, index, condition.command, result);
  }
}
