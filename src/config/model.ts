/**
 * Normalized, validated configuration model (Spec §5, §17, §18).
 *
 * Produced by the loader from the YAML files: identifiers are camelCase,
 * all durations are milliseconds, sizes are bytes, defaults are applied and
 * `null` marks "not configured". Instances handed out by the loader are
 * deeply frozen. No secret values are ever part of this model — identities
 * and notification headers only carry the *names* of environment variables.
 */
import type { FilterNode, HookName, NotificationEventType } from '../core/index.js';
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

/** Content of `config.yaml`. */
export interface GlobalConfig {
  server: ServerConfig;
  scheduler: SchedulerConfig;
  workspace: WorkspaceConfig;
  lifecycle: LifecycleConfig;
  retention: RetentionConfig;
  notifications: NotificationsConfig;
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
}

/** Project settings of a GitHub source (defaults resolved). */
export interface GithubProjectConfig {
  /** User or organisation login of the project (default: the source owner). */
  owner: string;
  number: number;
  /** Identity reading the project (default: the source identity). */
  identity: string;
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

/** Source trigger: polls one source. */
export interface SourceTriggerConfig {
  type: 'source';
  source: string;
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

/** Reference to an identity whose short-lived token is exposed as env variable. */
export interface SecretRef {
  identity: string;
}

/** Main worker execution (Spec §5.4, §8.3, §9). */
export interface ShellExecuteConfig {
  type: 'shell';
  command: string;
  /** Argument templates (text mode). */
  args: readonly string[];
  /** Path template (default `{workspace.base_dir}/{workflow.id}/{run.id}`). */
  workingDirectory: string;
  /** Default true. */
  createDirectory: boolean;
  /** Env variable → value template (text mode). */
  env: Readonly<Record<string, string>>;
  /** Env variable → identity whose token is injected (only in memory). */
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

/** Execution configuration (V1: shell only). */
export type ExecuteConfig = ShellExecuteConfig;

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

/** `source.update` action (V1: labels). */
export interface SourceUpdateActionConfig extends ActionBase {
  type: 'source.update';
  labels: { add: readonly string[]; remove: readonly string[] };
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
}

/** A lifecycle action. */
export type LifecycleActionConfig = SourceUpdateActionConfig | SourceCommentActionConfig | ShellActionConfig;

/** All seven hooks; missing hooks are empty lists. */
export type HooksConfig = Readonly<Record<HookName, readonly LifecycleActionConfig[]>>;

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
