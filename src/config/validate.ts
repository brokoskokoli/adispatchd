/**
 * Semantic validation across files (Spec §19): references, unique IDs,
 * allowed placeholders per context, contradictions, cron/time zone and
 * parameter defaults. Runs on the normalized model; paths in issues use the
 * YAML key names.
 */
import path from 'node:path';
import { Cron } from 'croner';
import {
  extractPlaceholders,
  isSecretKey,
  keepPatternError,
  outcomeOfHook,
  TECHNICAL_OUTCOME_HOOKS,
  validateTemplate,
  type HookName,
  type TemplateMode,
  type TemplateScope,
} from '../core/index.js';
import { PROJECT_FIELD_PREFIX, valueProblem } from '../sources/index.js';
import { checkFieldName, checkFilterFields, sourceFieldContext, suggestField, viewFieldContext, type FieldIssue } from './field-catalog.js';
import type { RawFilterNode } from './filter-schema.js';
import { formatIssuePath, type IssueCollector, type IssuePath } from './issues.js';
import {
  configuredHooks,
  resultHookOutcomes,
  type GlobalConfig,
  type IdentityConfig,
  type LifecycleActionConfig,
  type SecretRef,
  type SourceConfig,
  type ViewConfig,
  type WorkflowConfig,
} from './model.js';
import type { NamedFilters } from './named-filters.js';
import type { RawParameter } from './schemas.js';

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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateSources(input: SemanticInput, issues: IssueCollector): void {
  for (const source of Object.values(input.sources)) {
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

function checkEnvNames(
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

function checkLiteralSecrets(env: Readonly<Record<string, string>>, issues: IssueCollector, file: string, at: IssuePath): void {
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
  if (wf.trigger.type === 'source' && !input.sources[wf.trigger.source]) {
    issues.error(file, ['trigger', 'source'], `Unknown source "${wf.trigger.source}"`);
  }
  if (wf.trigger.type === 'schedule') {
    const tzOk = isValidTimeZone(wf.trigger.timezone);
    if (!tzOk) issues.error(file, ['trigger', 'timezone'], `Invalid time zone "${wf.trigger.timezone}"`);
    const err = cronError(wf.trigger.cron, tzOk ? wf.trigger.timezone : undefined);
    if (err) issues.error(file, ['trigger', 'cron'], err);
  }
  if (wf.trigger.type === 'source') {
    const source = input.sources[wf.trigger.source];
    if (source) {
      const ctx = sourceFieldContext(source);
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
  }
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
    validateParameter(name, raw, automatic, issues, file);
  }
  const parameterNames = Object.keys(wf.parameters);

  // Conditions: evaluated before a run exists, without manual parameters.
  wf.conditions.workflow.forEach((c, i) =>
    c.args.forEach((arg, j) => checkTemplate(arg, 'text', {}, issues, file, ['conditions', 'workflow', i, 'args', j])),
  );
  wf.conditions.item.forEach((c, i) =>
    c.args.forEach((arg, j) =>
      checkTemplate(arg, 'text', { source: true }, issues, file, ['conditions', 'item', i, 'args', j]),
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
  checkTemplate(exec.workingDirectory, 'path', { run: true, source: isSource, parameters: parameterNames }, issues, file, [
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
  const runScope: TemplateScope = { run: true, workspace: true, source: isSource, parameters: parameterNames };
  exec.args.forEach((arg, i) => checkTemplate(arg, 'text', runScope, issues, file, ['execute', 'args', i]));
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
  const { maxDurationMs, idleTimeoutMs } = exec.timeout;
  if (maxDurationMs !== null && idleTimeoutMs !== null && idleTimeoutMs > maxDurationMs) {
    issues.warning(file, ['execute', 'timeout', 'idle_timeout'], '"idle_timeout" is longer than "max_duration"');
  }

  // Hooks
  const triggerSource = wf.trigger.type === 'source' ? input.sources[wf.trigger.source] : undefined;
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
      validateAction(action, hook, at, isSource, parameterNames, input, issues, file, triggerSource);
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
  return execute.type === 'shell';
}

function safePlaceholders(template: string): string[] {
  try {
    return extractPlaceholders(template);
  } catch {
    return []; // syntax errors are reported by checkTemplate
  }
}

function validateAction(
  action: LifecycleActionConfig,
  hook: HookName,
  at: IssuePath,
  isSource: boolean,
  parameterNames: string[],
  input: SemanticInput,
  issues: IssueCollector,
  file: string,
  source: SourceConfig | undefined,
): void {
  const scope: TemplateScope = {
    run: true,
    workspace: true,
    source: isSource,
    result: hook !== 'on_start',
    parameters: parameterNames,
  };
  if ((action.type === 'source.update' || action.type === 'source.comment') && !isSource) {
    issues.error(file, [...at, 'type'], `"${action.type}" needs a source item; the workflow has no source trigger`);
  }
  switch (action.type) {
    case 'source.update':
      if (action.project !== undefined) checkProjectUpdate(action.project, source, issues, file, [...at, 'project']);
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
 * templates (like labels). Without a known trigger source other errors are
 * reported already.
 */
function checkProjectUpdate(
  project: Readonly<Record<string, unknown>>,
  source: SourceConfig | undefined,
  issues: IssueCollector,
  file: string,
  at: IssuePath,
): void {
  const names = Object.keys(project);
  if (names.length === 0) {
    issues.error(file, at, '"project" must set at least one field');
    return;
  }
  if (!source) return;
  if (!source.project) {
    issues.error(file, at, `Source "${source.id}" has no "project" in sources.yaml; project fields cannot be set`);
    return;
  }
  const declared = source.project.fields;
  for (const name of names) {
    const kind = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (!kind) {
      const bare = name.startsWith(PROJECT_FIELD_PREFIX) ? name.slice(PROJECT_FIELD_PREFIX.length) : undefined;
      // `project.<Name>` written as key: suggest on the name without the prefix.
      const suggestion = suggestField(bare ?? name, Object.keys(declared));
      const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
      issues.error(
        file,
        [...at, name],
        `Unknown project field "${name}": it is not declared in "project.fields" of source "${source.id}"${hint}`,
      );
      continue;
    }
    const problem = valueProblem(kind, project[name]);
    if (problem) issues.error(file, [...at, name], `Invalid value for project field "${name}" (${kind}): ${problem}`);
  }
}

function validateParameter(
  name: string,
  raw: RawParameter,
  automatic: boolean,
  issues: IssueCollector,
  file: string,
): void {
  const at: IssuePath = ['parameters', name];
  if (raw.type === 'enum' && new Set(raw.values).size !== raw.values.length) {
    issues.error(file, [...at, 'values'], 'Enum values must be unique');
  }
  if (raw.default !== undefined) {
    const def = raw.default;
    let ok: boolean;
    switch (raw.type) {
      case 'string':
        ok = typeof def === 'string';
        break;
      case 'number':
        ok = typeof def === 'number' && Number.isFinite(def);
        break;
      case 'boolean':
        ok = typeof def === 'boolean';
        break;
      case 'enum':
        ok = typeof def === 'string' && raw.values.includes(def);
        break;
    }
    if (!ok) {
      const expected = raw.type === 'enum' ? `one of ${raw.values.map((v) => `"${v}"`).join(', ')}` : `a ${raw.type}`;
      issues.error(file, [...at, 'default'], `Default does not match parameter type: expected ${expected}`);
    }
  } else if (raw.required && automatic) {
    issues.error(
      file,
      [...at, 'required'],
      'Required parameter without default in an automatically triggered workflow: automatic runs could never supply it',
    );
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
    const checkName = (field: string, at: IssuePath): void => {
      const message = checkFieldName(field, ctx);
      if (message) issues.error(file, at, message);
    };
    view.fields.forEach((f, i) => {
      checkName(f.field, ['fields', i, 'field']);
      if (f.link) checkName(f.link, ['fields', i, 'link']);
    });
    if (view.sort) checkName(view.sort.field, ['sort', 'field']);
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
