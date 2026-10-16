import { describe, expect, it } from 'vitest';
import { dueSlots, nextSlots, parseCron } from './cron.js';

const iso = (dates: Date[]): string[] => dates.map((d) => d.toISOString());

/**
 * Pins croner's DST behaviour (Spec §24.7). Documented in docs/cron-semantics.md.
 * Europe/Berlin 2026: spring forward 2026-03-29 02:00 CET → 03:00 CEST (01:00Z),
 * fall back 2026-10-25 03:00 CEST → 02:00 CET (01:00Z).
 */
describe('cron slots – DST (Europe/Berlin)', () => {
  it('spring forward: a daily slot in the skipped hour fires once at the shifted local time', () => {
    const s = parseCron('30 2 * * *', 'Europe/Berlin');
    expect(iso(nextSlots(s, new Date('2026-03-27T00:00:00Z'), 4))).toEqual([
      '2026-03-27T01:30:00.000Z', // 02:30 CET
      '2026-03-28T01:30:00.000Z', // 02:30 CET
      '2026-03-29T01:30:00.000Z', // 02:30 does not exist → 03:30 CEST
      '2026-03-30T00:30:00.000Z', // 02:30 CEST
    ]);
  });

  it('spring forward: 02:00 and 03:00 daily jobs both run once, at the same instant on the DST day', () => {
    expect(iso(nextSlots(parseCron('0 2 * * *', 'Europe/Berlin'), new Date('2026-03-28T12:00:00Z'), 2))).toEqual([
      '2026-03-29T01:00:00.000Z', // 02:00 does not exist → 03:00 CEST
      '2026-03-30T00:00:00.000Z',
    ]);
    expect(iso(nextSlots(parseCron('0 3 * * *', 'Europe/Berlin'), new Date('2026-03-28T12:00:00Z'), 2))).toEqual([
      '2026-03-29T01:00:00.000Z', // 03:00 CEST
      '2026-03-30T01:00:00.000Z',
    ]);
  });

  it('spring forward: sub-hourly slots inside the gap are dropped, no duplicates', () => {
    expect(iso(nextSlots(parseCron('*/30 * * * *', 'Europe/Berlin'), new Date('2026-03-29T00:00:00Z'), 5))).toEqual([
      '2026-03-29T00:30:00.000Z', // 01:30 CET
      '2026-03-29T01:00:00.000Z', // 03:00 CEST (02:00, 02:30 skipped)
      '2026-03-29T01:30:00.000Z',
      '2026-03-29T02:00:00.000Z',
      '2026-03-29T02:30:00.000Z',
    ]);
  });

  it('fall back: a daily slot in the repeated hour fires only once (first occurrence, CEST)', () => {
    expect(iso(nextSlots(parseCron('30 2 * * *', 'Europe/Berlin'), new Date('2026-10-24T12:00:00Z'), 2))).toEqual([
      '2026-10-25T00:30:00.000Z', // 02:30 CEST; the second 02:30 (CET, 01:30Z) does not fire
      '2026-10-26T01:30:00.000Z', // 02:30 CET
    ]);
  });

  it('fall back: hourly/half-hourly slots of the repeated hour fire only on the first pass', () => {
    expect(iso(nextSlots(parseCron('0 * * * *', 'Europe/Berlin'), new Date('2026-10-24T23:00:00Z'), 3))).toEqual([
      '2026-10-25T00:00:00.000Z', // 02:00 CEST
      '2026-10-25T02:00:00.000Z', // 03:00 CET – 02:00 CET (01:00Z) is skipped
      '2026-10-25T03:00:00.000Z',
    ]);
    expect(iso(nextSlots(parseCron('*/30 * * * *', 'Europe/Berlin'), new Date('2026-10-24T23:30:00Z'), 4))).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T02:00:00.000Z', // 1.5 h gap: 02:00/02:30 CET skipped
      '2026-10-25T02:30:00.000Z',
    ]);
  });

  it('UTC schedules are unaffected', () => {
    expect(iso(nextSlots(parseCron('0 3 * * *', 'UTC'), new Date('2026-03-28T12:00:00Z'), 2))).toEqual([
      '2026-03-29T03:00:00.000Z',
      '2026-03-30T03:00:00.000Z',
    ]);
  });
});

describe('cron slots – helpers', () => {
  it('next() is strictly after the reference (also inside a second)', () => {
    const s = parseCron('0 3 * * *', 'UTC');
    expect(s.next(new Date('2026-03-27T03:00:00Z'))?.toISOString()).toBe('2026-03-28T03:00:00.000Z');
    expect(s.next(new Date('2026-03-27T02:59:59.500Z'))?.toISOString()).toBe('2026-03-27T03:00:00.000Z');
  });

  it('dueSlots returns (after, now] and keeps only the most recent ones', () => {
    const s = parseCron('* * * * *', 'UTC');
    const r = dueSlots(s, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:10:30Z'), { keep: 3, maxScan: 1000 });
    expect(iso(r.slots)).toEqual(['2026-01-01T00:08:00.000Z', '2026-01-01T00:09:00.000Z', '2026-01-01T00:10:00.000Z']);
    expect(r.total).toBe(10);
    expect(r.scanLimited).toBe(false);
    // `now` exactly on a slot is due; `after` itself is not.
    const exact = dueSlots(s, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:01:00Z'), { keep: 5, maxScan: 1000 });
    expect(iso(exact.slots)).toEqual(['2026-01-01T00:01:00.000Z']);
  });

  it('dueSlots stays bounded for huge gaps and still finds the latest slots', () => {
    const s = parseCron('* * * * * *', 'UTC'); // every second
    const now = new Date('2026-01-08T00:00:00Z');
    const r = dueSlots(s, new Date('2026-01-01T00:00:00Z'), now, { keep: 2, maxScan: 500 });
    expect(r.scanLimited).toBe(true);
    expect(iso(r.slots)).toEqual(['2026-01-07T23:59:59.000Z', '2026-01-08T00:00:00.000Z']);
  });
});
