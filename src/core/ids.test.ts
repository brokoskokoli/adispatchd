import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { ValidationError } from './errors.js';
import {
  commentMarker,
  createRunId,
  formatCompactTimestamp,
  isValidConfigId,
  isValidRunId,
  parseSourceItemKey,
  sourceItemKey,
} from './ids.js';

describe('run ids', () => {
  it('creates deterministic ids with injected clock and randomness', () => {
    const clock = new FakeClock('2026-10-16T19:00:00.123Z');
    const id = createRunId({ clock, randomBytes: () => new Uint8Array([0x3f, 0xa2, 0xc9, 0x1b]) });
    expect(id).toBe('run-20261016T190000123Z-3fa2c91b');
    expect(isValidRunId(id)).toBe(true);
  });

  it('creates unique, chronologically sortable, path-safe ids', () => {
    const clock = new FakeClock('2026-10-16T19:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      ids.push(createRunId({ clock }));
      clock.advance(i % 3 === 0 ? 1 : 0);
    }
    expect(new Set(ids).size).toBe(ids.length);
    const byTime = ids.map((id) => id.slice(0, 23));
    expect([...byTime].sort()).toEqual(byTime);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('formats compact timestamps', () => {
    const d = new Date('2026-01-02T03:04:05.006Z');
    expect(formatCompactTimestamp(d)).toBe('20260102T030405Z');
    expect(formatCompactTimestamp(d, true)).toBe('20260102T030405006Z');
  });
});

describe('source item keys', () => {
  it('builds and parses global keys', () => {
    const key = sourceItemKey('project_a', '123');
    expect(key).toBe('project_a:123');
    expect(parseSourceItemKey(key)).toEqual({ sourceId: 'project_a', itemId: '123' });
    expect(parseSourceItemKey('src:a:b')).toEqual({ sourceId: 'src', itemId: 'a:b' });
  });

  it('keeps keys distinct across sources', () => {
    expect(sourceItemKey('project_a', '1')).not.toBe(sourceItemKey('project_b', '1'));
  });

  it('rejects invalid parts', () => {
    expect(() => sourceItemKey('bad:id', '1')).toThrow(ValidationError);
    expect(() => sourceItemKey('a', '')).toThrow(ValidationError);
    expect(() => sourceItemKey('a', 'x\ny')).toThrow(ValidationError);
    expect(() => parseSourceItemKey('nokey')).toThrow(ValidationError);
  });
});

describe('config ids and markers', () => {
  it('validates config ids', () => {
    expect(isValidConfigId('coder-project-a')).toBe(true);
    expect(isValidConfigId('project_a')).toBe(true);
    expect(isValidConfigId('-x')).toBe(false);
    expect(isValidConfigId('a/b')).toBe(false);
    expect(isValidConfigId('a'.repeat(65))).toBe(false);
  });

  it('builds comment markers', () => {
    expect(commentMarker('run-1', 7)).toBe('adispatchd:run-1:7');
    expect(() => commentMarker('run 1', 'x')).toThrow(ValidationError);
  });
});
