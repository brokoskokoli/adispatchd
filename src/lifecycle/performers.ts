/**
 * Execution of single lifecycle action attempts (Spec §10):
 * `source.update`, `source.comment` (with idempotency marker) and `shell`.
 * One call = one attempt; retry policy and journal handling live in the engine.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  LINKED_ITEM_FIELDS,
  commentMarker,
  dataPaths,
  linkedFieldsUsed,
  unknownLinkedField,
  type Executor,
  type FieldResolution,
  type HookName,
  type SourceAdapter,
  type SourceItem,
} from '../core/index.js';
import type {
  ShellActionConfig,
  SourceCommentActionConfig,
  SourceUpdateActionConfig,
  WorkflowSnapshot,
} from '../config/index.js';
import type { RunActionRecord, RunRecord } from '../persistence/index.js';
import {
  buildHookTemplateValues,
  buildShellActionContext,
  hookTemplateScope,
  isSourceWorkflow,
  itemFromRun,
  renderHookText,
  resolveActionIdentity,
} from './context.js';
import { LifecycleError } from './errors.js';

/** Resolves the adapter of a configured source ID (`undefined` if unknown). */
export type SourceResolver = (sourceId: string) => SourceAdapter | undefined;

/** Everything one attempt needs. */
export interface AttemptInput {
  run: RunRecord;
  snapshot: WorkflowSnapshot;
  hook: HookName;
  action: RunActionRecord;
  /** Number of this attempt (1-based, over the whole journal history of the action). */
  attempt: number;
  /** True if the action had attempts before this one (→ reconcile comments first). */
  hadPriorAttempts: boolean;
  /** Fresh item handed in by the caller, if any. */
  item: SourceItem | undefined;
  signal: AbortSignal | undefined;
  now: Date;
}

/** Successful attempt. */
export interface AttemptResult {
  /** External reference (comment ID), persisted as `external_key`. */
  externalKey: string | null;
  /** Journal/event details, e.g. applied labels, comment URL, `reconciled: true`. */
  details: Record<string, unknown>;
}

/** Dependencies of the performers. */
export interface PerformerDeps {
  sources: SourceResolver;
  executor: Executor;
  dataDir: string;
  shellCancelGraceMs: number;
  maxShellLogBytes: number;
}

interface SourceTarget {
  adapter: SourceAdapter;
  item: SourceItem;
}

/** Adapter + item for source actions. Uses the caller's item if it matches the run, else re-reads it. */
export async function resolveSourceTarget(
  deps: Pick<PerformerDeps, 'sources'>,
  run: RunRecord,
  snapshot: WorkflowSnapshot,
  given: SourceItem | undefined,
): Promise<SourceTarget> {
  if (!isSourceWorkflow(snapshot) || !snapshot.source) {
    throw new LifecycleError('no_source', `Workflow "${snapshot.workflow.id}" has no source; source actions are not possible`);
  }
  const adapter = deps.sources(snapshot.source.id);
  if (!adapter) {
    throw new LifecycleError('source_unavailable', `Source "${snapshot.source.id}" is not available`, {
      details: { sourceId: snapshot.source.id },
    });
  }
  const derived = itemFromRun(run);
  if (!derived) throw new LifecycleError('no_item', `Run ${run.id} is not bound to a source item`);
  if (given && given.key === derived.key) return { adapter, item: given };
  const item = await adapter.getItem(derived.itemId);
  if (!item) {
    throw new LifecycleError('item_not_found', `Item ${derived.key} no longer exists or is not visible`, {
      details: { itemKey: derived.key },
    });
  }
  return { adapter, item };
}

/**
 * Linked fields (WI-21) for action templates that use `{item.work_branch}` /
 * `{item.work_pr}`: resolved freshly at every attempt (a worker may have
 * opened the PR meanwhile). `undefined` if no template uses them. A used but
 * unknown field fails the attempt (retryable, e.g. after a rate limit) instead
 * of rendering an empty string.
 */
async function resolveLinkedForTemplates(
  deps: Pick<PerformerDeps, 'sources'>,
  input: AttemptInput,
  templates: readonly string[],
): Promise<{ target: SourceTarget; linked: Record<string, FieldResolution> } | undefined> {
  const used = linkedFieldsUsed(templates);
  if (used.length === 0 || !isSourceWorkflow(input.snapshot)) return undefined;
  const target = await resolveSourceTarget(deps, input.run, input.snapshot, input.item);
  const provided = new Set(target.adapter.fieldDefinitions().map((d) => d.name));
  const names = LINKED_ITEM_FIELDS.filter((f) => provided.has(f));
  const linked = names.length > 0 ? await target.adapter.resolveFields(target.item, names, input.signal ? { signal: input.signal } : {}) : {};
  const missing = unknownLinkedField(used, linked);
  if (missing) {
    throw new LifecycleError('linked_field_unknown', `{${missing.placeholder}} is unknown: ${missing.reason}`, {
      retryable: true,
      details: { field: missing.field },
    });
  }
  return { target, linked };
}

function requireIdentity(input: AttemptInput, config: SourceCommentActionConfig | SourceUpdateActionConfig): string {
  const identity = resolveActionIdentity(config, input.snapshot);
  if (!identity) throw new LifecycleError('no_identity', `No identity for action "${config.id}" (action → workflow → source)`);
  return identity;
}

/**
 * `source.update`: idempotent label and project field change via the adapter
 * (re-reads the item before writing; labels first, then project fields).
 */
export async function performSourceUpdate(
  deps: PerformerDeps,
  input: AttemptInput,
  config: SourceUpdateActionConfig,
): Promise<AttemptResult> {
  const identity = requireIdentity(input, config);
  const { adapter, item } = await resolveSourceTarget(deps, input.run, input.snapshot, input.item);
  const result = await adapter.applyUpdate(
    item,
    { labels: { add: config.labels.add, remove: config.labels.remove }, ...(config.project ? { project: config.project } : {}) },
    identity,
  );
  return { externalKey: null, details: { changed: result.changed, ...(result.applied ? { applied: result.applied } : {}) } };
}

/**
 * `source.comment`: renders the message, then posts it with the marker
 * `commentMarker(runId, actionId)`. If the action had attempts before
 * (failed, outcome unknown, interrupted), an existing comment with the marker
 * is searched first and, when found, taken as success instead of posting a duplicate.
 */
export async function performSourceComment(
  deps: PerformerDeps,
  input: AttemptInput,
  config: SourceCommentActionConfig,
): Promise<AttemptResult> {
  const identity = requireIdentity(input, config);
  // Render before any API call: template errors are permanent and must not post anything.
  const scope = hookTemplateScope(input.snapshot, input.hook);
  const probeValues = buildHookTemplateValues({ ...input, item: input.item ?? itemFromRun(input.run) });
  renderHookText(config.message, probeValues, scope);

  const resolved = await resolveLinkedForTemplates(deps, input, [config.message]);
  const { adapter, item } = resolved?.target ?? (await resolveSourceTarget(deps, input.run, input.snapshot, input.item));
  const linked = resolved?.linked;
  const marker = commentMarker(input.run.id, input.action.id);
  if (input.hadPriorAttempts) {
    const existing = await adapter.findCommentByMarker(item, marker, identity);
    if (existing) {
      return {
        externalKey: existing.id,
        details: { reconciled: true, marker, ...(existing.url ? { url: existing.url } : {}) },
      };
    }
  }
  const values = buildHookTemplateValues({
    ...input,
    item,
    ...(adapter.repository ? { repository: adapter.repository } : {}),
    ...(linked ? { linked } : {}),
  });
  const body = neutralizeHtmlComments(renderHookText(config.message, values, scope));
  const ref = await adapter.postComment(item, body, marker, identity);
  return { externalKey: ref.id, details: { marker, ...(ref.url ? { url: ref.url } : {}) } };
}

/**
 * Neutralize HTML comment openers in a comment body (`<!--` → `&lt;!--`).
 * Rendered values such as `{result.message}` are untrusted worker output and
 * must not be able to smuggle idempotency markers (`<!-- adispatchd:… -->`) or
 * hidden content into the comment; the adapter appends the only real marker.
 */
export function neutralizeHtmlComments(body: string): string {
  return body.replace(/<!--/g, '&lt;!--');
}

async function isDirectory(p: string | null): Promise<boolean> {
  if (!p) return false;
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `shell`: runs the command via the executor with the minimal environment
 * (no controller env), the rendered `env`/`args`, a JSON context file with
 * run + result (`ADISPATCH_CONTEXT_FILE`) and the action timeout. Exit code 0 =
 * success; anything else (exit ≠ 0, signal, timeout, start error) fails the attempt.
 * Working directory: the run workspace if it exists, else a per-attempt directory.
 */
export async function performShell(deps: PerformerDeps, input: AttemptInput, config: ShellActionConfig): Promise<AttemptResult> {
  const { run, snapshot, hook, action } = input;
  const resolved = await resolveLinkedForTemplates(deps, input, [...config.args, ...Object.values(config.env)]);
  const item = resolved?.target.item ?? input.item ?? itemFromRun(run);
  const linked = resolved?.linked;
  const scope = hookTemplateScope(snapshot, hook);
  const values = buildHookTemplateValues({
    run,
    snapshot,
    hook,
    item,
    now: input.now,
    ...(resolved?.target.adapter.repository ? { repository: resolved.target.adapter.repository } : {}),
    ...(linked ? { linked } : {}),
  });
  const args = config.args.map((a) => renderHookText(a, values, scope));
  const env: Record<string, string> = {};
  for (const [name, template] of Object.entries(config.env)) env[name] = renderHookText(template, values, scope);

  const paths = dataPaths(deps.dataDir).run(run.id);
  const attemptDir = path.join(paths.runDir, 'actions', String(action.id), `attempt-${input.attempt}`);
  const logDir = path.join(paths.logDir, 'actions', String(action.id), `attempt-${input.attempt}`);
  const files = {
    contextFile: path.join(attemptDir, 'context.json'),
    resultFile: path.join(attemptDir, 'result.json'),
    stdoutLog: path.join(logDir, 'stdout.log'),
    stderrLog: path.join(logDir, 'stderr.log'),
  };
  const useWorkspace = await isDirectory(run.workspacePath);
  const workingDirectory = useWorkspace && run.workspacePath ? run.workspacePath : path.join(attemptDir, 'cwd');

  const context = buildShellActionContext({
    run,
    snapshot,
    hook,
    item,
    action: { id: action.id, name: action.name, ordinal: action.ordinal, attempt: input.attempt },
    ...(linked ? { linked } : {}),
  });
  const proc = await deps.executor.start({
    runId: run.id,
    workflowId: snapshot.workflow.id,
    command: config.command,
    args,
    workingDirectory,
    createDirectory: !useWorkspace,
    env,
    secrets: {},
    context,
    files,
    timeouts: { maxDurationMs: config.timeoutMs },
    cancelGraceMs: deps.shellCancelGraceMs,
    maxLogBytes: deps.maxShellLogBytes,
  });
  const onAbort = (): void => {
    proc.cancel().catch(() => undefined);
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const outcome = await proc.wait().finally(() => input.signal?.removeEventListener('abort', onAbort));

  const logs = { stdout: files.stdoutLog, stderr: files.stderrLog };
  const base = { exitCode: outcome.exitCode, signal: outcome.signal, logs };
  if (outcome.spawnError) {
    throw new LifecycleError('shell_start_error', `Shell action could not be started: ${outcome.spawnError.message}`, {
      retryable: true,
      details: { ...base, spawnError: outcome.spawnError },
    });
  }
  if (outcome.cancelled) {
    throw new LifecycleError('shell_cancelled', 'Shell action was cancelled', { retryable: true, details: base });
  }
  if (outcome.timedOut) {
    throw new LifecycleError('shell_timeout', `Shell action exceeded its timeout (${config.timeoutMs} ms)`, {
      retryable: true,
      details: base,
    });
  }
  if (outcome.signal) {
    throw new LifecycleError('shell_signal', `Shell action was terminated by ${outcome.signal}`, { retryable: true, details: base });
  }
  if (outcome.exitCode !== 0) {
    throw new LifecycleError('shell_exit', `Shell action exited with code ${String(outcome.exitCode)}`, {
      retryable: true,
      details: base,
    });
  }
  return { externalKey: null, details: { exitCode: 0, logs } };
}
