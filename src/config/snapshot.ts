/**
 * Workflow snapshots for `runs.config_snapshot` (Spec §19): a run and its
 * hooks keep using the configuration that was active at start, even after a
 * reload. Snapshots are plain JSON and contain no secrets — identities are
 * referenced by ID only, notification channels are not included.
 */
import { OrchestratorError } from '../core/index.js';
import type { LoadedConfig, SourceConfig, WorkflowConfig, WorkspaceConfig } from './model.js';

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
  /** Source of a source-triggered workflow, otherwise `null`. */
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
  for (const [hook, actions] of Object.entries(workflow.hooks)) {
    for (const action of actions) {
      if (action.type === 'shell') add(action.id.startsWith(`${hook}.`) ? action.id : `${hook}.${action.id}`, action.secrets);
    }
  }
  return out;
}

/** Identities a workflow may use, sorted. */
export function workflowIdentityRefs(workflow: WorkflowConfig, source: SourceConfig | null): string[] {
  const refs = new Set<string>();
  if (workflow.identity) refs.add(workflow.identity);
  if (source) refs.add(source.identity);
  if (source?.project) refs.add(source.project.identity);
  for (const ref of Object.values(workflow.execute.secrets)) refs.add(ref.identity);
  for (const actions of Object.values(workflow.hooks)) {
    for (const action of actions) {
      if (action.type === 'source.comment' && action.identity) refs.add(action.identity);
      if (action.type === 'shell') for (const ref of Object.values(action.secrets)) refs.add(ref.identity);
    }
  }
  return [...refs].sort();
}

/**
 * Build a JSON-serializable snapshot of `workflowId`. The result is a deep
 * copy (mutable, independent of the frozen config).
 *
 * @throws UnknownWorkflowError
 */
export function snapshotWorkflow(config: LoadedConfig, workflowId: string): WorkflowSnapshot {
  const workflow = Object.hasOwn(config.workflows, workflowId) ? config.workflows[workflowId] : undefined;
  if (!workflow) throw new UnknownWorkflowError(workflowId);
  const source = workflow.trigger.type === 'source' ? (config.sources[workflow.trigger.source] ?? null) : null;
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
