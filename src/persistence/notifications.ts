/**
 * Central system notifications (Spec §18): persisted first, delivered
 * asynchronously by WI-10; delivery attempts are stored.
 *
 * Since schema v2 every notification may have one delivery row per channel
 * (`notification_deliveries`). For such notifications `deliveryState`,
 * `attempts` and `lastError` are the aggregate over its deliveries:
 * `pending` while any delivery is pending, else `failed` if any failed,
 * else `delivered` (also when no channel was subscribed).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Clock, NotificationType } from '../core/index.js';
import { NotFoundError } from './errors.js';
import { all, get, iso, run, str, transaction, type Params, type Row } from './sqlite.js';

/** Delivery state of a notification. */
export type DeliveryState = 'pending' | 'delivered' | 'failed';

/** A persisted notification. Payload must not contain secrets. */
export interface NotificationRecord {
  id: number;
  /** Orchestrator event or explicit message (WI-39: `workflow_notify`, `workflow_reminder`, `reply_feedback`). */
  eventType: NotificationType;
  payload: Record<string, unknown>;
  deliveryState: DeliveryState;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

/** Delivery of one notification to one channel (schema v2). */
export interface NotificationDeliveryRecord {
  id: number;
  notificationId: number;
  channelId: string;
  state: DeliveryState;
  attempts: number;
  /** Redacted error text of the last failed attempt. */
  lastError: string | null;
  /** HTTP status of the last attempt, if any. */
  lastStatus: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Chat thread the message goes into (WI-39); `null` = top-level / webhook. */
  threadId: number | null;
  /** Timestamp of the posted chat message (WI-39), once delivered. */
  messageTs: string | null;
}

/** Target of one delivery: a channel ID, optionally with the chat thread (WI-39). */
export type DeliveryTarget = string | { channelId: string; threadId?: number | null };

/** Outcome of one delivery attempt. */
export type DeliveryAttemptOutcome =
  | { success: true; status?: number | null; messageTs?: string | null }
  | { success: false; error: string; status?: number | null; nextAttemptAt: Date | string | null };

/** Repository for `notifications`. */
export class NotificationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** Persist a new notification in state `pending` (due immediately). */
  create(eventType: NotificationType, payload: Record<string, unknown>, dedupeKey: string | null = null): NotificationRecord {
    const now = this.clock.now().toISOString();
    const res = run(
      this.db,
      `INSERT INTO notifications (event_type, payload_json, delivery_state, attempts, next_attempt_at, created_at, updated_at, dedupe_key)
       VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
      [eventType, JSON.stringify(payload), now, now, now, dedupeKey],
    );
    return this.require(res.lastInsertRowid);
  }

  /** Notification with this dedupe key (WI-39: `notify` per run and action), or `null`. */
  getByDedupeKey(dedupeKey: string): NotificationRecord | null {
    const row = get(this.db, 'SELECT * FROM notifications WHERE dedupe_key = ?', [dedupeKey]);
    return row ? toNotification(row) : null;
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

  /**
   * Persist a notification together with one `pending` delivery per channel
   * (one transaction). Without channels the notification is stored as
   * `delivered` (nothing to deliver).
   */
  createWithDeliveries(
    eventType: NotificationType,
    payload: Record<string, unknown>,
    targets: readonly DeliveryTarget[],
    options: { dedupeKey?: string | null } = {},
  ): { notification: NotificationRecord; deliveries: NotificationDeliveryRecord[] } {
    return transaction(this.db, () => {
      const created = this.create(eventType, payload, options.dedupeKey ?? null);
      const now = this.clock.now().toISOString();
      const seen = new Set<string>();
      for (const target of targets) {
        const { channelId, threadId } = typeof target === 'string' ? { channelId: target, threadId: null } : target;
        if (seen.has(channelId)) continue;
        seen.add(channelId);
        run(
          this.db,
          `INSERT INTO notification_deliveries (notification_id, channel_id, state, attempts, next_attempt_at, created_at, updated_at, thread_id)
           VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
          [created.id, channelId, now, now, now, threadId ?? null],
        );
      }
      this.refreshAggregate(created.id);
      return { notification: this.require(created.id), deliveries: this.listDeliveries(created.id) };
    });
  }

  /** Deliveries of a notification (by channel ID). */
  listDeliveries(notificationId: number): NotificationDeliveryRecord[] {
    return all(this.db, 'SELECT * FROM notification_deliveries WHERE notification_id = ? ORDER BY channel_id ASC, id ASC', [
      notificationId,
    ]).map(toDelivery);
  }

  /** Delivery by ID or `null`. */
  getDelivery(id: number): NotificationDeliveryRecord | null {
    const row = get(this.db, 'SELECT * FROM notification_deliveries WHERE id = ?', [id]);
    return row ? toDelivery(row) : null;
  }

  /**
   * Pending deliveries due at `now`, oldest first. A delivery into a chat
   * thread (WI-39) waits while an older delivery of the same thread is still
   * pending (messages of a thread are delivered in order; the head message is posted once).
   */
  listDueDeliveries(now: Date, limit = 100): NotificationDeliveryRecord[] {
    return all(
      this.db,
      `SELECT * FROM notification_deliveries d WHERE d.state = 'pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
         AND ${NOT_WAITING_SQL}
       ORDER BY d.next_attempt_at ASC, d.id ASC LIMIT ?`,
      [iso(now), limit],
    ).map(toDelivery);
  }

  /** Earliest `next_attempt_at` of all pending deliveries that do not wait for an older one, or `null`. */
  nextDeliveryDue(): string | null {
    const row = get(this.db, `SELECT MIN(d.next_attempt_at) AS t FROM notification_deliveries d WHERE d.state = 'pending' AND ${NOT_WAITING_SQL}`);
    return str(row?.t);
  }

  /** Number of notifications per aggregate state. */
  countByState(): Record<DeliveryState, number> {
    const counts: Record<DeliveryState, number> = { pending: 0, delivered: 0, failed: 0 };
    for (const row of all(this.db, 'SELECT delivery_state AS s, COUNT(*) AS n FROM notifications GROUP BY delivery_state')) {
      counts[row.s as DeliveryState] = Number(row.n);
    }
    return counts;
  }

  /**
   * Record one attempt of a delivery (success → `delivered`; failure → stays
   * `pending` with `nextAttemptAt`, or `failed` when it is `null`) and update
   * the notification's aggregate. `error` must already be redacted.
   */
  recordDeliveryAttempt(deliveryId: number, outcome: DeliveryAttemptOutcome): NotificationDeliveryRecord {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(deliveryId);
      if (!delivery) throw new NotFoundError('notification_delivery', deliveryId);
      const now = this.clock.now().toISOString();
      const status = outcome.status ?? null;
      if (outcome.success) {
        run(
          this.db,
          `UPDATE notification_deliveries SET state = 'delivered', attempts = attempts + 1, last_status = ?, delivered_at = ?,
             next_attempt_at = NULL, updated_at = ?, message_ts = COALESCE(?, message_ts) WHERE id = ?`,
          [status, now, now, outcome.messageTs ?? null, deliveryId],
        );
      } else {
        const next = outcome.nextAttemptAt === null ? null : iso(outcome.nextAttemptAt);
        run(
          this.db,
          `UPDATE notification_deliveries SET state = ?, attempts = attempts + 1, last_error = ?, last_status = ?, next_attempt_at = ?,
             updated_at = ? WHERE id = ?`,
          [next === null ? 'failed' : 'pending', outcome.error, status, next, now, deliveryId],
        );
      }
      this.refreshAggregate(delivery.notificationId);
      return this.getDelivery(deliveryId) as NotificationDeliveryRecord;
    });
  }

  /** Re-queue a `failed` delivery (manual retry); returns `null` if it is not `failed`. */
  requeueDelivery(deliveryId: number): NotificationDeliveryRecord | null {
    return transaction(this.db, () => {
      const delivery = this.getDelivery(deliveryId);
      if (!delivery) throw new NotFoundError('notification_delivery', deliveryId);
      if (delivery.state !== 'failed') return null;
      const now = this.clock.now().toISOString();
      run(this.db, `UPDATE notification_deliveries SET state = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?`, [
        now,
        now,
        deliveryId,
      ]);
      this.refreshAggregate(delivery.notificationId);
      return this.getDelivery(deliveryId);
    });
  }

  /** Recompute the aggregate columns of a notification from its deliveries. */
  private refreshAggregate(notificationId: number): void {
    const deliveries = this.listDeliveries(notificationId);
    const now = this.clock.now().toISOString();
    const state: DeliveryState = deliveries.some((d) => d.state === 'pending')
      ? 'pending'
      : deliveries.some((d) => d.state === 'failed')
        ? 'failed'
        : 'delivered';
    const attempts = deliveries.reduce((sum, d) => sum + d.attempts, 0);
    const lastError =
      [...deliveries]
        .filter((d) => d.lastError !== null && d.state !== 'delivered')
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]?.lastError ?? null;
    const nextAttempt =
      deliveries
        .filter((d) => d.state === 'pending' && d.nextAttemptAt !== null)
        .map((d) => d.nextAttemptAt as string)
        .sort()[0] ?? null;
    const deliveredAt =
      state === 'delivered'
        ? (deliveries
            .map((d) => d.deliveredAt)
            .filter((t): t is string => t !== null)
            .sort()
            .at(-1) ?? null)
        : null;
    run(
      this.db,
      `UPDATE notifications SET delivery_state = ?, attempts = ?, last_error = ?, next_attempt_at = ?, delivered_at = ?, updated_at = ?
       WHERE id = ?`,
      [state, attempts, lastError, nextAttempt, deliveredAt, now, notificationId],
    );
  }

  private require(id: number): NotificationRecord {
    const n = this.get(id);
    if (!n) throw new NotFoundError('notification', id);
    return n;
  }
}

/** Delivery `d` does not wait for an older pending delivery of the same chat thread. */
const NOT_WAITING_SQL = `(d.thread_id IS NULL OR NOT EXISTS (SELECT 1 FROM notification_deliveries e
    WHERE e.thread_id = d.thread_id AND e.state = 'pending' AND e.id < d.id))`;

function toDelivery(row: Row): NotificationDeliveryRecord {
  return {
    id: Number(row.id),
    notificationId: Number(row.notification_id),
    channelId: String(row.channel_id),
    state: row.state as DeliveryState,
    attempts: Number(row.attempts),
    lastError: str(row.last_error),
    lastStatus: row.last_status === null || row.last_status === undefined ? null : Number(row.last_status),
    nextAttemptAt: str(row.next_attempt_at),
    deliveredAt: str(row.delivered_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : Number(row.thread_id),
    messageTs: str(row.message_ts),
  };
}

function toNotification(row: Row): NotificationRecord {
  return {
    id: Number(row.id),
    eventType: row.event_type as NotificationType,
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
