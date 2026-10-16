import { describe, expect, it } from 'vitest';
import { FakeClock, sleep, systemClock } from './clock.js';

describe('clock', () => {
  it('systemClock returns the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it('FakeClock advances and fires timers in order', () => {
    const clock = new FakeClock('2026-10-16T00:00:00Z');
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`b@${clock.now().toISOString()}`), 2000);
    clock.setTimeout(() => fired.push(`a@${clock.now().toISOString()}`), 1000);
    const cancelled = clock.setTimeout(() => fired.push('never'), 1500);
    clock.clearTimeout(cancelled);
    clock.advance(1500);
    expect(fired).toEqual(['a@2026-10-16T00:00:01.000Z']);
    clock.advance(1000);
    expect(fired).toEqual(['a@2026-10-16T00:00:01.000Z', 'b@2026-10-16T00:00:02.000Z']);
    expect(clock.now().toISOString()).toBe('2026-10-16T00:00:02.500Z');
    expect(clock.pendingTimers()).toBe(0);
  });

  it('sleep resolves through FakeClock.advanceAsync and honours abort', async () => {
    const clock = new FakeClock();
    let done = false;
    const p = sleep(clock, 30_000).then(() => {
      done = true;
    });
    await clock.advanceAsync(29_999);
    expect(done).toBe(false);
    await clock.advanceAsync(1);
    await p;
    expect(done).toBe(true);

    const ac = new AbortController();
    const aborted = sleep(clock, 1000, ac.signal);
    ac.abort(new Error('stop'));
    await expect(aborted).rejects.toThrow('stop');
    expect(clock.pendingTimers()).toBe(0);
  });
});
