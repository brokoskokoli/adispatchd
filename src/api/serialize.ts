/**
 * API response shapes (documented in docs/api.md). Responses never contain
 * secrets: run snapshots hold identity IDs only, worker context/result files
 * are redacted by the executor, error details pass `redactValue`.
 */
import { ACTIVE_STATUSES, isTerminalStatus, type TechnicalStatus } from '../core/index.js';
import { workflowSecrets, type EffectiveWorkflow, type ParameterDefinition, type ParameterOptionsSource, type WorkflowConfig } from '../config/index.js';
import { describeContainerExecute } from '../executors/index.js';
import type { ActionAttemptRecord, BlockRecord, RunActionRecord, RunRecord } from '../persistence/index.js';
import { checkDisplayName, displayCommand, type CronWorkflowStatus, type WorkflowConditionStatus, type WorkflowPlanningDiagnosis } from '../scheduler/index.js';

/**
 * Unambiguous outcome of a run for the UI (Spec §21): business `failure` vs.
 * technical errors vs. cancelled; `lifecycleFailed` separately.
 */
export type RunOutcome = 'active' | 'success' | 'failure' | 'technical_error' | 'cancelled';

/** Run in lists. */
export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string | null;
  triggerType: RunRecord['triggerType'];
  sourceId: string | null;
  sourceItemKey: string | null;
  sourceUrl: string | null;
  scheduledFor: string | null;
  identity: string | null;
  status: TechnicalStatus;
  active: boolean;
  outcome: RunOutcome;
  finalStatus: RunRecord['finalStatus'];
  businessResult: RunRecord['businessResult'];
  finalReason: string | null;
  /** `result.message` of the worker result file, if any. */
  resultMessage: string | null;
  /**
   * Named outcome of the result file (`outcome`, WI-17), e.g. `approved`. Called
   * `resultOutcome` because `outcome` is the UI classification above.
   */
  resultOutcome: string | null;
  /** Completion hook selected at finalization (WI-17), e.g. `on_result.approved`, `on_error`. */
  completionHook: RunRecord['completionHook'];
  /** WI-30: this run created a retry block and runs `on_retry_block` after its completion hook. */
  retryBlockHook: boolean;
  statusMessage: string | null;
  exitCode: number | null;
  lifecycleStatus: RunRecord['lifecycleStatus'];
  lifecycleFailed: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/** Action with its attempts. */
export interface ActionView extends RunActionRecord {
  attemptsDetail: ActionAttemptRecord[];
}

const ACTIVE = new Set<string>(ACTIVE_STATUSES);

interface SnapshotLike {
  workflow?: { name?: unknown; identity?: unknown; execute?: { command?: unknown; args?: unknown; workingDirectory?: unknown } };
  source?: { identity?: unknown } | null;
  configVersion?: unknown;
  configHash?: unknown;
}

function snap(run: RunRecord): SnapshotLike {
  return (run.configSnapshot ?? {}) as SnapshotLike;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Outcome classification (see {@link RunOutcome}). */
export function runOutcome(run: Pick<RunRecord, 'status' | 'businessResult'>): RunOutcome {
  if (!isTerminalStatus(run.status)) return 'active';
  if (run.status === 'completed') return run.businessResult === 'failure' ? 'failure' : 'success';
  if (run.status === 'cancelled') return 'cancelled';
  return 'technical_error';
}

/** Summary of a run. */
export function toRunSummary(run: RunRecord): RunSummary {
  const s = snap(run);
  const result = run.result as { message?: unknown } | null;
  const start = run.startedAt ?? null;
  const end = run.finishedAt ?? null;
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: str(s.workflow?.name),
    triggerType: run.triggerType,
    sourceId: run.sourceId,
    sourceItemKey: run.sourceItemKey,
    sourceUrl: run.sourceUrl,
    scheduledFor: run.scheduledFor,
    identity: run.identity ?? str(s.workflow?.identity) ?? str(s.source?.identity),
    status: run.status,
    active: ACTIVE.has(run.status),
    outcome: runOutcome(run),
    finalStatus: run.finalStatus,
    businessResult: run.businessResult,
    finalReason: run.finalReason,
    resultMessage: result && typeof result === 'object' ? str(result.message) : null,
    resultOutcome: run.outcome,
    completionHook: run.completionHook,
    retryBlockHook: run.retryBlockHook,
    statusMessage: run.statusMessage,
    exitCode: run.exitCode,
    lifecycleStatus: run.lifecycleStatus,
    lifecycleFailed: run.lifecycleStatus === 'failed',
    createdAt: run.createdAt,
    startedAt: start,
    finishedAt: end,
    durationMs: start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null,
  };
}

/** Extra fields of the run detail. */
export function runDetailFields(run: RunRecord): Record<string, unknown> {
  const s = snap(run);
  const configured = s.workflow?.execute;
  return {
    lockKey: run.lockKey,
    parameters: run.parameters,
    command:
      run.command ??
      (configured ? { command: configured.command ?? null, args: configured.args ?? [], configured: true } : null),
    workingDirectory: run.workspacePath ?? str(configured?.workingDirectory),
    workspacePath: run.workspacePath,
    pid: run.pid,
    result: run.result ?? null,
    error: run.error ?? null,
    blockGeneration: run.blockGeneration,
    countedTechnicalFailure: run.countedTechnicalFailure,
    finalizingAt: run.finalizingAt,
    updatedAt: run.updatedAt,
    configVersion: typeof s.configVersion === 'number' ? s.configVersion : null,
    configHash: str(s.configHash),
  };
}

/** Parameter definition in API form. */
function parameterView(def: ParameterDefinition, configDir?: string): Record<string, unknown> {
  return {
    type: def.type,
    required: def.required,
    default: def.default,
    description: def.description,
    ...(def.type === 'enum' ? { values: def.values, optionsFrom: optionsFromView(def.optionsFrom ?? null, configDir), allowCustom: def.allowCustom === true } : {}),
  };
}

/**
 * `options_from` of an enum parameter (WI-31): kind, source and limits; for
 * scripts the command (relative to the config dir) and the secret *names* –
 * never the arguments.
 */
function optionsFromView(source: ParameterOptionsSource | null, configDir?: string): Record<string, unknown> | null {
  if (!source) return null;
  if (source.type === 'github') {
    return { type: 'github', github: source.github, source: source.source, limit: source.limit, timeoutMs: source.timeoutMs, cacheMs: source.cacheMs };
  }
  return {
    type: 'command',
    command: displayCommand(source.command, configDir),
    secrets: Object.keys(source.secrets),
    timeoutMs: source.timeoutMs,
    cacheMs: source.cacheMs,
  };
}

/** Workflow in lists / detail. */
export function toWorkflowView(
  wf: EffectiveWorkflow,
  extra: {
    activeRuns: number;
    activeBlocks: number;
    cron: CronWorkflowStatus | null;
    diagnosis: WorkflowPlanningDiagnosis | undefined;
    /** Last condition status (WI-24); `undefined` = none recorded. */
    conditionStatus?: WorkflowConditionStatus | undefined;
    /** Config dir (display names relative to it). */
    configDir?: string;
    /** Redaction of error texts / stderr lines. */
    redact?: (text: string) => string;
  },
): Record<string, unknown> {
  const c: WorkflowConfig = wf.config;
  return {
    id: c.id,
    name: c.name,
    file: c.file,
    enabled: wf.enabled,
    priority: wf.priority,
    maxConcurrent: wf.maxConcurrent,
    /** `max_concurrent_per_source` (WI-20), `null` = not configured. */
    maxConcurrentPerSource: c.maxConcurrentPerSource ?? null,
    configured: { enabled: c.enabled, priority: c.priority, maxConcurrent: c.maxConcurrent },
    overrides: wf.overrides,
    trigger: c.trigger,
    identity: c.identity,
    activeRuns: extra.activeRuns,
    activeBlocks: extra.activeBlocks,
    parameters: Object.fromEntries(Object.entries(c.parameters).map(([k, v]) => [k, parameterView(v, extra.configDir)])),
    execute: {
      type: c.execute.type,
      // Container (WI-19): the engine command line with unresolved templates (secrets by name only).
      ...(c.execute.type === 'shell'
        ? { command: c.execute.command, args: c.execute.args }
        : describeContainerExecute(c.execute, { workflowId: c.id })),
      ...(c.execute.type === 'container'
        ? {
            container: {
              engine: c.execute.engine,
              image: c.execute.image,
              command: c.execute.command,
              workdir: c.execute.workdir,
              mounts: c.execute.mounts,
              resources: c.execute.resources,
              user: c.execute.user,
              network: c.execute.network,
              pull: c.execute.pull,
            },
          }
        : {}),
      workingDirectory: c.execute.workingDirectory,
      timeout: c.execute.timeout,
      secrets: Object.keys(c.execute.secrets),
      // WI-18: how each secret is delivered (`env` | `file`); no values, identity IDs only via the config view.
      secretDelivery: Object.fromEntries(Object.entries(c.execute.secrets).map(([name, ref]) => [name, ref.delivery ?? 'env'])),
      keep: c.execute.keep,
      keepMaxSizeBytes: c.execute.keepMaxSizeBytes,
    },
    // WI-18: every declared secret (execute + shell actions) with identity and delivery; never values.
    secrets: workflowSecrets(c),
    hasFilter: c.filter !== null,
    hasShellFilter: c.shellFilter !== null,
    conditions: conditionsView(c, extra.conditionStatus, extra.configDir, extra.redact ?? ((t) => t)),
    maxTechnicalFailures: c.retry.maxTechnicalFailures,
    cron: extra.cron,
    lastPlanning: extra.diagnosis
      ? {
          at: extra.diagnosis.at,
          status: extra.diagnosis.status,
          error: extra.diagnosis.error,
          polled: extra.diagnosis.polled,
          candidates: extra.diagnosis.candidates.length,
          started: extra.diagnosis.candidates.filter((x) => x.decision === 'started').length,
          // Per source (WI-20).
          sources: extra.diagnosis.sources.map((x) => ({ sourceId: x.sourceId, status: x.status, error: x.error, polled: x.polled })),
        }
      : null,
  };
}

/**
 * Shell checks of a workflow with display name and last status (WI-24):
 * workflow conditions with their last evaluation, item conditions and the
 * shell filter with the summary of the last planning step.
 */
export function conditionsView(
  c: WorkflowConfig,
  status: WorkflowConditionStatus | undefined,
  configDir: string | undefined,
  redact: (text: string) => string,
): Record<string, unknown> {
  const items = status?.items ?? null;
  const red = (t: string | null): string | null => (t === null ? null : redact(t));
  return {
    workflow: c.conditions.workflow.map((cond, index) => {
      const last = status?.workflow[index] ?? null;
      return {
        index,
        name: cond.name ?? null,
        label: checkDisplayName(cond, configDir),
        command: cond.command,
        displayCommand: displayCommand(cond.command, configDir),
        args: cond.args,
        timeoutMs: cond.timeoutMs,
        cacheMs: cond.cacheMs,
        last: last ? { ...last, error: red(last.error), stderr: red(last.stderr) } : null,
      };
    }),
    item: c.conditions.item.map((cond, index) => {
      const counts = items?.itemConditions[index];
      return {
        index,
        name: cond.name ?? null,
        label: checkDisplayName(cond, configDir),
        command: cond.command,
        displayCommand: displayCommand(cond.command, configDir),
        args: cond.args,
        timeoutMs: cond.timeoutMs,
        last: items && counts ? { at: items.at, items: items.items, ...counts } : null,
      };
    }),
    shellFilter: c.shellFilter
      ? {
          name: c.shellFilter.name ?? null,
          label: checkDisplayName(c.shellFilter, configDir),
          command: c.shellFilter.command,
          displayCommand: displayCommand(c.shellFilter.command, configDir),
          timeoutMs: c.shellFilter.timeoutMs,
          last: items?.shellFilter ? { at: items.at, ...items.shellFilter } : null,
        }
      : null,
  };
}

/** Block with UI helpers. */
export function toBlockView(block: BlockRecord, extra: { affectedRunIds: string[]; sourceUrl: string | null; workflowName: string | null }): Record<string, unknown> {
  return { ...block, active: block.clearedAt === null, ...extra };
}
