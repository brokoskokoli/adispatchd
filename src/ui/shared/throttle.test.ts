import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefresher } from './throttle.js';

describe('createRefresher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces triggers into one call per interval', async () => {
    const fn = vi.fn(async () => undefined);
    const r = createRefresher(fn, 1000);
    r.trigger();
    r.trigger();
    r.trigger();
    expect(fn).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    r.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps working after many cycles and errors', async () => {
    let n = 0;
    const r = createRefresher(async () => {
      n++;
      if (n % 2 === 0) throw new Error('boom');
    }, 100);
    for (let i = 0; i < 5; i++) {
      r.trigger();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(n).toBe(5);
  });

  it('never runs concurrently and re-runs once after a trigger during a run', async () => {
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const fn = async (): Promise<void> => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((res) => {
        release = res;
      });
      active--;
    };
    const r = createRefresher(fn, 100);
    r.trigger();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    r.trigger();
    r.trigger();
    await vi.advanceTimersByTimeAsync(100); // fires while the first run is in flight → marked dirty
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('now() runs immediately; dispose() stops further runs', async () => {
    const fn = vi.fn(async () => undefined);
    const r = createRefresher(fn, 1000);
    r.trigger();
    await r.now();
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1);
    r.dispose();
    r.trigger();
    await r.now();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
