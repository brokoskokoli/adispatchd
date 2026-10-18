/**
 * Line buffering and parsing of structured worker events (Spec §9.3).
 *
 * Lines starting with `@@ADISPATCH_EVENT ` carry a JSON object `{type: string, ...}`.
 * Valid events are reported via callback; invalid event lines produce a
 * parser warning. The raw line always stays in the log (this parser only
 * observes the stream).
 */
import { MAX_EVENT_LINE_BYTES, ADISPATCH_EVENT_PREFIX, workerEventPayloadSchema } from '../core/index.js';

/** Result of parsing one complete line. */
export type EventLineResult =
  | { kind: 'none' }
  | { kind: 'event'; type: string; data: Record<string, unknown> }
  | { kind: 'invalid'; error: string };

/** Maximum length of the line preview included in parser warnings. */
const PREVIEW_CHARS = 200;

/** Parse one complete line (without the line terminator). */
export function parseEventLine(line: string): EventLineResult {
  if (!line.startsWith(ADISPATCH_EVENT_PREFIX)) return { kind: 'none' };
  const payload = line.slice(ADISPATCH_EVENT_PREFIX.length);
  if (Buffer.byteLength(payload, 'utf8') > MAX_EVENT_LINE_BYTES) {
    return { kind: 'invalid', error: `event payload exceeds ${MAX_EVENT_LINE_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (err) {
    return { kind: 'invalid', error: `event is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = workerEventPayloadSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { kind: 'invalid', error: `event does not match schema: ${issues}` };
  }
  return { kind: 'event', type: parsed.data.type, data: parsed.data as Record<string, unknown> };
}

/** Callbacks of an {@link EventLineParser}. */
export interface EventLineHandlers {
  onEvent(type: string, data: Record<string, unknown>): void;
  onInvalid(error: string, preview: string): void;
}

/**
 * Incremental line splitter + event parser for one stream. Accepts decoded
 * text in arbitrary chunks (lines may span chunks). Memory is bounded: a
 * non-event line is not buffered beyond the prefix length, an event line is
 * buffered up to the payload limit; longer event lines are discarded up to
 * their newline and reported as invalid.
 */
export class EventLineParser {
  private buffer = '';
  /** The current line is known not to be an event; skip until newline. */
  private skipping = false;
  /** The current event line exceeded the limit; skip until newline, then warn. */
  private overflow = false;
  private readonly maxLineChars = ADISPATCH_EVENT_PREFIX.length + MAX_EVENT_LINE_BYTES;

  constructor(private readonly handlers: EventLineHandlers) {}

  /** Feed decoded text. */
  push(text: string): void {
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf('\n', start);
      const end = nl === -1 ? text.length : nl;
      this.append(text.slice(start, end));
      if (nl === -1) break;
      this.completeLine();
      start = nl + 1;
    }
  }

  /** Process a final unterminated line (call at end of stream). */
  flush(): void {
    if (this.buffer !== '' || this.overflow) this.completeLine();
    this.buffer = '';
    this.skipping = false;
    this.overflow = false;
  }

  private append(part: string): void {
    if (this.skipping || this.overflow || part === '') return;
    this.buffer += part;
    const prefixPart = this.buffer.slice(0, ADISPATCH_EVENT_PREFIX.length);
    if (!ADISPATCH_EVENT_PREFIX.startsWith(prefixPart)) {
      this.skipping = true;
      this.buffer = '';
      return;
    }
    // UTF-16 length is a lower bound of the UTF-8 byte length.
    if (this.buffer.length > this.maxLineChars) {
      this.overflow = true;
      this.buffer = this.buffer.slice(0, PREVIEW_CHARS);
    }
  }

  private completeLine(): void {
    if (this.overflow) {
      this.handlers.onInvalid(`event payload exceeds ${MAX_EVENT_LINE_BYTES} bytes`, this.buffer.slice(0, PREVIEW_CHARS));
    } else if (!this.skipping && this.buffer !== '') {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      const result = parseEventLine(line);
      if (result.kind === 'event') this.handlers.onEvent(result.type, result.data);
      else if (result.kind === 'invalid') this.handlers.onInvalid(result.error, line.slice(0, PREVIEW_CHARS));
    }
    this.buffer = '';
    this.skipping = false;
    this.overflow = false;
  }
}
