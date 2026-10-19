/**
 * Normalized, validated configuration model (Spec §5, §17, §18).
 *
 * Produced by the loader from the YAML files: identifiers are camelCase,
 * all durations are milliseconds, sizes are bytes, defaults are applied and
 * `null` marks "not configured". Instances handed out by the loader are
 * deeply frozen. No secret values are ever part of this model — identities
 * and notification headers only carry the *names* of environment variables.
 */
import {
  outcomeOfHook,
  type ContainerEngine,
  type ContainerMountMode,
  type ContainerPullPolicy,
  type FilterNode,
  type HookName,
  type ListHookName,
  type NotificationEventType,
  type ProjectFieldUpdateValue,
  type ResultHookName,
} from '../core/index.js';
import type { ProjectFieldKind } from '../sources/index.js';

// ---------------------------------------------------------------------------
// Global settings (config.yaml, Spec §5.1)
// ---------------------------------------------------------------------------

/** HTTP server bind address. */
export interface ServerConfig {
  host: string;
  port: number;
  /**
   * Extra accepted `Host`/`Origin` host names (lower case, `name` = any port, `name:port` = exact).
   * Loopback names are always accepted when bound to loopback (DNS-rebinding protection).
   */
  allowedHosts: readonly string[];
}

/** Scheduler settings. */
export interface SchedulerConfig {
  /** Source polling interval (default 30s). */
  pollingIntervalMs: number;
  /** Global limit for automatically started runs (default 5). */
  maxConcurrent: number;
}

/** Workspace cleanup policy after a run finished. */
export type WorkspaceCleanup = 'always' | 'on_success' | 'never';

/** Workspace settings. */
export interface WorkspaceConfig {
  /** Absolute, normalized base directory (default `${dataDir}/workspaces`). */
  baseDir: string;
  cleanup: WorkspaceCleanup;
}

/** Retry policy of a lifecycle action. */
export interface RetryPolicy {
  /** Total number of attempts (≥ 1). */
  maxAttempts: number;
  /** Pause between attempts. */
  delayMs: number;
}

/** Lifecycle defaults. */
export interface LifecycleConfig {
  /** Default retry policy of every action (default 3 × 30s). */
  actionRetry: RetryPolicy;
}

/** Retention settings; `null` = `never` (keep forever). */
export interface RetentionConfig {
  completedRunsMs: number | null;
  failedRunsMs: number | null;
  blockedRunsMs: number | null;
  maxLogSizePerRunBytes: number;
  cleanupIntervalMs: number;
}

/**
 * Webhook notification channel (Spec §18). Exactly one of `url` / `urlEnv`
 * is set. `url` may embed a token (e.g. Slack webhook URLs) and must be
 * redacted before it is logged or returned by the API ({@link toPublicConfig}).
 */
export interface WebhookChannelConfig {
  id: string;
  type: 'webhook';
  url: string | null;
  /** Name of the environment variable holding the URL. */
  urlEnv: string | null;
  /** HTTP header name → name of the environment variable holding its value. */
  headersEnv: Readonly<Record<string, string>>;
  /** Events delivered to this channel (default: the global `notifications.on`). */
  on: readonly NotificationEventType[];
}

/** A notification channel. */
export type NotificationChannelConfig = WebhookChannelConfig;

/** Central orchestrator notifications. */
export interface NotificationsConfig {
  /** Enabled events (default: all {@link NOTIFICATION_EVENT_TYPES}). */
  on: readonly NotificationEventType[];
  channels: readonly NotificationChannelConfig[];
}

/** Container executor defaults (`container:` in config.yaml, WI-19). */
export interface ContainerDefaultsConfig {
  /** Engine of `execute.type: container` without own `engine` (default `docker`). */
  engine: ContainerEngine;
}

/** External tool linked from the web UI toolbar (`ui.external_links`, WI-25). */
export interface ExternalLinkConfig {
  id: string;
  /** Text of the toolbar entry (1–40 characters, rendered as text only). */
  label: string;
  /** Absolute http(s) URL as the *browser* reaches the tool. */
  url: string;
  enabled: boolean;
  /** `true` = shown inside the UI (iframe), `false` = link opening a new tab. */
  embed: boolean;
}

/** Web UI settings (`ui:` in config.yaml, WI-25). */
export interface UiConfig {
  externalLinks: readonly ExternalLinkConfig[];
}

/** Content of `config.yaml`. */
export interface GlobalConfig {
  server: ServerConfig;
  scheduler: SchedulerConfig;
  workspace: WorkspaceConfig;
  lifecycle: LifecycleConfig;
  retention: RetentionConfig;
  notifications: NotificationsConfig;
  /**
   * Container defaults (WI-19). Snapshots and configurations of older
   * versions lack it: readers must treat `undefined` as `{ engine: 'docker' }`.
   */
  container: ContainerDefaultsConfig;
  /** Web UI settings (WI-25). */
  ui: UiConfig;
}

// ---------------------------------------------------------------------------
// Sources and identities (Spec §5.2, §5.3)
// ---------------------------------------------------------------------------

/** GitHub repository source. */
export interface GithubSourceConfig {
  id: string;
  type: 'github';
  owner: string;
  repository: string;
  /** Default identity for reading API calls. */
  identity: string;
  /** GitHub Projects (v2) project whose declared fields are available as `project.<name>`; `null` = none. */
  project: GithubProjectConfig | null;
  /**
   * Free variables of the source (WI-20), available as `{source.vars.<name>}`;
   * empty when not configured. Missing in run snapshots written before 0.3.0.
   */
  vars: Readonly<Record<string, string>>;
}

/** Project settings of a GitHub source (defaults resolved). */
export interface GithubProjectConfig {
  /** User or organisation login of the project (default: the source owner). */
  owner: string;
  number: number;
  /** Identity reading the project (default: the source identity). */
  identity: string;
  /** Explicitly configured `project.identity` (writes project fields, WI-16); `null` = writes use the action identity. */
  writeIdentity: string | null;
  /** Declared field name (case as written) → kind. */
  fields: Readonly<Record<string, ProjectFieldKind>>;
}

/** A configured source (V1: only GitHub). */
export type SourceConfig = GithubSourceConfig;

/** GitHub App identity. The private key is read from `privateKeyEnv` at runtime. */
export interface GithubAppIdentityConfig {
  id: string;
  type: 'github_app';
  appId: number;
  installationId: number;
  /** Name of the environment variable holding the PEM private key (never the key itself). */
  privateKeyEnv: string;
}

/**
 * GitHub token identity (e.g. a fine-grained personal access token, needed
 * for user-owned projects). The token is read from `tokenEnv` at runtime.
 */
export interface GithubTokenIdentityConfig {
  id: string;
  type: 'github_token';
  /** Name of the environment variable holding the token (never the token itself). */
  tokenEnv: string;
}

/** A configured identity. */
export type IdentityConfig = GithubAppIdentityConfig | GithubTokenIdentityConfig;

// ---------------------------------------------------------------------------
// Workflows (Spec §5.4, §5.5, §6, §10)
// ---------------------------------------------------------------------------

/**
 * Source trigger: polls one source (`source: <id>`) or several (WI-20,
 * `sources: [<id>, ...]`). Use {@link triggerSourceIds} to read the list.
 */
export interface SourceTriggerConfig {
  type: 'source';
  /** The (first) source; for multi-source workflows the first entry of `sources`. */
  source: string;
  /**
   * All sources in the configured order (the order is the tie-breaker between
   * equally prioritized items). Present only when configured as `sources:`
   * (also with a single entry); absent for `source: <id>`.
   */
  sources?: readonly string[];
}

/** Sources of a source trigger in configured order (`[source]` for `source: <id>`). */
export function triggerSourceIds(trigger: SourceTriggerConfig): readonly string[] {
  return trigger.sources ?? [trigger.source];
}

/** Cron trigger. */
export interface ScheduleTriggerConfig {
  type: 'schedule';
  cron: string;
  /** IANA time zone (default `UTC`). */
  timezone: string;
}

/** Only manually started. */
export interface ManualTriggerConfig {
  type: 'manual';
}

/** Workflow trigger. */
export type TriggerConfig = SourceTriggerConfig | ScheduleTriggerConfig | ManualTriggerConfig;

/** Shell condition (Spec §6): exit 0 = pass, 1 = fail, ≥ 2 = check error. */
export interface ShellCheckConfig {
  /** Display name (WI-24); absent when not configured (keeps workflow hashes stable). */
  name?: string;
  type: 'shell';
  command: string;
  args: readonly string[];
  /** Default 30s. */
  timeoutMs: number;
  /** Result cache TTL; `null` = no caching. */
  cacheMs: number | null;
}

/** Item-level shell filter (workflows only, never views). */
export interface ShellFilterConfig {
  /** Display name (WI-24); absent when not configured. */
  name?: string;
  command: string;
  /** Default 30s. */
  timeoutMs: number;
}

/** One item priority rule; the first matching rule wins (Spec §7). */
export interface ItemPriorityRule {
  when: FilterNode;
  value: number;
}

/** Item priority configuration. */
export interface ItemPriorityConfig {
  rules: readonly ItemPriorityRule[];
  default: number;
}

/** Shared properties of manual-start parameters. */
interface ParameterBase {
  required: boolean;
  description: string | null;
}

/** String parameter. */
export interface StringParameter extends ParameterBase {
  type: 'string';
  default: string | null;
}

/** Number parameter. */
export interface NumberParameter extends ParameterBase {
  type: 'number';
  default: number | null;
}

/** Boolean parameter. */
export interface BooleanParameter extends ParameterBase {
  type: 'boolean';
  default: boolean | null;
}

/** Enum parameter. */
export interface EnumParameter extends ParameterBase {
  type: 'enum';
  values: readonly string[];
  default: string | null;
}

/** Declared manual-start parameter (Spec §5.5). */
export type ParameterDefinition = StringParameter | NumberParameter | BooleanParameter | EnumParameter;

/** Value of a parameter after validation. */
export type ParameterValue = string | number | boolean;

/** How a secret reaches the process (WI-18). */
export type SecretDelivery = 'env' | 'file';

/**
 * Reference to an identity whose short-lived token is handed to a process:
 * `env` = token in the variable itself; `file` = token in a private file
 * (renewed before expiry), its path in `<NAME>_FILE`.
 */
export interface SecretRef {
  identity: string;
  /**
   * Default `env`. Snapshots written before WI-18 lack the field: readers
   * must treat `undefined` as `env`.
   */
  delivery: SecretDelivery;
}

/** Settings shared by every executor type (workspace on the host, env, secrets, timeouts, keep). */
interface ExecuteCommon {
  /** Path template of the host workspace (default `{workspace.base_dir}/{workflow.id}/{run.id}`). */
  workingDirectory: string;
  /** Default true. */
  createDirectory: boolean;
  /** Env variable → value template (text mode). */
  env: Readonly<Record<string, string>>;
  /** Env variable → identity whose token is injected (in memory or as token file, WI-18). */
  secrets: Readonly<Record<string, SecretRef>>;
  timeout: {
    maxDurationMs: number | null;
    idleTimeoutMs: number | null;
  };
  /** Grace period between SIGTERM and SIGKILL on cancel/timeout (default 30s). */
  cancelGraceMs: number;
  /**
   * Workspace files copied to `runs/<run-id>/kept/` after the completion hook
   * and before the workspace cleanup (WI-22): relative glob patterns
   * (`*`, `?`, `**`). Empty = nothing is kept.
   */
  keep: readonly string[];
  /** Max. total size of kept files per run in bytes (`keep_max_size`, default 100MB). */
  keepMaxSizeBytes: number;
}

/** Main worker execution as a local process (Spec §5.4, §8.3, §9). */
export interface ShellExecuteConfig extends ExecuteCommon {
  type: 'shell';
  command: string;
  /** Argument templates (text mode). */
  args: readonly string[];
}

/**
 * One bind mount of a container run (WI-19). `source` is either an absolute
 * host path (relative paths are resolved against the config dir) or a
 * template `{workspace.path}` / `{workspace.path}/<sub>` (host workspace).
 */
export interface ContainerMountConfig {
  source: string;
  /** Absolute, normalized path inside the container. */
  target: string;
  mode: ContainerMountMode;
}

/** Main worker execution in a throw-away container (WI-19). */
export interface ContainerExecuteConfig extends ExecuteCommon {
  type: 'container';
  /** Resolved engine (`execute.engine`, else `container.engine` of config.yaml). */
  engine: ContainerEngine;
  image: string;
  /** Command run in the container (templates, text mode); empty = the image's default command. */
  command: readonly string[];
  /** Working directory in the container; `null` = target of the workspace mount. */
  workdir: string | null;
  /** Mounts in configuration order (the workspace is added at `/work` if no mount uses `{workspace.path}`). */
  mounts: readonly ContainerMountConfig[];
  resources: { memory: string | null; cpus: number | null; pids: number | null };
  /** `--user`; `null` = the daemon's own `<uid>:<gid>`. */
  user: string | null;
  /** `default` (engine default network), `none` or a network name. */
  network: string;
  pull: ContainerPullPolicy;
}

/** Execution configuration: local process (`shell`) or container (`container`, WI-19). */
export type ExecuteConfig = ShellExecuteConfig | ContainerExecuteConfig;

/** Shared properties of lifecycle actions. */
interface ActionBase {
  /**
   * Stable action ID within the hook: the configured `id` or `<hook>.<index>`
   * (e.g. `on_start.0`). Used for the action journal and comment markers.
   */
  id: string;
  continueOnError: boolean;
  /** Effective retry policy (action override merged over `lifecycle.action_retry`). */
  retry: RetryPolicy;
}

/** `source.update` action: labels and (WI-16) project fields; labels are applied first. */
export interface SourceUpdateActionConfig extends ActionBase {
  type: 'source.update';
  /** Empty lists when `labels` is not configured. */
  labels: { add: readonly string[]; remove: readonly string[] };
  /** Project fields to set: declared name (without `project.`) → value, `null` = clear. Absent = none. */
  project?: Readonly<Record<string, ProjectFieldUpdateValue>>;
}

/**
 * `source.comment` action. `identity` = action override; callers fall back
 * to the workflow identity, then the source identity.
 */
export interface SourceCommentActionConfig extends ActionBase {
  type: 'source.comment';
  /** Text template. */
  message: string;
  identity: string | null;
}

/** `shell` action. */
export interface ShellActionConfig extends ActionBase {
  type: 'shell';
  command: string;
  args: readonly string[];
  /** Default 5m. */
  timeoutMs: number;
  env: Readonly<Record<string, string>>;
  /**
   * Secrets like `execute.secrets` (WI-18). Journal entries written before
   * WI-18 lack the field: readers must treat `undefined` as `{}`.
   */
  secrets: Readonly<Record<string, SecretRef>>;
}

/** A lifecycle action. */
export type LifecycleActionConfig = SourceUpdateActionConfig | SourceCommentActionConfig | ShellActionConfig;

/** Actions of one hook, in order. */
export type ActionList = readonly LifecycleActionConfig[];

/**
 * Hooks of a workflow by journal hook name (WI-17):
 * - `on_start`, `on_success`, `on_failure`: always present (`[]` if not configured).
 * - `on_crash`, `on_start_error`, `on_cancel`, `on_timeout`, `on_error`: absent
 *   (`undefined`) if not configured; a present list – even `[]` – is "defined"
 *   and takes precedence over `on_error` (see `selectCompletionHook`).
 * - `on_result.<outcome>`: one entry per configured named outcome.
 *
 * Snapshots of older versions contain every list hook (empty lists), which
 * keeps their behaviour (no `on_error`, no `on_result`).
 */
export type HooksConfig = Readonly<
  Record<'on_start' | 'on_success' | 'on_failure', ActionList> &
    Partial<Record<Exclude<ListHookName, 'on_start' | 'on_success' | 'on_failure'>, ActionList>> &
    Partial<Record<ResultHookName, ActionList>>
>;

/** Configured hooks (absent ones skipped) in configuration order: list hooks, then `on_result.*`. */
export function configuredHooks(hooks: HooksConfig): Array<[HookName, ActionList]> {
  const out: Array<[HookName, ActionList]> = [];
  for (const [hook, actions] of Object.entries(hooks) as Array<[HookName, ActionList | undefined]>) {
    if (actions !== undefined) out.push([hook, actions]);
  }
  return out;
}

/** Named outcomes with a configured `on_result.<outcome>` hook, in configuration order. */
export function resultHookOutcomes(hooks: HooksConfig): string[] {
  return configuredHooks(hooks)
    .map(([hook]) => outcomeOfHook(hook))
    .filter((o): o is string => o !== null);
}

/** A validated workflow. */
export interface WorkflowConfig {
  id: string;
  name: string;
  /** Path of the defining file, relative to the config dir (e.g. `workflows/coder.yaml`). */
  file: string;
  enabled: boolean;
  priority: number;
  /** Per-workflow limit for automatic starts (default 1). */
  maxConcurrent: number;
  /**
   * Limit of active runs per source of a source workflow (WI-20); absent =
   * none (only `maxConcurrent`). Absent rather than `null` so the hashes of
   * existing workflows stay unchanged.
   */
  maxConcurrentPerSource?: number;
  /** Default write identity of the workflow; `null` = source identity. */
  identity: string | null;
  trigger: TriggerConfig;
  /** Declarative filter (source workflows only). */
  filter: FilterNode | null;
  shellFilter: ShellFilterConfig | null;
  itemPriority: ItemPriorityConfig | null;
  conditions: {
    workflow: readonly ShellCheckConfig[];
    item: readonly ShellCheckConfig[];
  };
  parameters: Readonly<Record<string, ParameterDefinition>>;
  execute: ExecuteConfig;
  retry: { maxTechnicalFailures: number };
  hooks: HooksConfig;
}

// ---------------------------------------------------------------------------
// Views (Spec §17)
// ---------------------------------------------------------------------------

/** One view column. */
export interface ViewFieldConfig {
  field: string;
  /** Column label (default: field name). */
  label: string;
  /** Field holding the URL this column links to. */
  link: string | null;
}

/** A read-only view. */
export interface ViewConfig {
  id: string;
  title: string;
  file: string;
  sources: readonly string[];
  filter: FilterNode | null;
  fields: readonly ViewFieldConfig[];
  sort: { field: string; direction: 'asc' | 'desc' } | null;
}

// ---------------------------------------------------------------------------
// Named filters (filters/*.yaml, WI-15)
// ---------------------------------------------------------------------------

/**
 * A named, reusable filter. Workflows and views reference it with
 * `{ use: <id> }` or `filter: <id>`; their normalized filters already contain
 * the expanded tree, so this entry is informational (API, UI).
 */
export interface NamedFilterConfig {
  id: string;
  /** File relative to the config dir (`filters/<id>.yaml`). */
  file: string;
  description: string | null;
  /** Expanded tree (references to other named filters are replaced). */
  filter: FilterNode;
}

// ---------------------------------------------------------------------------
// Dashboard info tiles (dashboard.yaml, WI-24)
// ---------------------------------------------------------------------------

/** How the output of an info script is parsed and shown. */
export type DashboardInfoType = 'text' | 'number' | 'percent';

/** Threshold of a number/percent tile; `null` = not configured. */
export interface DashboardInfoThresholds {
  /** Value ≥ this → `warn`. */
  warnAbove: number | null;
  /** Value ≥ this → `critical`. */
  criticalAbove: number | null;
  /** Value ≤ this → `warn`. */
  warnBelow: number | null;
  /** Value ≤ this → `critical`. */
  criticalBelow: number | null;
}

/** One info tile: a trusted script whose first output line is shown on the dashboard. */
export interface DashboardInfoConfig {
  id: string;
  /** Default: the ID. */
  title: string;
  type: DashboardInfoType;
  /** Resolved like other commands (relative paths against the config dir). */
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Default 15s. */
  timeoutMs: number;
  /** How long a value is valid before it is fetched again in the background (default 5m, ≥ 10s). */
  cacheMs: number;
  /** Unit shown after number values (e.g. `GB`); `null` = none. */
  unit: string | null;
  thresholds: DashboardInfoThresholds;
}

/** Content of `dashboard.yaml`. */
export interface DashboardConfig {
  file: string;
  info: readonly DashboardInfoConfig[];
}

// ---------------------------------------------------------------------------
// Loaded configuration
// ---------------------------------------------------------------------------

/** Complete, validated, immutable configuration. */
export interface LoadedConfig {
  /** Absolute config directory it was loaded from. */
  configDir: string;
  /** Monotonic version assigned by the loader caller (ConfigManager: 1, 2, ...). */
  version: number;
  /** SHA-256 (hex) over the canonical normalized content. Equal content → equal hash. */
  hash: string;
  /** ISO-8601 load time. */
  loadedAt: string;
  global: GlobalConfig;
  sources: Readonly<Record<string, SourceConfig>>;
  identities: Readonly<Record<string, IdentityConfig>>;
  workflows: Readonly<Record<string, WorkflowConfig>>;
  views: Readonly<Record<string, ViewConfig>>;
  /** Named filters (`filters/*.yaml`); already expanded into workflows and views. */
  filters: Readonly<Record<string, NamedFilterConfig>>;
  /** `dashboard.yaml` (WI-24); `null` = file not present (no info tiles). */
  dashboard: DashboardConfig | null;
  /** SHA-256 per workflow definition (detects changed workflows on reload). */
  workflowHashes: Readonly<Record<string, string>>;
}

/** Severity of a {@link ConfigIssue}. */
export type ConfigIssueSeverity = 'error' | 'warning';

/** A problem found while loading/validating. Never contains secret values. */
export interface ConfigIssue {
  severity: ConfigIssueSeverity;
  /** File relative to the config dir (`config.yaml`, `workflows/coder.yaml`, ...). */
  file: string;
  /** Dotted path inside the file, e.g. `execute.timeout.max_duration`, `on_start[1].message`; empty = whole file. */
  path: string;
  message: string;
  /** 1-based line in the file, if known. */
  line?: number;
}
