/**
 * Path helpers with path-traversal protection (Spec §4, §9, §20) and the
 * canonical `data-dir` layout shared by persistence, executor, API and CLI.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { PathTraversalError } from './errors.js';

function assertNoNul(value: string, what: string): void {
  if (value.includes('\0')) throw new PathTraversalError(`${what} contains a NUL byte`);
}

/** Resolve `p` to a normalised absolute path (relative to `cwd`, default `process.cwd()`). */
export function toAbsolutePath(p: string, cwd: string = process.cwd()): string {
  assertNoNul(p, 'Path');
  if (p.trim() === '') throw new PathTraversalError('Path must not be empty');
  return path.resolve(cwd, p);
}

/** True when `target` equals `base` or lies below it (both are resolved first; purely lexical). */
export function isWithin(base: string, target: string): boolean {
  const b = path.resolve(base);
  const t = path.resolve(b, target);
  const rel = path.relative(b, t);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolve `rel` against the absolute directory `base` and guarantee that the
 * result stays inside `base` (or equals it).
 *
 * - `base` must be absolute; it is normalised.
 * - `rel` may be relative or absolute; an absolute `rel` is accepted only if it
 *   lies within `base`.
 * - `..` segments are allowed only as long as the normalised result stays inside.
 * - NUL bytes are rejected.
 *
 * The check is lexical; use {@link assertRealPathWithin} before destructive
 * operations on existing paths to also catch symlink escapes.
 *
 * @throws PathTraversalError
 */
export function resolveWithin(base: string, rel: string): string {
  assertNoNul(base, 'Base path');
  assertNoNul(rel, 'Path');
  if (!path.isAbsolute(base)) throw new PathTraversalError(`Base path must be absolute: ${base}`, { base });
  const normBase = path.resolve(base);
  const resolved = path.resolve(normBase, rel);
  if (!isWithin(normBase, resolved)) {
    throw new PathTraversalError(`Path "${rel}" escapes base directory "${normBase}"`, { base: normBase, path: rel });
  }
  return resolved;
}

/**
 * Like {@link resolveWithin}, but additionally requires the result to be
 * strictly below `base` (never `base` itself). Use for per-run directories
 * that may be deleted.
 */
export function resolveStrictlyWithin(base: string, rel: string): string {
  const resolved = resolveWithin(base, rel);
  if (resolved === path.resolve(base)) {
    throw new PathTraversalError(`Path "${rel}" must not be the base directory itself`, { base, path: rel });
  }
  return resolved;
}

/**
 * Verify (following symlinks) that the existing path `target` lies within the
 * existing directory `base`. Intended as a guard before deleting workspaces.
 *
 * @throws PathTraversalError if the real path escapes `base`
 */
export async function assertRealPathWithin(base: string, target: string): Promise<string> {
  const lexical = resolveWithin(base, target);
  const [realBase, realTarget] = await Promise.all([realpath(base), realpath(lexical)]);
  if (!isWithin(realBase, realTarget)) {
    throw new PathTraversalError(`Path "${target}" resolves outside "${base}" via symlink`, { base, path: target });
  }
  return realTarget;
}

/**
 * Validate a single path segment (file or directory name) without
 * transforming it: non-empty, no separators, not `.`/`..`, no NUL.
 *
 * @throws PathTraversalError
 */
export function assertSafeSegment(segment: string): string {
  assertNoNul(segment, 'Path segment');
  if (segment === '' || segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
    throw new PathTraversalError(`Unsafe path segment "${segment}"`, { segment });
  }
  return segment;
}

/** Maximum length of a sanitised path segment. */
export const MAX_SEGMENT_LENGTH = 128;

/**
 * Turn an arbitrary value into a single safe path segment: every character
 * outside `[A-Za-z0-9._@+=,-]` (including `/`, `\`, NUL, whitespace) becomes
 * `_`; a result consisting only of dots becomes underscores; empty becomes `_`;
 * length is capped at {@link MAX_SEGMENT_LENGTH}.
 */
export function sanitizeSegment(value: string): string {
  let out = value.replace(/[^A-Za-z0-9._@+=,-]/g, '_');
  if (/^\.*$/.test(out)) out = out.replace(/\./g, '_');
  if (out === '') out = '_';
  if (out.length > MAX_SEGMENT_LENGTH) out = out.slice(0, MAX_SEGMENT_LENGTH);
  return out;
}

/** Per-run file locations below `data-dir` (Spec §4). */
export interface RunPaths {
  /** `runs/<run-id>/` */
  runDir: string;
  /** `runs/<run-id>/context.json` (`ADISPATCH_CONTEXT_FILE`) */
  contextFile: string;
  /** `runs/<run-id>/result.json` (`ADISPATCH_RESULT_FILE`) */
  resultFile: string;
  /** `logs/<run-id>/` */
  logDir: string;
  /** `logs/<run-id>/stdout.log` */
  stdoutLog: string;
  /** `logs/<run-id>/stderr.log` */
  stderrLog: string;
}

/** Canonical `data-dir` layout (Spec §4). All paths are absolute. */
export interface DataPaths {
  dataDir: string;
  /** `adispatchd.sqlite` */
  database: string;
  /** Instance lock file next to the database. */
  instanceLock: string;
  /** `logs/` */
  logsDir: string;
  /** `runs/` */
  runsDir: string;
  /** Default `workspace.base_dir`: `workspaces/` */
  defaultWorkspacesDir: string;
  /** `backups/` */
  backupsDir: string;
  /** Paths of one run; `runId` must be a safe path segment. */
  run(runId: string): RunPaths;
}

/** Build the {@link DataPaths} for an (absolute or cwd-relative) `dataDir`. */
export function dataPaths(dataDir: string): DataPaths {
  const root = toAbsolutePath(dataDir);
  const logsDir = path.join(root, 'logs');
  const runsDir = path.join(root, 'runs');
  return {
    dataDir: root,
    database: path.join(root, 'adispatchd.sqlite'),
    instanceLock: path.join(root, 'adispatchd.lock'),
    logsDir,
    runsDir,
    defaultWorkspacesDir: path.join(root, 'workspaces'),
    backupsDir: path.join(root, 'backups'),
    run(runId: string): RunPaths {
      assertSafeSegment(runId);
      const runDir = path.join(runsDir, runId);
      const logDir = path.join(logsDir, runId);
      return {
        runDir,
        contextFile: path.join(runDir, 'context.json'),
        resultFile: path.join(runDir, 'result.json'),
        logDir,
        stdoutLog: path.join(logDir, 'stdout.log'),
        stderrLog: path.join(logDir, 'stderr.log'),
      };
    },
  };
}
