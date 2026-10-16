/**
 * Paged access to run log files (Spec §15, §16): byte offsets per stream,
 * bounded page size, tail mode. Never reads a whole (up to 100 MB) file.
 *
 * Pages are cut at UTF-8 character boundaries: an incomplete multi-byte
 * sequence at the end of a page is left for the next page, and a page that
 * starts inside a sequence (tail mode) skips the continuation bytes.
 */
import { open, stat } from 'node:fs/promises';

/** Default page size. */
export const DEFAULT_LOG_PAGE_BYTES = 64 * 1024;
/** Max page size per request. */
export const MAX_LOG_PAGE_BYTES = 1024 * 1024;

/** One page of a log stream. */
export interface LogPage {
  stream: 'stdout' | 'stderr';
  /** Byte offset of `data` in the file. */
  offset: number;
  /** Byte length of `data`. */
  length: number;
  /** Offset to request next (`offset + length`). */
  nextOffset: number;
  /** Current file size in bytes (0 if the file does not exist). */
  size: number;
  /** True if `nextOffset` reached the current end of the file. */
  eof: boolean;
  /** False if the log file does not exist (yet). */
  exists: boolean;
  data: string;
}

/**
 * Read a page. `tail` (bytes) reads the last bytes of the file and takes
 * precedence over `offset`.
 */
export async function readLogPage(
  file: string,
  stream: 'stdout' | 'stderr',
  options: { offset?: number; limit?: number; tail?: number } = {},
): Promise<LogPage> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LOG_PAGE_BYTES)), MAX_LOG_PAGE_BYTES);
  let size: number;
  try {
    const st = await stat(file);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    size = st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { stream, offset: 0, length: 0, nextOffset: 0, size: 0, eof: true, exists: false, data: '' };
    }
    throw err;
  }
  let offset: number;
  let length: number;
  if (options.tail !== undefined) {
    const tail = Math.min(Math.max(0, Math.floor(options.tail)), MAX_LOG_PAGE_BYTES);
    offset = Math.max(0, size - tail);
    length = size - offset;
  } else {
    offset = Math.min(Math.max(0, Math.floor(options.offset ?? 0)), size);
    length = Math.min(limit, size - offset);
  }
  if (length === 0) return { stream, offset, length: 0, nextOffset: offset, size, eof: offset >= size, exists: true, data: '' };

  const handle = await open(file, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  // Skip leading continuation bytes (page started inside a character) – only when not at the start of the file.
  let start = 0;
  if (offset > 0) while (start < buf.length && start < 3 && isContinuation(buf[start] as number)) start++;
  // Leave an incomplete trailing sequence for the next page; if the page consists of nothing
  // else and it is the end of the file (invalid trailing bytes), return it anyway so readers progress.
  let end = completeLength(buf, start);
  if (end <= start && buf.length > start && offset + buf.length >= size) end = buf.length;
  const data = buf.subarray(start, end).toString('utf8');
  const pageOffset = offset + start;
  const pageLength = end - start;
  const nextOffset = pageOffset + pageLength;
  return { stream, offset: pageOffset, length: pageLength, nextOffset, size, eof: nextOffset >= size, exists: true, data };
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Length of `buf` without an incomplete UTF-8 sequence at the end. */
function completeLength(buf: Buffer, start: number): number {
  const n = buf.length;
  // Find the start byte of the last (possibly incomplete) sequence within the last 4 bytes.
  for (let i = n - 1; i >= Math.max(start, n - 4); i--) {
    const byte = buf[i] as number;
    if (isContinuation(byte)) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return i + need <= n ? n : i;
  }
  return n;
}
