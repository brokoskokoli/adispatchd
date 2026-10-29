/**
 * Workflow snapshots for `runs.config_snapshot` (Spec §19): a run and its
 * hooks keep using the configuration that was active at start, even after a
 * reload. Snapshots are plain JSON and contain no secrets — identities are
 * referenced by ID only, notification channels are not included.
 */
import { OrchestratorError } from '../core/index.js';
import { configuredHooks, triggerSourceIds, type LoadedConfig, type SourceConfig, type WorkflowConfig, type WorkspaceConfig } from './model.js';

/** Current snapshot format version. */
export const WORKFLOW_SNAPSHOT_VERSION = 1;

/** Serializable configuration snapshot of one workflow. */
export interface WorkflowSnapshot {
  schemaVersion: typeof WORKFLOW_SNAPSHOT_VERSION;
  configHash: string;
  configVersion: number;
  workflowHash: string;
  /** Workflow as configured (runtime overrides are not part of the snapshot). */
  workflow: WorkflowConfig;
  /**
   * Source of a source-triggered workflow, otherwise `null`. Multi-source
   * workflows (WI-20): the source of the run's item.
   */
  source: SourceConfig | null;
  workspace: WorkspaceConfig;
  /** IDs of all identities the workflow can use (workflow, source, secrets, actions). */
  identityRefs: string[];
}

/** Thrown when a workflow ID is not part of the configuration. */
export class UnknownWorkflowError extends OrchestratorError {
  constructor(readonly workflowId: string) {
    super('config_unknown_workflow', `Unknown workflow "${workflowId}"`, { details: { workflowId } });
  }
}

/** One declared secret (names and identity only – never a value), see {@link workflowSecrets}. */
export interface WorkflowSecretInfo {
  /** `execute` or the action, e.g. `on_success.notify` / `on_success.1` (default ID). */
  where: string;
  name: string;
  identity: string;
  delivery: 'env' | 'file';
  /** Variable the process sees: `<NAME>` (env) or `<NAME>_FILE` (file). */
  variable: string;
}

/** All secrets a workflow declares (`execute.secrets` and `shell` action `secrets`, WI-18), in config order. */
export function workflowSecrets(workflow: WorkflowConfig): WorkflowSecretInfo[] {
  const out: WorkflowSecretInfo[] = [];
  const add = (where: string, secrets: WorkflowConfig['execute']['secrets'] | undefined): void => {
    for (const [name, ref] of Object.entries(secrets ?? {})) {
      // Snapshots/configs from before WI-18 have no `delivery`.
      const delivery = ref.delivery ?? 'env';
      out.push({ where, name, identity: ref.identity, delivery, variable: delivery === 'file' ? `${name}_FILE` : name });
    }
  };
  add('execute', workflow.execute.secrets);
  for (const [hook, actions] of configuredHooks(workflow.hooks)) {
    for (const action of actions) {
      if (action.type === 'shell') add(action.id.startsWith(`${hook}.`) ? action.id : `${hook}.${action.id}`, action.secrets);
    }
  }
  // WI-31: scripts that list the options of an enum parameter.
  for (const [name, def] of Object.entries(workflow.parameters ?? {})) {
    if (def.type === 'enum' && def.optionsFrom?.type === 'command') add(`parameters.${name}.options_from`, def.optionsFrom.secrets);
  }
  return out;
}

/** Identities a workflow may use, sorted. */
export function workflowIdentityRefs(workflow: WorkflowConfig, source: SourceConfig | null): string[] {
  const refs = new Set<string>();
  if (workflow.identity) refs.add(workflow.identity);
  if (source?.identity) refs.add(source.identity);
  if (source?.project) refs.add(source.project.identity);
  for (const ref of Object.values(workflow.execute.secrets)) refs.add(ref.identity);
  for (const [, actions] of configuredHooks(workflow.hooks)) {
    for (const action of actions) {
      if (action.type === 'source.comment' && action.identity) refs.add(action.identity);
      if (action.type === 'shell') for (const ref of Object.values(action.secrets ?? {})) refs.add(ref.identity);
    }
  }
  for (const def of Object.values(workflow.parameters ?? {})) {
    if (def.type === 'enum' && def.optionsFrom?.type === 'command') for (const ref of Object.values(def.optionsFrom.secrets)) refs.add(ref.identity);
  }
  return [...refs].sort();
}

/**
 * Build a JSON-serializable snapshot of `workflowId`. The result is a deep
 * copy (mutable, independent of the frozen config). `sourceId` selects the
 * source of the run's item for multi-source workflows (WI-20); it must be one
 * of the trigger sources (default: the first).
 *
 * @throws UnknownWorkflowError, OrchestratorError (`config_unknown_source`)
 */
export function snapshotWorkflow(config: LoadedConfig, workflowId: string, sourceId?: string): WorkflowSnapshot {
  const workflow = Object.hasOwn(config.workflows, workflowId) ? config.workflows[workflowId] : undefined;
  if (!workflow) throw new UnknownWorkflowError(workflowId);
  let source: SourceConfig | null = null;
  if (workflow.trigger.type === 'source') {
    const id = sourceId ?? workflow.trigger.source;
    if (!triggerSourceIds(workflow.trigger).includes(id)) {
      throw new OrchestratorError('config_unknown_source', `Source "${id}" is not a source of workflow "${workflowId}"`, {
        details: { workflowId, sourceId: id },
      });
    }
    source = config.sources[id] ?? null;
  }
  const snapshot: WorkflowSnapshot = {
    schemaVersion: WORKFLOW_SNAPSHOT_VERSION,
    configHash: config.hash,
    configVersion: config.version,
    workflowHash: config.workflowHashes[workflowId] ?? '',
    workflow,
    source,
    workspace: config.global.workspace,
    identityRefs: workflowIdentityRefs(workflow, source),
  };
  return JSON.parse(JSON.stringify(snapshot)) as WorkflowSnapshot;
}
