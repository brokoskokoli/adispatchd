/**
 * Minimal streaming ZIP writer for folder downloads (WI-35, no dependency).
 *
 * Every file is deflated (`zlib`) while it is read; sizes and the CRC-32 follow
 * the data in a data descriptor, so nothing is buffered. The writer does not
 * support ZIP64: the total size must stay below {@link ZIP_MAX_BYTES} and there
 * can be at most 65 535 entries (callers check; artifacts are capped far below).
 * Names are UTF-8 (general purpose flag bit 11).
 */
import { crc32, createDeflateRaw } from 'node:zlib';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** Total uncompressed bytes a ZIP written by {@link zipStream} may hold (no ZIP64). */
export const ZIP_MAX_BYTES = 0xffffffff - 64 * 1024 * 1024;
/** Max. entries (no ZIP64). */
export const ZIP_MAX_ENTRIES = 0xffff;

/** One file of the archive. */
export interface ZipEntry {
  /** `/`-separated path inside the archive. */
  name: string;
  size: number;
  /** Opens the file; the handle is closed by the writer. */
  open: () => Promise<FileHandle>;
}

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const FLAGS = 0x0808; // data descriptor + UTF-8 names
const VERSION = 20;
const METHOD_DEFLATE = 8;

/** MS-DOS date and time (local fields of the given instant, taken as UTC to be reproducible). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function localHeader(name: Buffer, dos: { time: number; date: number }): Buffer {
  const b = Buffer.alloc(30 + name.length);
  b.writeUInt32LE(LOCAL_SIGNATURE, 0);
  b.writeUInt16LE(VERSION, 4);
  b.writeUInt16LE(FLAGS, 6);
  b.writeUInt16LE(METHOD_DEFLATE, 8);
  b.writeUInt16LE(dos.time, 10);
  b.writeUInt16LE(dos.date, 12);
  // CRC-32 and sizes (14..25) follow in the data descriptor.
  b.writeUInt16LE(name.length, 26);
  name.copy(b, 30);
  return b;
}

function descriptor(crc: number, compressed: number, size: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
  b.writeUInt32LE(crc >>> 0, 4);
  b.writeUInt32LE(compressed, 8);
  b.writeUInt32LE(size, 12);
  return b;
}

function centralHeader(name: Buffer, dos: { time: number; date: number }, crc: number, compressed: number, size: number, offset: number): Buffer {
  const b = Buffer.alloc(46 + name.length);
  b.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  b.writeUInt16LE((3 << 8) | VERSION, 4); // made by: Unix
  b.writeUInt16LE(VERSION, 6);
  b.writeUInt16LE(FLAGS, 8);
  b.writeUInt16LE(METHOD_DEFLATE, 10);
  b.writeUInt16LE(dos.time, 12);
  b.writeUInt16LE(dos.date, 14);
  b.writeUInt32LE(crc >>> 0, 16);
  b.writeUInt32LE(compressed, 20);
  b.writeUInt32LE(size, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: regular file, 0644
  b.writeUInt32LE(offset, 42);
  name.copy(b, 46);
  return b;
}

/**
 * Stream the archive of `entries`. `mtime` is stored for every entry. Throws
 * (aborting the stream) if a file cannot be opened or read.
 */
export async function* zipStream(entries: readonly ZipEntry[], mtime: Date): AsyncGenerator<Buffer> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new RangeError('too many entries for a ZIP archive without ZIP64');
  const dos = dosDateTime(mtime);
  const central: Buffer[] = [];
  let offset = 0;
  const emit = (chunk: Buffer): Buffer => {
    offset += chunk.length;
    return chunk;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const start = offset;
    yield emit(localHeader(name, dos));
    const handle = await entry.open();
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw();
    const input = entry.size === 0 ? null : createReadStream('', { fd: handle, start: 0, end: entry.size - 1, autoClose: false });
    try {
      if (input) {
        input.on('data', (chunk) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          crc = crc32(buf, crc);
          size += buf.length;
        });
        input.on('error', (err) => deflate.destroy(err));
        input.pipe(deflate);
      } else {
        deflate.end();
      }
      for await (const chunk of deflate) {
        const buf = chunk as Buffer;
        compressed += buf.length;
        yield emit(buf);
      }
    } finally {
      // Also when the consumer stops early or a read fails: release the streams before closing the file.
      deflate.destroy();
      input?.destroy();
      await handle.close().catch(() => undefined);
    }
    yield emit(descriptor(crc, compressed, size));
    central.push(centralHeader(name, dos, crc, compressed, size, start));
  }
  const centralStart = offset;
  for (const header of central) yield emit(header);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  yield emit(end);
}
