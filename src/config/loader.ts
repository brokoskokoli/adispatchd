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
import type { ConfigIssue, GlobalConfig, LoadedConfig, ViewConfig, WorkflowConfig } from './model.js';
import { suggestField } from './field-catalog.js';
import { NamedFilters, type NamedFilterEntry } from './named-filters.js';
import {
  normalizeGlobal,
  normalizeIdentities,
  normalizeSources,
  normalizeView,
  normalizeWorkflow,
} from './normalize.js';
import {
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
      });
    } else allUsersParsed = false;
  }
  if (allUsersParsed) namedFilters.reportUnused();

  validateSemantics({ global, sources, identities, workflows: workflowEntries, views: viewEntries, namedFilters }, issues);

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
    hash: hashOf(content),
    loadedAt: new Date(clock.now()).toISOString(),
    ...content,
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
  for (const issue of result.error.issues) {
    const at = issue.path.filter((p): p is string | number => typeof p !== 'symbol');
    let message = issue.message;
    if (issue.code === 'unrecognized_keys') {
      const known = knownKeysAt(schema, at);
      message = `Unknown key(s): ${issue.keys
        .map((k) => {
          const suggestion = known.length > 0 ? suggestField(k, known) : undefined;
          return suggestion ? `"${k}" (did you mean "${suggestion}"?)` : `"${k}"`;
        })
        .join(', ')}`;
    } else if (issue.code === 'invalid_key') {
      // Record keys (e.g. `on_result.<outcome>`): report the key's own problem instead of "Invalid key in record".
      const reason = issue.issues[0]?.message;
      message = `Invalid key "${String(at[at.length - 1] ?? '')}"${reason ? `: ${reason}` : ''}`;
    }
    issues.error(file, at, message);
  }
  return undefined;
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
}

/**
 * Keys allowed by the object schema(s) at `at` (best effort, for "did you
 * mean" hints on unknown keys): unwraps defaults/optionals/pipes, follows
 * object properties, array elements and record values; for unions the keys of
 * all object variants are collected.
 */
function knownKeysAt(schema: unknown, at: IssuePath): string[] {
  const unwrap = (s: unknown): SchemaDef[] => {
    const def = (s as { _zod?: { def?: SchemaDef } } | null)?._zod?.def;
    if (!def) return [];
    switch (def.type) {
      case 'default':
      case 'prefault':
      case 'optional':
      case 'nullable':
      case 'readonly':
        return unwrap(def.innerType);
      case 'pipe':
        return unwrap(def.in);
      case 'union':
        return (def.options ?? []).flatMap(unwrap);
      default:
        return [def];
    }
  };
  let current = unwrap(schema);
  for (const segment of at) {
    current = current.flatMap((def) => {
      if (def.type === 'object' && typeof segment === 'string' && def.shape && Object.hasOwn(def.shape, segment)) {
        return unwrap(def.shape[segment]);
      }
      if (def.type === 'array' && typeof segment === 'number') return unwrap(def.element);
      if (def.type === 'record') return unwrap(def.valueType);
      return [];
    });
  }
  return [...new Set(current.flatMap((def) => (def.type === 'object' && def.shape ? Object.keys(def.shape) : [])))];
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
