/**
 * Placeholder interpolation for config strings such as
 * `working_directory: '{workspace.base_dir}/{workflow.id}/{run.id}'` or
 * `message: 'Completed: {result.message}'`.
 *
 * Only a fixed whitelist of placeholders is supported (Spec §20.5); unknown
 * placeholders are always an error. Syntax: `{name}`; `{{` and `}}` produce
 * literal braces.
 *
 * Modes:
 * - `text`: values are inserted verbatim (consumers must still escape for HTML etc.).
 * - `path`: every interpolated value becomes exactly one safe path segment
 *   (see {@link sanitizeSegment}: no `/`, no `..`, no NUL). Path-root
 *   placeholders (`{workspace.base_dir}`, `{workspace.path}`) are trusted
 *   absolute directories; they may only appear at the very start and must be
 *   followed by `/` or the end of the template.
 */
import path from 'node:path';
import { OrchestratorError } from './errors.js';
import { formatCompactTimestamp } from './ids.js';
import { sanitizeSegment } from './paths.js';
import type { BusinessResult, TerminalStatus, TriggerType } from './types.js';

/** Interpolation mode, see module docs. */
export type TemplateMode = 'text' | 'path';

/**
 * Availability group of a placeholder:
 * - `always`: every workflow context
 * - `run`: once a run exists (not in filters/conditions before reservation)
 * - `workspace`: after the workspace path is known (not in `working_directory` itself)
 * - `source`: only for source-bound runs (source trigger or manual with item);
 *   includes the source variables `{source.vars.<name>}` (WI-20)
 * - `result`: only in completion hooks (`on_success`, `on_failure`, ...)
 * - `parameters`: declared manual-start parameters, `{parameters.<name>}`
 */
export type PlaceholderGroup = 'always' | 'run' | 'workspace' | 'source' | 'result' | 'parameters';

/** Definition of a whitelisted placeholder. */
export interface PlaceholderDefinition {
  name: string;
  group: PlaceholderGroup;
  description: string;
  /** Trusted absolute directory; in `path` mode only allowed at the start of a template. */
  pathRoot?: boolean;
}

/** The fixed placeholder whitelist (Spec §5.4, §9, §20.5). */
export const PLACEHOLDERS: readonly PlaceholderDefinition[] = [
  { name: 'workflow.id', group: 'always', description: 'Workflow ID' },
  { name: 'workflow.name', group: 'always', description: 'Workflow display name' },
  { name: 'workspace.base_dir', group: 'always', description: 'Configured workspace base directory', pathRoot: true },
  { name: 'timestamp', group: 'always', description: 'Current UTC time, compact (YYYYMMDDTHHMMSSZ)' },
  { name: 'run.id', group: 'run', description: 'Run ID' },
  { name: 'run.trigger', group: 'run', description: 'Trigger type (source|schedule|manual)' },
  { name: 'run.started_at', group: 'run', description: 'Run start time (ISO-8601)' },
  { name: 'workspace.path', group: 'workspace', description: 'Absolute workspace path of the run', pathRoot: true },
  { name: 'source.id', group: 'source', description: 'Source ID' },
  { name: 'source.type', group: 'source', description: 'Source adapter type' },
  { name: 'source.repository', group: 'source', description: 'Source location, e.g. owner/name' },
  { name: 'item.id', group: 'source', description: 'Item ID within the source' },
  { name: 'item.number', group: 'source', description: 'Item number (e.g. GitHub issue number)' },
  { name: 'item.key', group: 'source', description: 'Global item key <source>:<item>' },
  { name: 'item.url', group: 'source', description: 'Item URL' },
  { name: 'item.title', group: 'source', description: 'Item title' },
  { name: 'result.status', group: 'result', description: 'Technical final status' },
  { name: 'result.result', group: 'result', description: 'Business result (success|failure|empty)' },
  { name: 'result.message', group: 'result', description: 'Message from the worker result file' },
];

/** Prefix of parameter placeholders: `{parameters.<name>}`. */
export const PARAMETER_PLACEHOLDER_PREFIX = 'parameters.';

/** Prefix of source variable placeholders: `{source.vars.<name>}` (WI-20, group `source`). */
export const SOURCE_VAR_PLACEHOLDER_PREFIX = 'source.vars.';

const PLACEHOLDER_BY_NAME = new Map(PLACEHOLDERS.map((p) => [p.name, p]));
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/;

/** Error thrown for template syntax errors, unknown/unavailable placeholders or unsafe values. */
export class TemplateError extends OrchestratorError {
  constructor(
    code: TemplateIssueCode,
    message: string,
    readonly placeholder?: string,
  ) {
    super(`template_${code}`, message, placeholder !== undefined ? { details: { placeholder } } : {});
  }
}

/** Problem codes reported by {@link validateTemplate}. */
export type TemplateIssueCode =
  | 'syntax'
  | 'unknown_placeholder'
  | 'unavailable_placeholder'
  | 'path_root_position'
  | 'missing_value'
  | 'unsafe_value';

/** One validation problem. */
export interface TemplateIssue {
  code: TemplateIssueCode;
  message: string;
  placeholder?: string;
}

/** Parsed template part. */
export type TemplatePart = { kind: 'literal'; text: string } | { kind: 'placeholder'; name: string; index: number };

/** Parse a template into literal and placeholder parts. Throws {@link TemplateError} (`syntax`). */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let literal = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch === '{') {
      if (template[i + 1] === '{') {
        literal += '{';
        i += 2;
        continue;
      }
      const end = template.indexOf('}', i + 1);
      if (end === -1) throw new TemplateError('syntax', `Unclosed "{" at position ${i} in template "${template}"`);
      const name = template.slice(i + 1, end).trim();
      if (!NAME_PATTERN.test(name)) {
        throw new TemplateError('syntax', `Invalid placeholder "{${name}}" at position ${i}`, name);
      }
      if (literal) parts.push({ kind: 'literal', text: literal });
      literal = '';
      parts.push({ kind: 'placeholder', name, index: i });
      i = end + 1;
      continue;
    }
    if (ch === '}') {
      if (template[i + 1] === '}') {
        literal += '}';
        i += 2;
        continue;
      }
      throw new TemplateError('syntax', `Unmatched "}" at position ${i} in template "${template}"`);
    }
    literal += ch;
    i += 1;
  }
  if (literal) parts.push({ kind: 'literal', text: literal });
  return parts;
}

/** Distinct placeholder names used in `template`, in order of first use. Throws on syntax errors. */
export function extractPlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const part of parseTemplate(template)) {
    if (part.kind === 'placeholder' && !names.includes(part.name)) names.push(part.name);
  }
  return names;
}

/**
 * Which placeholder groups are available in a given config context.
 * Omitted flags default to `false`; `always` placeholders are always available.
 */
export interface TemplateScope {
  run?: boolean;
  workspace?: boolean;
  source?: boolean;
  result?: boolean;
  /** Declared parameter names usable as `{parameters.<name>}`. */
  parameters?: readonly string[];
  /**
   * Check of a source variable `{source.vars.<name>}` (WI-20, needs `source`):
   * returns a problem (e.g. "not defined in source b") or `undefined`.
   * Omitted = every syntactically valid name is accepted (render time).
   */
  sourceVar?: (name: string) => string | undefined;
}

/** Scope with every group enabled (parameters: none). */
export const FULL_TEMPLATE_SCOPE: Readonly<TemplateScope> = { run: true, workspace: true, source: true, result: true };

/** True if `name` is on the whitelist (parameters: any syntactically valid name). */
export function isKnownPlaceholder(name: string): boolean {
  return PLACEHOLDER_BY_NAME.has(name) || isParameterPlaceholder(name) || isSourceVarPlaceholder(name);
}

function isSourceVarPlaceholder(name: string): boolean {
  const rest = name.startsWith(SOURCE_VAR_PLACEHOLDER_PREFIX) ? name.slice(SOURCE_VAR_PLACEHOLDER_PREFIX.length) : '';
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(rest);
}

function isParameterPlaceholder(name: string): boolean {
  const rest = name.startsWith(PARAMETER_PLACEHOLDER_PREFIX) ? name.slice(PARAMETER_PLACEHOLDER_PREFIX.length) : '';
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(rest);
}

function checkAvailability(name: string, scope: TemplateScope): TemplateIssue | undefined {
  if (isSourceVarPlaceholder(name)) {
    if (!scope.source) {
      return { code: 'unavailable_placeholder', message: `Placeholder "{${name}}" is not available in this context`, placeholder: name };
    }
    const problem = scope.sourceVar?.(name.slice(SOURCE_VAR_PLACEHOLDER_PREFIX.length));
    return problem ? { code: 'unavailable_placeholder', message: problem, placeholder: name } : undefined;
  }
  if (isParameterPlaceholder(name)) {
    const param = name.slice(PARAMETER_PLACEHOLDER_PREFIX.length);
    return scope.parameters?.includes(param)
      ? undefined
      : { code: 'unavailable_placeholder', message: `Parameter "${param}" is not declared`, placeholder: name };
  }
  const def = PLACEHOLDER_BY_NAME.get(name);
  if (!def) {
    return { code: 'unknown_placeholder', message: `Unknown placeholder "{${name}}"`, placeholder: name };
  }
  if (def.group !== 'always' && def.group !== 'parameters' && !scope[def.group]) {
    return {
      code: 'unavailable_placeholder',
      message: `Placeholder "{${name}}" is not available in this context`,
      placeholder: name,
    };
  }
  return undefined;
}

/** Options for {@link validateTemplate} and {@link renderTemplate}. */
export interface TemplateOptions {
  mode: TemplateMode;
  /** Available placeholder groups; default {@link FULL_TEMPLATE_SCOPE}. */
  scope?: TemplateScope;
}

/**
 * Validate a template without values (for config validation). Returns all
 * problems; an empty array means valid.
 */
export function validateTemplate(template: string, options: TemplateOptions): TemplateIssue[] {
  let parts: TemplatePart[];
  try {
    parts = parseTemplate(template);
  } catch (err) {
    return [{ code: 'syntax', message: (err as Error).message }];
  }
  const scope = options.scope ?? FULL_TEMPLATE_SCOPE;
  const issues: TemplateIssue[] = [];
  parts.forEach((part, idx) => {
    if (part.kind !== 'placeholder') return;
    const issue = checkAvailability(part.name, scope);
    if (issue) {
      issues.push(issue);
      return;
    }
    if (options.mode === 'path' && PLACEHOLDER_BY_NAME.get(part.name)?.pathRoot) {
      if (idx !== 0) {
        issues.push({
          code: 'path_root_position',
          message: `Placeholder "{${part.name}}" is a directory root and must start the path template`,
          placeholder: part.name,
        });
        return;
      }
      // The root must be followed by the end of the template or a literal "/"
      // so that `{workspace.base_dir}{workflow.id}` cannot extend the root name.
      const next = parts[idx + 1];
      if (next !== undefined && !(next.kind === 'literal' && next.text.startsWith('/'))) {
        issues.push({
          code: 'path_root_position',
          message: `Placeholder "{${part.name}}" must be followed by "/" or the end of the path template`,
          placeholder: part.name,
        });
      }
    }
  });
  if (options.mode === 'path' && template.includes('\0')) {
    issues.push({ code: 'unsafe_value', message: 'Path template contains a NUL byte' });
  }
  return issues;
}

/** Scalar value of a placeholder. */
export type TemplateScalar = string | number | boolean | null;

/** Flat map from placeholder name (e.g. `run.id`, `parameters.version`) to value. */
export type TemplateValues = Readonly<Record<string, TemplateScalar | undefined>>;

/** Options for {@link renderTemplate}. */
export interface RenderOptions extends TemplateOptions {
  /**
   * Behaviour for whitelisted placeholders without a value: `error` (default
   * in `path` mode) or `empty` (default in `text` mode).
   */
  missing?: 'error' | 'empty';
}

/**
 * Interpolate `template` with `values`.
 *
 * @throws TemplateError for syntax errors, unknown/unavailable placeholders,
 *   missing values (per `missing`), misplaced/relative path roots or NUL bytes.
 */
export function renderTemplate(template: string, values: TemplateValues, options: RenderOptions): string {
  const issues = validateTemplate(template, options);
  const first = issues[0];
  if (first) throw new TemplateError(first.code, first.message, first.placeholder);

  const missing = options.missing ?? (options.mode === 'path' ? 'error' : 'empty');
  let out = '';
  for (const part of parseTemplate(template)) {
    if (part.kind === 'literal') {
      out += part.text;
      continue;
    }
    const raw = values[part.name];
    if (raw === undefined || raw === null) {
      if (missing === 'error') {
        throw new TemplateError('missing_value', `No value for placeholder "{${part.name}}"`, part.name);
      }
      continue;
    }
    const value = String(raw);
    if (options.mode === 'text') {
      out += value;
    } else if (PLACEHOLDER_BY_NAME.get(part.name)?.pathRoot) {
      if (value.includes('\0') || !path.isAbsolute(value)) {
        throw new TemplateError('unsafe_value', `Placeholder "{${part.name}}" must be an absolute path`, part.name);
      }
      out += path.resolve(value);
    } else {
      out += sanitizeSegment(value);
    }
  }
  if (options.mode === 'path') {
    if (out.includes('\0')) throw new TemplateError('unsafe_value', 'Rendered path contains a NUL byte');
    if (out === '') throw new TemplateError('unsafe_value', 'Rendered path is empty');
    out = path.normalize(out);
  }
  return out;
}

/** Structured input for {@link buildTemplateValues}. */
export interface TemplateInput {
  workflow: { id: string; name?: string };
  workspace?: { baseDir?: string; path?: string };
  run?: { id: string; trigger?: TriggerType; startedAt?: Date };
  source?: { id: string; type: string; repository?: string; vars?: Readonly<Record<string, string>> };
  item?: { id: string; key?: string; number?: number | string; url?: string; title?: string };
  result?: { status?: TerminalStatus; result?: BusinessResult; message?: string };
  parameters?: Readonly<Record<string, string | number | boolean>>;
  /** Time used for `{timestamp}`. */
  now: Date;
}

/** Build the flat {@link TemplateValues} map from structured run data. */
export function buildTemplateValues(input: TemplateInput): TemplateValues {
  const values: Record<string, TemplateScalar | undefined> = {
    'workflow.id': input.workflow.id,
    'workflow.name': input.workflow.name ?? input.workflow.id,
    'workspace.base_dir': input.workspace?.baseDir,
    'workspace.path': input.workspace?.path,
    timestamp: formatCompactTimestamp(input.now),
    'run.id': input.run?.id,
    'run.trigger': input.run?.trigger,
    'run.started_at': input.run?.startedAt?.toISOString(),
    'source.id': input.source?.id,
    'source.type': input.source?.type,
    'source.repository': input.source?.repository,
    'item.id': input.item?.id,
    'item.key': input.item?.key,
    'item.number': input.item?.number,
    'item.url': input.item?.url,
    'item.title': input.item?.title,
    'result.status': input.result?.status,
    'result.result': input.result?.result ?? undefined,
    'result.message': input.result?.message,
  };
  for (const [name, value] of Object.entries(input.parameters ?? {})) {
    values[`${PARAMETER_PLACEHOLDER_PREFIX}${name}`] = value;
  }
  for (const [name, value] of Object.entries(input.source?.vars ?? {})) {
    values[`${SOURCE_VAR_PLACEHOLDER_PREFIX}${name}`] = value;
  }
  return values;
}
