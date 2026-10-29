import { describe, expect, it } from 'vitest';
import { SlotLedger } from './ledger.js';

describe('SlotLedger', () => {
  it('never grants more than max and frees slots on release', () => {
    const l = new SlotLedger(2);
    expect(l.tryAcquire('a', 'k1').ok).toBe(true);
    expect(l.tryAcquire('b', 'k2').ok).toBe(true);
    const denied = l.tryAcquire('a', 'k3');
    expect(denied).toMatchObject({ ok: false, code: 'limit', reason: 'hub limit reached (2/2 active)' });
    expect(l.active).toBe(2);
    expect(l.release('a', 'k1')).toBe(true);
    expect(l.release('a', 'k1')).toBe(false);
    expect(l.tryAcquire('a', 'k3').ok).toBe(true);
    expect(l.byWorkspace()).toEqual({ a: 1, b: 1 });
  });

  it('is idempotent for a key that is already held', () => {
    const l = new SlotLedger(1);
    expect(l.tryAcquire('a', 'k').ok).toBe(true);
    expect(l.tryAcquire('a', 'k').ok).toBe(true);
    expect(l.active).toBe(1);
  });

  it('denies while paused, but keeps held slots', () => {
    const l = new SlotLedger(3);
    l.tryAcquire('a', 'k');
    l.paused = true;
    expect(l.tryAcquire('a', 'k2')).toMatchObject({ ok: false, code: 'paused' });
    expect(l.active).toBe(1);
  });

  it('adopts leases beyond the limit and then denies new ones', () => {
    const l = new SlotLedger(1);
    l.adopt('a', 'run:1');
    l.adopt('b', 'run:2');
    expect(l.active).toBe(2);
    expect(l.tryAcquire('a', 'k').ok).toBe(false);
    l.release('a', 'run:1');
    expect(l.tryAcquire('a', 'k').ok).toBe(false);
    l.release('b', 'run:2');
    expect(l.tryAcquire('a', 'k').ok).toBe(true);
  });

  it('replace makes the list authoritative, retain only removes, drop frees all', () => {
    const l = new SlotLedger(5);
    l.replace('a', ['x', 'y']);
    expect(l.activeOf('a')).toBe(2);
    expect(l.retain('a', ['x', 'unknown'])).toBe(1);
    expect(l.activeOf('a')).toBe(1);
    expect(l.replace('a', ['z'])).toBe(2);
    expect(l.drop('a')).toBe(1);
    expect(l.active).toBe(0);
  });
});
