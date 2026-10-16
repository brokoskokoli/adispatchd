import { describe, expect, it } from 'vitest';
import { applyOperator } from './predicate.js';

const v = (r: { value: unknown }) => r.value;

describe('applyOperator', () => {
  it('equals / not_equals', () => {
    expect(v(applyOperator('equals', 'a', 'a'))).toBe(true);
    expect(v(applyOperator('equals', 'a', 'b'))).toBe(false);
    expect(v(applyOperator('equals', 0, 0))).toBe(true);
    expect(v(applyOperator('equals', true, true))).toBe(true);
    expect(v(applyOperator('not_equals', 'a', 'b'))).toBe(true);
    expect(v(applyOperator('not_equals', 'a', 'a'))).toBe(false);
    expect(v(applyOperator('equals', ['b', 'a'], ['a', 'b']))).toBe(true);
    expect(v(applyOperator('equals', ['a'], ['a', 'b']))).toBe(false);
  });

  it('null is a known absent value', () => {
    expect(v(applyOperator('equals', null, null))).toBe(true);
    expect(v(applyOperator('equals', null, 'x'))).toBe(false);
    expect(v(applyOperator('not_equals', null, 'x'))).toBe(true);
    expect(v(applyOperator('contains', null, 'x'))).toBe(false);
    expect(v(applyOperator('in', null, ['x']))).toBe(false);
    expect(v(applyOperator('greater_than', null, 1))).toBe('unknown');
  });

  it('type-incompatible comparisons are unknown', () => {
    expect(v(applyOperator('equals', 1, '1'))).toBe('unknown');
    expect(v(applyOperator('not_equals', 1, '1'))).toBe('unknown');
    expect(v(applyOperator('equals', ['a'], 'a'))).toBe('unknown');
    expect(v(applyOperator('greater_than', 'abc', 3))).toBe('unknown');
    expect(v(applyOperator('less_than', true, false))).toBe('unknown');
    expect(v(applyOperator('greater_than', ['a'], 'a'))).toBe('unknown');
    expect(v(applyOperator('contains', 5, 'a'))).toBe('unknown');
    expect(v(applyOperator('contains', ['a'], 1))).toBe('unknown');
    expect(v(applyOperator('contains', ['a'], ['a']))).toBe('unknown');
    expect(v(applyOperator('in', 3, ['3']))).toBe('unknown');
    expect(v(applyOperator('in', 'a', 'a'))).toBe('unknown');
    expect(v(applyOperator('greater_than', 'not a date', '2026-01-01', 'date'))).toBe('unknown');
    expect(applyOperator('equals', 1, '1').reason).toMatch(/incompatible/);
  });

  it('contains on arrays and strings', () => {
    expect(v(applyOperator('contains', ['bug', 'ready'], 'ready'))).toBe(true);
    expect(v(applyOperator('contains', ['bug'], 'ready'))).toBe(false);
    expect(v(applyOperator('contains', [], 'ready'))).toBe(false);
    expect(v(applyOperator('contains', 'Implement OAuth', 'OAuth'))).toBe(true);
    expect(v(applyOperator('contains', 'Implement', 'OAuth'))).toBe(false);
  });

  it('in', () => {
    expect(v(applyOperator('in', 'open', ['open', 'closed']))).toBe(true);
    expect(v(applyOperator('in', 'merged', ['open', 'closed']))).toBe(false);
    expect(v(applyOperator('in', 2, [1, 2]))).toBe(true);
    expect(v(applyOperator('in', 'x', []))).toBe(false);
    expect(v(applyOperator('in', ['a', 'b'], ['b', 'c']))).toBe(true);
    expect(v(applyOperator('in', ['a'], ['b']))).toBe(false);
  });

  it('dates must be strict ISO-8601; no offset means UTC', () => {
    // Non-ISO formats that Date.parse would accept are unknown.
    expect(v(applyOperator('greater_than', 'Oct 1, 2026', '2026-01-01', 'date'))).toBe('unknown');
    expect(v(applyOperator('equals', '2026/10/01', '2026-10-01', 'date'))).toBe('unknown');
    expect(v(applyOperator('equals', '2026-02-30', '2026-03-02', 'date'))).toBe('unknown');
    expect(v(applyOperator('equals', '2026-10-01T25:00:00Z', '2026-10-01', 'date'))).toBe('unknown');
    // Without offset: UTC, independent of the host time zone.
    expect(v(applyOperator('equals', '2026-10-01T10:00:00', '2026-10-01T10:00:00Z', 'date'))).toBe(true);
    expect(v(applyOperator('equals', '2026-10-01', '2026-10-01T00:00:00.000Z', 'date'))).toBe(true);
    expect(v(applyOperator('equals', '2026-10-01T10:00:00.5Z', '2026-10-01T10:00:00.500Z', 'date'))).toBe(true);
    expect(v(applyOperator('less_than', '2026-10-01T10:00:00-01:00', '2026-10-01T10:30:00Z', 'date'))).toBe(false);
  });

  it('greater_than / less_than on numbers, strings and dates', () => {
    expect(v(applyOperator('greater_than', 3, 2))).toBe(true);
    expect(v(applyOperator('greater_than', 2, 2))).toBe(false);
    expect(v(applyOperator('less_than', 1, 2))).toBe(true);
    expect(v(applyOperator('less_than', 'a', 'b'))).toBe(true);
    // Dates compare as instants when the field type is `date`.
    expect(v(applyOperator('greater_than', '2026-10-01T10:00:00Z', '2026-10-01T11:00:00+02:00', 'date'))).toBe(true);
    expect(v(applyOperator('equals', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00+02:00', 'date'))).toBe(true);
  });
});
