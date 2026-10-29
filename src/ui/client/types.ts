/**
 * Response shapes of the API as used by the UI (docs/api.md). Only the
 * fields the UI reads; everything is treated as untrusted display data.
 */
import type { ParameterDef } from '../shared/params.js';

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string | null;
  triggerType: string;
  sourceId: string | null;
  sourceItemKey: string | null;
  sourceUrl: string | null;
  scheduledFor: string | null;
  identity: string | null;
  status: string;
  active: boolean;
  outcome: string;
  finalStatus: string | null;
  businessResult: string | null;
  finalReason: string | null;
  resultMessage: string | null;
  /** Named outcome from the result file (WI-17). */
  resultOutcome?: string | null;
  /** Completion hook that ran / runs (WI-17). */
  completionHook?: string | null;
  /** WI-30: `on_retry_block` runs after the completion hook. */
  retryBlockHook?: boolean;
  statusMessage: string | null;
  exitCode: number | null;
  lifecycleStatus: string | null;
  lifecycleFailed: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface RunEvent {
  id: number;
  runId: string;
  sequence: number;
  timestamp: string;
  origin: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface ActionAttempt {
  id: number;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  error: unknown;
  externalKey: string | null;
}

export interface Action {
  id: number;
  runId: string;
  hook: string;
  ordinal: number;
  type: string;
  name: string | null;
  config: unknown;
  status: string;
  externalKey: string | null;
  attempts: number;
  lastError: unknown;
  createdAt: string;
  updatedAt: string;
  attemptsDetail?: ActionAttempt[];
  run?: RunSummary | null;
  busy?: boolean;
}

export interface Block {
  id: number;
  workflowId: string;
  workflowName: string | null;
  itemKey: string | null;
  reason: string;
  runId: string | null;
  failureCount: number;
  generation: number;
  createdAt: string;
  clearedAt: string | null;
  clearedBy: string | null;
  /** Final status of the run that created the block (WI-30). */
  lastStatus: string | null;
  /** Lifecycle run of the removal (`on_retry_unblock`, WI-30). */
  clearedRunId: string | null;
  active: boolean;
  affectedRunIds: string[];
  sourceUrl: string | null;
}

export interface RunDetail extends RunSummary {
  lockKey: string | null;
  parameters: Record<string, unknown> | null;
  command: { command: string | null; args: unknown[]; configured?: boolean } | null;
  workingDirectory: string | null;
  workspacePath: string | null;
  pid: number | null;
  result: unknown;
  error: unknown;
  input: unknown;
  inputError: string | null;
  resultFile: unknown;
  resultFileError: string | null;
  actions: Action[];
  events: RunEvent[];
  eventsTruncated: boolean;
  logs: { stdout: { size: number | null; truncated: boolean }; stderr: { size: number | null; truncated: boolean } };
  block: Block | null;
  /** Summary of the `run.kept_files` event (WI-22), `null` if nothing was kept. */
  kept: { files: number; bytes: number; skippedCount: number; message: string | null; error: string | null } | null;
  supervised: boolean;
  configVersion: number | null;
  configHash: string | null;
  updatedAt: string;
}

/** One kept file (`GET /api/v1/runs/:id/kept`). */
export interface KeptFile {
  path: string;
  size: number;
}

export interface KeptSkip {
  path: string;
  reason: string;
  size?: number;
  message?: string;
}

export interface KeptListing {
  runId: string;
  files: KeptFile[];
  totalBytes: number;
  truncated: boolean;
  report: {
    message?: string;
    patterns?: string[];
    maxBytes?: number;
    unmatched?: string[];
    notSearched?: string[];
    skipped?: KeptSkip[];
    skippedCount?: number;
    error?: string;
  } | null;
}

export interface LogPage {
  runId: string;
  active: boolean;
  stream: string;
  offset: number;
  length: number;
  nextOffset: number;
  size: number;
  eof: boolean;
  exists: boolean;
  data: string;
}

export interface Status {
  version: string;
  startedAt: string;
  time: string;
  readiness: { ready: boolean; checks: Record<string, boolean> };
  scheduler: {
    state: string;
    ready: boolean;
    paused: boolean;
    draining: boolean;
    stopping: boolean;
    pollingIntervalMs: number;
    lastPlanningStep: { startedAt: string; finishedAt: string; skipped: string | null; startedRunIds: string[] } | null;
  };
  limits: { maxConcurrent: number; configuredMaxConcurrent: number; override: number | null };
  usage: { activeRuns: number; supervisedRuns: number; recoveryPending: number; byWorkflow: Record<string, { active: number; max: number }> };
  counts: { activeBlocks: number; failedActions: number; notifications: Record<string, number> };
  config: { version: number; hash: string; loadedAt: string; configDir: string };
  server: { host: string; port: number | null; loopback: boolean };
  sse: { clients: number };
  /** Present when this instance is a workspace of a hub (WI-35). */
  hub?: { workspace: string; reachable: boolean; paused: boolean; active: number; max: number } | null;
  retention: { lastRunAt: string; deletedRuns: Record<string, number>; errors: number } | null;
}

export interface Trigger {
  type: string;
  source?: string;
  /** Multi-source workflows (WI-20): all sources in configured order. */
  sources?: string[];
  cron?: string;
  timezone?: string;
}

export interface Workflow {
  id: string;
  name: string;
  file: string;
  enabled: boolean;
  priority: number;
  maxConcurrent: number;
  /** WI-20; absent from older instances. */
  maxConcurrentPerSource?: number | null;
  configured: { enabled: boolean; priority: number; maxConcurrent: number };
  overrides: { enabled?: boolean; priority?: number; maxConcurrent?: number };
  trigger: Trigger;
  identity: string | null;
  activeRuns: number;
  activeBlocks: number;
  parameters: Record<string, ParameterDef>;
  execute: {
    type: string;
    command: string;
    args: unknown[];
    workingDirectory: string | null;
    timeout: unknown;
    secrets: string[];
    /** Delivery per secret name (WI-18). */
    secretDelivery?: Record<string, string>;
    /** `execute.keep` patterns (WI-22). */
    keep?: string[];
    keepMaxSizeBytes?: number;
    /** `execute.type: container` (WI-19); `command`/`args` are then the engine command line. */
    container?: {
      engine: string;
      image: string;
      command: string[];
      workdir: string | null;
      mounts: Array<{ source: string; target: string; mode: string }>;
      resources: { memory: string | null; cpus: number | null; pids: number | null };
      user: string | null;
      network: string;
      pull: string;
    };
  };
  /** All declared secrets (execute + shell actions), WI-18; missing on older instances. */
  secrets?: SecretInfo[];
  hasFilter: boolean;
  hasShellFilter: boolean;
  /** Shell checks with display name and last status (WI-24). */
  conditions: WorkflowConditions;
  maxTechnicalFailures: number;
  cron: { nextSlot: string | null; lastFiring: { scheduledFor: string; decision: string; runId: string | null; reason: string | null } | null } | null;
  lastPlanning: {
    at: string;
    status: string;
    error: string | null;
    polled: number;
    candidates: number;
    started: number;
    /** Per source (WI-20); absent from older instances. */
    sources?: SourcePoll[];
  } | null;
  diagnosis?: unknown;
  filter?: unknown;
  hooks?: Record<string, unknown[]>;
}

/** Poll result of one source (WI-20). */
export interface SourcePoll {
  sourceId: string;
  status: string;
  error: string | null;
  polled: number;
  pushdown?: unknown;
}

/** Last evaluation of a workflow condition (WI-24). */
export interface LastConditionCheck {
  status: 'ok' | 'not_now' | 'error' | 'skipped';
  checkedAt: string;
  ranAt: string | null;
  durationMs: number | null;
  cached: boolean;
  exitCode: number | null;
  error: string | null;
  stderr: string | null;
}

/** Item-check counts of the last planning step (WI-24). */
export interface CheckCountsView {
  at: string;
  items: number;
  ok: number;
  notNow: number;
  error: number;
  notEvaluated: number;
}

/** `conditions` of a workflow view (WI-24). */
export interface WorkflowConditions {
  workflow: Array<{ index: number; name: string | null; label: string; command: string; displayCommand?: string; args: string[]; timeoutMs: number; cacheMs: number | null; last: LastConditionCheck | null }>;
  item: Array<{ index: number; name: string | null; label: string; command: string; displayCommand?: string; args: string[]; timeoutMs: number; last: CheckCountsView | null }>;
  shellFilter: { name: string | null; label: string; command: string; displayCommand?: string; timeoutMs: number; last: CheckCountsView | null } | null;
}

/** Dashboard info tile (WI-24, `GET /api/v1/dashboard/info`). */
export interface InfoTile {
  id: string;
  title: string;
  type: 'text' | 'number' | 'percent';
  value: string | number | null;
  unit: string | null;
  status: 'ok' | 'warn' | 'critical' | 'error' | 'pending';
  updatedAt: string | null;
  expiresAt: string | null;
  /** Next background fetch (also the retry time after an error); `null` while running/queued. */
  nextAttemptAt?: string | null;
  error?: string;
  stale: boolean;
  refreshing: boolean;
  lastAttemptAt: string | null;
  durationMs: number | null;
}

export interface CheckDiagnosis {
  kind: string;
  index: number;
  command: string;
  /** Configured display name (WI-24). */
  name?: string;
  value: unknown;
  cached: boolean;
  exitCode: number | null;
  error: string | null;
  durationMs: number | null;
}

export type FilterTrace =
  | { kind: 'all' | 'any'; value: unknown; children: FilterTrace[] }
  | { kind: 'not'; value: unknown; child: FilterTrace }
  | { kind: 'predicate'; value: unknown; field: string; operator: string; expected: unknown; actual?: unknown; reason?: string | null }
  | { kind: 'invalid'; value: unknown; reason: string };

export interface Candidate {
  /** Absent from very old instances only. */
  sourceId?: string;
  itemKey: string;
  url: string;
  title: string | null;
  workflowPriority: number;
  itemPriority: number;
  matchedPriorityRule: number | null;
  decision: string;
  reason: string | null;
  filter: FilterTrace | null;
  shellFilter: CheckDiagnosis | null;
  itemConditions: CheckDiagnosis[];
  runId: string | null;
  blockId: number | null;
  /** GitHub Projects fields of the item: value or unknown reason. */
  projectFields?: Record<string, { known: true; value: unknown } | { known: false; reason: string }>;
  linkedFields?: Record<string, { known: true; value: unknown } | { known: false; reason: string }>;
}

export interface CronFiring {
  scheduledFor: string;
  decision: string;
  runId: string | null;
  reason: string | null;
}

/** Declared secret (WI-18): names and identity only, never a value. */
export interface SecretInfo {
  where: string;
  name: string;
  identity: string;
  delivery: string;
  variable: string;
}

export interface DryRunResult {
  workflowId: string;
  name: string;
  generatedAt: string;
  enabled: boolean;
  workflowPriority: number;
  capacity: {
    global: { active: number; max: number };
    workflow: { active: number; max: number };
    /** `max_concurrent_per_source` (WI-20). */
    perSource?: { max: number; active: Record<string, number> };
  };
  gate: { canStartAutomatically: boolean; reason: string | null } | null;
  conditions: CheckDiagnosis[];
  source: { sourceId: string; polled: number; filter?: unknown; pushdown: unknown; error: string | null; sources?: SourcePoll[] } | null;
  candidates: Candidate[];
  cron: { cron: string; timezone: string; nextSlots: string[]; nextSlotForecast: string; forecastReason: string | null; recentFirings: CronFiring[]; blockId: number | null } | null;
  secrets?: SecretInfo[];
  notes: string[];
  summary: { candidates: number; wouldStart: number; pendingChecks: number; notStartable: number };
  /** Completion hook routing (WI-17; missing before 0.3.0). */
  hooks?: { onResult: string[]; technical: Record<string, string> };
  /** Container workflows (WI-19): engine command line (templates unresolved, secrets by name only). */
  container?: { engine: string; image: string; command: string; args: string[] };
}

export interface ViewDef {
  id: string;
  title: string;
  file?: string;
  sources: string[];
}

export type ViewColumnDef = { field: string; label: string; link?: string | null; type?: string };
export type ViewRowData = {
  key: string;
  sourceId: string;
  itemId: string;
  url: string | null;
  lastRunId: string | null;
  cells: Array<{ value: unknown; known: boolean; link?: string | null }>;
  /** WI-28: value of the first sort key when the table is grouped. */
  group?: string | null;
};
export type ViewSortKeyDef = { field: string; direction: 'asc' | 'desc'; order: string[] | null };

/** WI-28: one section of a view result. */
export interface ViewSectionData {
  title: string;
  rest: boolean;
  fields: ViewColumnDef[];
  sort: ViewSortKeyDef[];
  rows: ViewRowData[];
  counts: { rows: number; filterUnknown: number; truncated: boolean };
  groupBy: { field: string; label: string } | null;
}

export interface ViewItems {
  view: ViewDef;
  columns: ViewColumnDef[];
  rows: ViewRowData[];
  errors: Array<{ sourceId: string; message: string }>;
  filterUnknown: number;
  truncated: boolean;
  fetchedAt: string;
  cached: boolean;
  /** WI-28 (missing before 0.5.0). */
  warnings?: string[];
  sections?: ViewSectionData[];
  groupBy?: { field: string; label: string };
  hideEmptySections?: boolean;
  /** WI-32: rows of a view without sections before `limit` (only with `limit`). */
  totalRows?: number;
}

export interface ConfigIssue {
  severity: string;
  file: string;
  path: string;
  message: string;
  line?: number;
}

export interface Notification {
  id: number;
  eventType: string;
  payload: unknown;
  deliveryState: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
  deliveries: Array<{ channelId: string; state: string; attempts: number; lastError: string | null; lastStatus: number | null; nextAttemptAt: string | null; deliveredAt: string | null }>;
}
