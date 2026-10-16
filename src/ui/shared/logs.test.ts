import { describe, expect, it } from 'vitest';
import { LogWindow, utf8Length, type LogPageLike } from './logs.js';

/** Serve pages of a log file like `GET /runs/:id/logs` (byte offsets, ASCII content). */
function server(content: string) {
  const size = utf8Length(content);
  const page = (offset: number, limit: number): LogPageLike => {
    const data = Buffer.from(content, 'utf8').subarray(offset, offset + limit).toString('utf8');
    const length = utf8Length(data);
    return { offset, length, nextOffset: offset + length, size, eof: offset + length >= size, exists: true, data };
  };
  return {
    page,
    tail: (n: number) => page(Math.max(0, size - n), n),
  };
}

const lines = (n: number, from = 1): string => Array.from({ length: n }, (_, i) => `line ${String(i + from).padStart(6, '0')}\n`).join('');

describe('LogWindow', () => {
  it('starts with the tail page and pages backwards without gaps', () => {
    const content = lines(1000); // 12 bytes per line → 12000 bytes
    const s = server(content);
    const w = new LogWindow(1000, 100_000);
    expect(w.tailQuery()).toEqual({ tail: 1000 });
    w.reset(s.tail(1000));
    expect(w.start).toBe(11000);
    expect(w.end).toBe(12000);
    expect(w.hasEarlier).toBe(true);
    expect(w.hasLater).toBe(false);
    for (let i = 0; i < 11; i++) {
      const q = w.earlierQuery()!;
      expect(w.prepend(s.page(q.offset, q.limit))).toBe(true);
    }
    expect(w.earlierQuery()).toBeNull();
    expect(w.text).toBe(content);
  });

  it('follows appended output from `end`', () => {
    let content = lines(10);
    const w = new LogWindow(64, 100_000);
    w.reset(server(content).tail(64));
    content += lines(5, 11);
    for (;;) {
      const q = w.laterQuery();
      const p = server(content).page(q.offset, q.limit);
      expect(w.append(p)).toBe(true);
      if (p.eof) break;
    }
    expect(content.endsWith(w.text)).toBe(true);
    expect(w.end).toBe(utf8Length(content));
    expect(w.hasLater).toBe(false);
  });

  it('rejects pages that do not fit the current range', () => {
    const s = server(lines(100));
    const w = new LogWindow(120, 100_000);
    w.reset(s.tail(120));
    expect(w.append(s.page(0, 10))).toBe(false);
    expect(w.prepend(s.page(0, 10))).toBe(false);
  });

  it('caps the kept text (big logs do not grow the DOM unbounded) and keeps offsets consistent', () => {
    const content = lines(5000); // 60 kB
    const s = server(content);
    const w = new LogWindow(1200, 5000);
    w.reset(s.page(0, 1200));
    for (let i = 0; i < 49; i++) {
      const q = w.laterQuery();
      w.append(s.page(q.offset, q.limit));
    }
    expect(w.text.length).toBeLessThanOrEqual(5000);
    expect(w.trimmed).toBe(true);
    expect(w.end).toBe(60000);
    // the kept text is exactly bytes [start, end) and starts at a line boundary
    expect(w.text).toBe(content.slice(w.start, w.end));
    expect(w.text.startsWith('line ')).toBe(true);
    // paging back trims the end instead
    for (let i = 0; i < 10; i++) {
      const q = w.earlierQuery()!;
      expect(w.prepend(s.page(q.offset, q.limit))).toBe(true);
      expect(w.text).toBe(content.slice(w.start, w.end));
      expect(w.text.length).toBeLessThanOrEqual(5000);
    }
    expect(w.hasLater).toBe(true);
  });

  it('handles multi-byte UTF-8 offsets when trimming', () => {
    const content = 'äöü€\n'.repeat(400); // 4 multi-byte chars + newline = 10 bytes per line
    const s = server(content);
    const w = new LogWindow(400, 500);
    w.reset(s.page(0, 400));
    for (let i = 0; i < 9; i++) w.append(s.page(w.end, 400));
    expect(w.text).toBe(Buffer.from(content).subarray(w.start, w.end).toString('utf8'));
  });

  it('empty / missing log', () => {
    const w = new LogWindow();
    w.reset({ offset: 0, length: 0, nextOffset: 0, size: 0, eof: true, exists: false, data: '' });
    expect(w.text).toBe('');
    expect(w.exists).toBe(false);
    expect(w.earlierQuery()).toBeNull();
  });
});
