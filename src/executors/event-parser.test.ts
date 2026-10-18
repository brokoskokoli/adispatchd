import { describe, expect, it } from 'vitest';
import { MAX_EVENT_LINE_BYTES, ADISPATCH_EVENT_PREFIX } from '../core/index.js';
import { EventLineParser, parseEventLine } from './event-parser.js';

function collect() {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const warnings: { error: string; preview: string }[] = [];
  const parser = new EventLineParser({
    onEvent: (type, data) => events.push({ type, data }),
    onInvalid: (error, preview) => warnings.push({ error, preview }),
  });
  return { parser, events, warnings };
}

describe('parseEventLine', () => {
  it('ignores normal lines', () => {
    expect(parseEventLine('hello')).toEqual({ kind: 'none' });
    expect(parseEventLine('@@ADISPATCH_EVENT{"type":"x"}')).toEqual({ kind: 'none' });
  });

  it('parses a valid event', () => {
    expect(parseEventLine('@@ADISPATCH_EVENT {"type":"progress","value":60}')).toEqual({
      kind: 'event',
      type: 'progress',
      data: { type: 'progress', value: 60 },
    });
  });

  it.each([
    ['not json', '@@ADISPATCH_EVENT {nope'],
    ['no type', '@@ADISPATCH_EVENT {"message":"x"}'],
    ['type not string', '@@ADISPATCH_EVENT {"type":5}'],
    ['array', '@@ADISPATCH_EVENT [1,2]'],
    ['empty', '@@ADISPATCH_EVENT '],
  ])('rejects %s', (_name, line) => {
    expect(parseEventLine(line).kind).toBe('invalid');
  });

  it('rejects oversized payloads', () => {
    const big = JSON.stringify({ type: 'x', pad: 'a'.repeat(MAX_EVENT_LINE_BYTES) });
    expect(parseEventLine(ADISPATCH_EVENT_PREFIX + big)).toMatchObject({ kind: 'invalid' });
  });
});

describe('EventLineParser', () => {
  it('handles events split across chunk boundaries at every position', () => {
    const text = 'log line\n@@ADISPATCH_EVENT {"type":"status","message":"Tests laufen"}\nafter\n';
    for (let cut = 1; cut < text.length; cut++) {
      const { parser, events, warnings } = collect();
      parser.push(text.slice(0, cut));
      parser.push(text.slice(cut));
      parser.flush();
      expect(events).toEqual([{ type: 'status', data: { type: 'status', message: 'Tests laufen' } }]);
      expect(warnings).toEqual([]);
    }
  });

  it('handles byte-by-byte delivery and CRLF', () => {
    const { parser, events } = collect();
    for (const ch of '@@ADISPATCH_EVENT {"type":"a"}\r\n@@ADISPATCH_EVENT {"type":"b"}\n') parser.push(ch);
    expect(events.map((e) => e.type)).toEqual(['a', 'b']);
  });

  it('parses a final unterminated line on flush', () => {
    const { parser, events } = collect();
    parser.push('@@ADISPATCH_EVENT {"type":"last"}');
    expect(events).toEqual([]);
    parser.flush();
    expect(events.map((e) => e.type)).toEqual(['last']);
  });

  it('emits a warning for invalid event lines and continues', () => {
    const { parser, events, warnings } = collect();
    parser.push('@@ADISPATCH_EVENT {broken\n@@ADISPATCH_EVENT {"type":"ok"}\n');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.preview).toBe('@@ADISPATCH_EVENT {broken');
    expect(events.map((e) => e.type)).toEqual(['ok']);
  });

  it('bounds memory for oversized event lines and warns once', () => {
    const { parser, events, warnings } = collect();
    parser.push(ADISPATCH_EVENT_PREFIX + '{"type":"x","pad":"');
    const chunk = 'a'.repeat(16 * 1024);
    for (let i = 0; i < 8; i++) parser.push(chunk);
    parser.push('"}\n@@ADISPATCH_EVENT {"type":"next"}\n');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.error).toContain('exceeds');
    expect(events.map((e) => e.type)).toEqual(['next']);
  });

  it('does not treat lines containing the prefix mid-line as events', () => {
    const { parser, events, warnings } = collect();
    parser.push('x @@ADISPATCH_EVENT {"type":"no"}\n');
    parser.push('@@ADISPATCH_EVEN');
    parser.push('X {"type":"no"}\n');
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
