/**
 * The artifact input of a run (WI-35): the stored content is copied
 * read-only into the workspace below `inputs/<name>`. Files get mode 0444,
 * directories 0555 (also `inputs/` itself), so tools cannot change the input
 * by accident. {@link makeTreeWritable} undoes this before a workspace is
 * deleted (a read-only directory cannot be emptied).
 */
import { chmod, copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_INPUT_DIR } from '../core/index.js';
import { ArtifactError } from './errors.js';

/** Make every directory below `root` (and `root` itself) writable again; never follows symlinks; never throws. */
export async function makeTreeWritable(root: string): Promise<void> {
  const st = await lstat(root).catch(() => null);
  if (!st?.isDirectory()) return;
  await chmod(root, 0o755).catch(() => undefined);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) await makeTreeWritable(path.join(root, name));
}

/** Copy `src` (a stored file or folder) to `dest` with read-only modes; directories are locked bottom-up. */
async function copyReadOnly(src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isDirectory()) {
    await mkdir(dest, { mode: 0o700 });
    for (const name of (await readdir(src)).sort()) await copyReadOnly(path.join(src, name), path.join(dest, name));
    await chmod(dest, 0o555);
  } else if (st.isFile()) {
    await copyFile(src, dest);
    await chmod(dest, 0o444);
  } else {
    throw new ArtifactError('artifact_corrupt', `stored artifact contains an unsupported entry: ${path.basename(src)}`);
  }
}

/**
 * Copy the stored `content` of an artifact to `<workspace>/inputs/<name>`.
 * An existing `inputs/<name>` of an earlier run in the same workspace is replaced.
 * The workspace directory must exist; `inputs/` is created if needed.
 *
 * @throws ArtifactError (`artifact_corrupt`), fs errors
 */
export async function stageArtifactInput(workspace: string, name: string, content: string): Promise<string> {
  const inputs = path.join(workspace, ARTIFACT_INPUT_DIR);
  const existing = await lstat(inputs).catch(() => null);
  if (existing && !existing.isDirectory()) {
    throw new ArtifactError('artifact_input_blocked', `"${ARTIFACT_INPUT_DIR}" in the workspace exists and is not a directory`);
  }
  if (existing) await makeTreeWritable(inputs);
  else await mkdir(inputs, { mode: 0o755 });
  const target = path.join(inputs, name);
  await rm(target, { recursive: true, force: true });
  try {
    await copyReadOnly(content, target);
  } catch (err) {
    await makeTreeWritable(target);
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await chmod(inputs, 0o555);
  return target;
}
