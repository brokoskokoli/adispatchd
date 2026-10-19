/**
 * Builds the {@link ExecutionSpec} of the main worker from the run's
 * configuration snapshot (Spec §5.4, §9): workspace path, args/env
 * templates (scopes as in the WI-02 table "Platzhalter-Scopes"), secrets
 * and the worker context. Never reads the live configuration.
 */
import path from 'node:path';
import {
  WORKER_PROTOCOL_VERSION,
  buildTemplateValues,
  dataPaths,
  isWithin,
  linkedTemplateItem,
  renderTemplate,
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
import { linkedFieldUsage as workflowLinkedFieldUsage, type WorkflowSnapshot } from '../config/index.js';
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
            repository: input.repository ?? `${source.owner}/${source.repository}`,
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
  const values = executionTemplateValues(input, rendered);
  const args = execute.args.map((a) => renderTemplate(a, values, { mode: 'text', scope: textScope }));
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
    workspace: { path: rendered },
  };

  const files = dataPaths(input.dataDir).run(run.id);
  const spec: ExecutionSpec = {
    runId: run.id,
    workflowId: workflow.id,
    command: execute.command,
    args,
    workingDirectory: rendered,
    createDirectory: execute.createDirectory,
    env,
    secrets,
    context,
    files: {
      contextFile: files.contextFile,
      resultFile: files.resultFile,
      stdoutLog: files.stdoutLog,
      stderrLog: files.stderrLog,
    },
    timeouts: {
      ...(execute.timeout.maxDurationMs !== null ? { maxDurationMs: execute.timeout.maxDurationMs } : {}),
      ...(execute.timeout.idleTimeoutMs !== null ? { idleTimeoutMs: execute.timeout.idleTimeoutMs } : {}),
    },
    cancelGraceMs: execute.cancelGraceMs,
    ...(input.maxLogBytes !== undefined ? { maxLogBytes: input.maxLogBytes } : {}),
  };
  return { spec, workspaceBaseDir, tokenFiles };
}
