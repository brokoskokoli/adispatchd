/**
 * Semantic validation across files (Spec §19): references, unique IDs,
 * allowed placeholders per context, contradictions, cron/time zone and
 * parameter defaults. Runs on the normalized model; paths in issues use the
 * YAML key names.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import {
  ARTIFACT_SOURCE_TYPE,
  CONTAINER_PATHS,
  artifactPathError,
  formatDuration,
  isContainerEngineEnvName,
  extractPlaceholders,
  isSecretKey,
  keepPatternError,
  outcomeOfHook,
  TECHNICAL_OUTCOME_HOOKS,
  VIEW_HISTORY_FIELD,
  isRetryBlockHook,
  validateTemplate,
  type HookName,
  type TemplateMode,
  type TemplateScope,
} from '../core/index.js';
import { PROJECT_FIELD_PREFIX, valueProblem } from '../sources/index.js';
import {
  checkFieldName,
  checkFilterFields,
  checkSectionListing,
  fieldType,
  providesLinkedFields,
  suggestField,
  viewFieldContext,
  workflowFieldContext,
  type FieldIssue,
} from './field-catalog.js';
import { isIdentityForgeableLocally } from './auth.js';
import { validateExternalLinks } from './external-links.js';
import type { RawFilterNode } from './filter-schema.js';
import { formatIssuePath, type IssueCollector, type IssuePath } from './issues.js';
import {
  configuredHooks,
  resultHookOutcomes,
  type ContainerExecuteConfig,
  triggerSourceIds,
  type GlobalConfig,
  type IdentityConfig,
  type LifecycleActionConfig,
  type ParameterDefinition,
  type ParameterOptionsSource,
  type SecretRef,
  type SourceConfig,
  type ViewConfig,
  type ViewFieldConfig,
  type ViewSortKey,
  type WorkflowConfig,
} from './model.js';
import type { NamedFilters } from './named-filters.js';
import { MAX_MONITORING_SAMPLES, MIN_MONITORING_SAMPLES, PARAMETER_OPTIONS_DEFAULTS, type RawParameter, type RawParameterOptionsFrom } from './schemas.js';

/** Files of the top-level documents. */
export const CONFIG_FILE = 'config.yaml';
export const SOURCES_FILE = 'sources.yaml';
export const IDENTITIES_FILE = 'identities.yaml';

/** Env variable prefix reserved for the orchestrator (Spec §9.1). */
export const RESERVED_ENV_PREFIX = 'ADISPATCH_';

/** A workflow together with the raw data needed for checks the model cannot express. */
export interface WorkflowEntry {
  workflow: WorkflowConfig;
  rawParameters: Readonly<Record<string, RawParameter>>;
  /** Filter trees as written (with references to named filters), to locate field issues. */
  rawFilter: RawFilterNode | null;
  rawPriorityRules: readonly RawFilterNode[];
}

/** A view together with raw flags. */
export interface ViewEntry {
  view: ViewConfig;
  hasShellFilter: boolean;
  /** Filter tree as written (with references to named filters). */
  rawFilter: RawFilterNode | null;
  /** `sort` written as a list (issue paths `sort.<i>.…` instead of `sort.…`, WI-28). */
  rawSortIsList?: boolean;
  /** Per section: filter as written and whether `sort` is a list (WI-28). */
  rawSections?: ReadonlyArray<{ filter: RawFilterNode | null; sortIsList: boolean }>;
  /** Section-only keys present in the file (`exclusive`, `hide_empty_sections`). */
  rawSectionOptions?: readonly string[];
}

/** Input of {@link validateSemantics}. */
export interface SemanticInput {
  global: GlobalConfig;
  sources: Readonly<Record<string, SourceConfig>>;
  identities: Readonly<Record<string, IdentityConfig>>;
  workflows: readonly WorkflowEntry[];
  views: readonly ViewEntry[];
  namedFilters: NamedFilters;
}

/** True if `tz` is a valid IANA time zone for this runtime. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate a cron expression (croner syntax); returns an error message or `undefined`. */
export function cronError(expression: string, timezone?: string): string | undefined {
  try {
    const job = new Cron(expression, { paused: true, ...(timezone ? { timezone } : {}) });
    const next = job.nextRun();
    job.stop();
    if (next === null) return `Cron expression "${expression}" never fires`;
    return undefined;
  } catch (err) {
    return `Invalid cron expression "${expression}": ${(err as Error).message}`;
  }
}

/** Run all semantic checks and add problems to `issues`. */
export function validateSemantics(input: SemanticInput, issues: IssueCollector): void {
  validateGlobal(input.global, issues);
  validateSources(input, issues);
  validateUiActions(input, issues);
  const seenWorkflows = new Map<string, string>();
  for (const entry of input.workflows) {
    const { workflow } = entry;
    const previous = seenWorkflows.get(workflow.id);
    if (previous !== undefined) {
      issues.error(workflow.file, ['id'], `Duplicate workflow ID "${workflow.id}" (already defined in ${previous})`);
      continue;
    }
    seenWorkflows.set(workflow.id, workflow.file);
    validateWorkflow(entry, input, issues);
  }
  const seenViews = new Map<string, string>();
  for (const entry of input.views) {
    const previous = seenViews.get(entry.view.id);
    if (previous !== undefined) {
      issues.error(entry.view.file, ['id'], `Duplicate view ID "${entry.view.id}" (already defined in ${previous})`);
      continue;
    }
    seenViews.set(entry.view.id, entry.view.file);
    validateView(entry, input, issues);
  }
}

function validateGlobal(global: GlobalConfig, issues: IssueCollector): void {
  const { intervalMs, retentionMs } = global.monitoring;
  if (retentionMs < intervalMs * MIN_MONITORING_SAMPLES) {
    issues.error(CONFIG_FILE, ['monitoring', 'retention'], `Must be at least ${MIN_MONITORING_SAMPLES} sampling intervals (${MIN_MONITORING_SAMPLES} × ${formatDuration(intervalMs)})`);
  } else if (retentionMs > intervalMs * MAX_MONITORING_SAMPLES) {
    issues.error(CONFIG_FILE, ['monitoring', 'retention'], `Must be at most ${MAX_MONITORING_SAMPLES} sampling intervals (${MAX_MONITORING_SAMPLES} × ${formatDuration(intervalMs)})`);
  }
  validateExternalLinks(global.ui.externalLinks, CONFIG_FILE, issues);
  validateAuth(global, issues);
  const ids = new Set<string>();
  global.notifications.channels.forEach((channel, i) => {
    const at: IssuePath = ['notifications', 'channels', i];
    if (ids.has(channel.id)) issues.error(CONFIG_FILE, [...at, 'id'], `Duplicate channel ID "${channel.id}"`);
    ids.add(channel.id);
    if ((channel.url === null) === (channel.urlEnv === null)) {
      issues.error(CONFIG_FILE, at, 'Webhook channel needs exactly one of "url" or "url_env"');
    } else if (channel.url !== null && !isHttpUrl(channel.url)) {
      // Never echo the URL: it may contain a token (Spec §18).
      issues.error(CONFIG_FILE, [...at, 'url'], 'Webhook "url" must be an absolute http(s) URL');
    }
  });
}

/** `auth:` (WI-26): unique users; a mode without users locks everybody out (warning, the control token still works). */
function validateAuth(global: GlobalConfig, issues: IssueCollector): void {
  const auth = global.auth;
  const names = new Set<string>();
  auth.users.forEach((user, i) => {
    const key = user.name.toLowerCase();
    if (names.has(key)) issues.error(CONFIG_FILE, ['auth', 'users', i, 'name'], `Duplicate user "${user.name}"`);
    names.add(key);
  });
  const logins = new Set<string>();
  auth.trustedHeader.users.forEach((user, i) => {
    if (logins.has(user.login)) issues.error(CONFIG_FILE, ['auth', 'trusted_header', 'users', i, 'login'], `Duplicate login "${user.login}"`);
    logins.add(user.login);
  });
  if (auth.mode === 'password' && auth.users.length === 0) {
    issues.warning(CONFIG_FILE, ['auth', 'users'], 'No users configured: nobody can log in to the web UI (CLI control commands still work locally)');
  }
  if (auth.mode === 'trusted_header' && auth.trustedHeader.users.length === 0) {
    issues.warning(CONFIG_FILE, ['auth', 'trusted_header', 'users'], 'No logins configured: every request is rejected with 403 (CLI control commands still work locally)');
  }
  if (auth.mode === 'trusted_header' && auth.trustedHeader.trustedProxies.length === 0) {
    issues.warning(CONFIG_FILE, ['auth', 'trusted_header', 'trusted_proxies'], 'No trusted proxies: every request is rejected with 401');
  }
  const anyAddress = (list: readonly string[], at: IssuePath): void => {
    list.forEach((entry, i) => {
      if (/\/0$/.test(entry)) issues.warning(CONFIG_FILE, [...at, i], `"${entry}" trusts every address: anyone who can connect can claim an identity or HTTPS`);
    });
  };
  anyAddress(auth.trustedHeader.trustedProxies, ['auth', 'trusted_header', 'trusted_proxies']);
  anyAddress(auth.trustedProxies, ['auth', 'trusted_proxies']);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * `ui_actions: true` (WI-27) only works with a login: without one the UI
 * actions are disabled (warning). With a header login that local processes
 * can forge, a worker could act as the identity: error.
 */
function validateUiActions(input: SemanticInput, issues: IssueCollector): void {
  const mode = input.global.auth.mode;
  const forgeable = isIdentityForgeableLocally(input.global.auth);
  for (const identity of Object.values(input.identities)) {
    if (!identity.uiActions) continue;
    const at: IssuePath = ['identities', identity.id, 'ui_actions'];
    if (mode === 'none') {
      issues.warning(IDENTITIES_FILE, at, 'UI actions need a login (auth.mode password or trusted_header); with auth.mode none they are disabled');
    } else if (forgeable) {
      issues.error(
        IDENTITIES_FILE,
        at,
        'UI actions are not allowed with auth.mode trusted_header behind a local (loopback) proxy without auth.trusted_header.proxy_secret_env: any local process, including workers, could forge the login header. Use auth.mode password (also works over Tailscale) or set proxy_secret_env',
      );
    }
  }
}

function validateSources(input: SemanticInput, issues: IssueCollector): void {
  const artifactSources = Object.values(input.sources).filter((s) => s.type === ARTIFACT_SOURCE_TYPE);
  artifactSources.slice(1).forEach((source) =>
    issues.error(
      SOURCES_FILE,
      ['sources', source.id],
      `Only one source of type "${ARTIFACT_SOURCE_TYPE}" is allowed (already defined: "${artifactSources[0]?.id ?? ''}")`,
    ),
  );
  for (const source of Object.values(input.sources)) {
    if (source.identity === null) continue; // artifacts source: no identity
    if (!input.identities[source.identity]) {
      issues.error(SOURCES_FILE, ['sources', source.id, 'identity'], `Unknown identity "${source.identity}"`);
    }
    // Only check an explicit project identity (the default is the source identity, checked above).
    if (source.project && source.project.identity !== source.identity && !input.identities[source.project.identity]) {
      issues.error(SOURCES_FILE, ['sources', source.id, 'project', 'identity'], `Unknown identity "${source.project.identity}"`);
    }
  }
}

function checkIdentity(
  id: string | null | undefined,
  input: SemanticInput,
  issues: IssueCollector,
  file: string,
  at: IssuePath,
): void {
  if (id && !input.identities[id]) {
    const suggestion = suggestField(id, Object.keys(input.identities));
    issues.error(file, at, `Unknown identity "${id}"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`);
  }
}

/**
 * `secrets` of `execute` and `shell` actions (WI-18): reserved prefix,
 * existing identities, no clash with `env`; with `delivery: file` the
 * generated `<NAME>_FILE` must clash neither with `env` nor with another secret.
 */
function checkSecrets(
  secrets: Readonly<Record<string, SecretRef>>,
  env: Readonly<Record<string, string>>,
  input: SemanticInput,
  issues: IssueCollector,
  file: string,
  at: IssuePath,
): void {
  checkEnvNames(Object.keys(secrets), issues, file, at);
  for (const [name, ref] of Object.entries(secrets)) {
    checkIdentity(ref.identity, input, issues, file, [...at, name, 'identity']);
    if (name in env) {
      issues.error(file, [...at, name], `"${name}" is defined both in "env" and "secrets"`);
    }
    if (ref.delivery !== 'file') continue;
    const fileVar = `${name}_FILE`;
    if (fileVar in env) {
      issues.error(file, [...at, name, 'delivery'], `"delivery: file" sets "${fileVar}", which is also defined in "env"`);
    }
    if (fileVar in secrets) {
      issues.error(file, [...at, name, 'delivery'], `"delivery: file" sets "${fileVar}", which is also a secret name`);
    }
  }
}

function checkTemplate(
  template: string,
  mode: TemplateMode,
  scope: TemplateScope,
  issues: IssueCollector,
  file: string,
  at: IssuePath,
): void {
  for (const issue of validateTemplate(template, { mode, scope })) {
    issues.error(file, at, issue.message);
  }
}

/** Error for env names with the reserved prefix. */
export function checkEnvNames(
  names: readonly string[],
  issues: IssueCollector,
  file: string,
  at: IssuePath,
): void {
  for (const name of names) {
    if (name.toUpperCase().startsWith(RESERVED_ENV_PREFIX)) {
      issues.error(file, [...at, name], `Environment variables with prefix "${RESERVED_ENV_PREFIX}" are reserved`);
    }
  }
}

/** Warning for literal values of secret-looking env names. */
export function checkLiteralSecrets(env: Readonly<Record<string, string>>, issues: IssueCollector, file: string, at: IssuePath): void {
  for (const [name, value] of Object.entries(env)) {
    if (value !== '' && isSecretKey(name)) {
      issues.warning(
        file,
        [...at, name],
        'Looks like a secret stored literally in YAML; use "secrets" with an identity or an environment of the service instead',
      );
    }
  }
}

function validateWorkflow(entry: WorkflowEntry, input: SemanticInput, issues: IssueCollector): void {
  const { workflow: wf } = entry;
  const file = wf.file;
  const stem = path.basename(file, path.extname(file));
  if (stem !== wf.id) {
    issues.warning(file, ['id'], `Workflow ID "${wf.id}" differs from file name "${path.basename(file)}"`);
  }
  checkIdentity(wf.identity, input, issues, file, ['identity']);

  const isSource = wf.trigger.type === 'source';
  // Known trigger sources in configured order (WI-20: several; unknown ones are reported here).
  const triggerSources: SourceConfig[] = [];
  let sameType = true;
  if (wf.trigger.type === 'source') {
    const multi = wf.trigger.sources !== undefined;
    triggerSourceIds(wf.trigger).forEach((id, i) => {
      const source = input.sources[id];
      if (!source) issues.error(file, multi ? ['trigger', 'sources', i] : ['trigger', 'source'], `Unknown source "${id}"`);
      else triggerSources.push(source);
    });
    const types = [...new Set(triggerSources.map((s) => s.type))];
    if (types.length > 1) {
      sameType = false;
      issues.error(file, ['trigger', 'sources'], `All sources of a workflow must have the same adapter type (found: ${types.join(', ')})`);
    }
  } else if (wf.maxConcurrentPerSource !== undefined) {
    issues.error(
      file,
      ['max_concurrent_per_source'],
      `"max_concurrent_per_source" is only allowed for workflows with a source trigger (trigger is "${wf.trigger.type}")`,
    );
  }
  if (wf.trigger.type === 'schedule') {
    const tzOk = isValidTimeZone(wf.trigger.timezone);
    if (!tzOk) issues.error(file, ['trigger', 'timezone'], `Invalid time zone "${wf.trigger.timezone}"`);
    const err = cronError(wf.trigger.cron, tzOk ? wf.trigger.timezone : undefined);
    if (err) issues.error(file, ['trigger', 'cron'], err);
  }
  if (triggerSources.length > 0 && sameType) {
    const ctx = workflowFieldContext(triggerSources);
    const target = (raw: RawFilterNode | undefined, at: IssuePath): FieldIssueTarget => ({
      issues,
      file,
      at,
      raw: raw ?? null,
      named: input.namedFilters,
    });
    if (wf.filter) {
      addFieldIssues(checkFilterFields(wf.filter, ctx, { listing: true }), target(entry.rawFilter ?? undefined, ['filter']));
    }
    wf.itemPriority?.rules.forEach((rule, i) =>
      addFieldIssues(
        checkFilterFields(rule.when, ctx, { listing: false }),
        target(entry.rawPriorityRules[i], ['item_priority', 'rules', i, 'when']),
      ),
    );
  }
  // Artifact items (WI-35): `{item.name}`, `{item.type}`, `{item.path}`.
  const artifact = triggerSources.length > 0 && triggerSources.every((s) => s.type === ARTIFACT_SOURCE_TYPE);
  // `{item.work_branch}` / `{item.work_pr}` need adapters that provide the linked fields (WI-21) – every trigger source.
  const linked = triggerSources.length > 0 && triggerSources.every((s) => providesLinkedFields(s.type));
  // `{source.vars.<name>}` must be defined in every (known) source of the workflow (WI-20).
  const sourceVar = (name: string): string | undefined => {
    const missing = triggerSources.filter((s) => !Object.hasOwn(s.vars, name)).map((s) => `"${s.id}"`);
    if (missing.length === 0) return undefined;
    const where = missing.length === 1 ? `source ${missing[0] ?? ''}` : `sources ${missing.join(', ')}`;
    return `Source variable "${name}" is not defined in "vars" of ${where} (sources.yaml)`;
  };
  if (!isSource) {
    const why = `is only allowed for workflows with a source trigger (trigger is "${wf.trigger.type}")`;
    if (wf.filter) issues.error(file, ['filter'], `"filter" ${why}`);
    if (wf.shellFilter) issues.error(file, ['shell_filter'], `"shell_filter" ${why}`);
    if (wf.itemPriority) issues.error(file, ['item_priority'], `"item_priority" ${why}`);
    if (wf.conditions.item.length > 0) issues.error(file, ['conditions', 'item'], `Item conditions ${why}`);
  }

  // Parameters
  const automatic = wf.trigger.type !== 'manual';
  for (const [name, raw] of Object.entries(entry.rawParameters)) {
    validateParameter(name, raw, wf.parameters[name], automatic, input, issues, file);
  }
  const parameterNames = Object.keys(wf.parameters);

  // Conditions: evaluated before a run exists, without manual parameters.
  wf.conditions.workflow.forEach((c, i) =>
    c.args.forEach((arg, j) => checkTemplate(arg, 'text', {}, issues, file, ['conditions', 'workflow', i, 'args', j])),
  );
  wf.conditions.item.forEach((c, i) =>
    c.args.forEach((arg, j) =>
      checkTemplate(arg, 'text', { source: true, sourceVar, artifact }, issues, file, ['conditions', 'item', i, 'args', j]),
    ),
  );

  wf.conditions.item.forEach((c, i) => {
    if (c.cacheMs !== null) {
      issues.error(file, ['conditions', 'item', i, 'cache'], '"cache" is only supported for workflow conditions');
    }
  });

  // Execute
  const exec = wf.execute;
  const wdIssues = issues.items.length;
  checkTemplate(exec.workingDirectory, 'path', { run: true, source: isSource, sourceVar, linked, artifact, parameters: parameterNames }, issues, file, [
    'execute',
    'working_directory',
  ]);
  // In path mode a parameter must always have a value: required or with default.
  const wdPlaceholders = safePlaceholders(exec.workingDirectory);
  for (const [name, def] of Object.entries(wf.parameters)) {
    if (!def.required && def.default === null && wdPlaceholders.includes(`parameters.${name}`)) {
      issues.error(
        file,
        ['execute', 'working_directory'],
        `Parameter "${name}" is optional without default and cannot be used in a path`,
      );
    }
  }
  if (
    issues.items.length === wdIssues &&
    !exec.workingDirectory.startsWith('/') &&
    !exec.workingDirectory.startsWith('{workspace.base_dir}')
  ) {
    issues.error(file, ['execute', 'working_directory'], 'Must be absolute: start with "/" or "{workspace.base_dir}"');
  }
  const runScope: TemplateScope = { run: true, workspace: true, source: isSource, sourceVar, linked, artifact, artifactInput: artifact, parameters: parameterNames };
  if (exec.type === 'shell') {
    exec.args.forEach((arg, i) => checkTemplate(arg, 'text', runScope, issues, file, ['execute', 'args', i]));
  } else {
    exec.command.forEach((arg, i) => checkTemplate(arg, 'text', runScope, issues, file, ['execute', 'command', i]));
    validateContainer(exec, issues, file);
  }
  for (const [name, value] of Object.entries(exec.env)) {
    checkTemplate(value, 'text', runScope, issues, file, ['execute', 'env', name]);
  }
  checkEnvNames(Object.keys(exec.env), issues, file, ['execute', 'env']);
  checkLiteralSecrets(exec.env, issues, file, ['execute', 'env']);
  checkSecrets(exec.secrets, exec.env, input, issues, file, ['execute', 'secrets']);
  exec.keep.forEach((pattern, i) => {
    const error = keepPatternError(pattern);
    if (error) issues.error(file, ['execute', 'keep', i], error);
  });
  exec.artifacts.forEach((entry, i) => {
    const at: IssuePath = ['execute', 'artifacts', i];
    const error = artifactPathError(entry.path);
    if (error) issues.error(file, [...at, 'path'], error);
    checkTemplate(entry.name, 'text', runScope, issues, file, [...at, 'name']);
    if (/[\u0000-\u001f\u007f]/.test(entry.type)) issues.error(file, [...at, 'type'], 'Type must not contain control characters');
  });
  const { maxDurationMs, idleTimeoutMs } = exec.timeout;
  if (maxDurationMs !== null && idleTimeoutMs !== null && idleTimeoutMs > maxDurationMs) {
    issues.warning(file, ['execute', 'timeout', 'idle_timeout'], '"idle_timeout" is longer than "max_duration"');
  }

  // Hooks
  const actionIds = new Map<string, string>();
  for (const [hook, actions] of configuredHooks(wf.hooks)) {
    const outcome = outcomeOfHook(hook);
    // YAML path: `on_result.<outcome>[i]` is the map entry `on_result: { <outcome>: [...] }`.
    const base: IssuePath = outcome !== null ? ['on_result', outcome] : [hook];
    actions.forEach((action, i) => {
      const at: IssuePath = [...base, i];
      const where = formatIssuePath(at);
      const previous = actionIds.get(action.id);
      if (previous !== undefined) {
        issues.error(file, [...at, 'id'], `Duplicate action ID "${action.id}" (also used at ${previous})`);
      }
      actionIds.set(action.id, where);
      validateAction(action, hook, at, { isSource, sourceVar, linked, sources: triggerSources, artifact }, parameterNames, input, issues, file);
    });
  }
  validateHookRouting(wf, issues, file);
}

/**
 * WI-17 checks of `on_result`/`on_error`: named outcomes need a result file;
 * an `on_error` shadowed by all four technical hooks never runs (warning).
 */
function validateHookRouting(wf: WorkflowConfig, issues: IssueCollector, file: string): void {
  if (resultHookOutcomes(wf.hooks).length > 0 && !hasResultFile(wf.execute)) {
    issues.error(file, ['on_result'], `"on_result" needs a worker result file; execute type "${wf.execute.type}" has none`);
  }
  if (wf.hooks.on_error !== undefined) {
    const technical = Object.values(TECHNICAL_OUTCOME_HOOKS);
    if (technical.every((hook) => wf.hooks[hook] !== undefined)) {
      issues.warning(
        file,
        ['on_error'],
        `"on_error" never runs: ${technical.map((h) => `"${h}"`).join(', ')} are all defined (a defined hook, even [], takes precedence)`,
      );
    }
  }
}

/** True if the executor of `execute` reads a worker result file (WI-17: needed for `on_result`). */
function hasResultFile(execute: WorkflowConfig['execute']): boolean {
  return execute.type === 'shell' || execute.type === 'container';
}

/** `{workspace.path}` alone or followed by `/<sub>` (the only template allowed in mount sources). */
const WORKSPACE_MOUNT_SOURCE = /^\{\s*workspace\.path\s*\}(\/.*)?$/;

/** Characters that would break the engine's `--mount type=bind,source=…,target=…` syntax. */
const UNSAFE_MOUNT_CHARS = /[,"\n\r\0]/;

/**
 * Problem with a path inside the container (mount `target`, `workdir`), or
 * `undefined`: absolute, normalized, not `/`, not the reserved `/adispatch` tree.
 */
export function containerPathError(p: string): string | undefined {
  if (!p.startsWith('/')) return 'Must be an absolute path inside the container (start with "/")';
  if (UNSAFE_MOUNT_CHARS.test(p)) return 'Must not contain commas, double quotes, line breaks or NUL';
  const normalized = path.posix.normalize(p).replace(/(.)\/$/, '$1');
  if (normalized !== p) return `Must be a normalized path ("${normalized}")`;
  if (p === '/') return 'Must not be "/"';
  if (p === CONTAINER_PATHS.root || p.startsWith(`${CONTAINER_PATHS.root}/`)) {
    return `"${CONTAINER_PATHS.root}" is reserved for the daemon's own mounts (context, result, token files)`;
  }
  return undefined;
}

/**
 * Checks of `execute.type: container` (WI-19): mount sources exist (static
 * sources, resolved against the config dir) or use only `{workspace.path}`;
 * targets are absolute, normalized, unique and outside `/adispatch`; secrets
 * must not use names of the engine process environment. The engine binary is
 * not checked here (offline validation) but when the daemon starts.
 */
function validateContainer(exec: ContainerExecuteConfig, issues: IssueCollector, file: string): void {
  const targets = new Map<string, number>();
  let workspaceMounted = false;
  exec.mounts.forEach((mount, i) => {
    const at: IssuePath = ['execute', 'mounts', i];
    const source = mount.source;
    if (UNSAFE_MOUNT_CHARS.test(source)) {
      issues.error(file, [...at, 'source'], 'Must not contain commas, double quotes, line breaks or NUL');
    } else if (source.includes('{') || source.includes('}')) {
      const match = WORKSPACE_MOUNT_SOURCE.exec(source);
      const sub = match?.[1] ?? '';
      if (!match || sub.includes('{') || sub.includes('}')) {
        issues.error(file, [...at, 'source'], 'Only "{workspace.path}" (optionally followed by "/<path>") is allowed as template in a mount source');
      } else if (sub.split('/').includes('..')) {
        issues.error(file, [...at, 'source'], 'Must not contain ".." (the mount must stay inside the workspace)');
      } else if (sub === '' || sub === '/') {
        workspaceMounted = true;
      }
    } else {
      try {
        statSync(source);
      } catch {
        issues.error(file, [...at, 'source'], `Mount source does not exist: ${source}`);
      }
    }
    const targetError = containerPathError(mount.target);
    if (targetError) {
      issues.error(file, [...at, 'target'], targetError);
      return;
    }
    const previous = targets.get(mount.target);
    if (previous !== undefined) {
      issues.error(file, [...at, 'target'], `Duplicate mount target "${mount.target}" (also used by mounts[${previous}])`);
    } else {
      targets.set(mount.target, i);
    }
  });
  const autoTarget = targets.get(CONTAINER_PATHS.workspace);
  if (!workspaceMounted && autoTarget !== undefined) {
    issues.error(
      file,
      ['execute', 'mounts', autoTarget, 'target'],
      `"${CONTAINER_PATHS.workspace}" is the target of the automatic workspace mount; mount "{workspace.path}" explicitly or use another target`,
    );
  }
  if (exec.workdir !== null) {
    const error = containerPathError(exec.workdir);
    if (error) issues.error(file, ['execute', 'workdir'], error);
  }
  for (const name of Object.keys(exec.secrets)) {
    if (isContainerEngineEnvName(name)) {
      issues.error(
        file,
        ['execute', 'secrets', name],
        `"${name}" belongs to the environment of the container engine process (or would steer the engine CLI) and cannot be a secret of a container run`,
      );
    }
  }
}


function safePlaceholders(template: string): string[] {
  try {
    return extractPlaceholders(template);
  } catch {
    return []; // syntax errors are reported by checkTemplate
  }
}

/** Source context of a workflow for its actions. */
interface ActionSourceContext {
  isSource: boolean;
  sourceVar: (name: string) => string | undefined;
  /** `{item.work_branch}` / `{item.work_pr}` allowed (WI-21). */
  linked: boolean;
  /** Known trigger sources (several for multi-source workflows, WI-20). */
  sources: readonly SourceConfig[];
  /** Workflow runs on artifact items (WI-35): `{item.name}`, `{item.type}`, `{item.path}`. */
  artifact: boolean;
}

function validateAction(
  action: LifecycleActionConfig,
  hook: HookName,
  at: IssuePath,
  sourceCtx: ActionSourceContext,
  parameterNames: string[],
  input: SemanticInput,
  issues: IssueCollector,
  file: string,
): void {
  const { isSource } = sourceCtx;
  const scope: TemplateScope = {
    run: true,
    workspace: true,
    source: isSource,
    sourceVar: sourceCtx.sourceVar,
    // `on_retry_unblock` (WI-30) runs in a lifecycle run without worker: no result (like `on_start`).
    result: hook !== 'on_start' && hook !== 'on_retry_unblock',
    linked: sourceCtx.linked,
    artifact: sourceCtx.artifact,
    // The input is staged right before the worker starts: not available in `on_start`.
    artifactInput: sourceCtx.artifact && hook !== 'on_start',
    parameters: parameterNames,
    block: isRetryBlockHook(hook),
    blockCleared: hook === 'on_retry_unblock',
  };
  if ((action.type === 'source.update' || action.type === 'source.comment') && !isSource) {
    issues.error(file, [...at, 'type'], `"${action.type}" needs a source item; the workflow has no source trigger`);
  }
  if ((action.type === 'source.update' || action.type === 'source.comment') && sourceCtx.artifact) {
    issues.error(file, [...at, 'type'], `"${action.type}" is not supported for artifact items: the artifacts source has nothing to update or comment on`);
  }
  switch (action.type) {
    case 'source.update':
      if (action.project !== undefined) checkProjectUpdate(action.project, sourceCtx.sources, issues, file, [...at, 'project']);
      if (action.labels.add.length === 0 && action.labels.remove.length === 0 && action.project === undefined) {
        issues.error(file, [...at, 'labels'], '"source.update" must add or remove at least one label or set a project field');
      }
      // Labels compare case-insensitively (GitHub, adapter): `Ready` and `ready` are the same label.
      for (const label of action.labels.add) {
        if (action.labels.remove.some((r) => r.toLowerCase() === label.toLowerCase())) {
          issues.error(file, [...at, 'labels'], `Label "${label}" is both added and removed`);
        }
      }
      break;
    case 'source.comment':
      checkIdentity(action.identity, input, issues, file, [...at, 'identity']);
      checkTemplate(action.message, 'text', scope, issues, file, [...at, 'message']);
      break;
    case 'shell':
      action.args.forEach((arg, j) => checkTemplate(arg, 'text', scope, issues, file, [...at, 'args', j]));
      for (const [name, value] of Object.entries(action.env)) {
        checkTemplate(value, 'text', scope, issues, file, [...at, 'env', name]);
      }
      checkEnvNames(Object.keys(action.env), issues, file, [...at, 'env']);
      checkLiteralSecrets(action.env, issues, file, [...at, 'env']);
      checkSecrets(action.secrets, action.env, input, issues, file, [...at, 'secrets']);
      break;
  }
}

/**
 * `source.update.project` (WI-16): at least one field, every key declared in
 * `project.fields` of the trigger source, value type per kind. Values are no
 * templates (like labels). Multi-source workflows (WI-20): every source must
 * declare the field with the same kind (rule of views). Without a known
 * trigger source other errors are reported already.
 */
function checkProjectUpdate(
  project: Readonly<Record<string, unknown>>,
  sources: readonly SourceConfig[],
  issues: IssueCollector,
  file: string,
  at: IssuePath,
): void {
  const names = Object.keys(project);
  if (names.length === 0) {
    issues.error(file, at, '"project" must set at least one field');
    return;
  }
  if (sources.length === 0) return;
  const withoutProject = sources.filter((s) => !s.project);
  if (withoutProject.length > 0) {
    const list = withoutProject.map((s) => `"${s.id}"`).join(', ');
    issues.error(
      file,
      at,
      withoutProject.length === 1
        ? `Source ${list} has no "project" in sources.yaml; project fields cannot be set`
        : `Sources ${list} have no "project" in sources.yaml; project fields cannot be set`,
    );
    return;
  }
  for (const name of names) {
    const declaring = sources.filter((s) => s.project && Object.hasOwn(s.project.fields, name));
    if (declaring.length < sources.length) {
      const bare = name.startsWith(PROJECT_FIELD_PREFIX) ? name.slice(PROJECT_FIELD_PREFIX.length) : undefined;
      // `project.<Name>` written as key: suggest on the name without the prefix.
      const known = [...new Set(sources.flatMap((s) => Object.keys(s.project?.fields ?? {})))];
      const suggestion = declaring.length === 0 ? suggestField(bare ?? name, known) : undefined;
      const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
      const missing = sources.filter((s) => !declaring.includes(s)).map((s) => `"${s.id}"`);
      const where =
        sources.length === 1
          ? `source ${missing[0] ?? ''}`
          : declaring.length === 0
            ? `any source of the workflow (${missing.join(', ')})`
            : `all sources of the workflow (missing in ${missing.join(', ')})`;
      issues.error(file, [...at, name], `Unknown project field "${name}": it is not declared in "project.fields" of ${where}${hint}`);
      continue;
    }
    const kinds = new Set(sources.map((s) => s.project?.fields[name]));
    if (kinds.size > 1) {
      const list = sources.map((s) => `"${s.id}": ${s.project?.fields[name] ?? '?'}`).join(', ');
      issues.error(file, [...at, name], `Project field "${name}" has different kinds in the sources of the workflow (${list}); declare it with the same kind everywhere`);
      continue;
    }
    const kind = [...kinds][0];
    const problem = kind ? valueProblem(kind, project[name]) : undefined;
    if (kind && problem) issues.error(file, [...at, name], `Invalid value for project field "${name}" (${kind}): ${problem}`);
  }
}

function validateParameter(
  name: string,
  raw: RawParameter,
  def: ParameterDefinition | undefined,
  automatic: boolean,
  input: SemanticInput,
  issues: IssueCollector,
  file: string,
): void {
  const at: IssuePath = ['parameters', name];
  const dynamic = raw.type === 'enum' && raw.options_from !== undefined;
  if (raw.type === 'enum') {
    if (raw.values !== undefined && raw.options_from !== undefined) {
      issues.error(file, [...at, 'options_from'], '"options_from" cannot be combined with "values" (use one of them)');
    } else if (raw.values === undefined && raw.options_from === undefined) {
      issues.error(file, [...at, 'values'], 'Enum needs "values" or "options_from"');
    }
    if (raw.values !== undefined && new Set(raw.values).size !== raw.values.length) {
      issues.error(file, [...at, 'values'], 'Enum values must be unique');
    }
    if (raw.options_from !== undefined && def?.type === 'enum' && def.optionsFrom) {
      validateOptionsFrom(raw.options_from, def.optionsFrom, input, issues, file, [...at, 'options_from']);
    }
  }
  if (raw.default !== undefined) {
    const value = raw.default;
    let ok: boolean;
    switch (raw.type) {
      case 'string':
        ok = typeof value === 'string';
        break;
      case 'number':
        ok = typeof value === 'number' && Number.isFinite(value);
        break;
      case 'boolean':
        ok = typeof value === 'boolean';
        break;
      case 'enum':
        // With `options_from` / `allow_custom` the default is checked at run time only (WI-31).
        ok = typeof value === 'string' && (dynamic || raw.allow_custom || (raw.values ?? []).includes(value));
        break;
    }
    if (!ok) {
      const expected =
        raw.type === 'enum'
          ? dynamic || raw.allow_custom
            ? 'a string'
            : `one of ${(raw.values ?? []).map((v) => `"${v}"`).join(', ')}`
          : `a ${raw.type}`;
      issues.error(file, [...at, 'default'], `Default does not match parameter type: expected ${expected}`);
    }
  } else if (dynamic && automatic) {
    issues.error(
      file,
      [...at, 'default'],
      '"options_from" without "default" in an automatically triggered workflow: automatic runs only receive the default',
    );
  } else if (raw.required && automatic) {
    issues.error(
      file,
      [...at, 'required'],
      'Required parameter without default in an automatically triggered workflow: automatic runs could never supply it',
    );
  }
}

/**
 * `options_from` (WI-31): exactly one of `github`/`command`, keys of the other
 * kind are errors; the GitHub source exists and is a GitHub source; timeout
 * within bounds; `args` only with `always` placeholders; secrets as for shell
 * actions; a script given as path must exist (like dashboard info tiles).
 */
function validateOptionsFrom(
  raw: RawParameterOptionsFrom,
  def: ParameterOptionsSource,
  input: SemanticInput,
  issues: IssueCollector,
  file: string,
  at: IssuePath,
): void {
  if (raw.github !== undefined && raw.command !== undefined) {
    issues.error(file, at, '"options_from" needs exactly one of "github" or "command", not both');
    return;
  }
  if (raw.github === undefined && raw.command === undefined) {
    issues.error(file, at, '"options_from" needs "github" (branches|tags) or "command"');
    return;
  }
  const wrongKeys = def.type === 'github' ? (['args', 'secrets'] as const) : (['source', 'limit'] as const);
  for (const key of wrongKeys) {
    if (raw[key] !== undefined) {
      issues.error(file, [...at, key], `"${key}" is only allowed with "options_from.${def.type === 'github' ? 'command' : 'github'}"`);
    }
  }
  if (def.timeoutMs > PARAMETER_OPTIONS_DEFAULTS.maxTimeoutMs) {
    issues.error(file, [...at, 'timeout'], `"timeout" must not exceed ${PARAMETER_OPTIONS_DEFAULTS.maxTimeoutMs / 1000}s`);
  }
  if (def.type === 'github') {
    if (def.source === '') {
      issues.error(file, [...at, 'source'], '"source" is required: the workflow has no single source to read branches/tags from');
      return;
    }
    const source = input.sources[def.source];
    if (!source) {
      const suggestion = suggestField(def.source, Object.keys(input.sources));
      issues.error(file, [...at, 'source'], `Unknown source "${def.source}"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`);
    } else if (source.type !== 'github') {
      issues.error(file, [...at, 'source'], `Source "${def.source}" is not a GitHub source (type "${source.type}")`);
    }
    return;
  }
  def.args.forEach((arg, i) => checkTemplate(arg, 'text', {}, issues, file, [...at, 'args', i]));
  checkSecrets(def.secrets, {}, input, issues, file, [...at, 'secrets']);
  if (def.command.includes('/')) {
    let problem: string | null = null;
    try {
      if (!statSync(def.command).isFile()) problem = 'is not a regular file';
    } catch {
      problem = 'does not exist';
    }
    if (problem) issues.error(file, [...at, 'command'], `Script ${problem}: ${def.command} (relative paths are resolved against the config dir)`);
  }
}

function validateView(entry: ViewEntry, input: SemanticInput, issues: IssueCollector): void {
  const { view } = entry;
  const file = view.file;
  if (entry.hasShellFilter) {
    issues.error(file, ['shell_filter'], 'Views do not support "shell_filter"; views never run shell scripts (Spec §17)');
  }
  const types = new Set<string>();
  const known: SourceConfig[] = [];
  view.sources.forEach((id, i) => {
    const source = input.sources[id];
    if (!source) issues.error(file, ['sources', i], `Unknown source "${id}"`);
    else {
      types.add(source.type);
      known.push(source);
    }
  });
  if (new Set(view.sources).size !== view.sources.length) {
    issues.error(file, ['sources'], 'Sources of a view must be unique');
  }
  if (types.size > 1) {
    issues.error(file, ['sources'], `All sources of a view must have the same adapter type (found: ${[...types].join(', ')})`);
  }
  if (types.size === 1) {
    const ctx = viewFieldContext(known);
    if (view.filter) {
      addFieldIssues(checkFilterFields(view.filter, ctx, { listing: true }), {
        issues,
        file,
        at: ['filter'],
        raw: entry.rawFilter,
        named: input.namedFilters,
      });
    }
    const checkName = (field: string, at: IssuePath): boolean => {
      const message = checkFieldName(field, ctx);
      if (message) issues.error(file, at, message);
      return message === undefined;
    };
    const checkFields = (fields: readonly ViewFieldConfig[], at: IssuePath): void =>
      fields.forEach((f, i) => {
        checkName(f.field, [...at, i, 'field']);
        if (f.link) checkName(f.link, [...at, i, 'link']);
      });
    const checkSort = (keys: readonly ViewSortKey[], at: IssuePath, isList: boolean): void =>
      keys.forEach((key, i) => {
        const keyAt: IssuePath = isList ? [...at, i] : at;
        if (!checkName(key.field, [...keyAt, 'field'])) return;
        const type = fieldType(key.field, ctx);
        if (type === 'object[]') issues.error(file, [...keyAt, 'field'], `Views cannot be sorted by "${key.field}" (type object[])`);
        if (key.field === VIEW_HISTORY_FIELD) {
          issues.error(file, [...keyAt, 'field'], `Views cannot be sorted by "${VIEW_HISTORY_FIELD}": it is a link column to the item history (use it in "fields" only)`);
          return;
        }
        if (key.order) {
          if (type !== undefined && type !== 'string') {
            issues.error(
              file,
              [...keyAt, 'order'],
              `"order" is only allowed for string fields (e.g. project.* single_select/text/iteration, state, run.last_status); "${key.field}" has type ${type}`,
            );
          }
          const seen = new Set<string>();
          key.order.forEach((value, j) => {
            if (seen.has(value)) issues.error(file, [...keyAt, 'order', j], `Duplicate value "${value}" in "order"`);
            seen.add(value);
          });
        }
      });
    checkFields(view.fields, ['fields']);
    checkSort(view.sort, ['sort'], entry.rawSortIsList ?? false);
    view.sections?.forEach((section, i) => {
      const raw = entry.rawSections?.[i];
      const at: IssuePath = ['sections', i];
      if (section.filter) {
        const target = { issues, file, at: [...at, 'filter'], raw: raw?.filter ?? null, named: input.namedFilters };
        addFieldIssues(checkFilterFields(section.filter, ctx, { listing: false }), target);
        addFieldIssues(checkSectionListing(section.filter, view.filter, ctx), target);
      }
      if (section.fields) checkFields(section.fields, [...at, 'fields']);
      if (section.sort) checkSort(section.sort, [...at, 'sort'], raw?.sortIsList ?? false);
    });
  }
  validateViewLayout(entry, issues);
}

/** Field-independent rules of sections and grouping (WI-28). */
function validateViewLayout(entry: ViewEntry, issues: IssueCollector): void {
  const { view } = entry;
  const file = view.file;
  const sections = view.sections;
  if (!sections) {
    for (const key of entry.rawSectionOptions ?? []) {
      issues.warning(file, [key], `"${key}" has no effect without "sections"`);
    }
  } else {
    const titles = new Map<string, number>();
    let rest: number | null = null;
    sections.forEach((section, i) => {
      const at: IssuePath = ['sections', i];
      const previous = titles.get(section.title);
      if (previous !== undefined) issues.error(file, [...at, 'title'], `Duplicate section title "${section.title}" (also used by section ${previous + 1})`);
      else titles.set(section.title, i);
      if (section.rest && section.filter) {
        issues.error(file, at, 'A section has either "filter" or "rest: true", not both');
      } else if (!section.rest && !section.filter) {
        issues.error(file, at, 'A section needs a "filter" or "rest: true"');
      }
      if (section.rest) {
        if (rest !== null) issues.error(file, [...at, 'rest'], `Only one section can be "rest: true" (already section ${rest + 1})`);
        else rest = i;
      }
    });
  }
  if (view.groupByFirst) {
    const tables = sections ? sections.map((s) => s.sort ?? view.sort) : [view.sort];
    if (!tables.some((keys) => keys[0]?.order)) {
      issues.error(
        file,
        ['group_by_first'],
        '"group_by_first" needs a first sort key with "order" (in the view "sort" or in a section "sort")',
      );
    }
  }
}

/** Where field issues of one filter tree are reported. */
interface FieldIssueTarget {
  issues: IssueCollector;
  file: string;
  /** Path of the filter tree in `file`. */
  at: IssuePath;
  /** The tree as written, to map issues inside named filters back to the place of use (WI-15). */
  raw: RawFilterNode | null;
  named: NamedFilters;
}

function addFieldIssues(found: readonly FieldIssue[], target: FieldIssueTarget): void {
  for (const issue of found) {
    const loc = target.raw ? target.named.locate(target.raw, issue.path) : { path: issue.path };
    target.issues.add({
      severity: 'error',
      file: target.file,
      path: [...target.at, ...loc.path],
      message: issue.message,
      ...(loc.via !== undefined ? { via: loc.via } : {}),
    });
  }
}
