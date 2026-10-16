/**
 * Event list of the run detail: a contiguous REST cursor over the run's
 * events (`sequence` 1, 2, 3, …) plus live events from SSE.
 *
 * - The detail endpoint returns only the first 500 events (`eventsTruncated`);
 *   further pages come from `GET /runs/:id/events?after=<cursor>`.
 * - A live event is appended only if it directly continues the loaded range
 *   (`sequence === cursor + 1`) and nothing is pending on the server. Otherwise
 *   the list is marked as having newer events and the user loads them via REST
 *   from the cursor – so no range is ever skipped.
 * - At most `maxRows` events are kept; the oldest are dropped (counted).
 */

/** Minimal event shape. */
export interface SequencedEvent {
  sequence: number;
}

/** What the view has to do after a change. */
export interface EventListChange<E> {
  /** Events to append (in order). */
  append: E[];
  /** Number of oldest rows to remove. */
  drop: number;
}

/** Default cap of rows kept in the view. */
export const EVENT_ROWS_MAX = 5000;

/** See module comment. */
export class EventList<E extends SequencedEvent> {
  /** Highest sequence of the contiguous loaded range (0 = none). */
  cursor = 0;
  /** True if the server may have events after `cursor` that are not loaded. */
  pending = false;
  /** Number of oldest events dropped from the view. */
  dropped = 0;
  private rows = 0;
  /** Highest sequence seen live (also while not appended). */
  private liveMax = 0;

  constructor(readonly maxRows = EVENT_ROWS_MAX) {}

  /** Number of rows currently kept. */
  get size(): number {
    return this.rows;
  }

  /** Query for the next REST page. */
  nextQuery(limit = 1000): { after: number; limit: number } {
    return { after: this.cursor, limit };
  }

  /**
   * Apply a REST page that was requested with `after = cursor` (initial
   * detail events: `after = 0`). Events must be ordered by sequence.
   * A page that does not start at the cursor (stale response) is ignored.
   */
  page(events: readonly E[], hasMore: boolean, after: number): EventListChange<E> {
    if (after !== this.cursor) return { append: [], drop: 0 };
    const append: E[] = [];
    for (const e of events) {
      if (e.sequence <= this.cursor) continue;
      append.push(e);
      this.cursor = e.sequence;
    }
    // Live events seen beyond the loaded range (e.g. while this page was in flight) keep `pending`.
    this.pending = hasMore || this.liveMax > this.cursor;
    return this.add(append);
  }

  /**
   * Apply a live event. Returns `null` if it was not appended: either a
   * duplicate, or it does not continue the loaded range (then `pending` is set
   * and the view should offer "load newer events").
   */
  live(e: E): EventListChange<E> | null {
    if (e.sequence > this.liveMax) this.liveMax = e.sequence;
    if (e.sequence <= this.cursor) return null;
    if (this.pending || e.sequence !== this.cursor + 1) {
      this.pending = true;
      return null;
    }
    this.cursor = e.sequence;
    return this.add([e]);
  }

  /** Mark that events may have been missed (e.g. after an SSE reconnect). */
  markPending(): void {
    this.pending = true;
  }

  private add(append: E[]): EventListChange<E> {
    this.rows += append.length;
    let drop = 0;
    if (this.rows > this.maxRows) {
      drop = this.rows - this.maxRows;
      this.rows = this.maxRows;
      this.dropped += drop;
    }
    return { append, drop };
  }
}
