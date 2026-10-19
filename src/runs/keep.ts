/**
 * Keep files of a run workspace (WI-22, `execute.keep`): after the completion
 * hook and before the workspace cleanup, regular files matching the
 * configured glob patterns are copied to `runs/<run-id>/kept/` with their
 * relative structure.
 *
 * Safety rules:
 * - Symlinks are never followed (neither directories nor files); a matching
 *   symlink is reported as skipped. Only regular files are copied.
 * - Every file is opened with `O_NOFOLLOW`, its identity (dev/inode) must
 *   equal the one seen while walking and its real path must lie inside the
 *   real workspace – a path swapped for a symlink after the walk is skipped.
 * - The total size per run is capped (`keep_max_size`): files that do not fit
 *   any more are skipped (smaller later files may still fit).
 * - Copies go to `kept.tmp/` first, which is renamed to `kept/` at the end; an
 *   existing `kept/` (e.g. recovery after a crash) is never overwritten.
 * - Walking is bounded ({@link KEEP_MAX_ENTRIES} directory entries,
 *   {@link KEEP_MAX_FILES} files).
 */
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { errorMessage, isWithin, parseKeepPattern, resolveWithin, type GlobSegment, type KeepPattern } from '../core/index.js';

/** Max. directory entries inspected while matching (protects against huge trees with `**`). */
export const KEEP_MAX_ENTRIES = 100_000;
/** Max. number of kept files per run. */
export const KEEP_MAX_FILES = 10_000;
/** Max. skipped entries listed in the event (the count is always complete). */
export const KEEP_MAX_REPORTED_SKIPS = 100;

/** Why a matching entry was not kept. */
export type KeepSkipReason = 'size_limit' | 'symlink' | 'not_regular_file' | 'outside_workspace' | 'changed' | 'file_limit' | 'error';

/** A matching entry that was not kept. */
export interface KeepSkip {
  /** Path relative to the workspace (`/`-separated). */
  path: string;
  reason: KeepSkipReason;
  /** Size in bytes, if known. */
  size?: number;
  message?: string;
}

/** Summary of {@link keepWorkspaceFiles} (payload of the `run.kept_files` event). */
export interface KeepReport {
  /** Human readable summary (shown in event lists). */
  message: string;
  patterns: string[];
  maxBytes: number;
  /** Number of kept files. */
  files: number;
  /** Total bytes of kept files. */
  bytes: number;
  /** Patterns without any match (not an error). */
  unmatched: string[];
  /** Skipped entries (at most {@link KEEP_MAX_REPORTED_SKIPS}). */
  skipped: KeepSkip[];
  /** Total number of skipped entries. */
  skippedCount: number;
  /** True if the walk stopped early at {@link KEEP_MAX_ENTRIES}. */
  walkLimitReached: boolean;
  /** `kept/` existed already (resumed finalization): nothing was copied. */
  alreadyPresent?: boolean;
  /** Fatal problem (e.g. workspace missing); nothing or only part was kept. */
  error?: string;
}

/** Options of {@link keepWorkspaceFiles}. */
export interface KeepOptions {
  /** Absolute workspace directory of the run. */
  workspace: string;
  /** Target directory (`runs/<run-id>/kept`). */
  keptDir: string;
  /** Configured patterns (validated by the config loader). */
  patterns: readonly string[];
  /** Max. total bytes. */
  maxBytes: number;
}

interface Match {
  rel: string;
  /** `lstat` result of the entry while walking. */
  kind: 'file' | 'symlink' | 'other';
  size: number;
  dev: number;
  ino: number;
}

/**
 * Copy matching workspace files to `keptDir`. Never throws: problems are
 * reported in the result (`error`, `skipped`).
 */
export async function keepWorkspaceFiles(options: KeepOptions): Promise<KeepReport> {
  const report: KeepReport = {
    message: '',
    patterns: [...options.patterns],
    maxBytes: options.maxBytes,
    files: 0,
    bytes: 0,
    unmatched: [],
    skipped: [],
    skippedCount: 0,
    walkLimitReached: false,
  };
  const skip = (s: KeepSkip): void => {
    report.skippedCount++;
    if (report.skipped.length < KEEP_MAX_REPORTED_SKIPS) report.skipped.push(s);
  };
  const tmpDir = `${options.keptDir}.tmp`;
  try {
    if (await exists(options.keptDir)) {
      const existing = await listKeptFiles(options.keptDir);
      report.files = existing.files.length;
      report.bytes = existing.files.reduce((sum, f) => sum + f.size, 0);
      report.alreadyPresent = true;
      return finish(report);
    }
    let root: string;
    try {
      root = await realpath(options.workspace);
      if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${options.workspace}`);
    } catch (err) {
      report.error = `workspace not readable: ${errorMessage(err)}`;
      return finish(report);
    }

    const patterns = options.patterns.map((p) => parseKeepPattern(p));
    const matches = new Map<string, Match>();
    const budget = { entries: KEEP_MAX_ENTRIES };
    for (const pattern of patterns) {
      const found = new Set<string>();
      await walk(root, [], pattern, 0, matches, found, budget, new Set());
      if (found.size === 0) report.unmatched.push(pattern.pattern);
      if (budget.entries <= 0) report.walkLimitReached = true;
    }

    await rm(tmpDir, { recursive: true, force: true });
    const sorted = [...matches.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    let created = false;
    for (const m of sorted) {
      if (m.kind === 'symlink') {
        skip({ path: m.rel, reason: 'symlink' });
        continue;
      }
      if (m.kind === 'other') {
        skip({ path: m.rel, reason: 'not_regular_file' });
        continue;
      }
      if (report.files >= KEEP_MAX_FILES) {
        skip({ path: m.rel, reason: 'file_limit', size: m.size });
        continue;
      }
      if (report.bytes + m.size > options.maxBytes) {
        skip({ path: m.rel, reason: 'size_limit', size: m.size });
        continue;
      }
      if (!created) {
        await mkdir(tmpDir, { recursive: true, mode: 0o700 });
        created = true;
      }
      const outcome = await copyOne(root, m, tmpDir, options.maxBytes - report.bytes);
      if (outcome.ok) {
        report.files++;
        report.bytes += outcome.size;
      } else {
        skip({ path: m.rel, reason: outcome.reason, size: m.size, ...(outcome.message ? { message: outcome.message } : {}) });
      }
    }
    if (created) await rename(tmpDir, options.keptDir);
  } catch (err) {
    report.error = errorMessage(err);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return finish(report);
}

function finish(report: KeepReport): KeepReport {
  const parts: string[] = [];
  if (report.alreadyPresent) parts.push(`kept files already present (${report.files} file(s), ${report.bytes} bytes)`);
  else parts.push(`kept ${report.files} file(s), ${report.bytes} bytes`);
  if (report.skippedCount > 0) {
    const reasons = [...new Set(report.skipped.map((s) => s.reason))].join(', ');
    parts.push(`${report.skippedCount} skipped (${reasons})`);
  }
  if (report.unmatched.length > 0) parts.push(`no match: ${report.unmatched.join(', ')}`);
  if (report.walkLimitReached) parts.push(`stopped after ${KEEP_MAX_ENTRIES} directory entries`);
  if (report.error) parts.push(`error: ${report.error}`);
  report.message = parts.join('; ');
  return report;
}

/**
 * Match `pattern.segments[si..]` below the real directory `dir` (relative
 * parts `relParts`). Symlinked directories are never entered.
 */
async function walk(
  dir: string,
  relParts: string[],
  pattern: KeepPattern,
  si: number,
  matches: Map<string, Match>,
  found: Set<string>,
  budget: { entries: number },
  visited: Set<string>,
): Promise<void> {
  if (budget.entries <= 0) return;
  const key = `${relParts.join('/')}\0${si}`;
  if (visited.has(key)) return;
  visited.add(key);
  const seg = pattern.segments[si] as GlobSegment;
  const last = si === pattern.segments.length - 1;

  if (seg.kind === 'globstar') {
    // Zero directories …
    await walk(dir, relParts, pattern, si + 1, matches, found, budget, visited);
    // … or one more (then still at `**`).
    for (const name of await listDir(dir, budget)) {
      const child = await lstatOrNull(path.join(dir, name));
      if (child?.isDirectory()) await walk(path.join(dir, name), [...relParts, name], pattern, si, matches, found, budget, visited);
    }
    return;
  }

  const names = seg.kind === 'literal' ? [seg.value] : (await listDir(dir, budget)).filter((n) => seg.regex.test(n));
  for (const name of names) {
    if (seg.kind === 'literal') budget.entries--;
    const abs = path.join(dir, name);
    const st = await lstatOrNull(abs);
    if (!st) continue;
    const rel = [...relParts, name].join('/');
    if (last) {
      found.add(rel);
      if (!matches.has(rel)) {
        const kind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? null : 'other';
        if (kind) matches.set(rel, { rel, kind, size: st.size, dev: st.dev, ino: st.ino });
      }
    } else if (st.isDirectory()) {
      await walk(abs, [...relParts, name], pattern, si + 1, matches, found, budget, visited);
    }
  }
}

async function listDir(dir: string, budget: { entries: number }): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  if (names.length > budget.entries) names = names.slice(0, Math.max(0, budget.entries));
  budget.entries -= names.length;
  if (budget.entries === 0) budget.entries = -1; // mark "limit reached"
  return names;
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await lstatOrNull(p)) !== null;
}

type CopyOutcome = { ok: true; size: number } | { ok: false; reason: KeepSkipReason; message?: string };

/** Copy one file (see module docs for the checks). */
async function copyOne(root: string, m: Match, tmpDir: string, remaining: number): Promise<CopyOutcome> {
  const src = path.join(root, ...m.rel.split('/'));
  let handle;
  try {
    handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, reason: 'symlink' };
    return { ok: false, reason: 'error', message: errorMessage(err) };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: 'not_regular_file' };
    if (st.dev !== m.dev || st.ino !== m.ino) return { ok: false, reason: 'changed' };
    const real = await realpath(src);
    if (!isWithin(root, real)) return { ok: false, reason: 'outside_workspace' };
    if (st.size > remaining) return { ok: false, reason: 'size_limit' };
    const dest = resolveWithin(tmpDir, m.rel);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const out = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    if (st.size === 0) {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } else {
      // Copy exactly the size seen at open time (a file growing meanwhile is cut, never exceeds the budget).
      await pipeline(createReadStream('', { fd: handle, start: 0, end: st.size - 1, autoClose: false }), out);
    }
    return { ok: true, size: st.size };
  } catch (err) {
    return { ok: false, reason: 'error', message: errorMessage(err) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** One kept file (API listing). */
export interface KeptFile {
  /** Path relative to `kept/` (`/`-separated). */
  path: string;
  size: number;
}

/**
 * List the regular files below `keptDir` (sorted, symlinks ignored), at most
 * `limit` entries. A missing directory yields an empty list.
 */
export async function listKeptFiles(keptDir: string, limit = KEEP_MAX_FILES): Promise<{ files: KeptFile[]; truncated: boolean }> {
  const files: KeptFile[] = [];
  let truncated = false;
  const visit = async (dir: string, rel: string[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await visit(abs, [...rel, e.name]);
      else if (e.isFile()) {
        const st = await lstatOrNull(abs);
        if (st?.isFile()) files.push({ path: [...rel, e.name].join('/'), size: st.size });
      }
    }
  };
  await visit(keptDir, []);
  return { files, truncated };
}
