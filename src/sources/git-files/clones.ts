/**
 * Clones of `git_files` sources that are no longer configured (WI-40): a
 * source removed or renamed in `sources.yaml` leaves `<data-dir>/sources/<id>/`
 * behind. They are only reported, never deleted automatically (a run may
 * still reference the old source; the operator decides).
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Folders below `clonesDir` that hold a git clone but belong to none of `sourceIds` (sorted). */
export async function findOrphanedClones(clonesDir: string, sourceIds: Iterable<string>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(clonesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const known = new Set(sourceIds);
  const out: string[] = [];
  for (const name of names.sort()) {
    if (known.has(name)) continue;
    try {
      if ((await stat(path.join(clonesDir, name, '.git'))).isDirectory()) out.push(name);
    } catch {
      // Not a clone (or unreadable): not ours to report.
    }
  }
  return out;
}
