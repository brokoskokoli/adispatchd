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
import { systemClock, toAbsolutePath, type Clock } from '../core/index.js';
import { formatIssuePath, IssueCollector, sortIssues, type IssuePath } from './issues.js';
import type { ConfigIssue, GlobalConfig, LoadedConfig, ViewConfig, WorkflowConfig } from './model.js';
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

  const workflowEntries: WorkflowEntry[] = [];
  for (const parsed of workflowFiles) {
    const raw = parseWith(workflowSchema, parsed, parsed.file, issues);
    if (raw) {
      workflowEntries.push({ workflow: normalizeWorkflow(raw, parsed.file, global, dir), rawParameters: raw.parameters });
    }
  }
  const viewEntries: ViewEntry[] = [];
  for (const parsed of viewFiles) {
    const raw = parseWith(viewSchema, parsed, parsed.file, issues);
    if (raw) viewEntries.push({ view: normalizeView(raw, parsed.file), hasShellFilter: raw.shell_filter !== undefined });
  }

  validateSemantics({ global, sources, identities, workflows: workflowEntries, views: viewEntries }, issues);

  if (issues.hasErrors) return finish(issues, files);

  const workflows: Record<string, WorkflowConfig> = {};
  const workflowHashes: Record<string, string> = {};
  for (const { workflow } of workflowEntries) {
    workflows[workflow.id] = workflow;
    workflowHashes[workflow.id] = hashOf(workflow);
  }
  const views: Record<string, ViewConfig> = {};
  for (const { view } of viewEntries) views[view.id] = view;

  const content = { global, sources, identities, workflows, views };
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
      path: formatIssuePath(item.path),
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
    }
  }
  return out;
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
      message = `Unknown key(s): ${issue.keys.map((k) => `"${k}"`).join(', ')}`;
    }
    issues.error(file, at, message);
  }
  return undefined;
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
