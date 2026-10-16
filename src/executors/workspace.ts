/**
 * Safe workspace creation below `workspace.base_dir` (Spec §9, §20).
 */
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isWithin, OrchestratorError, PathTraversalError, resolveStrictlyWithin } from '../core/index.js';

/**
 * Ensure `target` exists as a directory strictly below `baseDir` (never
 * `baseDir` itself). Directories are created one segment at a time and each
 * segment's real path is checked BEFORE anything is created below it, so a
 * symlink inside `baseDir` cannot cause directories to be created outside.
 * With `create: false` the existing directory is only verified.
 *
 * @throws PathTraversalError on lexical or symlink escapes
 */
export async function ensureWorkspaceWithin(baseDir: string, target: string, create: boolean): Promise<string> {
  const resolved = resolveStrictlyWithin(baseDir, target);
  if (create) await mkdir(baseDir, { recursive: true });
  const realBase = await realpath(baseDir);
  const segments = path.relative(path.resolve(baseDir), resolved).split(path.sep);
  let current = path.resolve(baseDir);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create) {
      try {
        await mkdir(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    const real = await realpath(current);
    if (!isWithin(realBase, real) || real === realBase) {
      throw new PathTraversalError(`Workspace "${target}" resolves outside "${baseDir}" via symlink`, {
        base: baseDir,
        path: target,
      });
    }
  }
  const st = await stat(resolved);
  if (!st.isDirectory()) throw new OrchestratorError('ENOTDIR', `working directory is not a directory: ${resolved}`);
  return resolved;
}
