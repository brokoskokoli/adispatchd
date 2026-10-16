/**
 * Shared domain types and component contracts (Spec §3, §6, §8, §9, §10, §13).
 *
 * Only types and tiny pure helpers live here. Implementations belong to the
 * owning components (sources, executors, identities, persistence, ...).
 */
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import type { WorkerContext, WorkerResult } from './worker-protocol.js';

/** Function that removes a previously registered listener. */
export type Unsubscribe = () => void;

/** Injectable HTTP client with the signature of the global `fetch`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Run status model (Spec §8.1)
// ---------------------------------------------------------------------------

/** All technical run states, including the technical extension `recovery_pending`. */
export const TECHNICAL_STATUSES = [
  'reserved',
  'starting',
  'running',
  'cancelling',
  'finalizing',
  'completed',
  'crashed',
  'start_error',
  'timed_out',
  'cancelled',
  'recovery_pending',
] as const;

/** Technical run state (Spec §8.1). Independent of the {@link BusinessResult}. */
export type TechnicalStatus = (typeof TECHNICAL_STATUSES)[number];

/** Final technical states; a run in one of these never changes state again. */
export const TERMINAL_STATUSES = ['completed', 'crashed', 'start_error', 'timed_out', 'cancelled'] as const;

/** A final technical state. */
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Non-terminal states. A run in one of these holds its lock and counts
 * towards concurrency. `recovery_pending` keeps the lock to prevent double starts (Spec §14).
 */
export const ACTIVE_STATUSES = ['reserved', 'starting', 'running', 'cancelling', 'finalizing', 'recovery_pending'] as const;

/** A non-terminal state. */
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

/**
 * Terminal states that count as technical failures for retry blocks
 * (Spec §8.1, §11). `cancelled` and business `failure` do not count.
 */
export const TECHNICAL_FAILURE_STATUSES = ['crashed', 'start_error', 'timed_out'] as const;

/** True if `status` is terminal. */
export function isTerminalStatus(status: TechnicalStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** True if `status` counts as a technical failure (Spec §11). */
export function isTechnicalFailure(status: TechnicalStatus): boolean {
  return (TECHNICAL_FAILURE_STATUSES as readonly string[]).includes(status);
}

/**
 * Reference state machine for run transitions. Persistence (WI-03) enforces
 * it; any transition not listed is invalid.
 *
 * **Every terminal status is reached only via `finalizing` — no exceptions.**
 *
 * Normal path: `reserved → starting → running → finalizing → <terminal>`.
 *
 * Finalization protocol (WI-03/WI-08):
 * 1. `X → finalizing` persists the {@link FinalizationTarget} (columns
 *    `runs.final_status`, `runs.business_result`, `runs.final_reason`) and, for
 *    technical failures that reach the limit, the retry block — all in ONE
 *    transaction (Spec §11 "important order").
 * 2. The completion hook ({@link hookForOutcome}) runs while `finalizing`.
 *    After a controller crash, recovery resumes the hook chain of runs still
 *    in `finalizing` from the persisted target.
 * 3. `finalizing → target.status` (must equal the persisted target, see
 *    {@link canTransition}); the lock is released in the same transaction.
 *
 * Special cases (also via `finalizing`):
 * - Cancel before the worker started (`reserved`/`starting` → `cancelling`
 *   or directly → `finalizing` with target `cancelled`): a uniform path keeps
 *   the journal and recovery logic simple; WI-08 decides whether `on_cancel`
 *   runs when `on_start` never ran.
 * - `on_start` chain failed: `starting → finalizing` with target `start_error`.
 * - Recovery: `recovery_pending → finalizing` with target `crashed` (or
 *   `cancelled`) once the process is confirmed gone.
 *
 * `cancelling` is entered on a cancel request; `recovery_pending` marks runs
 * whose process could not be identified or stopped during recovery (keeps the lock).
 */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<TechnicalStatus, readonly TechnicalStatus[]>> = {
  reserved: ['starting', 'cancelling', 'finalizing', 'recovery_pending'],
  starting: ['running', 'cancelling', 'finalizing', 'recovery_pending'],
  running: ['cancelling', 'finalizing', 'recovery_pending'],
  cancelling: ['finalizing', 'recovery_pending'],
  finalizing: ['completed', 'crashed', 'start_error', 'timed_out', 'cancelled'],
  recovery_pending: ['finalizing'],
  completed: [],
  crashed: [],
  start_error: [],
  timed_out: [],
  cancelled: [],
};

/**
 * True if the reference state machine allows `from → to`. For
 * `finalizing → <terminal>`, pass the persisted `target`; the transition is
 * then only valid if `to === target.status`.
 */
export function canTransition(from: TechnicalStatus, to: TechnicalStatus, target?: FinalizationTarget): boolean {
  if (!RUN_STATUS_TRANSITIONS[from].includes(to)) return false;
  if (from === 'finalizing' && target !== undefined) return to === target.status;
  return true;
}

/**
 * Business result reported by the worker via the result file (Spec §8.2).
 * `null` for every technically failed or cancelled run.
 */
export type BusinessResult = 'success' | 'failure' | null;

/**
 * Final outcome decided when a run enters `finalizing`. Persisted with that
 * transition (`runs.final_status`, `runs.business_result`, `runs.final_reason`)
 * so that hooks and recovery work from it; the run later moves to exactly
 * `status`. `businessResult` is non-null only for `completed`.
 */
export interface FinalizationTarget {
  status: TerminalStatus;
  businessResult: BusinessResult;
  /** Short explanation, e.g. `exit code 1`, `cancelled by user`, `on_start failed`. */
  reason: string;
}

/** How a run was triggered. */
export type TriggerType = 'source' | 'schedule' | 'manual';

/** Lifecycle hooks in declaration order (Spec §10). */
export const HOOK_NAMES = [
  'on_start',
  'on_success',
  'on_failure',
  'on_crash',
  'on_start_error',
  'on_cancel',
  'on_timeout',
] as const;

/** Name of a lifecycle hook. */
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * The completion hook to run for a final outcome (Spec §8.2 rule 7):
 * `completed`+`success` → `on_success`, `completed`+`failure` → `on_failure`,
 * `crashed` → `on_crash`, `start_error` → `on_start_error`,
 * `timed_out` → `on_timeout`, `cancelled` → `on_cancel`.
 */
export function hookForOutcome(status: TerminalStatus, businessResult: BusinessResult): HookName {
  switch (status) {
    case 'completed':
      return businessResult === 'failure' ? 'on_failure' : 'on_success';
    case 'crashed':
      return 'on_crash';
    case 'start_error':
      return 'on_start_error';
    case 'timed_out':
      return 'on_timeout';
    case 'cancelled':
      return 'on_cancel';
  }
}

/** Lifecycle action types available in V1 (Spec §10). */
export const ACTION_TYPES = ['source.update', 'source.comment', 'shell'] as const;

/** A lifecycle action type. */
export type ActionType = (typeof ACTION_TYPES)[number];

/** Persisted state of one journaled lifecycle action (Spec §10). */
export type ActionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/**
 * Aggregate lifecycle state of a run (`runs.lifecycle_status`):
 * `failed` when a hook chain stopped at a failed action (Spec §21: "lifecycle failed").
 */
export type LifecycleStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** Orchestrator events that can trigger central notifications (Spec §18). */
export const NOTIFICATION_EVENT_TYPES = ['retry_block_created', 'lifecycle_action_failed', 'recovery_failed'] as const;

/** A notification event type. */
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * Sink for critical orchestrator events. Implementations persist and deliver
 * asynchronously; `notify` must never block or throw into orchestration.
 */
export interface Notifier {
  notify(type: NotificationEventType, payload: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Filters and fields (Spec §6, §17)
// ---------------------------------------------------------------------------

/** Three-valued logic result (Spec §6). `unknown` is never startable. */
export type TriValue = true | false | 'unknown';

/** Declarative filter operators (Spec §6). */
export const FILTER_OPERATORS = ['equals', 'not_equals', 'contains', 'in', 'greater_than', 'less_than'] as const;

/** A declarative filter operator. */
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Literal value in a filter predicate. */
export type FilterValue = string | number | boolean | null | readonly (string | number | boolean)[];

/** Leaf of the filter AST: `{ field, operator, value }`. */
export interface FilterPredicate {
  field: string;
  operator: FilterOperator;
  value: FilterValue;
}

/** Conjunction: true iff all children are true (Kleene logic with `unknown`). */
export interface FilterAll {
  all: FilterNode[];
}

/** Disjunction: true iff any child is true (Kleene logic with `unknown`). */
export interface FilterAny {
  any: FilterNode[];
}

/** Negation; `not unknown` is `unknown`. */
export interface FilterNot {
  not: FilterNode;
}

/** Declarative filter AST shared by workflows, item priorities and views (Spec §6). */
export type FilterNode = FilterAll | FilterAny | FilterNot | FilterPredicate;

/** Type guard for {@link FilterAll}. */
export function isFilterAll(node: FilterNode): node is FilterAll {
  return 'all' in node;
}

/** Type guard for {@link FilterAny}. */
export function isFilterAny(node: FilterNode): node is FilterAny {
  return 'any' in node;
}

/** Type guard for {@link FilterNot}. */
export function isFilterNot(node: FilterNode): node is FilterNot {
  return 'not' in node;
}

/** Type guard for {@link FilterPredicate}. */
export function isFilterPredicate(node: FilterNode): node is FilterPredicate {
  return 'field' in node && 'operator' in node;
}

/** Field value types. `date` values are ISO-8601 strings. */
export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'string[]';

/** Runtime value of a field. `date` fields carry ISO-8601 strings; absent values are `null`. */
export type FieldValue = string | number | boolean | null | readonly string[];

/** Field declared by a source adapter (Spec §17). */
export interface FieldDefinition {
  /** Full field name, possibly dotted, e.g. `labels`, `dependencies.blocked_by_open`. */
  name: string;
  type: FieldType;
  /** Short human-readable description (for docs / config validation messages). */
  description?: string;
  /** Name of another field holding a URL to link this field to in views (e.g. `url`). */
  link?: string;
  /** Operators that are meaningful for this field. */
  operators: readonly FilterOperator[];
  /**
   * Expensive field: not contained in {@link SourceItem.fields} from
   * `listCandidates`, must be resolved lazily via {@link SourceAdapter.resolveFields}
   * (e.g. GitHub dependencies; Spec §7 step 5).
   */
  expensive?: boolean;
  /**
   * Operators the adapter can push down into the external query
   * (`listCandidates({ filter })`). Must be a subset of `operators`.
   */
  pushdown?: readonly FilterOperator[];
}

/**
 * Result of resolving a field. `known: false` means the value could not be
 * determined (e.g. missing API permission) and MUST evaluate to `unknown` —
 * never to 0/empty (Spec §6, §20.7).
 */
export type FieldResolution = { known: true; value: FieldValue } | { known: false; reason: string };

// ---------------------------------------------------------------------------
// Sources and identities (Spec §5.2, §5.3, §10)
// ---------------------------------------------------------------------------

/** One external work item (e.g. GitHub issue/PR) as seen by the orchestrator. */
export interface SourceItem {
  /** Configured source ID (e.g. `project_a`). */
  sourceId: string;
  /** Adapter-defined item ID, stable within the source (GitHub: issue/PR number as string). */
  itemId: string;
  /** Global key `sourceItemKey(sourceId, itemId)`, used for locks/blocks/history. */
  key: string;
  /** Canonical web URL of the item. */
  url: string;
  /** Adapter-defined item kind, e.g. `issue` or `pull_request`. */
  type: string;
  /** Creation time (ISO-8601), used as deterministic scheduling tie-breaker (Spec §7). */
  createdAt?: string;
  /**
   * Cheap field values keyed by the full field name (see {@link FieldDefinition.name}).
   * Expensive fields are absent; they are resolved via {@link SourceAdapter.resolveFields}
   * and callers never write resolved values back into this record.
   */
  fields: Record<string, FieldValue>;
}

/** Identity ID as declared in `identities.yaml` (e.g. `coder`). */
export type IdentityRef = string;

/** Short-lived credential. Never persist or log `token`. */
export interface AccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * Provides short-lived credentials per identity (Spec §5.3), e.g. GitHub App
 * installation tokens. Implementations cache and refresh internally and
 * register issued tokens with the secret redactor.
 */
export interface CredentialProvider {
  /**
   * Return a valid token for `identity`. Throws `SourceError`: kind `auth`
   * for configuration/credential problems (not retryable), but also
   * `transient` / `rate_limited` for temporary failures of the token
   * exchange — consumers decide on retries via `SourceError.retryable`.
   */
  getToken(identity: IdentityRef, options?: { signal?: AbortSignal }): Promise<AccessToken>;
  /** Drop a cached token (e.g. after a 401) so the next call fetches a fresh one. */
  invalidate?(identity: IdentityRef): void;
  /**
   * Non-secret public facts about an identity (e.g. the GitHub App ID), used
   * by adapters to recognise their own writes (comment authorship for
   * idempotency markers). `undefined` for unknown identities.
   */
  describe?(identity: IdentityRef): IdentityDescription | undefined;
}

/** Public, non-secret description of an identity (see {@link CredentialProvider.describe}). */
export interface IdentityDescription {
  /** GitHub App ID for `github_app` identities. */
  appId?: string;
}

/** Declarative change to an item (`source.update`, Spec §10). */
export interface SourceUpdate {
  labels?: {
    add?: readonly string[];
    remove?: readonly string[];
  };
}

/** Outcome of {@link SourceAdapter.applyUpdate}. */
export interface SourceUpdateResult {
  /** False if the item already was in the desired state (idempotent no-op). */
  changed: boolean;
  /** What was actually changed, for the action journal. */
  applied?: { labelsAdded?: string[]; labelsRemoved?: string[] };
}

/** Reference to a posted comment. */
export interface CommentRef {
  /** Adapter-specific comment ID (persisted as action `external_key`). */
  id: string;
  url?: string;
}

/** Options for {@link SourceAdapter.listCandidates}. */
export interface ListCandidatesOptions {
  /**
   * Filter the adapter MAY push into the external query. Adapters may ignore
   * any part of it; the result may therefore be a superset and callers always
   * re-evaluate the full filter locally.
   */
  filter?: FilterNode;
  signal?: AbortSignal;
}

/**
 * Adapter for one configured source instance (Spec §1.4, §5.2). Created per
 * entry in `sources.yaml` by a {@link SourceAdapterFactory}.
 *
 * Reads use the source's default identity; writes take an explicit identity
 * (action → workflow → source fallback is resolved by the caller).
 * Failures are reported as `SourceError`.
 */
export interface SourceAdapter {
  /** Adapter type, e.g. `github`. */
  readonly type: string;
  /** Configured source ID, e.g. `project_a`. */
  readonly sourceId: string;
  /** Human-readable location for `{source.repository}` (GitHub: `owner/name`). */
  readonly repository?: string;

  /** Fields this adapter can provide, including expensive ones. */
  fieldDefinitions(): readonly FieldDefinition[];

  /** List candidate items (default: open items) with cheap fields populated. */
  listCandidates(options?: ListCandidatesOptions): Promise<SourceItem[]>;

  /** Fetch a single item freshly; `null` if it does not exist / is not visible. */
  getItem(itemId: string, options?: { signal?: AbortSignal }): Promise<SourceItem | null>;

  /**
   * Parse a user-supplied reference (URL like `https://github.com/o/r/issues/1`
   * or a bare ID like `1`) into an `itemId` of THIS source; `null` if the
   * reference is malformed or belongs to another source.
   */
  parseItemRef(ref: string): string | null;

  /**
   * Resolve (typically expensive) fields of one item lazily, as a batch.
   *
   * Contract:
   * - Returns an entry for EVERY requested name; unknown field names and
   *   permission/availability problems yield `{ known: false }` instead of
   *   throwing, so filters evaluate to `unknown` (fail-closed, Spec §20.7).
   *   Only unexpected failures (e.g. aborted signal) may reject.
   * - Adapters keep NO cache across calls: every call reflects the external
   *   state at call time. Related fields (e.g. all `dependencies.*`) should be
   *   computed from one API round trip within a call.
   * - Callers request all expensive fields they need for an item in one call
   *   (once the first one is needed), hold the result only for the current
   *   planning step / view request, and never write it back into
   *   {@link SourceItem.fields}.
   */
  resolveFields(
    item: SourceItem,
    fields: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, FieldResolution>>;

  /**
   * Apply a declarative update idempotently: re-read the item first, change
   * only what differs, preserve unrelated manual changes (Spec §10).
   */
  applyUpdate(item: SourceItem, update: SourceUpdate, identity: IdentityRef): Promise<SourceUpdateResult>;

  /**
   * Post a conversation comment (not a review) containing `marker` in an
   * unobtrusive, adapter-specific way (GitHub: `<!-- marker -->`).
   */
  postComment(item: SourceItem, body: string, marker: string, identity: IdentityRef): Promise<CommentRef>;

  /** Find a previously posted comment carrying `marker` (idempotency before retry). */
  findCommentByMarker(item: SourceItem, marker: string, identity: IdentityRef): Promise<CommentRef | null>;
}

/** Dependencies handed to adapter factories. */
export interface SourceAdapterDeps {
  credentials: CredentialProvider;
  logger: Logger;
  clock: Clock;
  fetch?: FetchLike;
}

/** Creates {@link SourceAdapter} instances for one adapter type. */
export interface SourceAdapterFactory<TConfig = unknown> {
  readonly type: string;
  /** Build an adapter for one source; `config` is the validated source entry. */
  create(sourceId: string, config: TConfig, deps: SourceAdapterDeps): SourceAdapter;
}

// ---------------------------------------------------------------------------
// Executor (Spec §8.2, §8.3, §9, §13)
// ---------------------------------------------------------------------------

/**
 * Platform-specific identity of a started process (Spec §13). PID alone is
 * not sufficient: `token` captures e.g. Linux boot-id + start time or the
 * macOS `lstart`. Persisted as JSON in `runs.process_start_identity`.
 */
export interface ProcessStartIdentity {
  pid: number;
  /** Process group ID signalled on cancel/timeout (usually equals `pid`). */
  pgid: number;
  /** Opaque, platform-prefixed start identity, e.g. `linux:<boot-id>:<starttime>`. */
  token: string;
}

/** Files used by one execution (see `dataPaths().run()`). */
export interface ExecutionFiles {
  contextFile: string;
  resultFile: string;
  stdoutLog: string;
  stderrLog: string;
}

/** Everything an executor needs to start the main worker of a run. */
export interface ExecutionSpec {
  runId: string;
  workflowId: string;
  /** Executable (absolute path or resolvable via PATH of the minimal env). */
  command: string;
  /** Arguments passed as a list (no shell interpolation, Spec §20.6). */
  args: readonly string[];
  /** Absolute workspace directory (already rendered and checked with `resolveWithin`). */
  workingDirectory: string;
  /** Create `workingDirectory` if missing. */
  createDirectory: boolean;
  /** Explicitly declared environment variables (not secrets). */
  env: Readonly<Record<string, string>>;
  /** Resolved secret values by env var name; never persisted, redacted from logs. */
  secrets: Readonly<Record<string, string>>;
  /**
   * Context written to `files.contextFile` (contains no secrets). The main
   * worker gets a {@link WorkerContext}; other executions (e.g. lifecycle
   * `shell` actions, WI-07) may pass their own JSON object (e.g. run + result).
   * `ORCH_SOURCE_*` variables are derived from a `source` block shaped like
   * {@link WorkerContext.source} if present.
   */
  context: WorkerContext | Readonly<Record<string, unknown>>;
  files: ExecutionFiles;
  timeouts: {
    /** Total runtime limit; `undefined` = off. */
    maxDurationMs?: number;
    /** Limit since last stdout/stderr output or event; `undefined` = off. */
    idleTimeoutMs?: number;
  };
  /** Grace period between SIGTERM and SIGKILL. */
  cancelGraceMs: number;
  /**
   * Max bytes persisted per run, shared by stdout and stderr (Spec §5.1
   * `max_log_size_per_run`); beyond that a truncation diagnostic naming the stream is emitted.
   */
  maxLogBytes?: number;
}

/** A chunk of raw worker output. */
export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  /** UTF-8 decoded text as received (may contain partial lines). */
  data: string;
  at: Date;
}

/** Structured worker event from a `@@ORCH_EVENT {...}` line (Spec §9.3). Informative only. */
export interface WorkerEvent {
  /** Event type, e.g. `status`, `progress`, `question`. */
  type: string;
  at: Date;
  stream: 'stdout' | 'stderr';
  /** Full parsed JSON object, including `type`. */
  data: Record<string, unknown>;
}

/**
 * Orchestrator-side diagnostics of an execution that must be persisted as
 * events (Spec §9.3, §12): log truncation, log write errors, unparsable
 * event lines.
 */
export interface ExecutorDiagnostic {
  type: 'log_truncated' | 'log_write_error' | 'event_parse_warning' | 'kill_failed';
  at: Date;
  stream?: 'stdout' | 'stderr';
  message: string;
  details?: Record<string, unknown>;
}

/** State of the result file after the worker exited (Spec §8.2). */
export type ResultFileStatus =
  | { state: 'missing' }
  | { state: 'valid'; result: WorkerResult }
  | { state: 'invalid'; error: string };

/** Raw facts about how an execution ended; classified by `classifyOutcome` (WI-05). */
export interface ExecutionOutcome {
  /** Exit code, or `null` if killed by a signal or never started. */
  exitCode: number | null;
  /** Terminating signal name, or `null`. */
  signal: NodeJS.Signals | null;
  /** Set when the process (or its workspace/context) could not be started. */
  spawnError?: { code?: string; message: string };
  /** Which timeout fired, if any. */
  timedOut: false | 'max_duration' | 'idle';
  /** True if the process was stopped through {@link RunningProcess.cancel}. */
  cancelled: boolean;
  resultFile: ResultFileStatus;
  startedAt: Date;
  finishedAt: Date;
  /** Bytes persisted per stream and whether limits truncated them. */
  logs: { stdoutBytes: number; stderrBytes: number; truncated: boolean };
}

/** Classified final outcome of a run (Spec §8.2 table). */
export interface OutcomeClassification extends FinalizationTarget {
  /** The valid worker result, only when `status === 'completed'` and a file was present. */
  result: WorkerResult | null;
}

/** Handle of a started worker process. */
export interface RunningProcess {
  /** OS process ID; `undefined` if spawning failed. */
  readonly pid: number | undefined;
  /** Start identity captured right after spawn; `undefined` if unavailable. */
  readonly startIdentity: ProcessStartIdentity | undefined;
  /**
   * Subscribe to raw output. Listeners are called asynchronously and must not
   * block log capture. Register before yielding to the event loop to avoid
   * missing early output.
   */
  onOutput(listener: (chunk: OutputChunk) => void): Unsubscribe;
  /** Subscribe to valid structured worker events. */
  onEvent(listener: (event: WorkerEvent) => void): Unsubscribe;
  /** Subscribe to orchestrator-side diagnostics (truncation, write errors, parse warnings). */
  onDiagnostic(listener: (diagnostic: ExecutorDiagnostic) => void): Unsubscribe;
  /** Resolves once the process (group) has ended and the result file was inspected. Never rejects. */
  wait(): Promise<ExecutionOutcome>;
  /**
   * Controlled stop: SIGTERM to the process group, SIGKILL after `graceMs`
   * (default: spec's `cancelGraceMs`). Resolves once termination is
   * confirmed; rejects if the group could not be terminated — the run must
   * then NOT be marked finished (Spec §13).
   */
  cancel(graceMs?: number): Promise<void>;
}

/** Starts worker processes (V1: shell executor). */
export interface Executor {
  readonly type: string;
  /**
   * Prepare workspace/context and spawn the worker. Never rejects for runtime
   * failures (spawn error, unwritable workspace): those surface as
   * `ExecutionOutcome.spawnError` from `wait()`.
   */
  start(spec: ExecutionSpec): Promise<RunningProcess>;
}
