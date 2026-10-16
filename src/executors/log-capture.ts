/**
 * Capture of one output stream (stdout or stderr) of a worker (Spec §9.3, §5.1, §12):
 * raw bytes → secret redaction → log file (size limit) + live output
 * listeners + event line parser.
 *
 * - The log file receives the bytes unchanged except for redacted secrets.
 * - The size limit is a per-run budget shared by stdout and stderr
 *   ({@link LogBudget}, Spec §5.1 `max_log_size_per_run`). When a stream hits
 *   it, that stream's file is not written any further and a single
 *   `log_truncated` diagnostic naming the stream is emitted (no silent overwrite).
 * - Write errors produce a `log_write_error` diagnostic; the log is then
 *   reported as incomplete (`truncated`), never as complete.
 * - Backpressure only comes from the file: {@link StreamCapture.push}
 *   returns `false` when the file stream's buffer is full, and the caller
 *   pauses the source until `onDrain`. Listeners never block (see Dispatcher).
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Clock, ExecutorDiagnostic, OutputChunk } from '../core/index.js';
import { EventLineParser } from './event-parser.js';
import type { StreamRedactor } from './stream-redactor.js';

/** Byte budget shared by all log streams of one run. */
export class LogBudget {
  private used = 0;

  constructor(readonly limit: number | undefined) {}

  /** Reserve up to `bytes`; returns how many bytes may be written. */
  take(bytes: number): number {
    if (this.limit === undefined) return bytes;
    const granted = Math.max(0, Math.min(bytes, this.limit - this.used));
    this.used += granted;
    return granted;
  }
}

/** Sinks for everything a capture produces. */
export interface CaptureSinks {
  output(chunk: OutputChunk): void;
  event(type: string, data: Record<string, unknown>, stream: 'stdout' | 'stderr'): void;
  diagnostic(diagnostic: ExecutorDiagnostic): void;
}

export interface StreamCaptureOptions {
  stream: 'stdout' | 'stderr';
  /** Log file path; `undefined` disables file output (e.g. directory could not be created). */
  filePath: string | undefined;
  /** Error that prevented opening the file, reported as `log_write_error`. */
  openError?: Error;
  /** Shared per-run budget (default: unlimited). */
  budget?: LogBudget;
  redactor: StreamRedactor;
  clock: Clock;
  sinks: CaptureSinks;
}

export class StreamCapture {
  private readonly stream: 'stdout' | 'stderr';
  private readonly decoder = new StringDecoder('utf8');
  private readonly parser: EventLineParser;
  private readonly file: WriteStream | undefined;
  private accepted = 0;
  private limitReached = false;
  private writeFailed = false;
  private drainWaiter: (() => void) | undefined;
  private closed: Promise<void>;

  constructor(private readonly opts: StreamCaptureOptions) {
    this.stream = opts.stream;
    this.parser = new EventLineParser({
      onEvent: (type, data) => opts.sinks.event(type, data, this.stream),
      onInvalid: (error, preview) =>
        opts.sinks.diagnostic({
          type: 'event_parse_warning',
          at: opts.clock.now(),
          stream: this.stream,
          message: `invalid worker event line: ${error}`,
          details: { line: preview },
        }),
    });
    if (opts.openError || opts.filePath === undefined) {
      this.fail(opts.openError ?? new Error('log file unavailable'));
      this.closed = Promise.resolve();
      return;
    }
    const file = createWriteStream(opts.filePath, { flags: 'w', mode: 0o600 });
    this.file = file;
    this.closed = new Promise((resolve) => file.once('close', () => resolve()));
    file.on('error', (err) => this.fail(err));
  }

  /** Bytes handed to the log file (after redaction, within the limit). */
  get bytesWritten(): number {
    return this.file ? Math.min(this.file.bytesWritten, this.accepted) : 0;
  }

  /** True if the persisted log is incomplete (size limit or write error). */
  get truncated(): boolean {
    return this.limitReached || this.writeFailed;
  }

  /**
   * Feed raw bytes. Returns `false` if the source should pause until
   * `onDrain` is called (file buffer full).
   */
  push(raw: Buffer, onDrain: () => void): boolean {
    return this.handle(this.opts.redactor.push(raw), onDrain);
  }

  /** Flush buffered data, close the file and wait until it is closed. */
  async end(): Promise<void> {
    this.handle(this.opts.redactor.flush(), () => {});
    const tail = this.decoder.end();
    if (tail) this.deliverText(tail);
    this.parser.flush();
    if (this.file && !this.file.closed && !this.file.destroyed) this.file.end();
    await this.closed;
  }

  private handle(data: Buffer, onDrain: () => void): boolean {
    if (data.length === 0) return true;
    const text = this.decoder.write(data);
    if (text) this.deliverText(text);
    return this.writeFile(data, onDrain);
  }

  private deliverText(text: string): void {
    this.opts.sinks.output({ stream: this.stream, data: text, at: this.opts.clock.now() });
    this.parser.push(text);
  }

  private writeFile(data: Buffer, onDrain: () => void): boolean {
    if (!this.file || this.writeFailed || this.limitReached) return true;
    let chunk = data;
    const budget = this.opts.budget;
    const granted = budget ? budget.take(chunk.length) : chunk.length;
    if (granted < chunk.length) {
      chunk = chunk.subarray(0, granted);
      this.limitReached = true;
      this.opts.sinks.diagnostic({
        type: 'log_truncated',
        at: this.opts.clock.now(),
        stream: this.stream,
        message: `run log limit of ${budget?.limit} bytes reached while writing ${this.stream}; further ${this.stream} output is not persisted`,
        details: { limitBytes: budget?.limit, stream: this.stream },
      });
    }
    if (chunk.length === 0) return true;
    this.accepted += chunk.length;
    const ok = this.file.write(chunk);
    if (ok) return true;
    this.drainWaiter = onDrain;
    this.file.once('drain', () => this.releaseDrain());
    return false;
  }

  private releaseDrain(): void {
    const waiter = this.drainWaiter;
    this.drainWaiter = undefined;
    waiter?.();
  }

  private fail(err: Error): void {
    if (this.writeFailed) return;
    this.writeFailed = true;
    this.opts.sinks.diagnostic({
      type: 'log_write_error',
      at: this.opts.clock.now(),
      stream: this.stream,
      message: `${this.stream} log could not be written; the persisted log is incomplete: ${err.message}`,
      details: { code: (err as NodeJS.ErrnoException).code, path: this.opts.filePath },
    });
    // 'drain' will never come after an error; do not leave the source paused.
    this.releaseDrain();
  }
}
