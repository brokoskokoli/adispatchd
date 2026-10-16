/**
 * Typed in-process event bus (Spec §15 SSE source, consumed by WI-10).
 *
 * Rules:
 * - Persisted events (`run.event`, including every run status transition)
 *   reach the bus only AFTER their transaction committed, strictly in ID
 *   order and exactly once ({@link PersistedEventPublisher}); their `id` is
 *   usable as SSE `Last-Event-ID`.
 * - Log chunks (`run.output`) are live-only and never persisted in SQLite
 *   (the log files are the source of truth).
 * - Publishing never blocks or throws into orchestration: listeners are
 *   called synchronously in subscription order, exceptions are caught and
 *   logged. Listeners must therefore return quickly (e.g. push into a bounded
 *   per-client buffer, Spec §15 "slow clients").
 */
import { noopLogger, type Logger, type Unsubscribe } from '../core/index.js';
import type { BlockRecord, Repositories, RunActionRecord, RunEventRecord } from '../persistence/index.js';

/** Snapshot of the controller state (readiness, pause/drain). */
export interface ControllerStatus {
  /** Recovery finished; the scheduler may start runs. */
  ready: boolean;
  /** Automatic starts paused (manual starts still allowed). */
  paused: boolean;
  /** Draining: no new runs at all, active runs finish. */
  draining: boolean;
  /** Shutting down (cancel-all or after drain). */
  stopping: boolean;
  /** Runs currently supervised by this process. */
  activeRuns: number;
}

/** All bus events. */
export type BusEvent =
  /** A persisted run event (status transitions `run.status`, worker events, diagnostics, lifecycle). */
  | { type: 'run.event'; event: RunEventRecord }
  /** Live stdout/stderr chunk (already secret-redacted by the executor). Not persisted. */
  | { type: 'run.output'; runId: string; stream: 'stdout' | 'stderr'; data: string; at: string }
  /** A lifecycle action changed (journal record after commit). */
  | { type: 'run.action'; action: RunActionRecord }
  /** A retry block was created (after commit). */
  | { type: 'block.created'; block: BlockRecord }
  /** A retry block was cleared (after commit). */
  | { type: 'block.cleared'; block: BlockRecord }
  /** Controller status changed (ready, paused, draining, stopping, active run count). */
  | { type: 'system.status'; status: ControllerStatus };

/** Type names of {@link BusEvent}. */
export type BusEventType = BusEvent['type'];

/** Listener of {@link RunEventBus}. Must not block. */
export type BusListener = (event: BusEvent) => void;

/** See module docs. */
export class RunEventBus {
  private readonly listeners = new Set<{ fn: BusListener; types: ReadonlySet<BusEventType> | null }>();

  constructor(private readonly logger: Logger = noopLogger) {}

  /** Subscribe to all events, or only to `types`. */
  subscribe(listener: BusListener, types?: readonly BusEventType[]): Unsubscribe {
    const entry = { fn: listener, types: types ? new Set(types) : null };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Number of subscribers (diagnostics). */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Deliver `event` to all matching listeners; never throws. */
  publish(event: BusEvent): void {
    for (const entry of [...this.listeners]) {
      if (entry.types && !entry.types.has(event.type)) continue;
      try {
        entry.fn(event);
      } catch (err) {
        this.logger.warn('event bus listener failed', { type: event.type, error: err });
      }
    }
  }
}

/**
 * Publishes persisted `run_events` to the bus after commit, in ID order and
 * exactly once. One instance per process; the run controller and the
 * lifecycle engine (`onActionChange`, see {@link actionListener}) share it.
 */
export class PersistedEventPublisher {
  private lastId: number;
  private flushing = false;

  constructor(
    private readonly repositories: Pick<Repositories, 'events' | 'afterCommit'>,
    readonly bus: RunEventBus,
    options: { fromId?: number } = {},
  ) {
    // Start at the current end: history is replayed by SSE from the DB, not by the bus.
    this.lastId = options.fromId ?? repositories.events.latestId();
  }

  /** Highest event ID published so far. */
  get lastPublishedId(): number {
    return this.lastId;
  }

  /**
   * Publish all events committed since the last flush. Deferred via
   * `afterCommit`, so calling it inside an open transaction never leaks
   * uncommitted (possibly rolled back) rows.
   */
  flush(): void {
    this.repositories.afterCommit(() => this.flushNow());
  }

  /** `onActionChange` callback for the lifecycle engine: publish pending events, then the action. */
  actionListener(): (action: RunActionRecord) => void {
    return (action) => {
      this.flushNow();
      this.bus.publish({ type: 'run.action', action });
    };
  }

  private flushNow(): void {
    if (this.flushing) return; // re-entrant call from a listener: the running loop picks the rows up
    this.flushing = true;
    try {
      for (;;) {
        const batch = this.repositories.events.listSince(this.lastId, { limit: 500 });
        if (batch.length === 0) break;
        for (const event of batch) {
          this.lastId = event.id;
          this.bus.publish({ type: 'run.event', event });
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
