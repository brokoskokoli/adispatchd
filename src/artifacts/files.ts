/**
 * Safe access to the stored content of an artifact (WI-35), the same rules as
 * the kept files of a run (WI-22): the requested path is validated segment by
 * segment, every existing component is checked with `lstat` (symlinks are
 * refused), the real path must lie inside the real content directory and the
 * file is opened with `O_NOFOLLOW` and must be a regular file.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isWithin, type ArtifactKind } from '../core/index.js';
import { ArtifactError } from './errors.js';

/** Max. length of a requested artifact file path. */
const MAX_PATH_LENGTH = 4096;
/** Max. files listed for one artifact. */
export const ARTIFACT_LIST_LIMIT = 10_000;

/** One stored file. */
export interface ArtifactFile {
  /** Path relative to the artifact (`/`-separated; the file name for a file artifact). */
  path: string;
  size: number;
}

/** Validate a requested `/`-separated path and return its segments. @throws ArtifactError `artifact_invalid_path` */
export function artifactPathSegments(raw: string): string[] {
  const invalid = (): ArtifactError => new ArtifactError('artifact_invalid_path', 'Invalid file path');
  if (raw === '' || raw.length > MAX_PATH_LENGTH) throw invalid();
  const segments = raw.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0')) throw invalid();
  }
  return segments;
}

/** An opened artifact file. */
export interface OpenedArtifactFile {
  handle: FileHandle;
  size: number;
  name: string;
}

/**
 * Open a file of an artifact for reading. `content` is the stored content path
 * (`artifacts/<id>/content`): the file itself for `kind: file` (requested as
 * `[fileName]`), the folder for `kind: folder`.
 * @throws ArtifactError `artifact_file_not_found`
 */
export async function openArtifactFile(
  content: string,
  kind: ArtifactKind,
  fileName: string,
  segments: readonly string[],
): Promise<OpenedArtifactFile> {
  const notFound = (): ArtifactError => new ArtifactError('artifact_file_not_found', 'File not found in the artifact');
  let target: string;
  let base: string;
  if (kind === 'file') {
    if (segments.length !== 1 || segments[0] !== fileName) throw notFound();
    target = path.resolve(content);
    base = path.dirname(target);
  } else {
    base = path.resolve(content);
    target = base;
  }
  let realBase: string;
  try {
    realBase = await realpath(base);
    if (kind === 'folder') {
      const st = await lstat(base);
      if (!st.isDirectory()) throw notFound();
    }
  } catch {
    throw notFound();
  }
  if (kind === 'folder') {
    let current = base;
    for (const segment of segments) {
      current = path.join(current, segment);
      let st;
      try {
        st = await lstat(current);
      } catch {
        throw notFound();
      }
      if (st.isSymbolicLink()) throw notFound();
    }
    if (!isWithin(base, current)) throw notFound();
    target = current;
  } else {
    try {
      if ((await lstat(target)).isSymbolicLink()) throw notFound();
    } catch {
      throw notFound();
    }
  }
  let handle: FileHandle;
  try {
    const real = await realpath(target);
    if (!isWithin(realBase, real) || real === realBase) throw notFound();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw notFound();
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw notFound();
    return { handle, size: st.size, name: segments[segments.length - 1] as string };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err instanceof ArtifactError ? err : notFound();
  }
}

/**
 * List the regular files of an artifact (sorted, symlinks ignored), at most
 * `limit` entries. A missing content yields an empty list.
 */
export async function listArtifactFiles(
  content: string,
  kind: ArtifactKind,
  fileName: string,
  limit = ARTIFACT_LIST_LIMIT,
): Promise<{ files: ArtifactFile[]; truncated: boolean }> {
  if (kind === 'file') {
    const st = await lstat(content).catch(() => null);
    return { files: st?.isFile() ? [{ path: fileName, size: st.size }] : [], truncated: false };
  }
  const files: ArtifactFile[] = [];
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
        const st = await lstat(abs).catch(() => null);
        if (st?.isFile()) files.push({ path: [...rel, e.name].join('/'), size: st.size });
      }
    }
  };
  await visit(content, []);
  return { files, truncated };
}
