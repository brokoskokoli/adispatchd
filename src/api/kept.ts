/**
 * Safe access to the kept files of a run (`runs/<run-id>/kept/`, WI-22).
 *
 * The requested path is validated segment by segment (no empty, `.`/`..`
 * segments, no backslash, no NUL), every existing component is checked with
 * `lstat` (symlinks are refused), the real path must lie inside the real
 * `kept/` directory and the file is opened with `O_NOFOLLOW` and must be a
 * regular file. Downloads are always served as attachment.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from '../core/index.js';
import { ApiError } from './errors.js';

/** Max. length of a requested kept path. */
const MAX_KEPT_PATH_LENGTH = 4096;

/** Validate a requested `/`-separated path and return its segments. @throws ApiError 400 */
export function keptPathSegments(raw: string): string[] {
  if (raw === '' || raw.length > MAX_KEPT_PATH_LENGTH) throw new ApiError(400, 'invalid_path', 'Invalid file path');
  const segments = raw.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0')) {
      throw new ApiError(400, 'invalid_path', 'Invalid file path');
    }
  }
  return segments;
}

/** An opened kept file. */
export interface OpenedKeptFile {
  handle: FileHandle;
  size: number;
  name: string;
}

/**
 * Open `kept/<segments…>` for reading (see module docs).
 * @throws ApiError 404 when missing or not a safe regular file
 */
export async function openKeptFile(keptDir: string, segments: readonly string[]): Promise<OpenedKeptFile> {
  const notFound = (): ApiError => new ApiError(404, 'not_found', 'Kept file not found');
  let realBase: string;
  try {
    const baseStat = await lstat(keptDir);
    if (!baseStat.isDirectory()) throw notFound();
    realBase = await realpath(keptDir);
  } catch {
    throw notFound();
  }
  let current = path.resolve(keptDir);
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
  if (!isWithin(path.resolve(keptDir), current)) throw notFound();
  let handle: FileHandle;
  try {
    const real = await realpath(current);
    if (!isWithin(realBase, real) || real === realBase) throw notFound();
    handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw notFound();
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw notFound();
    return { handle, size: st.size, name: segments[segments.length - 1] as string };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err instanceof ApiError ? err : notFound();
  }
}

const TEXT_TYPES: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

/**
 * Content type by extension. Anything that a browser could execute (HTML,
 * SVG, JS …) or that is unknown is served as `application/octet-stream`.
 */
export function keptContentType(name: string): string {
  return TEXT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** `Content-Disposition: attachment` with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
