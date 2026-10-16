/**
 * Central system notifications (Spec §18): persisted first, delivered
 * asynchronously by WI-10; delivery attempts are stored.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Clock, NotificationEventType } from '../core/index.js';
import { NotFoundError } from './errors.js';
import { all, get, iso, run, str, transaction, type Params, type Row } from './sqlite.js';

/** Delivery state of a notification. */
export type DeliveryState = 'pending' | 'delivered' | 'failed';

/** A persisted notification. Payload must not contain secrets. */
export interface NotificationRecord {
  id: number;
  eventType: NotificationEventType;
  payload: Record<string, unknown>;
  deliveryState: DeliveryState;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

/** Repository for `notifications`. */
export class NotificationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** Persist a new notification in state `pending` (due immediately). */
  create(eventType: NotificationEventType, payload: Record<string, unknown>): NotificationRecord {
    const now = this.clock.now().toISOString();
    const res = run(
      this.db,
      `INSERT INTO notifications (event_type, payload_json, delivery_state, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
      [eventType, JSON.stringify(payload), now, now, now],
    );
    return this.require(res.lastInsertRowid);
  }

  /** Notification by ID or `null`. */
  get(id: number): NotificationRecord | null {
    const row = get(this.db, 'SELECT * FROM notifications WHERE id = ?', [id]);
    return row ? toNotification(row) : null;
  }

  /** Notifications, newest first, optionally filtered by state. */
  list(options: { state?: DeliveryState; limit?: number; offset?: number } = {}): NotificationRecord[] {
    const params: Params = [];
    let sql = 'SELECT * FROM notifications';
    if (options.state !== undefined) {
      sql += ' WHERE delivery_state = ?';
      params.push(options.state);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    params.push(options.limit ?? 100, options.offset ?? 0);
    return all(this.db, sql, params).map(toNotification);
  }

  /** Pending notifications due at `now` (default: clock), oldest first. */
  listDue(now?: Date, limit = 100): NotificationRecord[] {
    return all(
      this.db,
      `SELECT * FROM notifications WHERE delivery_state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [iso(now ?? this.clock.now()), limit],
    ).map(toNotification);
  }

  /**
   * Record one delivery attempt. Success → `delivered`. Failure → stays
   * `pending` with `nextAttemptAt`, or `failed` when `nextAttemptAt` is `null`
   * (retries exhausted). `error` must already be redacted.
   */
  recordAttempt(
    id: number,
    outcome: { success: true } | { success: false; error: string; nextAttemptAt: Date | string | null },
  ): NotificationRecord {
    return transaction(this.db, () => {
      this.require(id);
      const now = this.clock.now().toISOString();
      if (outcome.success) {
        run(
          this.db,
          `UPDATE notifications SET delivery_state = 'delivered', attempts = attempts + 1, delivered_at = ?, next_attempt_at = NULL,
             updated_at = ? WHERE id = ?`,
          [now, now, id],
        );
      } else {
        const next = outcome.nextAttemptAt === null ? null : iso(outcome.nextAttemptAt);
        run(
          this.db,
          `UPDATE notifications SET delivery_state = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ?`,
          [next === null ? 'failed' : 'pending', outcome.error, next, now, id],
        );
      }
      return this.require(id);
    });
  }

  private require(id: number): NotificationRecord {
    const n = this.get(id);
    if (!n) throw new NotFoundError('notification', id);
    return n;
  }
}

function toNotification(row: Row): NotificationRecord {
  return {
    id: Number(row.id),
    eventType: row.event_type as NotificationEventType,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    deliveryState: row.delivery_state as DeliveryState,
    attempts: Number(row.attempts),
    lastError: str(row.last_error),
    nextAttemptAt: str(row.next_attempt_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deliveredAt: str(row.delivered_at),
  };
}
