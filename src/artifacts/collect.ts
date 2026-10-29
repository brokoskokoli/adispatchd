/**
 * Collecting a workspace file or folder as an artifact (WI-35). Safety rules
 * as for `execute.keep` (WI-22): the path is a literal, relative workspace
 * path; no component may be a symlink; only regular files are copied
 * (symlinks and special files inside a folder are skipped and reported);
 * every file is opened with `O_NOFOLLOW` and checked against the walk
 * (see {@link copyRegularFile}); secrets are redacted while copying; the size,
 * the number of files and the number of directory entries are bounded.
 */
import { lstat, mkdir, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, isWithin } from '../core/index.js';
import { copyRegularFile } from './copy.js';

/** Max. directory entries inspected per folder artifact. */
export const ARTIFACT_MAX_ENTRIES = 100_000;
/** Max. files per folder artifact. */
export const ARTIFACT_MAX_FILES = 10_000;
/** Max. skipped entries listed in a report. */
export const ARTIFACT_MAX_REPORTED_SKIPS = 50;

/** Why a path could not be collected. */
export type CollectFailure =
  | 'missing'
  | 'symlink'
  | 'hardlink'
  | 'outside_workspace'
  | 'not_regular_file'
  | 'empty'
  | 'size_limit'
  | 'file_limit'
  | 'entry_limit'
  | 'error';

/** A path inside a folder artifact that was left out. */
export interface CollectSkip {
  /** Path relative to the artifact folder. */
  path: string;
  reason: 'symlink' | 'hardlink' | 'unsafe_name' | 'not_regular_file' | 'changed' | 'outside_workspace' | 'error';
}

/** The inspected source of an artifact. */
export interface InspectedSource {
  kind: 'file' | 'folder';
  /** Real workspace directory. */
  root: string;
  /** Absolute path of the file or folder. */
  abs: string;
  /** Base name. */
  name: string;
  size: number;
  dev: number;
  ino: number;
}

/** Result of {@link inspectArtifactPath}. */
export type InspectResult = { ok: true; source: InspectedSource } | { ok: false; reason: CollectFailure; message: string };

/**
 * Resolve `rel` below `workspace` without following symlinks: every component
 * is checked with `lstat`; the last one must be a regular file or a directory.
 */
export async function inspectArtifactPath(workspace: string, rel: string): Promise<InspectResult> {
  let root: string;
  try {
    root = await realpath(workspace);
    if (!(await stat(root)).isDirectory()) return { ok: false, reason: 'error', message: `workspace is not a directory` };
  } catch (err) {
    return { ok: false, reason: 'error', message: `workspace not readable: ${errorMessage(err)}` };
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0') || s.includes('\\'))) {
    return { ok: false, reason: 'error', message: `invalid path "${rel.replace(/\0/g, '')}"` };
  }
  let current = root;
  for (const [i, segment] of segments.entries()) {
    current = path.join(current, segment);
    let st;
    try {
      st = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return { ok: false, reason: 'missing', message: `path "${rel}" does not exist in the workspace` };
      }
      return { ok: false, reason: 'error', message: errorMessage(err) };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, reason: 'symlink', message: `"${segments.slice(0, i + 1).join('/')}" is a symbolic link; symlinks are never followed` };
    }
    const last = i === segments.length - 1;
    if (!last) {
      if (!st.isDirectory()) return { ok: false, reason: 'not_regular_file', message: `"${segments.slice(0, i + 1).join('/')}" is not a directory` };
      continue;
    }
    if (!st.isFile() && !st.isDirectory()) {
      return { ok: false, reason: 'not_regular_file', message: `"${rel}" is neither a regular file nor a folder` };
    }
    try {
      if (!isWithin(root, await realpath(current))) return { ok: false, reason: 'outside_workspace', message: `"${rel}" resolves outside the workspace` };
    } catch (err) {
      return { ok: false, reason: 'error', message: errorMessage(err) };
    }
    return { ok: true, source: { kind: st.isDirectory() ? 'folder' : 'file', root, abs: current, name: segment, size: st.size, dev: st.dev, ino: st.ino } };
  }
  return { ok: false, reason: 'error', message: `invalid path "${rel}"` };
}

/** Options of {@link collectArtifact}. */
export interface CollectOptions {
  source: InspectedSource;
  /** Destination: a file path for a file, a directory for a folder (must not exist). */
  dest: string;
  /** Max. bytes that may be written. */
  maxBytes: number;
  secrets: readonly string[];
  maxEntries?: number;
  maxFiles?: number;
  /** Test hook: called right before a file of a folder is copied. */
  beforeCopy?: (relPath: string) => void | Promise<void>;
}

/** Result of {@link collectArtifact}. */
export type CollectResult =
  | { ok: true; kind: 'file' | 'folder'; fileName: string; size: number; fileCount: number; skipped: CollectSkip[]; skippedCount: number }
  | { ok: false; reason: CollectFailure; message: string };

/** Copy the inspected source to `dest`. Never throws; the caller removes a partial destination on failure. */
export async function collectArtifact(options: CollectOptions): Promise<CollectResult> {
  const { source, dest } = options;
  const maxFiles = options.maxFiles ?? ARTIFACT_MAX_FILES;
  const budget = { entries: options.maxEntries ?? ARTIFACT_MAX_ENTRIES };
  const skipped: CollectSkip[] = [];
  let skippedCount = 0;
  const skip = (s: CollectSkip): void => {
    skippedCount++;
    if (skipped.length < ARTIFACT_MAX_REPORTED_SKIPS) skipped.push(s);
  };
  try {
    if (source.kind === 'file') {
      const res = await copyRegularFile({ src: source.abs, root: source.root, expect: source, dest, remaining: options.maxBytes, secrets: options.secrets });
      if (!res.ok) return { ok: false, reason: res.reason === 'changed' || res.reason === 'not_regular_file' ? 'not_regular_file' : res.reason, message: copyMessage(res.reason, res.message) };
      return { ok: true, kind: 'file', fileName: source.name, size: res.written, fileCount: 1, skipped, skippedCount };
    }
    await mkdir(dest, { recursive: true, mode: 0o700 });
    let size = 0;
    let fileCount = 0;
    const failure: { value: CollectResult | null } = { value: null };
    const visit = async (dir: string, destDir: string, rel: string[]): Promise<void> => {
      const names: string[] = [];
      const handle = await opendir(dir);
      try {
        for (;;) {
          const entry = await handle.read();
          if (!entry) break;
          if (--budget.entries < 0) {
            failure.value = { ok: false, reason: 'entry_limit', message: `the folder has more than ${options.maxEntries ?? ARTIFACT_MAX_ENTRIES} entries` };
            return;
          }
          names.push(entry.name);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      names.sort();
      for (const name of names) {
        if (failure.value) return;
        const relPath = [...rel, name].join('/');
        // Names a path or an archive could misread (separators, NUL, control characters) never enter an artifact.
        if (/[\\\u0000-\u001f\u007f]/.test(name)) {
          skip({ path: relPath.replace(/[\u0000-\u001f\u007f]/g, '?'), reason: 'unsafe_name' });
          continue;
        }
        const abs = path.join(dir, name);
        const st = await lstat(abs).catch(() => null);
        if (!st) {
          skip({ path: relPath, reason: 'changed' });
        } else if (st.isSymbolicLink()) {
          skip({ path: relPath, reason: 'symlink' });
        } else if (st.isDirectory()) {
          await mkdir(path.join(destDir, name), { mode: 0o700 });
          await visit(abs, path.join(destDir, name), [...rel, name]);
        } else if (st.isFile()) {
          if (fileCount >= maxFiles) {
            failure.value = { ok: false, reason: 'file_limit', message: `the folder has more than ${maxFiles} files` };
            return;
          }
          await options.beforeCopy?.(relPath);
          const res = await copyRegularFile({
            src: abs,
            root: source.root,
            expect: st,
            dest: path.join(destDir, name),
            remaining: options.maxBytes - size,
            secrets: options.secrets,
          });
          if (res.ok) {
            size += res.written;
            fileCount++;
          } else if (res.reason === 'size_limit') {
            failure.value = { ok: false, reason: 'size_limit', message: `the content exceeds the size limit of ${options.maxBytes} bytes` };
            return;
          } else {
            skip({ path: relPath, reason: res.reason === 'error' ? 'error' : res.reason });
          }
        } else {
          skip({ path: relPath, reason: 'not_regular_file' });
        }
      }
    };
    await visit(source.abs, dest, []);
    if (failure.value) return failure.value;
    if (fileCount === 0) return { ok: false, reason: 'empty', message: 'the folder contains no regular files' };
    return { ok: true, kind: 'folder', fileName: source.name, size, fileCount, skipped, skippedCount };
  } catch (err) {
    return { ok: false, reason: 'error', message: errorMessage(err) };
  }
}

function copyMessage(reason: string, message: string | undefined): string {
  switch (reason) {
    case 'size_limit':
      return 'the content exceeds the size limit';
    case 'symlink':
      return 'the file is a symbolic link';
    case 'hardlink':
      return 'the file has several hard links and is not copied';
    case 'outside_workspace':
      return 'the file resolves outside the workspace';
    case 'changed':
    case 'not_regular_file':
      return 'the file changed while it was collected or is not a regular file';
    default:
      return message ?? 'the file could not be copied';
  }
}
