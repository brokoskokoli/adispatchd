import { describe, expect, it } from 'vitest';
import { EventList } from './events.js';

const ev = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ sequence: from + i }));
const seqs = (c: { append: Array<{ sequence: number }> } | null) => (c ? c.append.map((e) => e.sequence) : null);

describe('EventList (run detail events: contiguous cursor + live)', () => {
  it('truncated detail (first 500): live events are not appended, the gap is loaded via REST from the cursor', () => {
    const l = new EventList();
    expect(seqs(l.page(ev(1, 500), true, 0))).toHaveLength(500);
    expect(l.cursor).toBe(500);
    expect(l.pending).toBe(true);
    // live event far ahead (seq 1200) must not be appended – otherwise 501–1199 would never be loaded
    expect(l.live({ sequence: 1200 })).toBeNull();
    expect(l.cursor).toBe(500);
    expect(l.nextQuery()).toEqual({ after: 500, limit: 1000 });
    expect(seqs(l.page(ev(501, 1200), false, 500))).toEqual(ev(501, 1200).map((e) => e.sequence));
    expect(l.pending).toBe(false);
    // now contiguous live events are appended directly
    expect(seqs(l.live({ sequence: 1201 }))).toEqual([1201]);
    expect(l.cursor).toBe(1201);
  });

  it('a live gap (missed event) switches to REST loading; duplicates are ignored', () => {
    const l = new EventList();
    l.page(ev(1, 10), false, 0);
    expect(l.live({ sequence: 10 })).toBeNull();
    expect(l.pending).toBe(false);
    expect(l.live({ sequence: 12 })).toBeNull(); // 11 missed
    expect(l.pending).toBe(true);
    expect(l.live({ sequence: 13 })).toBeNull(); // still pending → not appended
    expect(seqs(l.page(ev(11, 13), false, 10))).toEqual([11, 12, 13]);
    expect(l.pending).toBe(false);
  });

  it('live events arriving while a page is in flight keep `pending`', () => {
    const l = new EventList();
    l.page(ev(1, 5), true, 0);
    const q = l.nextQuery();
    l.live({ sequence: 9 }); // arrives during the request
    l.page(ev(6, 8), false, q.after); // server snapshot ended at 8
    expect(l.cursor).toBe(8);
    expect(l.pending).toBe(true);
    expect(seqs(l.page(ev(9, 9), false, 8))).toEqual([9]);
    expect(l.pending).toBe(false);
  });

  it('ignores stale pages and overlapping events', () => {
    const l = new EventList();
    l.page(ev(1, 10), true, 0);
    expect(l.page(ev(5, 20), false, 4)).toEqual({ append: [], drop: 0 }); // requested with an old cursor
    expect(l.cursor).toBe(10);
    expect(seqs(l.page(ev(8, 12), false, 10))).toEqual([11, 12]);
  });

  it('markPending (after SSE reconnect) forces a REST load before live appends', () => {
    const l = new EventList();
    l.page(ev(1, 3), false, 0);
    l.markPending();
    expect(l.live({ sequence: 4 })).toBeNull();
    l.page(ev(4, 6), false, 3);
    expect(seqs(l.live({ sequence: 7 }))).toEqual([7]);
  });

  it('caps the number of rows, dropping the oldest', () => {
    const l = new EventList(100);
    expect(l.page(ev(1, 80), true, 0).drop).toBe(0);
    const c = l.page(ev(81, 150), false, 80);
    expect(c.append).toHaveLength(70);
    expect(c.drop).toBe(50);
    expect(l.size).toBe(100);
    expect(l.dropped).toBe(50);
    expect(l.live({ sequence: 151 })!.drop).toBe(1);
    expect(l.dropped).toBe(51);
  });
});
