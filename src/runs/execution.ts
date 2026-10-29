/**
 * Builds the {@link ExecutionSpec} of the main worker from the run's
 * configuration snapshot (Spec §5.4, §9): workspace path, args/env
 * templates (scopes as in the WI-02 table "Platzhalter-Scopes"), secrets
 * and the worker context. Never reads the live configuration.
 */
import path from 'node:path';
import {
  CONTAINER_LABELS,
  CONTAINER_PATHS,
  WORKER_PROTOCOL_VERSION,
  containerInstanceId,
  containerName,
  defaultContainerUser,
  buildTemplateValues,
  dataPaths,
  isWithin,
  linkedTemplateItem,
  renderTemplate,
  type ContainerExecution,
  unknownLinkedField,
  type CredentialProvider,
  type FieldResolution,
  type FieldValue,
  type ExecutionSpec,
  type SourceItem,
  type TemplateScope,
  type TemplateValues,
  type WorkerContext,
} from '../core/index.js';
import { linkedFieldUsage as workflowLinkedFieldUsage, sourceLocation, type ContainerExecuteConfig, type WorkflowSnapshot } from '../config/index.js';
import type { TokenFileRequest } from '../executors/index.js';
import type { RunRecord } from '../persistence/index.js';
import { RunControllerError } from './errors.js';

/** Input of {@link buildExecutionSpec}. */
export interface ExecutionInput {
  run: RunRecord;
  snapshot: WorkflowSnapshot;
  /** Freshly read item for source-bound runs, else `null`. */
  item: SourceItem | null;
  /** `{source.repository}` as reported by the adapter (default `owner/repository`). */
  repository?: string;
  dataDir: string;
  /** Start time of the run (used for `{run.started_at}` and the context). */
  startedAt: Date;
  now: Date;
  /** Required if the workflow declares `execute.secrets`. */
  credentials?: CredentialProvider;
  /** `retention.max_log_size_per_run` (bytes). */
  maxLogBytes?: number;
  signal?: AbortSignal;
  /**
   * Linked fields (`work_branch`, `work_pr`, … – WI-21) resolved right before
   * the start, if the workflow uses them (see {@link linkedFieldUsage}).
   */
  linked?: Readonly<Record<string, FieldResolution>>;
}

/**
 * Which linked fields (WI-21) a run start needs:
 * - `templates`: fields behind `{item.work_branch}` / `{item.work_pr}` in
 *   `execute` (working_directory, args, env) – unknown → `start_error`;
 * - `resolve`: true if the start resolves them at all, i.e. they are used in
 *   `execute` templates or in the workflow `filter` / `item_priority`. Then
 *   the known values are also written to `source.attributes` of the worker
 *   context ("when used"; costs one GraphQL query per run start).
 */
export function linkedFieldUsage(snapshot: WorkflowSnapshot): { templates: string[]; workingDirectory: string[]; resolve: boolean } {
  const usage = workflowLinkedFieldUsage(snapshot.workflow);
  return { templates: usage.execute, workingDirectory: usage.workingDirectory, resolve: usage.resolveAtStart };
}

/** Known linked field values for `source.attributes` of a context. */
export function knownLinkedAttributes(linked: Readonly<Record<string, FieldResolution>> | undefined): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [name, res] of Object.entries(linked ?? {})) if (res.known) out[name] = res.value;
  return out;
}

/** Result of {@link buildExecutionSpec}. */
export interface PreparedExecution {
  spec: ExecutionSpec;
  /**
   * `workspace.base_dir` if the workspace lies strictly below it (the executor
   * then creates it safely and cleanup may delete it), else `undefined`
   * (absolute workspace outside the base dir: created as configured, never cleaned up).
   */
  workspaceBaseDir: string | undefined;
  /**
   * Secrets with `delivery: file` (WI-18). Not resolved here: the controller
   * writes them as token files and adds `<NAME>_FILE` to the environment.
   */
  tokenFiles: TokenFileRequest[];
}

function scalarParameters(run: RunRecord): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(run.parameters ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Template values of the main execution (no `result.*`). */
export function executionTemplateValues(input: ExecutionInput, workspacePath?: string): TemplateValues {
  const { run, snapshot, item } = input;
  const source = snapshot.workflow.trigger.type === 'source' ? snapshot.source : null;
  const title = item?.fields.title;
  return buildTemplateValues({
    workflow: { id: snapshot.workflow.id, name: snapshot.workflow.name },
    workspace: { baseDir: snapshot.workspace.baseDir, ...(workspacePath !== undefined ? { path: workspacePath } : {}) },
    run: { id: run.id, trigger: run.triggerType, startedAt: input.startedAt },
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
          },
        }
      : {}),
    parameters: scalarParameters(run),
    now: input.now,
  });
}

/**
 * Render templates, resolve secrets and build the worker context.
 *
 * @throws TemplateError / PathTraversalError / SourceError (secrets) / RunControllerError — all map to `start_error`
 */
export async function buildExecutionSpec(input: ExecutionInput): Promise<PreparedExecution> {
  const { run, snapshot, item } = input;
  const workflow = snapshot.workflow;
  const execute = workflow.execute;
  const sourceBound = workflow.trigger.type === 'source';
  if (sourceBound && !item) {
    throw new RunControllerError('run_item_missing', `Run ${run.id} of source workflow '${workflow.id}' has no item`);
  }
  // Fail closed: a used linked placeholder must never render as an empty string because it is unknown.
  const unknownLinked = unknownLinkedField(linkedFieldUsage(snapshot).templates, input.linked);
  if (unknownLinked) {
    throw new RunControllerError(
      'run_linked_field_unknown',
      `{${unknownLinked.placeholder}} is unknown: ${unknownLinked.reason}`,
      { field: unknownLinked.field },
    );
  }

  // working_directory: path mode, scope run + source + parameters that always have a value (WI-02).
  const pathParams = Object.entries(workflow.parameters)
    .filter(([, def]) => def.required || def.default !== null)
    .map(([name]) => name);
  const pathScope: TemplateScope = { run: true, source: sourceBound, linked: sourceBound, parameters: pathParams };
  const baseValues = executionTemplateValues(input);
  const rendered = renderTemplate(execute.workingDirectory, baseValues, { mode: 'path', scope: pathScope });
  if (!path.isAbsolute(rendered)) {
    throw new RunControllerError('run_invalid_workspace', `working_directory must render to an absolute path: ${rendered}`);
  }
  const baseDir = snapshot.workspace.baseDir;
  const workspaceBaseDir = isWithin(baseDir, rendered) && path.resolve(rendered) !== path.resolve(baseDir) ? baseDir : undefined;
  if (workspaceBaseDir === undefined && isWithin(baseDir, rendered)) {
    throw new RunControllerError('run_invalid_workspace', 'working_directory must not be workspace.base_dir itself');
  }

  // args/env: text mode, scope run + workspace + source + all declared parameters.
  const textScope: TemplateScope = {
    run: true,
    workspace: true,
    source: sourceBound,
    linked: sourceBound,
    parameters: Object.keys(workflow.parameters),
  };
  // Container (WI-19): `{workspace.path}` in `command`/`env` is the path inside the container.
  const workspaceTarget = execute.type === 'container' ? containerWorkspaceTarget(execute) : null;
  const values = executionTemplateValues(input, workspaceTarget ?? rendered);
  const args = (execute.type === 'shell' ? execute.args : execute.command).map((a) =>
    renderTemplate(a, values, { mode: 'text', scope: textScope }),
  );
  const env: Record<string, string> = {};
  for (const [name, template] of Object.entries(execute.env)) {
    env[name] = renderTemplate(template, values, { mode: 'text', scope: textScope });
  }

  const secrets: Record<string, string> = {};
  const tokenFiles: TokenFileRequest[] = [];
  const secretEntries = Object.entries(execute.secrets);
  if (secretEntries.length > 0 && !input.credentials) {
    throw new RunControllerError('run_no_credentials', 'Workflow declares secrets but no credential provider is configured');
  }
  for (const [name, ref] of secretEntries) {
    // Snapshots from before WI-18 have no `delivery`: env.
    if (ref.delivery === 'file') {
      tokenFiles.push({ name, identity: ref.identity });
      continue;
    }
    const token = await input.credentials!.getToken(ref.identity, input.signal ? { signal: input.signal } : {});
    secrets[name] = token.token;
  }

  const source = sourceBound ? snapshot.source : null;
  const context: WorkerContext = {
    schema_version: WORKER_PROTOCOL_VERSION,
    run: {
      id: run.id,
      trigger: run.triggerType,
      started_at: input.startedAt.toISOString(),
      ...(run.scheduledFor ? { scheduled_for: run.scheduledFor } : {}),
    },
    workflow: { id: workflow.id, name: workflow.name },
    ...(source && item
      ? {
          source: {
            id: source.id,
            type: source.type,
            item_id: item.itemId,
            item_key: item.key,
            url: item.url,
            attributes: { ...item.fields, ...knownLinkedAttributes(input.linked) },
          },
        }
      : {}),
    parameters: scalarParameters(run),
    workspace: { path: workspaceTarget ?? rendered },
  };

  const files = dataPaths(input.dataDir).run(run.id);
  const container =
    execute.type === 'container'
      ? containerExecution(execute, {
          runId: run.id,
          workflowId: workflow.id,
          dataDir: input.dataDir,
          workspace: rendered,
          workspaceTarget: workspaceTarget as string,
          hostValues: executionTemplateValues(input, rendered),
        })
      : undefined;
  const spec: ExecutionSpec = {
    runId: run.id,
    workflowId: workflow.id,
    command: execute.type === 'shell' ? execute.command : execute.engine,
    args,
    workingDirectory: rendered,
    createDirectory: execute.createDirectory,
    env,
    secrets,
    context,
    files: {
      contextFile: files.contextFile,
      // Container runs write into their own output directory (the only writable daemon mount).
      resultFile: container ? path.join(files.outDir, 'result.json') : files.resultFile,
      stdoutLog: files.stdoutLog,
      stderrLog: files.stderrLog,
    },
    timeouts: {
      ...(execute.timeout.maxDurationMs !== null ? { maxDurationMs: execute.timeout.maxDurationMs } : {}),
      ...(execute.timeout.idleTimeoutMs !== null ? { idleTimeoutMs: execute.timeout.idleTimeoutMs } : {}),
    },
    cancelGraceMs: execute.cancelGraceMs,
    ...(input.maxLogBytes !== undefined ? { maxLogBytes: input.maxLogBytes } : {}),
    ...(container ? { container } : {}),
  };
  return { spec, workspaceBaseDir, tokenFiles };
}

/** Mount source that is the workspace itself (`{workspace.path}`, optionally with a trailing `/`). */
const WORKSPACE_ITSELF = /^\{\s*workspace\.path\s*\}\/?$/;

/** Target of the workspace mount: the first mount of `{workspace.path}`, else the automatic `/work`. */
export function containerWorkspaceTarget(execute: ContainerExecuteConfig): string {
  return execute.mounts.find((m) => WORKSPACE_ITSELF.test(m.source))?.target ?? CONTAINER_PATHS.workspace;
}

/**
 * Resolve the container part of the spec: render mount sources (host
 * workspace), add the automatic workspace mount, default user and workdir.
 *
 * @throws RunControllerError if a `{workspace.path}/<sub>` source escapes the workspace
 */
export function containerExecution(
  execute: ContainerExecuteConfig,
  input: { runId: string; workflowId: string; dataDir: string; workspace: string; workspaceTarget: string; hostValues: TemplateValues },
): ContainerExecution {
  const mounts: ContainerExecution['mounts'][number][] = execute.mounts.map((m) => {
    if (!m.source.includes('{')) return { source: m.source, target: m.target, mode: m.mode };
    const source = path.resolve(renderTemplate(m.source, input.hostValues, { mode: 'text', scope: { workspace: true } }));
    if (!isWithin(input.workspace, source)) {
      throw new RunControllerError('run_invalid_mount', `mount source must stay inside the workspace: ${m.source}`);
    }
    // Symlinks below the workspace are checked by the executor right before the start (lstat per segment).
    return { source, target: m.target, mode: m.mode, ...(source !== path.resolve(input.workspace) ? { withinWorkspace: true } : {}) };
  });
  if (!execute.mounts.some((m) => WORKSPACE_ITSELF.test(m.source))) {
    mounts.unshift({ source: input.workspace, target: CONTAINER_PATHS.workspace, mode: 'rw' });
  }
  return {
    engine: execute.engine,
    image: execute.image,
    name: containerName(input.runId),
    labels: {
      [CONTAINER_LABELS.run]: input.runId,
      [CONTAINER_LABELS.workflow]: input.workflowId,
      [CONTAINER_LABELS.instance]: containerInstanceId(input.dataDir),
    },
    mounts,
    workspaceTarget: input.workspaceTarget,
    dataDir: path.resolve(input.dataDir),
    workdir: execute.workdir ?? input.workspaceTarget,
    resources: { ...execute.resources },
    user: execute.user ?? defaultContainerUser(),
    network: execute.network,
    pull: execute.pull,
  };
}
