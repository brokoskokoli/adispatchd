/**
 * Best-effort, chunk-boundary-safe secret redaction for raw process output
 * (Spec §20.4, §24.8).
 *
 * Works on raw bytes: data is mapped 1:1 to a `latin1` string, so bytes that
 * are not part of a secret are passed through unchanged (also invalid UTF-8).
 *
 * Limits (documented, Spec §24.8): only exact occurrences of registered secret
 * values (and the `\n`-escaped form of multi-line values) are replaced.
 * Transformed secrets (base64, URL-encoded, reversed, split by other output,
 * printed character by character with interleaved bytes) are NOT detected. A
 * worker can always leak secrets it was given; reliable secrecy requires
 * trusted workers.
 */

/** Replacement marker for redacted secrets (same as the core logger). */
export const REDACTION_MARKER = '[REDACTED]';

/** Secrets shorter than this are ignored (too many false positives). */
export const MIN_STREAM_SECRET_LENGTH = 4;

/**
 * Redacts known secret values from a byte stream split into arbitrary chunks.
 *
 * Holds back the shortest possible tail: only bytes at the end of a chunk
 * that could be the beginning of a secret are withheld until the next chunk
 * (or {@link flush}). Output without such a tail is passed through immediately.
 */
export class StreamRedactor {
  /** Secrets as latin1 strings of their UTF-8 bytes, longest first. */
  private secrets: string[] = [];
  private carry = '';

  constructor(secretValues: Iterable<string>) {
    for (const value of secretValues) this.addValue(value);
    this.sort();
  }

  /**
   * Register a further secret (e.g. a renewed token, WI-18). Applies to data
   * pushed from now on; register a value before the process can know it.
   */
  add(value: string): void {
    if (this.addValue(value)) this.sort();
  }

  private addValue(value: string): boolean {
    if (typeof value !== 'string' || value.length < MIN_STREAM_SECRET_LENGTH) return false;
    const forms = [toLatin1(value)];
    if (value.includes('\n')) forms.push(toLatin1(value.replace(/\n/g, '\\n')));
    let added = false;
    for (const form of forms) {
      if (this.secrets.includes(form)) continue;
      this.secrets.push(form);
      added = true;
    }
    return added;
  }

  private sort(): void {
    this.secrets.sort((a, b) => b.length - a.length);
  }

  /** True if at least one secret is registered (otherwise data passes unchanged). */
  get active(): boolean {
    return this.secrets.length > 0;
  }

  /** Feed a chunk; returns the bytes that are safe to emit now. */
  push(chunk: Buffer): Buffer {
    if (!this.active) return chunk;
    const text = this.redact(this.carry + chunk.toString('latin1'));
    const hold = this.pendingPrefixLength(text);
    this.carry = text.slice(text.length - hold);
    return Buffer.from(text.slice(0, text.length - hold), 'latin1');
  }

  /** Emit the withheld tail (it is not a complete secret). */
  flush(): Buffer {
    const rest = this.carry;
    this.carry = '';
    return Buffer.from(rest, 'latin1');
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTION_MARKER);
    }
    return out;
  }

  /** Length of the longest suffix of `text` that is a proper prefix of a secret. */
  private pendingPrefixLength(text: string): number {
    let best = 0;
    for (const secret of this.secrets) {
      const first = secret.charCodeAt(0);
      const from = Math.max(0, text.length - (secret.length - 1));
      for (let i = from; i < text.length; i++) {
        if (text.length - i <= best) break;
        if (text.charCodeAt(i) === first && secret.startsWith(text.slice(i))) {
          best = text.length - i;
          break;
        }
      }
    }
    return best;
  }
}

function toLatin1(value: string): string {
  return Buffer.from(value, 'utf8').toString('latin1');
}
