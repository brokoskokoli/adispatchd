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
  retention: { lastRunAt: string; deletedRuns: Record<string, number>; errors: number } | null;
}

export interface Trigger {
  type: string;
  source?: string;
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
    /** `execute.keep` patterns (WI-22). */
    keep?: string[];
    keepMaxSizeBytes?: number;
  };
  hasFilter: boolean;
  hasShellFilter: boolean;
  conditions: { workflow: number; item: number };
  maxTechnicalFailures: number;
  cron: { nextSlot: string | null; lastFiring: { scheduledFor: string; decision: string; runId: string | null; reason: string | null } | null } | null;
  lastPlanning: { at: string; status: string; error: string | null; polled: number; candidates: number; started: number } | null;
  diagnosis?: unknown;
  filter?: unknown;
  hooks?: Record<string, unknown[]>;
}

export interface CheckDiagnosis {
  kind: string;
  index: number;
  command: string;
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
}

export interface CronFiring {
  scheduledFor: string;
  decision: string;
  runId: string | null;
  reason: string | null;
}

export interface DryRunResult {
  workflowId: string;
  name: string;
  generatedAt: string;
  enabled: boolean;
  workflowPriority: number;
  capacity: { global: { active: number; max: number }; workflow: { active: number; max: number } };
  gate: { canStartAutomatically: boolean; reason: string | null } | null;
  conditions: CheckDiagnosis[];
  source: { sourceId: string; polled: number; filter?: unknown; pushdown: unknown; error: string | null } | null;
  candidates: Candidate[];
  cron: { cron: string; timezone: string; nextSlots: string[]; nextSlotForecast: string; forecastReason: string | null; recentFirings: CronFiring[]; blockId: number | null } | null;
  notes: string[];
  summary: { candidates: number; wouldStart: number; pendingChecks: number; notStartable: number };
}

export interface ViewDef {
  id: string;
  title: string;
  file?: string;
  sources: string[];
}

export interface ViewItems {
  view: ViewDef;
  columns: Array<{ field: string; label: string; link?: string | null; type?: string }>;
  rows: Array<{ key: string; sourceId: string; itemId: string; url: string | null; lastRunId: string | null; cells: Array<{ value: unknown; known: boolean; link?: string | null }> }>;
  errors: Array<{ sourceId: string; message: string }>;
  filterUnknown: number;
  truncated: boolean;
  fetchedAt: string;
  cached: boolean;
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
