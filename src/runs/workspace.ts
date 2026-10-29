/**
 * Workspace cleanup after a run (Spec §5.1 `workspace.cleanup`, §9, §20):
 * only directories strictly below `workspace.base_dir` are ever deleted.
 */
import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isWithin, resolveStrictlyWithin, type BusinessResult, type TerminalStatus } from '../core/index.js';
import type { WorkspaceCleanup } from '../config/index.js';
import { makeTreeWritable } from '../artifacts/index.js';

/** True if the policy asks to delete the workspace of a run with this outcome. */
export function shouldCleanupWorkspace(policy: WorkspaceCleanup, status: TerminalStatus, businessResult: BusinessResult): boolean {
  switch (policy) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'on_success':
      return status === 'completed' && businessResult === 'success';
  }
}

/** Outcome of {@link removeWorkspace}. */
export type WorkspaceRemoval =
  | { removed: true; path: string }
  | { removed: false; path: string; reason: 'missing' | 'outside_base_dir' | 'symlink' | 'error'; message?: string };

/**
 * Delete the run workspace `workspacePath` if – lexically AND after resolving
 * symlinks of its parents – it lies strictly below `baseDir`. A workspace
 * that is itself a symlink is never followed or deleted. Never throws.
 */
export async function removeWorkspace(baseDir: string, workspacePath: string): Promise<WorkspaceRemoval> {
  let target: string;
  try {
    target = resolveStrictlyWithin(baseDir, workspacePath);
  } catch (err) {
    return { removed: false, path: workspacePath, reason: 'outside_base_dir', message: (err as Error).message };
  }
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) return { removed: false, path: target, reason: 'symlink' };
    const [realBase, realTarget] = await Promise.all([realpath(baseDir), realpath(target)]);
    if (!isWithin(realBase, realTarget) || path.resolve(realBase) === path.resolve(realTarget)) {
      return { removed: false, path: target, reason: 'outside_base_dir', message: `resolves to ${realTarget}` };
    }
    // `rm` does not follow symlinks inside the tree; it removes the links themselves.
    try {
      await rm(realTarget, { recursive: true, force: true });
    } catch (err) {
      // The read-only artifact input (WI-35, `inputs/`) cannot be emptied: make the directories writable and retry once.
      if ((err as NodeJS.ErrnoException).code !== 'EACCES' && (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      await makeTreeWritable(realTarget);
      await rm(realTarget, { recursive: true, force: true });
    }
    return { removed: true, path: target };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { removed: false, path: target, reason: 'missing' };
    return { removed: false, path: target, reason: 'error', message: (err as Error).message };
  }
}
