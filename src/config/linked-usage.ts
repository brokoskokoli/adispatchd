/**
 * Where a workflow uses the linked branch/PR fields (WI-21): placeholders
 * `{item.work_branch}` / `{item.work_pr}` in `execute` and lifecycle actions,
 * or the fields themselves in `filter` / `item_priority`.
 */
import { LINKED_ITEM_FIELDS, linkedFieldsUsed } from '../core/index.js';
import { collectFields } from '../filters/index.js';
import type { LifecycleActionConfig, WorkflowConfig } from './model.js';

/** Result of {@link linkedFieldUsage}. */
export interface LinkedFieldUsage {
  /** Fields behind the placeholders in `execute` (`working_directory`, `args`, `env`). */
  execute: string[];
  /** Fields behind the placeholders in `execute.working_directory` (path mode: `null` is an error). */
  workingDirectory: string[];
  /** Linked fields referenced in `filter` / `item_priority`. */
  filter: string[];
  /** True if any lifecycle action template uses the placeholders. */
  actions: boolean;
  /** True if the run start resolves the fields: used in `execute` or in `filter`/`item_priority`. */
  resolveAtStart: boolean;
  /** True if the workflow uses them anywhere (filter, item_priority, execute, actions). */
  any: boolean;
}

/** Template strings of one lifecycle action. */
export function actionTemplates(action: LifecycleActionConfig): string[] {
  switch (action.type) {
    case 'source.comment':
      return [action.message];
    case 'shell':
      return [...action.args, ...Object.values(action.env)];
    default:
      return [];
  }
}

/** All lifecycle actions of a workflow (every hook). */
function allActions(workflow: WorkflowConfig): LifecycleActionConfig[] {
  const out: LifecycleActionConfig[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) out.push(...(value as LifecycleActionConfig[]));
    else if (value && typeof value === 'object') for (const v of Object.values(value)) visit(v);
  };
  visit(workflow.hooks);
  return out;
}

/** See {@link LinkedFieldUsage}. Workflows without a source trigger never use them. */
export function linkedFieldUsage(workflow: WorkflowConfig): LinkedFieldUsage {
  if (workflow.trigger.type !== 'source') {
    return { execute: [], workingDirectory: [], filter: [], actions: false, resolveAtStart: false, any: false };
  }
  const execute = workflow.execute;
  // Container (WI-19): `command` takes the place of `args`.
  const commandArgs = execute.type === 'shell' ? execute.args : execute.command;
  const executeFields = linkedFieldsUsed([execute.workingDirectory, ...commandArgs, ...Object.values(execute.env)]);
  const workingDirectory = linkedFieldsUsed([execute.workingDirectory]);
  const linked = new Set<string>(LINKED_ITEM_FIELDS);
  const filter = [
    ...new Set(
      [...collectFields(workflow.filter), ...(workflow.itemPriority?.rules.flatMap((r) => collectFields(r.when)) ?? [])].filter((f) =>
        linked.has(f),
      ),
    ),
  ];
  const actions = allActions(workflow).some((a) => linkedFieldsUsed(actionTemplates(a)).length > 0);
  const resolveAtStart = executeFields.length > 0 || filter.length > 0;
  return { execute: executeFields, workingDirectory, filter, actions, resolveAtStart, any: resolveAtStart || actions };
}
