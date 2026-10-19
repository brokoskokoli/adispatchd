/**
 * Workflow snapshots for `runs.config_snapshot` (Spec §19): a run and its
 * hooks keep using the configuration that was active at start, even after a
 * reload. Snapshots are plain JSON and contain no secrets — identities are
 * referenced by ID only, notification channels are not included.
 */
import { OrchestratorError } from '../core/index.js';
import { triggerSourceIds, type LoadedConfig, type SourceConfig, type WorkflowConfig, type WorkspaceConfig } from './model.js';

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

/** Identities a workflow may use, sorted. */
export function workflowIdentityRefs(workflow: WorkflowConfig, source: SourceConfig | null): string[] {
  const refs = new Set<string>();
  if (workflow.identity) refs.add(workflow.identity);
  if (source) refs.add(source.identity);
  if (source?.project) refs.add(source.project.identity);
  for (const ref of Object.values(workflow.execute.secrets)) refs.add(ref.identity);
  for (const actions of Object.values(workflow.hooks)) {
    for (const action of actions) if (action.type === 'source.comment' && action.identity) refs.add(action.identity);
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
