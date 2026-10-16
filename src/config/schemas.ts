/**
 * zod schemas for the YAML files (Spec §5.1–§5.5, §17, §18).
 *
 * The schemas check structure and types, parse durations/sizes and apply
 * static defaults. Output keeps the YAML (snake_case) structure; the loader
 * normalizes it into the model of `model.ts` and runs the semantic checks
 * (references, placeholders, cron, contradictions) in `validate.ts`.
 *
 * All objects are strict: unknown keys are reported (typo protection).
 */
import { z } from 'zod';
import {
  CONFIG_ID_PATTERN,
  HOOK_NAMES,
  NOTIFICATION_EVENT_TYPES,
  parseDuration,
  parseSize,
} from '../core/index.js';
import { filterNodeSchema } from './filter-schema.js';

/** Pattern for environment variable names. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Pattern for parameter names (usable as `{parameters.<name>}`). */
export const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Default `execute.working_directory` (Spec §9). */
export const DEFAULT_WORKING_DIRECTORY = '{workspace.base_dir}/{workflow.id}/{run.id}';

/** Static defaults (Spec §5.1, §10, §11, §21). */
export const DEFAULTS = {
  serverHost: '127.0.0.1',
  serverPort: 8787,
  pollingInterval: '30s',
  globalMaxConcurrent: 5,
  workspaceCleanup: 'on_success',
  actionRetryMaxAttempts: 3,
  actionRetryDelay: '30s',
  completedRuns: '30d',
  failedRuns: '90d',
  blockedRuns: 'never',
  maxLogSizePerRun: '100MB',
  cleanupInterval: '24h',
  workflowPriority: 0,
  workflowMaxConcurrent: 1,
  maxTechnicalFailures: 3,
  checkTimeout: '30s',
  shellActionTimeout: '5m',
  cancelGrace: '30s',
  scheduleTimezone: 'UTC',
} as const;

const configId = z
  .string()
  .regex(CONFIG_ID_PATTERN, 'Invalid ID (allowed: letters, digits, "_" and "-", must start with a letter or digit, max. 64)');

const nonEmpty = z.string().trim().min(1, 'Must not be empty');

/** Duration like `30s`, parsed to milliseconds. */
export const durationSchema = z.string('Expected a duration such as 30s, 45m, 6h').transform((value, ctx) => {
  try {
    return parseDuration(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});

/** Duration or `never` (→ `null`). */
const durationOrNever = z.string('Expected a duration such as 30d or "never"').transform((value, ctx) => {
  if (value.trim() === 'never') return null;
  try {
    return parseDuration(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `${(err as Error).message} or "never"` });
    return z.NEVER;
  }
});

const sizeSchema = z.string('Expected a size such as 100MB').transform((value, ctx) => {
  try {
    return parseSize(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});

const positiveInt = z.number().int('Must be an integer').positive('Must be greater than 0');
const nonNegativeInt = z.number().int('Must be an integer').min(0, 'Must not be negative');

const envName = z.string().regex(ENV_NAME_PATTERN, 'Invalid environment variable name');

/** Env values: YAML scalars are accepted and stringified (`PORT: 8080`). */
const envMap = z
  .record(envName, z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v)))
  .default({});

const stringList = z.array(z.string()).default([]);

const notificationEvent = z.enum(NOTIFICATION_EVENT_TYPES);

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

const retryPolicySchema = z.strictObject({
  max_attempts: positiveInt.default(DEFAULTS.actionRetryMaxAttempts),
  delay: durationSchema.default(parseDuration(DEFAULTS.actionRetryDelay)),
});

const webhookChannelSchema = z.strictObject({
  id: configId.optional(),
  type: z.literal('webhook'),
  url: z.string().optional(),
  url_env: envName.optional(),
  headers_env: z.record(z.string().regex(/^[A-Za-z0-9-]+$/, 'Invalid HTTP header name'), envName).default({}),
  on: z.array(notificationEvent).optional(),
});

/** Schema of `config.yaml`. */
export const globalConfigSchema = z.strictObject({
  server: z
    .strictObject({
      host: nonEmpty.default(DEFAULTS.serverHost),
      port: z.number().int().min(1).max(65535).default(DEFAULTS.serverPort),
    })
    .default({ host: DEFAULTS.serverHost, port: DEFAULTS.serverPort }),
  scheduler: z
    .strictObject({
      polling_interval: durationSchema.default(parseDuration(DEFAULTS.pollingInterval)),
      max_concurrent: positiveInt.default(DEFAULTS.globalMaxConcurrent),
    })
    .prefault({}),
  workspace: z
    .strictObject({
      base_dir: nonEmpty.optional(),
      cleanup: z.enum(['always', 'on_success', 'never']).default(DEFAULTS.workspaceCleanup),
    })
    .prefault({}),
  lifecycle: z.strictObject({ action_retry: retryPolicySchema.prefault({}) }).prefault({}),
  retention: z
    .strictObject({
      completed_runs: durationOrNever.default(parseDuration(DEFAULTS.completedRuns)),
      failed_runs: durationOrNever.default(parseDuration(DEFAULTS.failedRuns)),
      blocked_runs: durationOrNever.default(null),
      max_log_size_per_run: sizeSchema.default(parseSize(DEFAULTS.maxLogSizePerRun)),
      cleanup_interval: durationSchema.default(parseDuration(DEFAULTS.cleanupInterval)),
    })
    .prefault({}),
  notifications: z
    .strictObject({
      on: z.array(notificationEvent).default([...NOTIFICATION_EVENT_TYPES]),
      channels: z.array(z.discriminatedUnion('type', [webhookChannelSchema])).default([]),
    })
    .prefault({}),
});

/** Parsed `config.yaml`. */
export type RawGlobalConfig = z.output<typeof globalConfigSchema>;

// ---------------------------------------------------------------------------
// sources.yaml / identities.yaml
// ---------------------------------------------------------------------------

const githubSourceSchema = z.strictObject({
  type: z.literal('github'),
  owner: nonEmpty,
  repository: nonEmpty,
  identity: configId,
});

/** Schema of `sources.yaml`. */
export const sourcesFileSchema = z.strictObject({
  sources: z.record(configId, z.discriminatedUnion('type', [githubSourceSchema])).default({}),
});

/** Parsed `sources.yaml`. */
export type RawSourcesFile = z.output<typeof sourcesFileSchema>;

const githubAppIdentitySchema = z.strictObject({
  type: z.literal('github_app'),
  app_id: positiveInt,
  installation_id: positiveInt,
  private_key_env: envName,
});

/** Schema of `identities.yaml`. */
export const identitiesFileSchema = z.strictObject({
  identities: z.record(configId, z.discriminatedUnion('type', [githubAppIdentitySchema])).default({}),
});

/** Parsed `identities.yaml`. */
export type RawIdentitiesFile = z.output<typeof identitiesFileSchema>;

// ---------------------------------------------------------------------------
// workflows/*.yaml
// ---------------------------------------------------------------------------

const triggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('source'), source: configId }),
  z.strictObject({
    type: z.literal('schedule'),
    cron: nonEmpty,
    timezone: nonEmpty.default(DEFAULTS.scheduleTimezone),
  }),
  z.strictObject({ type: z.literal('manual') }),
]);

const shellCheckSchema = z.strictObject({
  type: z.literal('shell'),
  command: nonEmpty,
  args: stringList,
  timeout: durationSchema.default(parseDuration(DEFAULTS.checkTimeout)),
  cache: durationSchema.optional(),
});

const shellFilterSchema = z.strictObject({
  command: nonEmpty,
  timeout: durationSchema.default(parseDuration(DEFAULTS.checkTimeout)),
});

const itemPrioritySchema = z.strictObject({
  rules: z.array(z.strictObject({ when: filterNodeSchema, value: z.number() })).default([]),
  default: z.number().default(0),
});

const parameterBase = {
  required: z.boolean().default(false),
  description: z.string().optional(),
};

const parameterSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), ...parameterBase, default: z.unknown().optional() }),
  z.strictObject({ type: z.literal('number'), ...parameterBase, default: z.unknown().optional() }),
  z.strictObject({ type: z.literal('boolean'), ...parameterBase, default: z.unknown().optional() }),
  z.strictObject({
    type: z.literal('enum'),
    ...parameterBase,
    values: z.array(z.union([z.string(), z.number(), z.boolean()]).transform(String)).min(1, 'Enum needs values'),
    default: z.unknown().optional(),
  }),
]);

/** Parsed parameter definition (default still unchecked; see validate.ts). */
export type RawParameter = z.output<typeof parameterSchema>;

const executeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('shell'),
    command: nonEmpty,
    args: stringList,
    working_directory: nonEmpty.default(DEFAULT_WORKING_DIRECTORY),
    create_directory: z.boolean().default(true),
    env: envMap,
    secrets: z.record(envName, z.strictObject({ identity: configId })).default({}),
    timeout: z
      .strictObject({
        max_duration: durationSchema.optional(),
        idle_timeout: durationSchema.optional(),
      })
      .default({}),
    cancel_grace: durationSchema.default(parseDuration(DEFAULTS.cancelGrace)),
  }),
]);

const actionCommon = {
  id: configId.optional(),
  continue_on_error: z.boolean().default(false),
  retry: z
    .strictObject({
      max_attempts: positiveInt.optional(),
      delay: durationSchema.optional(),
    })
    .optional(),
};

const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('source.update'),
    ...actionCommon,
    labels: z.strictObject({ add: stringList, remove: stringList }),
  }),
  z.strictObject({
    type: z.literal('source.comment'),
    ...actionCommon,
    message: nonEmpty,
    identity: configId.optional(),
  }),
  z.strictObject({
    type: z.literal('shell'),
    ...actionCommon,
    command: nonEmpty,
    args: stringList,
    timeout: durationSchema.default(parseDuration(DEFAULTS.shellActionTimeout)),
    env: envMap,
  }),
]);

/** Parsed lifecycle action. */
export type RawAction = z.output<typeof actionSchema>;

const hookList = z.array(actionSchema).default([]);

const hookShape = Object.fromEntries(HOOK_NAMES.map((h) => [h, hookList])) as Record<
  (typeof HOOK_NAMES)[number],
  typeof hookList
>;

/** Schema of one `workflows/*.yaml` file. */
export const workflowSchema = z.strictObject({
  id: configId,
  name: nonEmpty.optional(),
  enabled: z.boolean().default(true),
  priority: z.number().default(DEFAULTS.workflowPriority),
  max_concurrent: positiveInt.default(DEFAULTS.workflowMaxConcurrent),
  identity: configId.optional(),
  trigger: triggerSchema,
  filter: filterNodeSchema.optional(),
  shell_filter: shellFilterSchema.optional(),
  item_priority: itemPrioritySchema.optional(),
  conditions: z
    .strictObject({
      workflow: z.array(shellCheckSchema).default([]),
      item: z.array(shellCheckSchema).default([]),
    })
    .prefault({}),
  parameters: z.record(z.string().regex(PARAMETER_NAME_PATTERN, 'Invalid parameter name'), parameterSchema).default({}),
  execute: executeSchema,
  retry: z
    .strictObject({ max_technical_failures: positiveInt.default(DEFAULTS.maxTechnicalFailures) })
    .prefault({}),
  ...hookShape,
});

/** Parsed workflow file. */
export type RawWorkflow = z.output<typeof workflowSchema>;

// ---------------------------------------------------------------------------
// views/*.yaml
// ---------------------------------------------------------------------------

/** Schema of one `views/*.yaml` file. */
export const viewSchema = z.strictObject({
  id: configId,
  title: nonEmpty.optional(),
  sources: z.array(configId).min(1, 'A view needs at least one source'),
  filter: filterNodeSchema.optional(),
  /** Not allowed in views (Spec §6, §17); accepted here to report a precise error in validate.ts. */
  shell_filter: z.unknown().optional(),
  fields: z
    .array(
      z.strictObject({
        field: nonEmpty,
        label: z.string().optional(),
        link: nonEmpty.optional(),
      }),
    )
    .min(1, 'A view needs at least one field'),
  sort: z
    .strictObject({
      field: nonEmpty,
      direction: z.enum(['asc', 'desc']).default('asc'),
    })
    .optional(),
});

/** Parsed view file. */
export type RawView = z.output<typeof viewSchema>;
