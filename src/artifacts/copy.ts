/**
 * Safe copy primitives for artifacts (WI-35), the same rules as the kept
 * files of a run (WI-22, `runs/keep.ts`): a file is opened with `O_NOFOLLOW`,
 * its identity (dev/inode) must equal the one seen while walking, its real
 * path must lie inside the real workspace, secrets are redacted while
 * copying and the written bytes are capped.
 */
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorMessage, isWithin } from '../core/index.js';
import { StreamRedactor } from '../executors/index.js';

/** Why a file could not be copied. */
export type CopyFailure = 'symlink' | 'not_regular_file' | 'changed' | 'outside_workspace' | 'size_limit' | 'error';

/** Result of {@link copyRegularFile}. */
export type CopyResult = { ok: true; written: number } | { ok: false; reason: CopyFailure; message?: string };

/** Thrown inside the copy pipeline when the written bytes exceed the budget. */
class SizeLimitExceeded extends Error {}

/** Redacts secrets (chunk-boundary safe) and fails once more than `limit` bytes would be written. */
class RedactingCounter extends Transform {
  written = 0;
  private readonly redactor: StreamRedactor;

  constructor(
    secrets: readonly string[],
    private readonly limit: number,
  ) {
    super();
    this.redactor = new StreamRedactor(secrets);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.forward(this.redactor.push(chunk), cb);
  }

  override _flush(cb: TransformCallback): void {
    this.forward(this.redactor.flush(), cb);
  }

  private forward(out: Buffer, cb: TransformCallback): void {
    this.written += out.length;
    if (this.written > this.limit) {
      cb(new SizeLimitExceeded('size limit'));
      return;
    }
    cb(null, out);
  }
}

/** Options of {@link copyRegularFile}. */
export interface CopyFileOptions {
  /** Absolute path of the source file. */
  src: string;
  /** Real workspace directory the source must stay inside. */
  root: string;
  /** Identity of the file as seen by `lstat` while walking. */
  expect: { dev: number; ino: number };
  /** Absolute destination (must not exist). */
  dest: string;
  /** Max. bytes that may still be written. */
  remaining: number;
  secrets: readonly string[];
}

/** Copy one regular file; never throws. A partial destination is removed on failure. */
export async function copyRegularFile(options: CopyFileOptions): Promise<CopyResult> {
  const { src, root, expect, dest, remaining, secrets } = options;
  let handle: FileHandle;
  try {
    handle = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, reason: 'symlink' };
    if (code === 'ENOENT') return { ok: false, reason: 'changed' };
    return { ok: false, reason: 'error', message: errorMessage(err) };
  }
  let created = false;
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: 'not_regular_file' };
    if (st.dev !== expect.dev || st.ino !== expect.ino) return { ok: false, reason: 'changed' };
    if (!isWithin(root, await realpath(src))) return { ok: false, reason: 'outside_workspace' };
    // Without secrets the written size equals the source size; with secrets it is checked while writing.
    if (secrets.length === 0 && st.size > remaining) return { ok: false, reason: 'size_limit' };
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const counter = new RedactingCounter(secrets, remaining);
    created = true;
    const out = createWriteStream(dest, { flags: 'wx', mode: 0o600 });
    // Copy exactly the size seen at open time (a file growing meanwhile is cut).
    const input = st.size === 0 ? Readable.from([]) : createReadStream('', { fd: handle, start: 0, end: st.size - 1, autoClose: false });
    await pipeline(input, counter, out);
    return { ok: true, written: counter.written };
  } catch (err) {
    if (created) await rm(dest, { force: true }).catch(() => undefined);
    if (err instanceof SizeLimitExceeded) return { ok: false, reason: 'size_limit' };
    return { ok: false, reason: 'error', message: errorMessage(err) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
