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
 * - Secrets are redacted while copying (best effort, same byte-level
 *   {@link StreamRedactor} as the worker logs; secrets split across read
 *   chunks are caught).
 * - The total size per run is capped (`keep_max_size`) by the bytes actually
 *   written: files that do not fit any more are skipped (smaller later files
 *   may still fit).
 * - Copies go to `kept.tmp/` first, which is renamed to `kept/` at the end; an
 *   existing `kept/` (e.g. recovery after a crash) is never overwritten.
 * - Walking is bounded ({@link KEEP_MAX_ENTRIES} directory entries,
 *   {@link KEEP_MAX_FILES} files). Patterns without wildcards are resolved
 *   first with plain `lstat`s and do not consume the entry budget.
 */
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorMessage, isWithin, parseKeepPattern, resolveWithin, type GlobSegment, type KeepPattern } from '../core/index.js';
import { StreamRedactor } from '../executors/index.js';

/** Max. directory entries inspected while matching (protects against huge trees with `**`). */
export const KEEP_MAX_ENTRIES = 100_000;
/** Max. number of kept files per run. */
export const KEEP_MAX_FILES = 10_000;
/** Max. skipped entries listed in the event (the count is always complete). */
export const KEEP_MAX_REPORTED_SKIPS = 100;

/** Why a matching entry was not kept. */
export type KeepSkipReason =
  | 'size_limit'
  | 'symlink'
  | 'directory'
  | 'not_regular_file'
  | 'outside_workspace'
  | 'changed'
  | 'file_limit'
  | 'error';

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
  /** Total bytes written to `kept/` (after redaction). */
  bytes: number;
  /** Patterns without any match (not an error). */
  unmatched: string[];
  /** Patterns that could not be searched (completely) because the walk limit was reached first. */
  notSearched: string[];
  /** Skipped entries (at most {@link KEEP_MAX_REPORTED_SKIPS}). */
  skipped: KeepSkip[];
  /** Total number of skipped entries. */
  skippedCount: number;
  /** True if the walk stopped early at {@link KEEP_MAX_ENTRIES}. */
  walkLimitReached: boolean;
  /** `kept/` existed already (resumed finalization): nothing was copied. */
  alreadyPresent?: boolean;
  /** Fatal problem (e.g. workspace missing); nothing was kept. */
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
  /** Max. total bytes (written). */
  maxBytes: number;
  /** Secret values redacted while copying (the run's secrets and the shared redactor's). */
  secrets?: Iterable<string>;
  /** Override of {@link KEEP_MAX_ENTRIES} (tests). */
  maxEntries?: number;
  /** Override of {@link KEEP_MAX_FILES} (tests). */
  maxFiles?: number;
  /** Test hook: called after the walk, right before a file is opened for copying. */
  beforeCopy?: (relPath: string) => void | Promise<void>;
}

interface Match {
  rel: string;
  /** `lstat` result of the entry while walking. */
  kind: 'file' | 'symlink' | 'other' | 'directory';
  size: number;
  dev: number;
  ino: number;
}

interface Budget {
  entries: number;
  exhausted: boolean;
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
    notSearched: [],
    skipped: [],
    skippedCount: 0,
    walkLimitReached: false,
  };
  const skip = (s: KeepSkip): void => {
    report.skippedCount++;
    if (report.skipped.length < KEEP_MAX_REPORTED_SKIPS) report.skipped.push(s);
  };
  const tmpDir = `${options.keptDir}.tmp`;
  const maxFiles = options.maxFiles ?? KEEP_MAX_FILES;
  const secrets = [...(options.secrets ?? [])];
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

    // Literal patterns first: they need no directory listing and never starve.
    const patterns = options.patterns.map((p) => parseKeepPattern(p));
    const ordered = [...patterns.filter(isLiteral), ...patterns.filter((p) => !isLiteral(p))];
    const matches = new Map<string, Match>();
    const budget: Budget = { entries: options.maxEntries ?? KEEP_MAX_ENTRIES, exhausted: false };
    const outcome = new Map<string, 'found' | 'unmatched' | 'not_searched'>();
    for (const pattern of ordered) {
      const found = new Set<string>();
      const wasExhausted = budget.exhausted;
      await walk(root, [], pattern, 0, matches, found, budget, new Set());
      if (found.size > 0) outcome.set(pattern.pattern, 'found');
      // A wildcard pattern without match is only "unmatched" if it was searched completely.
      else if (!isLiteral(pattern) && (wasExhausted || budget.exhausted)) outcome.set(pattern.pattern, 'not_searched');
      else outcome.set(pattern.pattern, 'unmatched');
    }
    for (const p of patterns) {
      const o = outcome.get(p.pattern);
      if (o === 'unmatched' && !report.unmatched.includes(p.pattern)) report.unmatched.push(p.pattern);
      if (o === 'not_searched' && !report.notSearched.includes(p.pattern)) report.notSearched.push(p.pattern);
    }
    report.walkLimitReached = budget.exhausted;

    await rm(tmpDir, { recursive: true, force: true });
    const sorted = [...matches.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    let created = false;
    for (const m of sorted) {
      if (m.kind === 'symlink') {
        skip({ path: m.rel, reason: 'symlink' });
        continue;
      }
      if (m.kind === 'directory') {
        skip({ path: m.rel, reason: 'directory', message: `directories are not copied; use "${m.rel}/**/*" to keep its files` });
        continue;
      }
      if (m.kind === 'other') {
        skip({ path: m.rel, reason: 'not_regular_file' });
        continue;
      }
      if (report.files >= maxFiles) {
        skip({ path: m.rel, reason: 'file_limit', size: m.size });
        continue;
      }
      const remaining = options.maxBytes - report.bytes;
      // Without secrets the written size equals the source size; with secrets it is checked while writing.
      if (secrets.length === 0 && m.size > remaining) {
        skip({ path: m.rel, reason: 'size_limit', size: m.size });
        continue;
      }
      if (!created) {
        await mkdir(tmpDir, { recursive: true, mode: 0o700 });
        created = true;
      }
      await options.beforeCopy?.(m.rel);
      const result = await copyOne(root, m, tmpDir, remaining, secrets);
      if (result.ok) {
        report.files++;
        report.bytes += result.written;
      } else {
        skip({ path: m.rel, reason: result.reason, size: m.size, ...(result.message ? { message: result.message } : {}) });
      }
    }
    if (created && report.files > 0) await rename(tmpDir, options.keptDir);
    else if (created) await rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // Nothing of a failed attempt is kept (kept.tmp is removed).
    report.error = errorMessage(err);
    report.files = 0;
    report.bytes = 0;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return finish(report);
}

function isLiteral(pattern: KeepPattern): boolean {
  return pattern.segments.every((s) => s.kind === 'literal');
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
  if (report.notSearched.length > 0) parts.push(`not searched (limit): ${report.notSearched.join(', ')}`);
  if (report.walkLimitReached) parts.push('directory entry limit reached');
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
  budget: Budget,
  visited: Set<string>,
): Promise<void> {
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

  // Literal segments need no listing (and no budget).
  const names = seg.kind === 'literal' ? [seg.value] : (await listDir(dir, budget)).filter((n) => seg.regex.test(n));
  for (const name of names) {
    const abs = path.join(dir, name);
    const st = await lstatOrNull(abs);
    if (!st) continue;
    const rel = [...relParts, name].join('/');
    if (last) {
      if (st.isDirectory()) {
        // An explicitly named directory is reported; directories matched by wildcards are ignored.
        if (seg.kind !== 'literal') continue;
        found.add(rel);
        if (!matches.has(rel)) matches.set(rel, { rel, kind: 'directory', size: 0, dev: st.dev, ino: st.ino });
        continue;
      }
      found.add(rel);
      if (!matches.has(rel)) {
        const kind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other';
        matches.set(rel, { rel, kind, size: st.size, dev: st.dev, ino: st.ino });
      }
    } else if (st.isDirectory()) {
      await walk(abs, [...relParts, name], pattern, si + 1, matches, found, budget, visited);
    }
  }
}

/** Names in `dir` (sorted), read incrementally and at most the remaining budget. */
async function listDir(dir: string, budget: Budget): Promise<string[]> {
  if (budget.entries <= 0) {
    budget.exhausted = true;
    return [];
  }
  const names: string[] = [];
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return [];
  }
  try {
    for (;;) {
      const entry = await handle.read();
      if (!entry) break;
      if (budget.entries <= 0) {
        budget.exhausted = true;
        break;
      }
      budget.entries--;
      names.push(entry.name);
    }
  } catch {
    // unreadable directory: use what was read
  } finally {
    await handle.close().catch(() => undefined);
  }
  return names.sort();
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

type CopyOutcome = { ok: true; written: number } | { ok: false; reason: KeepSkipReason; message?: string };

/** Thrown inside the copy pipeline when the written bytes exceed the budget. */
class SizeLimitExceeded extends Error {}

/**
 * Redacts secrets (chunk-boundary safe) and counts the written bytes; fails
 * with {@link SizeLimitExceeded} once more than `limit` bytes would be written.
 */
class RedactingCounter extends Transform {
  written = 0;
  private readonly redactor: StreamRedactor;

  constructor(
    secrets: readonly string[],
    private readonly limit: number,
  ) {
    super();
    this.redactor = new StreamRedactor(secrets);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.forward(this.redactor.push(chunk), cb);
  }

  override _flush(cb: TransformCallback): void {
    this.forward(this.redactor.flush(), cb);
  }

  private forward(out: Buffer, cb: TransformCallback): void {
    this.written += out.length;
    if (this.written > this.limit) {
      cb(new SizeLimitExceeded('size limit'));
      return;
    }
    cb(null, out);
  }
}

/** Copy one file (see module docs for the checks). */
async function copyOne(root: string, m: Match, tmpDir: string, remaining: number, secrets: readonly string[]): Promise<CopyOutcome> {
  const src = path.join(root, ...m.rel.split('/'));
  let handle: FileHandle;
  try {
    handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, reason: 'symlink' };
    if (code === 'ENOENT') return { ok: false, reason: 'changed' };
    return { ok: false, reason: 'error', message: errorMessage(err) };
  }
  let dest: string | undefined;
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: 'not_regular_file' };
    if (st.dev !== m.dev || st.ino !== m.ino) return { ok: false, reason: 'changed' };
    const real = await realpath(src);
    if (!isWithin(root, real)) return { ok: false, reason: 'outside_workspace' };
    if (secrets.length === 0 && st.size > remaining) return { ok: false, reason: 'size_limit' };
    dest = resolveWithin(tmpDir, m.rel);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const counter = new RedactingCounter(secrets, remaining);
    const out = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    // Copy exactly the size seen at open time (a file growing meanwhile is cut).
    const input = st.size === 0 ? Readable.from([]) : createReadStream('', { fd: handle, start: 0, end: st.size - 1, autoClose: false });
    await pipeline(input, counter, out);
    return { ok: true, written: counter.written };
  } catch (err) {
    if (dest) await rm(dest, { force: true }).catch(() => undefined);
    if (err instanceof SizeLimitExceeded) return { ok: false, reason: 'size_limit' };
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
