/**
 * Config loader (Spec §19): reads the config directory, parses YAML,
 * validates schemas and cross-file semantics, collects **all** problems with
 * file and path, and produces an immutable {@link LoadedConfig}.
 *
 * The loader never reads environment variables, so no secret value can end
 * up in the loaded model or in issue messages.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import type { z } from 'zod';
import { CONFIG_ID_PATTERN, systemClock, toAbsolutePath, type Clock } from '../core/index.js';
import { formatIssuePath, IssueCollector, sortIssues, type IssuePath } from './issues.js';
import type { ConfigIssue, DashboardConfig, GlobalConfig, LoadedConfig, ViewConfig, WorkflowConfig } from './model.js';
import { DASHBOARD_FILE, normalizeDashboard, validateDashboard } from './dashboard.js';
import { editDistance, suggestField } from './field-catalog.js';
import { NamedFilters, type NamedFilterEntry } from './named-filters.js';
import {
  normalizeGlobal,
  normalizeIdentities,
  normalizeSources,
  normalizeView,
  normalizeWorkflow,
} from './normalize.js';
import {
  dashboardFileSchema,
  globalConfigSchema,
  identitiesFileSchema,
  namedFilterSchema,
  sourcesFileSchema,
  viewSchema,
  workflowSchema,
} from './schemas.js';
import {
  CONFIG_FILE,
  IDENTITIES_FILE,
  SOURCES_FILE,
  validateSemantics,
  type ViewEntry,
  type WorkflowEntry,
} from './validate.js';

/** Sub-directory with one file per workflow. */
export const WORKFLOWS_DIR = 'workflows';
/** Sub-directory with one file per view. */
export const VIEWS_DIR = 'views';
/** Sub-directory with one file per named filter (WI-15). */
export const FILTERS_DIR = 'filters';

/** Maximum accepted size of a single YAML file. */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Data directory; used for the default `workspace.base_dir` (`${dataDir}/workspaces`). */
  dataDir: string;
  /** Version number stored in the result (default 1). */
  version?: number;
  clock?: Clock;
}

/** Result of {@link loadConfig}. Warnings never prevent loading. */
export type LoadConfigResult =
  | { ok: true; config: LoadedConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

interface ParsedFile {
  file: string;
  doc: Document | undefined;
  lineCounter: LineCounter;
  data: unknown;
}

/** Load and validate the configuration in `configDir`. Never throws for config problems. */
export async function loadConfig(configDir: string, options: LoadConfigOptions): Promise<LoadConfigResult> {
  const dir = toAbsolutePath(configDir);
  const issues = new IssueCollector();
  const files = new Map<string, ParsedFile>();
  const clock = options.clock ?? systemClock;

  try {
    const st = await stat(dir);
    if (!st.isDirectory()) issues.error('.', [], `Config path "${dir}" is not a directory`);
  } catch {
    issues.error('.', [], `Config directory "${dir}" does not exist or is not readable`);
  }
  if (issues.hasErrors) return finish(issues, files);

  const readTop = async (name: string, warnIfMissing: boolean): Promise<ParsedFile | undefined> => {
    const parsed = await readYaml(dir, name, issues);
    if (parsed === null) {
      if (warnIfMissing) issues.warning(name, [], `${name} not found, using defaults`);
      return undefined;
    }
    if (parsed) files.set(name, parsed);
    return parsed;
  };

  const configFile = await readTop(CONFIG_FILE, true);
  const sourcesFile = await readTop(SOURCES_FILE, false);
  const identitiesFile = await readTop(IDENTITIES_FILE, false);
  const dashboardFile = await readTop(DASHBOARD_FILE, false);
  const workflowFiles = await readDir(dir, WORKFLOWS_DIR, issues, files);
  const viewFiles = await readDir(dir, VIEWS_DIR, issues, files);
  // Unreadable filter files still count by name, so places of use report "invalid" rather than "unknown".
  const unusableFilterFiles: string[] = [];
  const filterFiles = await readDir(dir, FILTERS_DIR, issues, files, (file) => unusableFilterFiles.push(file));

  const rawGlobal = parseWith(globalConfigSchema, configFile, CONFIG_FILE, issues);
  const rawSources = parseWith(sourcesFileSchema, sourcesFile, SOURCES_FILE, issues);
  const rawIdentities = parseWith(identitiesFileSchema, identitiesFile, IDENTITIES_FILE, issues);

  // Without valid global settings, workflows can still be checked against defaults.
  const global: GlobalConfig = normalizeGlobal(
    rawGlobal ?? globalConfigSchema.parse({}),
    dir,
    options.dataDir,
  );
  const sources = rawSources ? normalizeSources(rawSources) : {};
  const identities = rawIdentities ? normalizeIdentities(rawIdentities) : {};

  // Named filters first: workflows and views contain them expanded.
  const filterEntries: NamedFilterEntry[] = [];
  const brokenFilters = new Map<string, string>();
  for (const parsed of filterFiles) {
    const raw = parseWith(namedFilterSchema, parsed, parsed.file, issues);
    if (raw) {
      filterEntries.push({ id: raw.id, file: parsed.file, description: raw.description ?? null, filter: raw.filter });
    } else {
      const id = (parsed.data as { id?: unknown } | null)?.id;
      brokenFilters.set(typeof id === 'string' && CONFIG_ID_PATTERN.test(id) ? id : fileStem(parsed.file), parsed.file);
    }
  }
  for (const file of unusableFilterFiles) brokenFilters.set(fileStem(file), file);
  const namedFilters = new NamedFilters(filterEntries, brokenFilters, issues);

  // Usage of named filters is only complete if every workflow and view could be parsed.
  let allUsersParsed = true;
  const workflowEntries: WorkflowEntry[] = [];
  for (const parsed of workflowFiles) {
    const raw = parseWith(workflowSchema, parsed, parsed.file, issues);
    if (raw) {
      workflowEntries.push({
        workflow: normalizeWorkflow(raw, parsed.file, global, dir, (node, at) => namedFilters.expandAt(node, parsed.file, at)),
        rawParameters: raw.parameters,
        rawFilter: raw.filter ?? null,
        rawPriorityRules: raw.item_priority?.rules.map((r) => r.when) ?? [],
      });
    } else allUsersParsed = false;
  }
  const viewEntries: ViewEntry[] = [];
  for (const parsed of viewFiles) {
    const raw = parseWith(viewSchema, parsed, parsed.file, issues);
    if (raw) {
      viewEntries.push({
        view: normalizeView(raw, parsed.file, (node, at) => namedFilters.expandAt(node, parsed.file, at)),
        hasShellFilter: raw.shell_filter !== undefined,
        rawFilter: raw.filter ?? null,
        rawSortIsList: Array.isArray(raw.sort),
        rawSections: (raw.sections ?? []).map((s) => ({ filter: s.filter ?? null, sortIsList: Array.isArray(s.sort) })),
        rawSectionOptions: (['exclusive', 'hide_empty_sections'] as const).filter((k) => raw[k] !== undefined),
      });
    } else allUsersParsed = false;
  }
  if (allUsersParsed) namedFilters.reportUnused();

  validateSemantics({ global, sources, identities, workflows: workflowEntries, views: viewEntries, namedFilters }, issues);

  // dashboard.yaml (WI-24): optional; absent = no info tiles.
  let dashboard: DashboardConfig | null = null;
  if (dashboardFile) {
    const rawDashboard = parseWith(dashboardFileSchema, dashboardFile, DASHBOARD_FILE, issues);
    if (rawDashboard) {
      dashboard = normalizeDashboard(rawDashboard, dir);
      validateDashboard(dashboard, issues);
    }
  }

  if (issues.hasErrors) return finish(issues, files);

  const workflows: Record<string, WorkflowConfig> = {};
  const workflowHashes: Record<string, string> = {};
  for (const { workflow } of workflowEntries) {
    workflows[workflow.id] = workflow;
    workflowHashes[workflow.id] = hashOf(workflow);
  }
  const views: Record<string, ViewConfig> = {};
  for (const { view } of viewEntries) views[view.id] = view;

  const content = { global, sources, identities, workflows, views, filters: namedFilters.list() };
  const config: LoadedConfig = {
    configDir: dir,
    version: options.version ?? 1,
    // The dashboard is part of the hash only when present (hashes of configurations without it stay unchanged).
    hash: hashOf(dashboard ? { ...content, dashboard } : content),
    loadedAt: new Date(clock.now()).toISOString(),
    ...content,
    dashboard,
    workflowHashes,
  };
  const result = finish(issues, files);
  return { ok: true, config: deepFreeze(config), warnings: result.warnings };
}

function finish(
  issues: IssueCollector,
  files: Map<string, ParsedFile>,
): { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] } {
  const resolved: ConfigIssue[] = issues.items.map((item) => {
    const line = item.line ?? lineOf(files.get(item.file), item.path);
    return {
      severity: item.severity,
      file: item.file,
      path: item.via !== undefined ? `${formatIssuePath(item.path)} (${item.via})` : formatIssuePath(item.path),
      message: item.message,
      ...(line !== undefined ? { line } : {}),
    };
  });
  const sorted = sortIssues(resolved);
  return {
    ok: false,
    errors: sorted.filter((i) => i.severity === 'error'),
    warnings: sorted.filter((i) => i.severity === 'warning'),
  };
}

/**
 * Read and parse one YAML file. Returns `null` if the file does not exist,
 * `undefined` if it exists but is unusable (issue recorded).
 */
async function readYaml(dir: string, file: string, issues: IssueCollector): Promise<ParsedFile | null | undefined> {
  const full = path.join(dir, file);
  let text: string;
  try {
    const st = await stat(full);
    if (!st.isFile()) {
      issues.error(file, [], 'Not a regular file');
      return undefined;
    }
    if (st.size > MAX_CONFIG_FILE_BYTES) {
      issues.error(file, [], `File is larger than ${MAX_CONFIG_FILE_BYTES} bytes`);
      return undefined;
    }
    text = await readFile(full, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    issues.error(file, [], `Cannot read file: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    return undefined;
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  for (const err of doc.errors) {
    issues.error(file, [], `YAML syntax error: ${firstLine(err.message)}`, lineCounter.linePos(err.pos[0]).line);
  }
  if (doc.errors.length > 0) return undefined;
  for (const warn of doc.warnings) {
    issues.warning(file, [], `YAML: ${firstLine(warn.message)}`, lineCounter.linePos(warn.pos[0]).line);
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 100 });
  } catch (err) {
    issues.error(file, [], `YAML error: ${firstLine((err as Error).message)}`);
    return undefined;
  }
  return { file, doc, lineCounter, data: data ?? {} };
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

async function readDir(
  dir: string,
  sub: string,
  issues: IssueCollector,
  files: Map<string, ParsedFile>,
  onUnusable?: (file: string) => void,
): Promise<ParsedFile[]> {
  let names: string[];
  try {
    names = await readdir(path.join(dir, sub));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    issues.error(sub, [], `Cannot read directory: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    return [];
  }
  const out: ParsedFile[] = [];
  for (const name of names.filter((n) => /\.ya?ml$/.test(n) && !n.startsWith('.')).sort()) {
    const file = `${sub}/${name}`;
    const parsed = await readYaml(dir, file, issues);
    if (parsed) {
      files.set(file, parsed);
      out.push(parsed);
    } else onUnusable?.(file);
  }
  return out;
}

/** File name without directory and extension (`filters/x.yaml` → `x`). */
function fileStem(file: string): string {
  return path.basename(file, path.extname(file));
}

function parseWith<S extends z.ZodType>(
  schema: S,
  parsed: ParsedFile | undefined,
  file: string,
  issues: IssueCollector,
): z.output<S> | undefined {
  const data = parsed ? parsed.data : {};
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    issues.error(file, [], 'Top level must be a mapping');
    return undefined;
  }
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  for (const issue of result.error.issues.flatMap(unionIssues)) {
    const at = issue.path.filter((p): p is string | number => typeof p !== 'symbol');
    let message = issue.message;
    if (issue.code === 'unrecognized_keys') {
      const known = knownKeysAt(schema, data, at);
      message = `Unknown key(s): ${issue.keys
        .map((k) => {
          const suggestion = known.length > 0 ? suggestKey(k, known) : undefined;
          return suggestion ? `"${k}" (did you mean "${suggestion}"?)` : `"${k}"`;
        })
        .join(', ')}`;
    } else if (issue.code === 'invalid_key') {
      // Record keys (e.g. `on_result.<outcome>`): report the key's own problem instead of "Invalid key in record".
      const reason = issue.issues[0]?.message;
      message = `Invalid key "${String(at[at.length - 1] ?? '')}"${reason ? `: ${reason}` : ''}`;
    } else if (issue.code === 'invalid_value') {
      message += enumSuggestion(valueAt(data, at), issue.values);
    }
    issues.error(file, at, message);
  }
  return undefined;
}

/**
 * A failed plain union (e.g. view `sort`: one key or a list, WI-28) reports the
 * issues of the one variant whose shape fits the input (all others failed with a
 * top-level type mismatch) instead of a bare "Invalid input".
 */
function unionIssues(issue: z.core.$ZodIssue): z.core.$ZodIssue[] {
  if (issue.code !== 'invalid_union') return [issue];
  const fitting = issue.errors.filter((branch) => !(branch.length === 1 && branch[0]?.code === 'invalid_type' && branch[0].path.length === 0));
  const only = fitting.length === 1 ? fitting[0] : undefined;
  if (!only) return [issue];
  return only.flatMap((sub) => unionIssues({ ...sub, path: [...issue.path, ...sub.path] } as z.core.$ZodIssue));
}

/** Value at `at` inside parsed YAML data (`undefined` if absent). */
function valueAt(data: unknown, at: readonly (string | number)[]): unknown {
  let node = data;
  for (const segment of at) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

/** ` (did you mean "x"?)` for a mistyped enum string, else `''`. */
function enumSuggestion(value: unknown, options: readonly unknown[]): string {
  if (typeof value !== 'string') return '';
  const names = options.filter((o): o is string => typeof o === 'string');
  const suggestion = suggestField(value, names);
  return suggestion ? ` (did you mean "${suggestion}"?)` : '';
}

/** Minimal view of zod 4 schema internals used by {@link knownKeysAt}. */
interface SchemaDef {
  type?: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  in?: unknown;
  element?: unknown;
  valueType?: unknown;
  options?: unknown[];
  /** Discriminated unions: name of the discriminator key. */
  discriminator?: string;
  /** Literals: allowed values. */
  values?: unknown[];
}

function defOf(schema: unknown): SchemaDef | undefined {
  return (schema as { _zod?: { def?: SchemaDef } } | null)?._zod?.def;
}

/** Strip wrappers (default, optional, pipe, …) that do not change the allowed keys. */
function unwrapDef(schema: unknown): SchemaDef | undefined {
  let def = defOf(schema);
  for (let i = 0; def && i < 32; i++) {
    if (def.type === 'default' || def.type === 'prefault' || def.type === 'optional' || def.type === 'nullable' || def.type === 'readonly') {
      def = defOf(def.innerType);
    } else if (def.type === 'pipe') def = defOf(def.in);
    else break;
  }
  return def;
}

/** Variants of a union that match the input's discriminator value (discriminated unions only). */
function matchingVariants(def: SchemaDef, data: unknown): unknown[] | null {
  const key = def.discriminator;
  if (key === undefined || typeof data !== 'object' || data === null || !Object.hasOwn(data, key)) return null;
  const value = (data as Record<string, unknown>)[key];
  const matches = (def.options ?? []).filter((option) => {
    const literal = unwrapDef(unwrapDef(option)?.shape?.[key]);
    return literal?.type === 'literal' && (literal.values ?? []).includes(value);
  });
  return matches.length > 0 ? matches : null;
}

/**
 * Keys allowed by the object schema at `at` of `data` (best effort, for "did
 * you mean" hints on unknown keys): follows object properties, array elements
 * and record values alongside the parsed data. For a discriminated union only
 * the variant selected by the input's discriminator counts; without a match
 * (or for plain unions) only keys shared by all variants are offered.
 */
export function knownKeysAt(schema: unknown, data: unknown, at: IssuePath): string[] {
  const def = unwrapDef(schema);
  if (!def) return [];
  if (def.type === 'union') {
    const selected = matchingVariants(def, data);
    if (selected) return [...new Set(selected.flatMap((v) => knownKeysAt(v, data, at)))];
    // Plain unions of a mapping and a list (e.g. view `sort`, WI-28): only variants of the input's shape count.
    const options = def.options ?? [];
    const shaped = options.filter((v) => {
      const type = unwrapDef(v)?.type;
      return Array.isArray(data) ? type === 'array' : typeof data === 'object' && data !== null ? type === 'object' || type === 'record' : true;
    });
    const all = (shaped.length > 0 ? shaped : options).map((v) => knownKeysAt(v, data, at));
    if (all.length === 0) return [];
    return (all[0] ?? []).filter((k) => all.every((keys) => keys.includes(k)));
  }
  const [segment, ...rest] = at;
  if (segment === undefined) return def.type === 'object' && def.shape ? Object.keys(def.shape) : [];
  const child = typeof data === 'object' && data !== null ? (data as Record<string | number, unknown>)[segment] : undefined;
  if (def.type === 'object' && typeof segment === 'string' && def.shape && Object.hasOwn(def.shape, segment)) {
    return knownKeysAt(def.shape[segment], child, rest);
  }
  if (def.type === 'array' && typeof segment === 'number') return knownKeysAt(def.element, child, rest);
  if (def.type === 'record') return knownKeysAt(def.valueType, child, rest);
  return [];
}

/**
 * "Did you mean" for an unknown key: the closest allowed key within about a
 * third of the key's length (at least 1 edit). Stricter than field
 * suggestions so that short keys (`on` → `id`) get no misleading hint.
 */
export function suggestKey(key: string, known: readonly string[]): string | undefined {
  const suggestion = suggestField(key, known);
  if (suggestion === undefined) return undefined;
  return editDistance(key.toLowerCase(), suggestion.toLowerCase()) <= Math.max(1, Math.floor(key.length * 0.34)) ? suggestion : undefined;
}

/** Find the 1-based line of the deepest existing node along `issuePath`. */
function lineOf(parsed: ParsedFile | undefined, issuePath: IssuePath): number | undefined {
  if (!parsed?.doc) return undefined;
  let node: unknown = parsed.doc.contents;
  let found = node;
  for (const segment of issuePath) {
    if (isMap(node)) node = node.get(segment, true);
    else if (isSeq(node) && typeof segment === 'number') node = node.get(segment, true);
    else break;
    if (node === undefined || node === null) break;
    found = node;
  }
  const range = (found as { range?: [number, number, number] } | null)?.range;
  if (!range) return undefined;
  return parsed.lineCounter.linePos(range[0]).line;
}

/** Canonical JSON (sorted object keys) for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Recursively freeze an object graph. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
