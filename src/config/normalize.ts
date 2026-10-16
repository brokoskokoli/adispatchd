/**
 * Conversion of parsed YAML (snake_case, see `schemas.ts`) into the
 * normalized model (`model.ts`). Pure; semantic checks live in `validate.ts`.
 */
import path from 'node:path';
import { dataPaths, HOOK_NAMES, type HookName } from '../core/index.js';
import type {
  GlobalConfig,
  HooksConfig,
  IdentityConfig,
  LifecycleActionConfig,
  ParameterDefinition,
  RetryPolicy,
  SourceConfig,
  ViewConfig,
  WorkflowConfig,
} from './model.js';
import type {
  RawAction,
  RawGlobalConfig,
  RawIdentitiesFile,
  RawParameter,
  RawSourcesFile,
  RawView,
  RawWorkflow,
} from './schemas.js';

/** Resolve a configured directory: absolute stays, relative is taken relative to the config dir. */
export function resolveConfigPath(configDir: string, value: string): string {
  return path.resolve(configDir, value);
}

/** Normalize `config.yaml`. */
export function normalizeGlobal(raw: RawGlobalConfig, configDir: string, dataDir: string): GlobalConfig {
  const baseDir = raw.workspace.base_dir
    ? resolveConfigPath(configDir, raw.workspace.base_dir)
    : dataPaths(dataDir).defaultWorkspacesDir;
  return {
    server: { host: raw.server.host, port: raw.server.port },
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
  };
}

/** Normalize `sources.yaml`. */
export function normalizeSources(raw: RawSourcesFile): Record<string, SourceConfig> {
  const out: Record<string, SourceConfig> = {};
  for (const [id, source] of Object.entries(raw.sources)) {
    out[id] = { id, type: source.type, owner: source.owner, repository: source.repository, identity: source.identity };
  }
  return out;
}

/** Normalize `identities.yaml`. */
export function normalizeIdentities(raw: RawIdentitiesFile): Record<string, IdentityConfig> {
  const out: Record<string, IdentityConfig> = {};
  for (const [id, identity] of Object.entries(raw.identities)) {
    out[id] = {
      id,
      type: identity.type,
      appId: identity.app_id,
      installationId: identity.installation_id,
      privateKeyEnv: identity.private_key_env,
    };
  }
  return out;
}

function normalizeParameter(raw: RawParameter): ParameterDefinition {
  const base = { required: raw.required, description: raw.description ?? null };
  // Defaults are type-checked in validate.ts; here they are only narrowed.
  switch (raw.type) {
    case 'string':
      return { type: 'string', ...base, default: typeof raw.default === 'string' ? raw.default : null };
    case 'number':
      return { type: 'number', ...base, default: typeof raw.default === 'number' ? raw.default : null };
    case 'boolean':
      return { type: 'boolean', ...base, default: typeof raw.default === 'boolean' ? raw.default : null };
    case 'enum':
      return {
        type: 'enum',
        ...base,
        values: [...raw.values],
        default: typeof raw.default === 'string' && raw.values.includes(raw.default) ? raw.default : null,
      };
  }
}

function normalizeAction(raw: RawAction, hook: HookName, index: number, defaults: RetryPolicy): LifecycleActionConfig {
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
      return { ...common, type: 'source.update', labels: { add: [...raw.labels.add], remove: [...raw.labels.remove] } };
    case 'source.comment':
      return { ...common, type: 'source.comment', message: raw.message, identity: raw.identity ?? null };
    case 'shell':
      return {
        ...common,
        type: 'shell',
        command: raw.command,
        args: [...raw.args],
        timeoutMs: raw.timeout,
        env: { ...raw.env },
      };
  }
}

/** Normalize one workflow file. */
export function normalizeWorkflow(raw: RawWorkflow, file: string, global: GlobalConfig): WorkflowConfig {
  const hooks = Object.fromEntries(
    HOOK_NAMES.map((hook) => [
      hook,
      raw[hook].map((action, i) => normalizeAction(action, hook, i, global.lifecycle.actionRetry)),
    ]),
  ) as unknown as HooksConfig;
  const parameters: Record<string, ParameterDefinition> = {};
  for (const [name, def] of Object.entries(raw.parameters)) parameters[name] = normalizeParameter(def);
  const exec = raw.execute;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    file,
    enabled: raw.enabled,
    priority: raw.priority,
    maxConcurrent: raw.max_concurrent,
    identity: raw.identity ?? null,
    trigger:
      raw.trigger.type === 'schedule'
        ? { type: 'schedule', cron: raw.trigger.cron, timezone: raw.trigger.timezone }
        : raw.trigger.type === 'source'
          ? { type: 'source', source: raw.trigger.source }
          : { type: 'manual' },
    filter: raw.filter ?? null,
    shellFilter: raw.shell_filter ? { command: raw.shell_filter.command, timeoutMs: raw.shell_filter.timeout } : null,
    itemPriority: raw.item_priority
      ? { rules: raw.item_priority.rules.map((r) => ({ when: r.when, value: r.value })), default: raw.item_priority.default }
      : null,
    conditions: {
      workflow: raw.conditions.workflow.map((c) => ({
        type: c.type,
        command: c.command,
        args: [...c.args],
        timeoutMs: c.timeout,
        cacheMs: c.cache ?? null,
      })),
      item: raw.conditions.item.map((c) => ({
        type: c.type,
        command: c.command,
        args: [...c.args],
        timeoutMs: c.timeout,
        cacheMs: c.cache ?? null,
      })),
    },
    parameters,
    execute: {
      type: exec.type,
      command: exec.command,
      args: [...exec.args],
      workingDirectory: exec.working_directory,
      createDirectory: exec.create_directory,
      env: { ...exec.env },
      secrets: Object.fromEntries(Object.entries(exec.secrets).map(([k, v]) => [k, { identity: v.identity }])),
      timeout: {
        maxDurationMs: exec.timeout.max_duration ?? null,
        idleTimeoutMs: exec.timeout.idle_timeout ?? null,
      },
      cancelGraceMs: exec.cancel_grace,
    },
    retry: { maxTechnicalFailures: raw.retry.max_technical_failures },
    hooks,
  };
}

/** Normalize one view file. */
export function normalizeView(raw: RawView, file: string): ViewConfig {
  return {
    id: raw.id,
    title: raw.title ?? raw.id,
    file,
    sources: [...raw.sources],
    filter: raw.filter ?? null,
    fields: raw.fields.map((f) => ({ field: f.field, label: f.label ?? f.field, link: f.link ?? null })),
    sort: raw.sort ? { field: raw.sort.field, direction: raw.sort.direction } : null,
  };
}
