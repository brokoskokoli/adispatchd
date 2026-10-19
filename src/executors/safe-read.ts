/**
 * Hardened reading of files a worker controls (result file, WI-19 review):
 * the worker – or a container with a writable output mount – can replace the
 * file with a symlink (to a host file or another run's result) or a FIFO.
 *
 * - `lstat`: symlinks and non-regular files are refused;
 * - the real path of the directory must equal (or lie inside) the expected directory;
 * - `open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, `fstat` on the handle: regular
 *   file, same device/inode as the `lstat`, size within the limit;
 * - content is read from the handle only (never by path again).
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, isWithin, MAX_RESULT_FILE_BYTES } from '../core/index.js';

/** Result of {@link readFileNoFollow}. */
export type SafeReadResult = { state: 'missing' } | { state: 'invalid'; error: string } | { state: 'ok'; text: string };

/**
 * Read `file` without following symlinks. `dir` is the directory the file
 * must really lie in (default: its own directory as given).
 */
export async function readFileNoFollow(
  file: string,
  options: { dir?: string; maxBytes?: number; what?: string } = {},
): Promise<SafeReadResult> {
  const what = options.what ?? 'result file';
  const maxBytes = options.maxBytes ?? MAX_RESULT_FILE_BYTES;
  let before;
  try {
    before = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', error: `${what} could not be read: ${errorMessage(err)}` };
  }
  if (before.isSymbolicLink()) return { state: 'invalid', error: `${what} is a symbolic link (refused)` };
  if (!before.isFile()) return { state: 'invalid', error: `${what} is not a regular file` };
  if (before.size > maxBytes) return { state: 'invalid', error: `${what} exceeds ${maxBytes} bytes` };
  try {
    const [realDir, realExpected] = await Promise.all([realpath(path.dirname(file)), realpath(options.dir ?? path.dirname(file))]);
    if (!isWithin(realExpected, realDir)) return { state: 'invalid', error: `${what} lies outside its directory (refused)` };
  } catch (err) {
    return { state: 'invalid', error: `${what} could not be read: ${errorMessage(err)}` };
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'missing' };
    if (code === 'ELOOP') return { state: 'invalid', error: `${what} is a symbolic link (refused)` };
    return { state: 'invalid', error: `${what} could not be read: ${errorMessage(err)}` };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { state: 'invalid', error: `${what} is not a regular file` };
    if (st.dev !== before.dev || st.ino !== before.ino) return { state: 'invalid', error: `${what} was replaced while reading (refused)` };
    if (st.size > maxBytes) return { state: 'invalid', error: `${what} exceeds ${maxBytes} bytes` };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) return { state: 'invalid', error: `${what} exceeds ${maxBytes} bytes` };
    }
    return { state: 'ok', text: buffer.subarray(0, length).toString('utf8') };
  } catch (err) {
    return { state: 'invalid', error: `${what} could not be read: ${errorMessage(err)}` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
