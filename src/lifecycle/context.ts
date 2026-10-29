/**
 * Run context for lifecycle actions: the run's configuration snapshot
 * (Spec §12, §19), placeholder values/scope for hook actions (WI-02 table
 * "Platzhalter-Scopes") and the JSON context handed to `shell` actions.
 */
import {
  ARTIFACT_SOURCE_TYPE,
  artifactTemplateItem,
  WORKER_PROTOCOL_VERSION,
  buildTemplateValues,
  isRetryBlockHook,
  linkedTemplateItem,
  parseSourceItemKey,
  renderTemplate,
  type FieldResolution,
  type HookName,
  type IdentityRef,
  type SourceItem,
  type TemplateScope,
  type TemplateValues,
} from '../core/index.js';
import { WORKFLOW_SNAPSHOT_VERSION, sourceLocation, type LifecycleActionConfig, type WorkflowSnapshot } from '../config/index.js';
import type { RunRecord } from '../persistence/index.js';
import { LifecycleError } from './errors.js';

/**
 * Validate and return the workflow snapshot stored with a run
 * (`runs.config_snapshot`). Hooks always run against this snapshot, never
 * against the currently active configuration.
 *
 * @throws LifecycleError `lifecycle_invalid_snapshot`
 */
export function parseRunSnapshot(value: unknown, runId?: string): WorkflowSnapshot {
  const s = value as Partial<WorkflowSnapshot> | null;
  const ok =
    typeof s === 'object' &&
    s !== null &&
    s.schemaVersion === WORKFLOW_SNAPSHOT_VERSION &&
    typeof s.workflow === 'object' &&
    s.workflow !== null &&
    typeof s.workflow.id === 'string' &&
    typeof s.workflow.hooks === 'object' &&
    s.workflow.hooks !== null &&
    typeof s.workspace === 'object' &&
    s.workspace !== null;
  if (!ok) {
    throw new LifecycleError('invalid_snapshot', `${runId !== undefined ? `Run ${runId}` : 'Run'} has no valid workflow configuration snapshot`, {
      details: runId !== undefined ? { runId } : {},
    });
  }
  return s as WorkflowSnapshot;
}

/** True for workflows whose runs are bound to a source item (WI-02: `trigger.type: source`). */
export function isSourceWorkflow(snapshot: WorkflowSnapshot): boolean {
  return snapshot.workflow.trigger.type === 'source';
}

/** True for workflows whose run item is an artifact (WI-35). */
export function isArtifactWorkflow(snapshot: WorkflowSnapshot): boolean {
  return snapshot.source?.type === ARTIFACT_SOURCE_TYPE;
}

/**
 * Write identity of an action: action `identity` (only `source.comment`) →
 * workflow `identity` → source `identity` (WI-02, Spec §5.2).
 */
export function resolveActionIdentity(action: LifecycleActionConfig, snapshot: WorkflowSnapshot): IdentityRef | null {
  if (action.type === 'source.comment' && action.identity) return action.identity;
  return snapshot.workflow.identity ?? snapshot.source?.identity ?? null;
}

/**
 * Placeholder scope of hook actions (WI-02): `result` everywhere except
 * `on_start` and `on_retry_unblock`; `block.*` only in the retry-block hooks
 * (WI-30), `block.cleared_*` only in `on_retry_unblock`.
 */
export function hookTemplateScope(snapshot: WorkflowSnapshot, hook: HookName): TemplateScope {
  return {
    run: true,
    workspace: true,
    source: isSourceWorkflow(snapshot),
    result: hasResult(hook),
    linked: isSourceWorkflow(snapshot),
    artifact: isArtifactWorkflow(snapshot),
    artifactInput: isArtifactWorkflow(snapshot) && hook !== 'on_start',
    parameters: Object.keys(snapshot.workflow.parameters ?? {}),
    block: isRetryBlockHook(hook),
    blockCleared: hook === 'on_retry_unblock',
  };
}

/** Hooks that see the run's result (`result.*`): all but `on_start` and `on_retry_unblock` (WI-30). */
function hasResult(hook: HookName): boolean {
  return hook !== 'on_start' && hook !== 'on_retry_unblock';
}

/** Retry block of a hook action (WI-30) as rendered into `{block.*}` and the shell context. */
export interface HookBlockInfo {
  id: number;
  failureCount: number;
  createdAt: string;
  lastStatus: string | null;
  clearedAt: string | null;
  clearedBy: string | null;
}

/** `{block.cleared_by}` / shell context `block.cleared_by`: the recorded name, `anonymous` if none. */
function clearedByOf(block: HookBlockInfo): string | null {
  return block.clearedAt === null ? null : (block.clearedBy ?? 'anonymous');
}

/** Minimal item derived from the run when the source item is not available. */
export function itemFromRun(run: RunRecord): SourceItem | null {
  if (!run.sourceItemKey) return null;
  const { sourceId, itemId } = parseSourceItemKey(run.sourceItemKey);
  return { sourceId, itemId, key: run.sourceItemKey, url: run.sourceUrl ?? '', type: 'unknown', fields: {} };
}

/** The worker result (`runs.result_json`) as plain object, if any. */
function runResult(run: RunRecord): Record<string, unknown> | null {
  return typeof run.result === 'object' && run.result !== null ? (run.result as Record<string, unknown>) : null;
}

function scalarParameters(run: RunRecord): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(run.parameters ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Input for {@link buildHookTemplateValues}. */
export interface HookValueInput {
  run: RunRecord;
  snapshot: WorkflowSnapshot;
  hook: HookName;
  /** Item (fresh or derived from the run); `null` for sourceless runs. */
  item: SourceItem | null;
  /** `{source.repository}` (adapter's value); defaults to `owner/repository` of the snapshot source. */
  repository?: string;
  now: Date;
  /** Freshly resolved linked fields (WI-21) when an action template uses them. */
  linked?: Readonly<Record<string, FieldResolution>>;
  /** Retry block of `on_retry_block` / `on_retry_unblock` (WI-30). */
  block?: HookBlockInfo | null;
}

/** Placeholder values for a hook action of `run`. Result values only outside `on_start`. */
export function buildHookTemplateValues(input: HookValueInput): TemplateValues {
  const { run, snapshot, hook, item } = input;
  const source = isSourceWorkflow(snapshot) ? snapshot.source : null;
  const result = runResult(run);
  const title = item?.fields.title;
  return buildTemplateValues({
    workflow: { id: snapshot.workflow.id, name: snapshot.workflow.name },
    workspace: { baseDir: snapshot.workspace.baseDir, ...(run.workspacePath ? { path: run.workspacePath } : {}) },
    run: {
      id: run.id,
      trigger: run.triggerType,
      ...(run.startedAt ? { startedAt: new Date(run.startedAt) } : {}),
    },
    ...(source
      ? {
          source: {
            id: source.id,
            type: source.type,
            repository: input.repository ?? sourceLocation(source),
            // `vars` is missing in snapshots written before 0.3.0 (WI-20).
            vars: source.vars ?? {},
          },
        }
      : {}),
    ...(source && item
      ? {
          item: {
            id: item.itemId,
            key: item.key,
            ...(/^\d+$/.test(item.itemId) ? { number: item.itemId } : {}),
            ...(item.url ? { url: item.url } : {}),
            ...(typeof title === 'string' ? { title } : {}),
            ...linkedTemplateItem(input.linked),
            ...(isArtifactWorkflow(snapshot) ? artifactTemplateItem(item.fields, run.workspacePath ?? undefined) : {}),
          },
        }
      : {}),
    ...(input.block && isRetryBlockHook(hook)
      ? {
          block: {
            id: input.block.id,
            failures: input.block.failureCount,
            createdAt: input.block.createdAt,
            lastStatus: input.block.lastStatus,
            clearedAt: hook === 'on_retry_unblock' ? input.block.clearedAt : null,
            clearedBy: hook === 'on_retry_unblock' ? input.block.clearedBy : null,
          },
        }
      : {}),
    ...(hasResult(hook)
      ? {
          result: {
            ...(run.finalStatus ? { status: run.finalStatus } : {}),
            result: run.businessResult,
            ...(typeof result?.message === 'string' ? { message: result.message } : {}),
            ...(run.outcome ? { outcome: run.outcome } : {}),
          },
        }
      : {}),
    parameters: scalarParameters(run),
    now: input.now,
  });
}

/**
 * Render a hook-action text template. Unknown placeholders and placeholders
 * outside the hook's scope (e.g. `{result.message}` in `on_start`) are
 * rejected with a `TemplateError`, even if config validation was bypassed.
 */
export function renderHookText(template: string, values: TemplateValues, scope: TemplateScope): string {
  return renderTemplate(template, values, { mode: 'text', scope });
}

/** JSON context written to `ADISPATCH_CONTEXT_FILE` for `shell` actions. */
export type ShellActionContext = {
  schema_version: typeof WORKER_PROTOCOL_VERSION;
  kind: 'lifecycle_action';
  run: {
    id: string;
    trigger: string;
    status: string;
    started_at: string | null;
    finished_at: string | null;
  };
  workflow: { id: string; name: string };
  hook: HookName;
  action: { id: number; name: string | null; ordinal: number; type: 'shell'; attempt: number };
  /** Shape of `WorkerContext.source` (sets `ADISPATCH_SOURCE_*`). */
  source?: {
    id: string;
    type: string;
    item_id: string;
    item_key: string;
    url: string;
    attributes: Record<string, unknown>;
  };
  parameters: Record<string, string | number | boolean>;
  workspace: { path: string | null; base_dir: string };
  /** Retry block (WI-30): only in `on_retry_block` / `on_retry_unblock` (`cleared_*` `null` in `on_retry_block`). */
  block?: {
    id: number;
    failures: number;
    created_at: string;
    last_status: string | null;
    cleared_at: string | null;
    cleared_by: string | null;
  };
  /** Final run outcome and worker result; `null` in `on_start` and `on_retry_unblock`. */
  result: {
    status: string | null;
    result: string | null;
    reason: string | null;
    message: string | null;
    /** Named outcome (WI-17), `null` if the worker reported none. */
    outcome: string | null;
    details: unknown;
    artifacts: unknown;
  } | null;
};

/** Build the context of a `shell` action. Contains no secrets. */
export function buildShellActionContext(input: {
  run: RunRecord;
  snapshot: WorkflowSnapshot;
  hook: HookName;
  item: SourceItem | null;
  action: { id: number; name: string | null; ordinal: number; attempt: number };
  /** Linked fields (WI-21) resolved for this attempt; known values go to `source.attributes`. */
  linked?: Readonly<Record<string, FieldResolution>>;
  /** Retry block of `on_retry_block` / `on_retry_unblock` (WI-30). */
  block?: HookBlockInfo | null;
}): ShellActionContext {
  const { run, snapshot, hook, item } = input;
  const result = runResult(run);
  const source = isSourceWorkflow(snapshot) ? snapshot.source : null;
  return {
    schema_version: WORKER_PROTOCOL_VERSION,
    kind: 'lifecycle_action',
    run: {
      id: run.id,
      trigger: run.triggerType,
      status: run.status,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
    },
    workflow: { id: snapshot.workflow.id, name: snapshot.workflow.name },
    hook,
    action: { ...input.action, type: 'shell' },
    ...(source && item
      ? {
          source: {
            id: source.id,
            type: source.type,
            item_id: item.itemId,
            item_key: item.key,
            url: item.url,
            attributes: { ...item.fields, ...knownAttributes(input.linked) },
          },
        }
      : {}),
    ...(input.block && isRetryBlockHook(hook)
      ? {
          block: {
            id: input.block.id,
            failures: input.block.failureCount,
            created_at: input.block.createdAt,
            last_status: input.block.lastStatus,
            cleared_at: hook === 'on_retry_unblock' ? input.block.clearedAt : null,
            cleared_by: hook === 'on_retry_unblock' ? clearedByOf(input.block) : null,
          },
        }
      : {}),
    parameters: scalarParameters(run),
    workspace: { path: run.workspacePath, base_dir: snapshot.workspace.baseDir },
    result:
      !hasResult(hook)
        ? null
        : {
            status: run.finalStatus,
            result: run.businessResult,
            reason: run.finalReason,
            message: typeof result?.message === 'string' ? result.message : null,
            outcome: run.outcome,
            details: result?.details ?? null,
            artifacts: result?.artifacts ?? null,
          },
  };
}

function knownAttributes(linked: Readonly<Record<string, FieldResolution>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, res] of Object.entries(linked ?? {})) if (res.known) out[name] = res.value;
  return out;
}
