/**
 * Coalescing refresher: many live events → at most one REST reload per
 * interval, never two concurrent reloads, and always a trailing reload after
 * the last trigger.
 */

/** Timer functions (injectable for tests). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Handle of {@link createRefresher}. */
export interface Refresher {
  /** Request a refresh (coalesced). */
  trigger(): void;
  /** Refresh now (still never concurrent). */
  now(): Promise<void>;
  /** Cancel pending refreshes; later triggers are ignored. */
  dispose(): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Create a {@link Refresher} for `fn` with a minimal distance of `intervalMs`. */
export function createRefresher(fn: () => Promise<void> | void, intervalMs: number, timers: Timers = defaultTimers): Refresher {
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let dirty = false;
  let disposed = false;

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      dirty = true;
      return running;
    }
    dirty = false;
    running = (async () => {
      try {
        await fn();
      } catch {
        // errors are reported by fn itself
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
    if (dirty && !disposed) schedule();
  };

  const schedule = (): void => {
    if (disposed || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void run();
    }, intervalMs);
  };

  return {
    trigger: schedule,
    now: () => {
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      return run();
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
