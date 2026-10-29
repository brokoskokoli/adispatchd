/**
 * Conversion of parsed YAML (snake_case, see `schemas.ts`) into the
 * normalized model (`model.ts`). Pure; semantic checks live in `validate.ts`.
 */
import path from 'node:path';
import { dataPaths, HOOK_NAMES, normalizeArtifactPath, parseSize, resultHookName, type FilterNode, type HookName } from '../core/index.js';
import type { RawFilterNode } from './filter-schema.js';
import type { IssuePath } from './issues.js';
import type {
  ExecuteConfig,
  GlobalConfig,
  HooksConfig,
  IdentityConfig,
  LifecycleActionConfig,
  ParameterDefinition,
  ParameterOptionsSource,
  RetryPolicy,
  SecretDelivery,
  SecretRef,
  SourceConfig,
  ViewConfig,
  ViewFieldConfig,
  ViewSortKey,
  WorkflowConfig,
} from './model.js';
import type {
  RawAction,
  RawGlobalConfig,
  RawIdentitiesFile,
  RawParameter,
  RawParameterOptionsFrom,
  RawSourcesFile,
  RawView,
  RawViewSortKey,
  RawWorkflow,
} from './schemas.js';
import { DEFAULTS, MAX_DEFAULT_MONITORING_INTERVAL_MS, MIN_MONITORING_INTERVAL_MS, PARAMETER_OPTIONS_DEFAULTS } from './schemas.js';

/**
 * Expands references to named filters in a filter tree used at `at` of the
 * file being normalized (WI-15, see `named-filters.ts`).
 */
export type FilterExpander = (node: RawFilterNode, at: IssuePath) => FilterNode;

/** Resolve a configured directory: absolute stays, relative is taken relative to the config dir. */
export function resolveConfigPath(configDir: string, value: string): string {
  return path.resolve(configDir, value);
}

/**
 * Resolve a configured command: absolute paths are normalized, relative paths
 * containing `/` (e.g. `scripts/coder.sh`, `./x.sh`) are resolved against the
 * config dir, bare names (e.g. `bash`) stay untouched for PATH lookup.
 */
export function resolveCommand(configDir: string, command: string): string {
  if (path.isAbsolute(command)) return path.normalize(command);
  return command.includes('/') ? resolveConfigPath(configDir, command) : command;
}

/** Normalize `config.yaml`. */
export function normalizeGlobal(raw: RawGlobalConfig, configDir: string, dataDir: string): GlobalConfig {
  const baseDir = raw.workspace.base_dir
    ? resolveConfigPath(configDir, raw.workspace.base_dir)
    : dataPaths(dataDir).defaultWorkspacesDir;
  return {
    server: { host: raw.server.host, port: raw.server.port, allowedHosts: raw.server.allowed_hosts.map((h) => h.toLowerCase()) },
    scheduler: {
      pollingIntervalMs: raw.scheduler.polling_interval,
      maxConcurrent: raw.scheduler.max_concurrent,
    },
    workspace: { baseDir, cleanup: raw.workspace.cleanup },
    lifecycle: {
      actionRetry: {
        maxAttempts: raw.lifecycle.action_retry.max_attempts,
        delayMs: raw.lifecycle.action_retry.delay,
      },
    },
    retention: {
      completedRunsMs: raw.retention.completed_runs,
      failedRunsMs: raw.retention.failed_runs,
      blockedRunsMs: raw.retention.blocked_runs,
      maxLogSizePerRunBytes: raw.retention.max_log_size_per_run,
      cleanupIntervalMs: raw.retention.cleanup_interval,
      uiActionsMs: raw.retention.ui_actions,
      artifactsMs: raw.retention.artifacts,
    },
    notifications: {
      on: [...raw.notifications.on],
      channels: raw.notifications.channels.map((channel, index) => ({
        id: channel.id ?? `channel-${index + 1}`,
        type: channel.type,
        url: channel.url ?? null,
        urlEnv: channel.url_env ?? null,
        headersEnv: { ...channel.headers_env },
        on: [...(channel.on ?? raw.notifications.on)],
      })),
    },
    container: { engine: raw.container.engine },
    monitoring: {
      enabled: raw.monitoring.enabled,
      intervalMs:
        raw.monitoring.interval ??
        Math.max(MIN_MONITORING_INTERVAL_MS, Math.min(raw.scheduler.polling_interval, MAX_DEFAULT_MONITORING_INTERVAL_MS)),
      retentionMs: raw.monitoring.retention,
      topProcesses: raw.monitoring.top_processes,
      minCpuPercent: raw.monitoring.min_cpu_percent,
    },
    ui: {
      externalLinks: raw.ui.external_links.map((link) => ({
        id: link.id,
        label: link.label,
        url: link.url,
        enabled: link.enabled,
        embed: link.embed,
      })),
    },
    auth: {
      mode: raw.auth.mode,
      users: raw.auth.users.map((u) => ({ name: u.name, passwordHashEnv: u.password_hash_env, role: u.role })),
      trustedHeader: {
        header: raw.auth.trusted_header.header.toLowerCase(),
        trustedProxies: raw.auth.trusted_header.trusted_proxies.map((p) => p.trim()),
        proxySecretEnv: raw.auth.trusted_header.proxy_secret_env ?? null,
        users: raw.auth.trusted_header.users.map((u) => ({ login: u.login.toLowerCase(), role: u.role })),
      },
      trustedProxies: raw.auth.trusted_proxies.map((p) => p.trim()),
      sessionTtlMs: raw.auth.session_ttl,
      readRequiresLogin: raw.auth.read_requires_login,
    },
  };
}

/** Normalize `sources.yaml`. */
export function normalizeSources(raw: RawSourcesFile): Record<string, SourceConfig> {
  const out: Record<string, SourceConfig> = {};
  for (const [id, source] of Object.entries(raw.sources)) {
    if (source.type === 'artifacts') {
      out[id] = { id, type: 'artifacts', identity: null, project: null, vars: { ...(source.vars ?? {}) } };
      continue;
    }
    out[id] = {
      id,
      type: source.type,
      owner: source.owner,
      repository: source.repository,
      identity: source.identity,
      project: source.project
        ? {
            owner: source.project.owner ?? source.owner,
            number: source.project.number,
            identity: source.project.identity ?? source.identity,
            writeIdentity: source.project.identity ?? null,
            fields: { ...source.project.fields },
          }
        : null,
      vars: { ...(source.vars ?? {}) },
    };
  }
  return out;
}

/** Normalize `identities.yaml`. */
export function normalizeIdentities(raw: RawIdentitiesFile): Record<string, IdentityConfig> {
  const out: Record<string, IdentityConfig> = {};
  for (const [id, identity] of Object.entries(raw.identities)) {
    out[id] =
      identity.type === 'github_app'
        ? {
            id,
            type: identity.type,
            appId: identity.app_id,
            installationId: identity.installation_id,
            privateKeyEnv: identity.private_key_env,
            uiActions: identity.ui_actions,
          }
        : { id, type: identity.type, tokenEnv: identity.token_env, uiActions: identity.ui_actions };
  }
  return out;
}

/**
 * `options_from` of an enum parameter (WI-31) with defaults applied.
 * `defaultSource` is the only trigger source of the workflow, else the only
 * source of the configuration, else `''` (validation reports it).
 */
function normalizeOptionsFrom(raw: RawParameterOptionsFrom, configDir: string, defaultSource: string): ParameterOptionsSource {
  const timeoutMs = raw.timeout ?? PARAMETER_OPTIONS_DEFAULTS.timeoutMs;
  if (raw.command !== undefined && raw.github === undefined) {
    return {
      type: 'command',
      command: resolveCommand(configDir, raw.command),
      args: [...(raw.args ?? [])],
      secrets: normalizeSecrets(raw.secrets ?? {}),
      timeoutMs,
      cacheMs: raw.cache ?? PARAMETER_OPTIONS_DEFAULTS.commandCacheMs,
    };
  }
  return {
    type: 'github',
    github: raw.github ?? 'branches',
    source: raw.source ?? defaultSource,
    limit: raw.limit ?? PARAMETER_OPTIONS_DEFAULTS.limit,
    timeoutMs,
    cacheMs: raw.cache ?? PARAMETER_OPTIONS_DEFAULTS.githubCacheMs,
  };
}

function normalizeParameter(raw: RawParameter, configDir: string, defaultSource: string): ParameterDefinition {
  const base = { required: raw.required, description: raw.description ?? null };
  // Defaults are type-checked in validate.ts; here they are only narrowed.
  switch (raw.type) {
    case 'string':
      return { type: 'string', ...base, default: typeof raw.default === 'string' ? raw.default : null };
    case 'number':
      return { type: 'number', ...base, default: typeof raw.default === 'number' ? raw.default : null };
    case 'boolean':
      return { type: 'boolean', ...base, default: typeof raw.default === 'boolean' ? raw.default : null };
    case 'enum': {
      const values = raw.options_from ? [] : [...(raw.values ?? [])];
      // With `options_from` or `allow_custom` the default is checked at run time only (WI-31).
      const open = raw.options_from !== undefined || raw.allow_custom;
      return {
        type: 'enum',
        ...base,
        values,
        default: typeof raw.default === 'string' && (open || values.includes(raw.default)) ? raw.default : null,
        optionsFrom: raw.options_from ? normalizeOptionsFrom(raw.options_from, configDir, defaultSource) : null,
        allowCustom: raw.allow_custom,
      };
    }
  }
}

function normalizeAction(
  raw: RawAction,
  hook: HookName,
  index: number,
  defaults: RetryPolicy,
  configDir: string,
): LifecycleActionConfig {
  const common = {
    id: raw.id ?? `${hook}.${index}`,
    continueOnError: raw.continue_on_error,
    retry: {
      maxAttempts: raw.retry?.max_attempts ?? defaults.maxAttempts,
      delayMs: raw.retry?.delay ?? defaults.delayMs,
    },
  };
  switch (raw.type) {
    case 'source.update':
      return {
        ...common,
        type: 'source.update',
        labels: { add: [...(raw.labels?.add ?? [])], remove: [...(raw.labels?.remove ?? [])] },
        // Only present when configured, so hashes of label-only actions stay unchanged.
        ...(raw.project !== undefined ? { project: { ...raw.project } } : {}),
      };
    case 'source.comment':
      return { ...common, type: 'source.comment', message: raw.message, identity: raw.identity ?? null };
    case 'shell':
      return {
        ...common,
        type: 'shell',
        command: resolveCommand(configDir, raw.command),
        args: [...raw.args],
        timeoutMs: raw.timeout,
        env: { ...raw.env },
        secrets: normalizeSecrets(raw.secrets),
      };
  }
}

/** Normalize `secrets` of `execute` / `shell` actions (WI-18: `delivery` defaults to `env`). */
function normalizeSecrets(raw: Readonly<Record<string, { identity: string; delivery: SecretDelivery }>>): Record<string, SecretRef> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { identity: v.identity, delivery: v.delivery }]));
}

/** Template prefix of mount sources that refer to the host workspace (WI-19). */
const WORKSPACE_SOURCE = /^\{\s*workspace\.path\s*\}/;

/** Normalize `execute` (shell or container). */
function normalizeExecute(exec: RawWorkflow['execute'], global: GlobalConfig, configDir: string): ExecuteConfig {
  const common = {
    workingDirectory: exec.working_directory,
    createDirectory: exec.create_directory,
    env: { ...exec.env },
    secrets: normalizeSecrets(exec.secrets),
    timeout: {
      maxDurationMs: exec.timeout.max_duration ?? null,
      idleTimeoutMs: exec.timeout.idle_timeout ?? null,
    },
    cancelGraceMs: exec.cancel_grace,
    keep: [...exec.keep],
    keepMaxSizeBytes: exec.keep_max_size ?? parseSize(DEFAULTS.keepMaxSize),
    artifacts: exec.artifacts.map((a) => ({ name: a.name, type: a.type, path: normalizeArtifactPath(a.path), required: a.required })),
    artifactsMaxSizeBytes: exec.artifacts_max_size ?? parseSize(DEFAULTS.artifactsMaxSize),
  };
  if (exec.type === 'shell') {
    return { type: 'shell', command: resolveCommand(configDir, exec.command), args: [...exec.args], ...common };
  }
  return {
    type: 'container',
    engine: exec.engine ?? global.container.engine,
    image: exec.image,
    command: [...exec.command],
    workdir: exec.workdir ?? null,
    mounts: exec.mounts.map((m) => ({
      // `{workspace.path}` templates stay; static sources are resolved against the config dir.
      source: WORKSPACE_SOURCE.test(m.source) || m.source.includes('{') ? m.source : resolveConfigPath(configDir, m.source),
      target: m.target,
      mode: m.mode,
    })),
    resources: {
      memory: exec.resources.memory ?? null,
      cpus: exec.resources.cpus ?? null,
      pids: exec.resources.pids ?? null,
    },
    user: exec.user ?? null,
    network: exec.network,
    pull: exec.pull,
    ...common,
  };
}

/** Normalize one workflow file. */
export function normalizeWorkflow(
  raw: RawWorkflow,
  file: string,
  global: GlobalConfig,
  configDir: string,
  expand: FilterExpander,
  /** IDs of all configured sources (default source of `options_from.github`, WI-31). */
  sourceIds: readonly string[] = [],
): WorkflowConfig {
  const normalizeList = (hook: HookName, actions: readonly RawAction[]): LifecycleActionConfig[] =>
    actions.map((action, i) => normalizeAction(action, hook, i, global.lifecycle.actionRetry, configDir));
  const hooks: Record<string, LifecycleActionConfig[]> = {};
  // Hooks that are not configured stay absent (WI-17: "defined" vs. "not given").
  for (const hook of HOOK_NAMES) {
    const actions = raw[hook];
    if (actions !== undefined) hooks[hook] = normalizeList(hook, actions);
  }
  for (const [outcome, actions] of Object.entries(raw.on_result ?? {})) {
    const hook = resultHookName(outcome);
    hooks[hook] = normalizeList(hook, actions);
  }
  const parameters: Record<string, ParameterDefinition> = {};
  // Default source of `options_from.github` (WI-31): the only trigger source, else the only configured source.
  const triggerIds = raw.trigger.type === 'source' ? (raw.trigger.sources ?? (raw.trigger.source !== undefined ? [raw.trigger.source] : [])) : [];
  const defaultSource = triggerIds.length === 1 ? (triggerIds[0] as string) : triggerIds.length === 0 && sourceIds.length === 1 ? (sourceIds[0] as string) : '';
  for (const [name, def] of Object.entries(raw.parameters)) parameters[name] = normalizeParameter(def, configDir, defaultSource);
  const exec = raw.execute;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    file,
    enabled: raw.enabled,
    priority: raw.priority,
    maxConcurrent: raw.max_concurrent,
    ...(raw.max_concurrent_per_source !== undefined ? { maxConcurrentPerSource: raw.max_concurrent_per_source } : {}),
    identity: raw.identity ?? null,
    trigger:
      raw.trigger.type === 'schedule'
        ? { type: 'schedule', cron: raw.trigger.cron, timezone: raw.trigger.timezone }
        : raw.trigger.type === 'source'
          ? raw.trigger.sources !== undefined
            ? { type: 'source', source: raw.trigger.sources[0] ?? '', sources: [...raw.trigger.sources] }
            : { type: 'source', source: raw.trigger.source ?? '' }
          : { type: 'manual' },
    filter: raw.filter ? expand(raw.filter, ['filter']) : null,
    shellFilter: raw.shell_filter
      ? {
          ...(raw.shell_filter.name !== undefined ? { name: raw.shell_filter.name } : {}),
          command: resolveCommand(configDir, raw.shell_filter.command),
          timeoutMs: raw.shell_filter.timeout,
        }
      : null,
    itemPriority: raw.item_priority
      ? {
          rules: raw.item_priority.rules.map((r, i) => ({ when: expand(r.when, ['item_priority', 'rules', i, 'when']), value: r.value })),
          default: raw.item_priority.default,
        }
      : null,
    conditions: {
      workflow: raw.conditions.workflow.map((c) => ({
        ...(c.name !== undefined ? { name: c.name } : {}),
        type: c.type,
        command: resolveCommand(configDir, c.command),
        args: [...c.args],
        timeoutMs: c.timeout,
        cacheMs: c.cache ?? null,
      })),
      item: raw.conditions.item.map((c) => ({
        ...(c.name !== undefined ? { name: c.name } : {}),
        type: c.type,
        command: resolveCommand(configDir, c.command),
        args: [...c.args],
        timeoutMs: c.timeout,
        cacheMs: c.cache ?? null,
      })),
    },
    parameters,
    execute: normalizeExecute(exec, global, configDir),
    retry: { maxTechnicalFailures: raw.retry.max_technical_failures },
    hooks: hooks as unknown as HooksConfig,
  };
}

/** Normalize one view file. */
export function normalizeView(raw: RawView, file: string, expand: FilterExpander): ViewConfig {
  return {
    id: raw.id,
    title: raw.title ?? raw.id,
    file,
    sources: [...raw.sources],
    filter: raw.filter ? expand(raw.filter, ['filter']) : null,
    fields: normalizeViewFields(raw.fields),
    sort: normalizeViewSort(raw.sort),
    groupByFirst: raw.group_by_first ?? false,
    sections: raw.sections
      ? raw.sections.map((sec, i) => ({
          title: sec.title,
          filter: sec.filter !== undefined ? expand(sec.filter, ['sections', i, 'filter']) : null,
          rest: sec.rest ?? false,
          sort: sec.sort !== undefined ? normalizeViewSort(sec.sort) : null,
          fields: sec.fields ? normalizeViewFields(sec.fields) : null,
        }))
      : null,
    exclusive: raw.exclusive ?? true,
    hideEmptySections: raw.hide_empty_sections ?? false,
  };
}

function normalizeViewFields(fields: RawView['fields']): ViewFieldConfig[] {
  return fields.map((f) => ({ field: f.field, label: f.label ?? f.field, link: f.link ?? null }));
}

/** `sort` as written (one key or a list) → list of keys (WI-28). */
function normalizeViewSort(sort: RawViewSortKey | readonly RawViewSortKey[] | undefined): ViewSortKey[] {
  if (sort === undefined) return [];
  const keys: readonly RawViewSortKey[] = Array.isArray(sort) ? sort : [sort as RawViewSortKey];
  return keys.map((k) => ({ field: k.field, direction: k.direction, order: k.order ? [...k.order] : null }));
}
