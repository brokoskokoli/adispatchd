/**
 * Time abstractions. All logic that must be testable reads time through a
 * {@link Clock} and schedules delays through {@link Timers}, never via
 * `Date.now()` / global `setTimeout` directly.
 */

/** Source of the current wall-clock time. */
export interface Clock {
  /** Current time. Implementations must return a fresh `Date` instance. */
  now(): Date;
}

/** Opaque handle returned by {@link Timers.setTimeout}. */
export type TimerHandle = object;

/** Minimal timer scheduling abstraction (injectable for tests). */
export interface Timers {
  /** Schedule `callback` once after `ms` milliseconds. */
  setTimeout(callback: () => void, ms: number): TimerHandle;
  /** Cancel a timer; unknown or already-fired handles are ignored. */
  clearTimeout(handle: TimerHandle): void;
}

/** Clock backed by the real system time. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** Timers backed by the Node.js event loop. */
export const systemTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

/**
 * Resolve after `ms` milliseconds using the given timers. Rejects with the
 * signal's reason when `signal` is aborted before the delay elapses.
 */
export function sleep(timers: Timers, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      timers.clearTimeout(handle);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const handle = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface FakeTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

/**
 * Deterministic clock + timers for tests. Time only moves through
 * {@link FakeClock.advance} / {@link FakeClock.set}; due timers fire in
 * chronological order while advancing.
 */
export class FakeClock implements Clock, Timers {
  private current: number;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  /** @param start initial time (Date, epoch ms or ISO string); default 2026-01-01T00:00:00Z */
  constructor(start: Date | number | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
    if (Number.isNaN(this.current)) throw new TypeError(`Invalid FakeClock start: ${String(start)}`);
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Current time in epoch milliseconds. */
  nowMs(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const timer: FakeTimer = { id: this.nextId++, dueAt: this.current + Math.max(0, ms), callback };
    this.timers.push(timer);
    return { id: timer.id };
  }

  clearTimeout(handle: TimerHandle): void {
    const id = (handle as { id?: number }).id;
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  /** Number of timers that have not fired yet. */
  pendingTimers(): number {
    return this.timers.length;
  }

  /** Move time forward by `ms`, firing every timer that becomes due (in order). */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError('FakeClock cannot move backwards via advance()');
    this.runUntil(this.current + ms);
  }

  /**
   * Like {@link advance}, but yields to the microtask queue after each fired
   * timer so that promise continuations (e.g. after {@link sleep}) can run.
   */
  async advanceAsync(ms: number): Promise<void> {
    if (ms < 0) throw new RangeError('FakeClock cannot move backwards via advanceAsync()');
    const target = this.current + ms;
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.fire(next);
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }

  /** Jump to an absolute time. Moving backwards does not fire timers. */
  set(time: Date | number | string): void {
    const target = new Date(time).getTime();
    if (Number.isNaN(target)) throw new TypeError(`Invalid time: ${String(time)}`);
    if (target >= this.current) this.runUntil(target);
    else this.current = target;
  }

  private runUntil(target: number): void {
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.fire(next);
    }
    this.current = target;
  }

  private nextDue(target: number): FakeTimer | undefined {
    let next: FakeTimer | undefined;
    for (const t of this.timers) {
      if (t.dueAt <= target && (!next || t.dueAt < next.dueAt || (t.dueAt === next.dueAt && t.id < next.id))) {
        next = t;
      }
    }
    return next;
  }

  private fire(timer: FakeTimer): void {
    this.timers = this.timers.filter((t) => t.id !== timer.id);
    this.current = Math.max(this.current, timer.dueAt);
    timer.callback();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
