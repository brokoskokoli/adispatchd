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
import { PROJECT_FIELD_KINDS } from '../sources/index.js';
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
  keepMaxSize: '100MB',
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

/** Duration that must be greater than zero. */
const positiveDuration = durationSchema.refine((ms) => ms > 0, 'Duration must be greater than 0');

/** Lower bound of loop intervals (polling, retention cleanup): a zero interval would spin. */
export const MIN_LOOP_INTERVAL_MS = 1_000;

/** Interval of a periodic loop: at least {@link MIN_LOOP_INTERVAL_MS}. */
const loopInterval = durationSchema.refine((ms) => ms >= MIN_LOOP_INTERVAL_MS, 'Duration must be at least 1s');

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

const positiveSize = sizeSchema.refine((bytes) => bytes > 0, 'Must be greater than 0');

const positiveInt = z.number().int('Must be an integer').positive('Must be greater than 0');
const nonNegativeInt = z.number().int('Must be an integer').min(0, 'Must not be negative');

const envName = z.string().regex(ENV_NAME_PATTERN, 'Invalid environment variable name');

/** Env values: YAML scalars are accepted and stringified (`PORT: 8080`). */
const envMap = z
  .record(envName, z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v)))
  .default({});

const stringList = z.array(z.string()).default([]);

/** How a secret reaches the process (WI-18): `env` = value in the variable, `file` = path in `<NAME>_FILE`. */
export const SECRET_DELIVERIES = ['env', 'file'] as const;

/** `secrets` of `execute` and `shell` actions: env name → identity whose token is handed over. */
const secretsMap = z
  .record(envName, z.strictObject({ identity: configId, delivery: z.enum(SECRET_DELIVERIES).default('env') }))
  .default({});

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
      /**
       * Additional host names (optionally `name:port`) accepted in the `Host` / `Origin`
       * header, e.g. the public name of an authenticating reverse proxy (DNS-rebinding protection).
       */
      allowed_hosts: z
        .array(z.string().regex(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/, 'Invalid host name (expected "name" or "name:port")'))
        .default([]),
    })
    .default({ host: DEFAULTS.serverHost, port: DEFAULTS.serverPort, allowed_hosts: [] }),
  scheduler: z
    .strictObject({
      polling_interval: loopInterval.default(parseDuration(DEFAULTS.pollingInterval)),
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
      cleanup_interval: loopInterval.default(parseDuration(DEFAULTS.cleanupInterval)),
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

/**
 * Problem with a declared project field name (`project.<name>`), or
 * `undefined`: the name is used as written, so it must not be empty, start or
 * end with whitespace, or contain control characters.
 */
function projectFieldNameError(name: string): string | undefined {
  if (name === '') return 'Project field name must not be empty';
  if (name.trim() !== name) return 'Project field name must not start or end with whitespace';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Project field name must not contain control characters';
  return undefined;
}

const githubProjectSchema = z.strictObject({
  /** User or organisation login of the project; default: the source owner. */
  owner: nonEmpty.optional(),
  number: positiveInt,
  /** Identity for reading the project; default: the source identity. */
  identity: configId.optional(),
  fields: z
    .record(z.string(), z.enum(PROJECT_FIELD_KINDS, `Expected one of: ${PROJECT_FIELD_KINDS.join(', ')}`))
    .superRefine((fields, ctx) => {
      const names = Object.keys(fields);
      if (names.length === 0) ctx.addIssue({ code: 'custom', message: 'Declare at least one project field' });
      for (const name of names) {
        const message = projectFieldNameError(name);
        if (message) ctx.addIssue({ code: 'custom', path: [name], message });
      }
    }),
});

/** Pattern for source variable names (usable as `{source.vars.<name>}`, WI-20). */
export const SOURCE_VAR_NAME_PATTERN = PARAMETER_NAME_PATTERN;

/**
 * Free per-source variables (WI-20): name → string. YAML scalars are
 * stringified like `env` values (`version: 2` → `"2"`).
 */
const sourceVarsSchema = z
  .record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()], { error: 'Expected a string (numbers and booleans are converted)' }).transform((v) => String(v)),
  )
  .superRefine((vars, ctx) => {
    // Checked here (not as record key schema) to keep the precise message and path.
    for (const name of Object.keys(vars)) {
      if (!SOURCE_VAR_NAME_PATTERN.test(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'Invalid variable name (allowed: letters, digits, "_" and "-", must start with a letter or "_")',
        });
      }
    }
  });

const githubSourceSchema = z.strictObject({
  type: z.literal('github'),
  owner: nonEmpty,
  repository: nonEmpty,
  identity: configId,
  project: githubProjectSchema.optional(),
  vars: sourceVarsSchema.optional(),
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

/** Token identity (e.g. a fine-grained personal access token); the token is read from `token_env`. */
const githubTokenIdentitySchema = z.strictObject({
  type: z.literal('github_token'),
  token_env: envName,
});

/** Schema of `identities.yaml`. */
export const identitiesFileSchema = z.strictObject({
  identities: z.record(configId, z.discriminatedUnion('type', [githubAppIdentitySchema, githubTokenIdentitySchema])).default({}),
});

/** Parsed `identities.yaml`. */
export type RawIdentitiesFile = z.output<typeof identitiesFileSchema>;

// ---------------------------------------------------------------------------
// workflows/*.yaml
// ---------------------------------------------------------------------------

/**
 * Source trigger: exactly one of `source: <id>` or (WI-20) `sources: [<id>, ...]`
 * (non-empty, unique; the list order is the tie-breaker between sources).
 */
const sourceTriggerSchema = z
  .strictObject({ type: z.literal('source'), source: configId.optional(), sources: z.array(configId).optional() })
  .superRefine((trigger, ctx) => {
    if (trigger.source !== undefined && trigger.sources !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: '"source" and "sources" are mutually exclusive: use "source: <id>" for one source or "sources: [<id>, ...]" for several',
      });
      return;
    }
    if (trigger.source === undefined && trigger.sources === undefined) {
      ctx.addIssue({ code: 'custom', message: 'A source trigger needs "source: <id>" or "sources: [<id>, ...]"' });
      return;
    }
    if (trigger.sources === undefined) return;
    if (trigger.sources.length === 0) ctx.addIssue({ code: 'custom', path: ['sources'], message: '"sources" must not be empty' });
    const seen = new Set<string>();
    trigger.sources.forEach((id, i) => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['sources', i], message: `Source "${id}" is listed more than once` });
      seen.add(id);
    });
  });

const triggerSchema = z.discriminatedUnion('type', [
  sourceTriggerSchema,
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
  timeout: positiveDuration.default(parseDuration(DEFAULTS.checkTimeout)),
  cache: durationSchema.optional(),
});

const shellFilterSchema = z.strictObject({
  command: nonEmpty,
  timeout: positiveDuration.default(parseDuration(DEFAULTS.checkTimeout)),
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
    // Scalars are stringified like `values`, so `values: [1, 2]` + `default: 1` matches.
    default: z
      .unknown()
      .optional()
      .transform((v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v)),
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
    secrets: secretsMap,
    timeout: z
      .strictObject({
        max_duration: positiveDuration.optional(),
        idle_timeout: positiveDuration.optional(),
      })
      .default({}),
    cancel_grace: durationSchema.default(parseDuration(DEFAULTS.cancelGrace)),
    // Patterns are checked in validate.ts (path + message per entry).
    keep: z.array(z.string('Expected a pattern such as .agent/*.log')).default([]),
    keep_max_size: positiveSize.optional(),
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

/**
 * Desired value of a project field in `source.update` (WI-16): string,
 * number or `null` (= clear). A YAML timestamp parsed as Date (YAML 1.1
 * documents) becomes `YYYY-MM-DD` at UTC midnight, otherwise its ISO string
 * (which the date check then rejects). Checked per kind in validate.ts.
 */
const projectUpdateValue = z
  .union([z.string(), z.number(), z.null(), z.date()], { error: 'Expected a string, a number, a date or null' })
  .transform((value) => {
    if (!(value instanceof Date)) return value;
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  });

const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('source.update'),
    ...actionCommon,
    labels: z.strictObject({ add: stringList, remove: stringList }).optional(),
    project: z.record(z.string(), projectUpdateValue).optional(),
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
    timeout: positiveDuration.default(parseDuration(DEFAULTS.shellActionTimeout)),
    env: envMap,
    secrets: secretsMap,
  }),
]);

/** Parsed lifecycle action. */
export type RawAction = z.output<typeof actionSchema>;

const hookList = z.array(actionSchema).default([]);
/**
 * Hooks whose presence matters (WI-17): a technical hook that is configured –
 * even as `[]` – takes precedence over `on_error`, so "not given" must stay
 * distinguishable from an empty list.
 */
const optionalHookList = z.array(actionSchema).optional();

/** Hooks that always resolve to a list (`[]` if not given). */
const ALWAYS_LIST_HOOKS = ['on_start', 'on_success', 'on_failure'] as const satisfies readonly (typeof HOOK_NAMES)[number][];

const hookShape = Object.fromEntries(
  HOOK_NAMES.map((h) => [h, (ALWAYS_LIST_HOOKS as readonly string[]).includes(h) ? hookList : optionalHookList]),
) as Record<(typeof ALWAYS_LIST_HOOKS)[number], typeof hookList> &
  Record<Exclude<(typeof HOOK_NAMES)[number], (typeof ALWAYS_LIST_HOOKS)[number]>, typeof optionalHookList>;

/** Schema of one `workflows/*.yaml` file. */
export const workflowSchema = z.strictObject({
  id: configId,
  name: nonEmpty.optional(),
  enabled: z.boolean().default(true),
  priority: z.number().default(DEFAULTS.workflowPriority),
  max_concurrent: positiveInt.default(DEFAULTS.workflowMaxConcurrent),
  /** Optional limit per source of a source workflow (WI-20); `max_concurrent` stays the overall limit. */
  max_concurrent_per_source: positiveInt.optional(),
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
  /** Named outcomes (WI-17): `on_result.<outcome>` replaces `on_success`/`on_failure`. */
  on_result: z.record(configId, z.array(actionSchema)).optional(),
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

// ---------------------------------------------------------------------------
// filters/*.yaml (WI-15)
// ---------------------------------------------------------------------------

/** Schema of one `filters/*.yaml` file: a named, reusable filter. */
export const namedFilterSchema = z.strictObject({
  id: configId,
  description: z.string().optional(),
  filter: filterNodeSchema,
});

/** Parsed named filter file. */
export type RawNamedFilter = z.output<typeof namedFilterSchema>;
