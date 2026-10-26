/**
 * Execution of single lifecycle action attempts (Spec §10):
 * `source.update`, `source.comment` (with idempotency marker) and `shell`.
 * One call = one attempt; retry policy and journal handling live in the engine.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  LINKED_ITEM_FIELDS,
  type ActionEffect,
  type ProjectFieldUpdateValue,
  type SourceUpdateApplied,
  commentMarker,
  dataPaths,
  linkedFieldsUsed,
  unknownLinkedField,
  type Clock,
  type CredentialProvider,
  type ExecutionOutcome,
  type Executor,
  type FieldResolution,
  type Logger,
  type Timers,
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
import { TOKEN_DIR_NAME, TokenFileSession, isTokenDirInWorkspace, type TokenFileRequest } from '../executors/index.js';
import type { RunActionRecord, RunRecord } from '../persistence/index.js';
import {
  buildHookTemplateValues,
  buildShellActionContext,
  hookTemplateScope,
  isSourceWorkflow,
  itemFromRun,
  renderHookText,
  resolveActionIdentity,
  type HookBlockInfo,
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
  /** Retry block of `on_retry_block` / `on_retry_unblock` (WI-30), else `null`/absent. */
  block?: HookBlockInfo | null;
}

/** Successful attempt. */
export interface AttemptResult {
  /** External reference (comment ID), persisted as `external_key`. */
  externalKey: string | null;
  /** Journal/event details, e.g. applied labels, comment URL, `reconciled: true`. */
  details: Record<string, unknown>;
  /** Structured effect for the item history (WI-33, `run_actions.effect_json`). */
  effect?: ActionEffect;
}

/** Effect of a (possibly partial) `source.update` from what the adapter applied (WI-33). */
export function updateEffect(applied: SourceUpdateApplied | undefined | null): ActionEffect {
  const effect: ActionEffect = {};
  if (applied?.labelsAdded && applied.labelsAdded.length > 0) effect.labelsAdded = [...applied.labelsAdded];
  if (applied?.labelsRemoved && applied.labelsRemoved.length > 0) effect.labelsRemoved = [...applied.labelsRemoved];
  const fields = Object.entries(applied?.projectFields ?? {});
  if (fields.length > 0) {
    const previous = applied?.projectFieldsPrevious ?? {};
    effect.projectFields = fields.map(([name, to]) => ({ name, ...(Object.hasOwn(previous, name) ? { from: previous[name] ?? null } : {}), to }));
  }
  if (applied?.projectItemAdded) effect.projectItemAdded = true;
  if (Object.keys(effect).length === 0) effect.unchanged = true;
  return effect;
}

/**
 * Combine the effects of several attempts of one action (WI-33): labels as the
 * net change (added then removed again = no change), project fields with the
 * first known old value and the last new value (dropped when back at the old
 * value), the item counts as added to the project once it was, the latest
 * comment reference and shell exit status win. `null` = nothing known.
 */
export function mergeEffects(previous: ActionEffect | null | undefined, next: ActionEffect | null | undefined): ActionEffect | null {
  if (!previous) return next ?? null;
  if (!next) return previous;
  const labels = new Map<string, { name: string; state: 'added' | 'removed' }>();
  const apply = (names: readonly string[] | undefined, state: 'added' | 'removed'): void => {
    for (const name of names ?? []) {
      const key = name.toLowerCase();
      const current = labels.get(key);
      if (current && current.state !== state) labels.delete(key);
      else labels.set(key, { name, state });
    }
  };
  apply(previous.labelsAdded, 'added');
  apply(previous.labelsRemoved, 'removed');
  apply(next.labelsAdded, 'added');
  apply(next.labelsRemoved, 'removed');
  const fields = new Map<string, { name: string; from?: ProjectFieldUpdateValue; to: ProjectFieldUpdateValue }>();
  for (const f of [...(previous.projectFields ?? []), ...(next.projectFields ?? [])]) {
    const known = fields.get(f.name);
    if (!known) fields.set(f.name, { ...f });
    else fields.set(f.name, { name: f.name, ...('from' in known ? { from: known.from } : 'from' in f ? { from: f.from } : {}), to: f.to });
  }
  const effect: ActionEffect = {};
  const added = [...labels.values()].filter((l) => l.state === 'added').map((l) => l.name);
  const removed = [...labels.values()].filter((l) => l.state === 'removed').map((l) => l.name);
  if (added.length > 0) effect.labelsAdded = added;
  if (removed.length > 0) effect.labelsRemoved = removed;
  const changedFields = [...fields.values()].filter((f) => !('from' in f) || f.from !== f.to);
  if (changedFields.length > 0) effect.projectFields = changedFields;
  if (previous.projectItemAdded || next.projectItemAdded) effect.projectItemAdded = true;
  const comment = next.comment ?? previous.comment;
  if (comment) effect.comment = comment;
  if ('exitCode' in next || 'signal' in next) {
    effect.exitCode = next.exitCode ?? null;
    effect.signal = next.signal ?? null;
  } else if ('exitCode' in previous || 'signal' in previous) {
    effect.exitCode = previous.exitCode ?? null;
    effect.signal = previous.signal ?? null;
  }
  if (Object.keys(effect).length === 0 && (previous.unchanged || next.unchanged)) effect.unchanged = true;
  return Object.keys(effect).length > 0 ? effect : null;
}

/**
 * Effect of a failed attempt (WI-33): what a `source.update` applied before it
 * failed, the exit status of a `shell` action; `null` if nothing is known.
 */
export function failureEffect(type: string, details: Record<string, unknown> | undefined): ActionEffect | null {
  if (type === 'source.update') {
    const applied = details?.applied as SourceUpdateApplied | undefined;
    if (!applied || typeof applied !== 'object') return null;
    const effect = updateEffect(applied);
    return effect.unchanged ? null : effect;
  }
  if (type === 'shell' && details && ('exitCode' in details || 'signal' in details)) {
    const exitCode = typeof details.exitCode === 'number' ? details.exitCode : null;
    const signal = typeof details.signal === 'string' ? details.signal : null;
    return { exitCode, signal };
  }
  return null;
}

/** Dependencies of the performers. */
export interface PerformerDeps {
  sources: SourceResolver;
  executor: Executor;
  dataDir: string;
  shellCancelGraceMs: number;
  maxShellLogBytes: number;
  /** Token source for `secrets` of `shell` actions (WI-18). */
  credentials: CredentialProvider | undefined;
  clock: Clock;
  timers: Timers;
  logger: Logger;
  /** Tuning of token files (tests). */
  tokenFiles: { renewBeforeMs?: number; retryDelayMs?: number; maxRetryDelayMs?: number };
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
  return {
    externalKey: null,
    details: { changed: result.changed, ...(result.applied ? { applied: result.applied } : {}) },
    effect: updateEffect(result.changed ? result.applied : null),
  };
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
        effect: { comment: { id: existing.id, url: existing.url ?? null, reconciled: true } },
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
  return { externalKey: ref.id, details: { marker, ...(ref.url ? { url: ref.url } : {}) }, effect: { comment: { id: ref.id, url: ref.url ?? null } } };
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
 * (no controller env), the rendered `env`/`args`, declared `secrets` (WI-18:
 * `env` → token in the variable, `file` → token file in the attempt directory,
 * renewed while the action runs and deleted afterwards), a JSON context file
 * with run + result (`ADISPATCH_CONTEXT_FILE`) and the action timeout. Exit code 0 =
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
    block: input.block ?? null,
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
    block: input.block ?? null,
  });

  // Secrets (WI-18). Journal entries from before WI-18 have no `secrets`.
  const secrets: Record<string, string> = {};
  const tokenFiles: TokenFileRequest[] = [];
  const secretRefs = Object.entries(config.secrets ?? {});
  if (secretRefs.length > 0 && !deps.credentials) {
    throw new LifecycleError('no_credentials', 'Shell action declares secrets but no credential provider is configured', {
      retryable: false,
    });
  }
  for (const [name, ref] of secretRefs) {
    if (ref.delivery === 'file') {
      tokenFiles.push({ name, identity: ref.identity });
      continue;
    }
    const token = await deps.credentials!.getToken(ref.identity, input.signal ? { signal: input.signal } : {});
    secrets[name] = token.token;
  }
  let session: TokenFileSession | undefined;
  try {
    if (tokenFiles.length > 0) {
      const dir = path.join(attemptDir, TOKEN_DIR_NAME);
      if (await isTokenDirInWorkspace(workingDirectory, dir)) {
        throw new LifecycleError('token_files_in_workspace', 'Token files must lie outside the workspace; move the workspace out of the data directory', {
          retryable: false,
        });
      }
      session = new TokenFileSession({
        dir,
        requests: tokenFiles,
        credentials: deps.credentials!,
        clock: deps.clock,
        timers: deps.timers,
        logger: deps.logger.child({ runId: run.id, actionId: action.id }),
        ...deps.tokenFiles,
      });
      Object.assign(env, await session.open(input.signal));
    }
    const proc = await deps.executor.start({
      runId: run.id,
      workflowId: snapshot.workflow.id,
      command: config.command,
      args,
      workingDirectory,
      createDirectory: !useWorkspace,
      env,
      secrets,
      ...(session ? { redactSecrets: session } : {}),
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
    return shellAttemptResult(outcome, config, files);
  } finally {
    await session?.close();
  }
}

function shellAttemptResult(
  outcome: ExecutionOutcome,
  config: ShellActionConfig,
  files: { stdoutLog: string; stderrLog: string },
): AttemptResult {
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
  return { externalKey: null, details: { exitCode: 0, logs }, effect: { exitCode: 0 } };
}
