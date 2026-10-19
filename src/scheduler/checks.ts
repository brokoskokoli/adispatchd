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

/** What identifies a check in diagnoses: its command and optional display name (WI-24). */
export interface CheckRef {
  command: string;
  name?: string;
}

/** Max. length of a display name derived from command + args. */
export const MAX_CHECK_LABEL_LENGTH = 80;

/**
 * Display name of a shell check (WI-24): the configured `name`, otherwise the
 * command (relative to the config dir when inside it; only the script name
 * when too long) plus its arguments, shortened to {@link MAX_CHECK_LABEL_LENGTH} characters.
 */
export function checkDisplayName(check: { command: string; name?: string; args?: readonly string[] }, configDir?: string): string {
  if (check.name !== undefined && check.name !== '') return check.name;
  let command = check.command;
  if (configDir) {
    const prefix = configDir.endsWith('/') ? configDir : `${configDir}/`;
    if (command.startsWith(prefix)) command = command.slice(prefix.length);
  }
  let text = [command, ...(check.args ?? [])].join(' ');
  // Too long: keep the script name and the arguments rather than the directory.
  const slash = command.lastIndexOf('/');
  if (text.length > MAX_CHECK_LABEL_LENGTH && slash > 0) text = [`…${command.slice(slash)}`, ...(check.args ?? [])].join(' ');
  return text.length > MAX_CHECK_LABEL_LENGTH ? `${text.slice(0, MAX_CHECK_LABEL_LENGTH - 1)}…` : text;
}

/** Short reference to a check in reasons: `0 "Credits available" (/path/check.sh)` or `0 (/path/check.sh)`. */
export function checkReason(c: { index: number; command: string; name?: string } | null | undefined): string {
  if (!c) return '? ()';
  return `${c.index}${c.name !== undefined ? ` "${c.name}"` : ''} (${c.command})`;
}

/** Diagnosis entry for a check that was not executed. */
export function notEvaluatedCheck(kind: CheckKind, index: number, check: CheckRef): CheckDiagnosis {
  return {
    kind,
    index,
    command: check.command,
    ...(check.name !== undefined ? { name: check.name } : {}),
    value: 'not_evaluated',
    cached: false,
    exitCode: null,
    error: null,
    durationMs: null,
  };
}

/** Diagnoses for all workflow conditions, none executed. */
export function notEvaluatedConditions(workflow: WorkflowConfig, kind: 'workflow_condition' | 'item_condition'): CheckDiagnosis[] {
  const list = kind === 'workflow_condition' ? workflow.conditions.workflow : workflow.conditions.item;
  return list.map((c, i) => notEvaluatedCheck(kind, i, c));
}

function fromResult(kind: CheckKind, index: number, check: CheckRef, r: ShellCheckResult): CheckDiagnosis {
  return {
    kind,
    index,
    command: check.command,
    ...(check.name !== undefined ? { name: check.name } : {}),
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

/**
 * Observer of executed workflow conditions (WI-24): called once per condition
 * of a {@link SchedulerChecks.workflowConditions} call, in order; `result` is
 * `null` when the condition was not executed (an earlier one decided, or its
 * argument template failed – then `diagnosis.error` says why).
 */
export type WorkflowConditionObserver = (
  workflow: WorkflowConfig,
  diagnosis: CheckDiagnosis,
  result: ShellCheckResult | null,
) => void;

/** Runs the scheduler's shell checks. */
export class SchedulerChecks {
  constructor(
    private readonly runner: ShellCheckRunner,
    private readonly now: () => Date,
    private readonly observer?: WorkflowConditionObserver,
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
    return fromResult('shell_filter', 0, filter, result);
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
        const skipped = notEvaluatedCheck(kind, index, condition);
        checks.push(skipped);
        if (kind === 'workflow_condition') this.notify(workflow, skipped, null);
        continue;
      }
      const { diag, result } = await this.runOne(workflow, kind, index, condition, target, signal);
      checks.push(diag);
      if (kind === 'workflow_condition') this.notify(workflow, diag, result);
      if (diag.value !== true) failed = diag;
    }
    const value: TriValue = failed === null ? true : failed.value === false ? false : 'unknown';
    return { value, checks, failed };
  }

  private notify(workflow: WorkflowConfig, diag: CheckDiagnosis, result: ShellCheckResult | null): void {
    try {
      this.observer?.(workflow, diag, result);
    } catch {
      // Observers are informational (UI status); they must never affect scheduling.
    }
  }

  private async runOne(
    workflow: WorkflowConfig,
    kind: 'workflow_condition' | 'item_condition',
    index: number,
    condition: ShellCheckConfig,
    target: CheckItem | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ diag: CheckDiagnosis; result: ShellCheckResult | null }> {
    let args: string[];
    try {
      const values = templateValues(workflow, this.now(), target);
      const scope = kind === 'item_condition' ? { source: true } : {};
      args = condition.args.map((a) => renderTemplate(a, values, { mode: 'text', scope }));
    } catch (err) {
      return { diag: { ...notEvaluatedCheck(kind, index, condition), value: 'unknown', error: `argument template: ${errorMessage(err)}` }, result: null };
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
    return { diag: fromResult(kind, index, condition, result), result };
  }
}
