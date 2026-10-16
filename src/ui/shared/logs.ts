/**
 * Paged log window of the run detail (Spec §16: only load the required
 * ranges, never a whole 100 MB log). Pure state: which byte range
 * `[start, end)` of the log file is loaded, and the loaded text. The text is
 * capped at `maxChars`; when it grows beyond, the opposite side is trimmed at
 * a line boundary and the range adjusted, so the DOM never holds more than
 * about `maxChars` characters.
 */

/** Page as returned by `GET /api/v1/runs/:id/logs` (subset). */
export interface LogPageLike {
  offset: number;
  /** Bytes in `data`. */
  length: number;
  nextOffset: number;
  size: number;
  eof: boolean;
  exists: boolean;
  data: string;
}

/** Default page size (bytes) requested by the UI. */
export const LOG_PAGE_BYTES = 64 * 1024;
/** Default cap of characters kept in the log view. */
export const LOG_MAX_CHARS = 1024 * 1024;

const encoder = new TextEncoder();
/** UTF-8 byte length of `s`. */
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

/** See module comment. */
export class LogWindow {
  /** First loaded byte offset. */
  start = 0;
  /** Byte offset after the last loaded byte. */
  end = 0;
  /** Last known file size. */
  size = 0;
  exists = false;
  /** Number of times text was trimmed (for the UI hint). */
  trimmed = false;
  private chunks: string[] = [];
  private chars = 0;

  constructor(
    readonly pageBytes = LOG_PAGE_BYTES,
    readonly maxChars = LOG_MAX_CHARS,
  ) {}

  /** Loaded text. */
  get text(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] ?? '';
  }

  /** True if bytes before `start` exist. */
  get hasEarlier(): boolean {
    return this.start > 0;
  }

  /** True if the file has bytes after `end` (as of the last known size). */
  get hasLater(): boolean {
    return this.end < this.size;
  }

  /** Query for the initial view: the last page (`tail`). */
  tailQuery(): { tail: number } {
    return { tail: this.pageBytes };
  }

  /** Query for the page before `start`, `null` if at the beginning. */
  earlierQuery(): { offset: number; limit: number } | null {
    if (this.start <= 0) return null;
    const offset = Math.max(0, this.start - this.pageBytes);
    return { offset, limit: this.start - offset };
  }

  /** Query for the bytes after `end` (follow / load newer). */
  laterQuery(): { offset: number; limit: number } {
    return { offset: this.end, limit: this.pageBytes };
  }

  /** Replace the window with `page` (initial load / resync). */
  reset(page: LogPageLike): void {
    this.chunks = page.data ? [page.data] : [];
    this.chars = page.data.length;
    this.start = page.offset;
    this.end = page.offset + page.length;
    this.size = page.size;
    this.exists = page.exists;
    this.trimmed = false;
    this.trimStart();
  }

  /**
   * Prepend a page that ends at `start`. Returns false if the page does not
   * fit (range moved meanwhile) – the caller should reload.
   */
  prepend(page: LogPageLike): boolean {
    if (page.offset + page.length !== this.start) return false;
    this.chunks = [page.data + this.text];
    this.chars += page.data.length;
    this.start = page.offset;
    this.size = Math.max(this.size, page.size);
    this.trimEnd();
    return true;
  }

  /**
   * Append a page that starts at `end`. Returns false if it does not fit.
   * The beginning is trimmed if the window grows beyond `maxChars`.
   */
  append(page: LogPageLike): boolean {
    this.size = Math.max(this.size, page.size);
    this.exists = this.exists || page.exists;
    if (page.offset !== this.end) return false;
    if (page.length > 0) {
      this.chunks.push(page.data);
      this.chars += page.data.length;
      this.end = page.offset + page.length;
    }
    this.trimStart();
    return true;
  }

  private trimStart(): void {
    if (this.chars <= this.maxChars) return;
    const text = this.text;
    let cut = text.length - this.maxChars;
    const nl = text.indexOf('\n', cut);
    if (nl >= 0 && nl - cut < 4096) cut = nl + 1;
    const dropped = text.slice(0, cut);
    this.chunks = [text.slice(cut)];
    this.chars = text.length - cut;
    this.start += utf8Length(dropped);
    this.trimmed = true;
  }

  private trimEnd(): void {
    if (this.chars <= this.maxChars) return;
    const text = this.text;
    let keep = this.maxChars;
    const nl = text.lastIndexOf('\n', keep);
    if (nl > 0 && keep - nl < 4096) keep = nl + 1;
    const dropped = text.slice(keep);
    this.chunks = [text.slice(0, keep)];
    this.chars = keep;
    this.end -= utf8Length(dropped);
    this.trimmed = true;
  }
}
