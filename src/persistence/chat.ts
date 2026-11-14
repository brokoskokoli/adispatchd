/**
 * Chat threads, replies and reminders (WI-39, schema v8).
 *
 * - `notification_threads`: one chat thread per (channel, workflow, item);
 *   `thread_ts` is the timestamp of the head message and `null` until it is
 *   posted. `thread: new` creates a further thread; the newest one is the
 *   current thread of the item.
 * - `notification_replies`: a reply that counts, from receipt until its
 *   lifecycle run (`pending → running → done|rejected|failed`). The text is
 *   kept only until the reply is processed (`done`/`rejected` clear it; a
 *   `failed` reply keeps it so a manual retry of the chain can render
 *   `{reply.text}`). `(chat_channel, ts)` is unique: a redelivered event is
 *   recorded once. Rows go with their run (FK cascade).
 * - `notification_reminders`: one reminder per `notify` with `remind_after`.
 *
 * No secrets are stored: texts that look like a secret are rejected before
 * they are recorded (only the reason is stored).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Clock, FilterNode } from '../core/index.js';
import { NotFoundError } from './errors.js';
import { all, fromJson, get, iso, num, run, str, transaction, type Row } from './sqlite.js';

/** A chat thread of (channel, workflow, item). */
export interface ChatThreadRecord {
  id: number;
  /** Configured channel ID (`notifications.channels[].id`). */
  channelId: string;
  workflowId: string;
  sourceId: string | null;
  itemKey: string;
  /** Provider channel ID (Slack `C…`). */
  chatChannel: string;
  /** Timestamp of the head message; `null` until it is posted. */
  threadTs: string | null;
  createdAt: string;
  lastMessageAt: string;
}

/** Status of a reply. */
export type ReplyStatus = 'pending' | 'running' | 'done' | 'rejected' | 'failed';

/** A recorded chat reply. */
export interface ReplyRecord {
  id: number;
  channelId: string;
  chatChannel: string;
  /** Message timestamp (Slack `ts`); unique per chat channel. */
  ts: string;
  threadId: number | null;
  workflowId: string;
  sourceId: string | null;
  itemKey: string;
  userId: string;
  /** Display name (best effort), resolved when the run starts. */
  userName: string | null;
  permalink: string | null;
  /** Plain text (already converted and shortened); `null` once processed. */
  text: string | null;
  /** Workflow snapshot taken at receipt (until the run is reserved). */
  configSnapshot: unknown;
  status: ReplyStatus;
  /** Why it was rejected / failed (no secrets, no texts). */
  reason: string | null;
  runId: string | null;
  receivedAt: string;
  updatedAt: string;
}

/** Input of {@link ReplyRepository.record}. */
export interface NewReply {
  channelId: string;
  chatChannel: string;
  ts: string;
  threadId: number;
  workflowId: string;
  sourceId: string | null;
  itemKey: string;
  userId: string;
  /** `null` for a reply rejected at receipt. */
  text: string | null;
  configSnapshot: unknown;
  status: 'pending' | 'rejected';
  reason?: string | null;
}

/** State of a reminder. */
export type ReminderState = 'pending' | 'sent' | 'cancelled' | 'skipped';

/** A reminder of a `notify` action. */
export interface ReminderRecord {
  id: number;
  /** The `workflow_notify` notification it reminds of. */
  notificationId: number;
  threadId: number;
  channelId: string;
  workflowId: string;
  sourceId: string | null;
  itemKey: string;
  dueAt: string;
  /** `remind_while` (expanded) or `null` = always. */
  filter: FilterNode | null;
  state: ReminderState;
  reason: string | null;
  /** The `workflow_reminder` notification created when it was sent. */
  reminderNotificationId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Repository for `notification_threads`. */
export class ChatThreadRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /**
   * The current thread of (channel, workflow, item) in `chatChannel`, created
   * if there is none; `mode: 'new'` always creates one (`thread: new`).
   */
  resolve(input: { channelId: string; workflowId: string; sourceId: string | null; itemKey: string; chatChannel: string; mode: 'item' | 'new' }): ChatThreadRecord {
    return transaction(this.db, () => {
      if (input.mode === 'item') {
        const row = get(
          this.db,
          `SELECT * FROM notification_threads WHERE channel_id = ? AND workflow_id = ? AND item_key = ? AND chat_channel = ?
           ORDER BY id DESC LIMIT 1`,
          [input.channelId, input.workflowId, input.itemKey, input.chatChannel],
        );
        if (row) return toThread(row);
      }
      const now = this.clock.now().toISOString();
      const res = run(
        this.db,
        `INSERT INTO notification_threads (channel_id, workflow_id, source_id, item_key, chat_channel, thread_ts, created_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        [input.channelId, input.workflowId, input.sourceId, input.itemKey, input.chatChannel, now, now],
      );
      return this.require(res.lastInsertRowid);
    });
  }

  get(id: number): ChatThreadRecord | null {
    const row = get(this.db, 'SELECT * FROM notification_threads WHERE id = ?', [id]);
    return row ? toThread(row) : null;
  }

  require(id: number): ChatThreadRecord {
    const t = this.get(id);
    if (!t) throw new NotFoundError('notification_thread', id);
    return t;
  }

  /** Thread whose head message is `threadTs` in `chatChannel`, or `null`. */
  findByTs(chatChannel: string, threadTs: string): ChatThreadRecord | null {
    const row = get(this.db, 'SELECT * FROM notification_threads WHERE chat_channel = ? AND thread_ts = ?', [chatChannel, threadTs]);
    return row ? toThread(row) : null;
  }

  /** Remember the head message (first time only; a set `thread_ts` is never replaced). */
  setThreadTs(id: number, threadTs: string): ChatThreadRecord {
    const now = this.clock.now().toISOString();
    run(this.db, 'UPDATE notification_threads SET thread_ts = COALESCE(thread_ts, ?), last_message_at = ? WHERE id = ?', [threadTs, now, id]);
    return this.require(id);
  }

  /** A message was posted into / received in the thread. */
  touch(id: number): void {
    run(this.db, 'UPDATE notification_threads SET last_message_at = ? WHERE id = ?', [this.clock.now().toISOString(), id]);
  }

  /** Threads of an item, newest first. */
  listForItem(itemKey: string): ChatThreadRecord[] {
    return all(this.db, 'SELECT * FROM notification_threads WHERE item_key = ? ORDER BY id DESC', [itemKey]).map(toThread);
  }

  /**
   * Retention (`retention.notification_threads`): delete threads without a
   * message since `olderThan` that have no pending reply, delivery or
   * reminder; replies without a run (rejected at receipt) go with them.
   * Returns the number of deleted threads.
   */
  deleteInactive(olderThan: Date | string): number {
    return transaction(this.db, () => {
      const ids = all(
        this.db,
        `SELECT t.id FROM notification_threads t WHERE t.last_message_at < ?
           AND NOT EXISTS (SELECT 1 FROM notification_replies r WHERE r.thread_id = t.id AND r.status IN ('pending','running'))
           AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.thread_id = t.id AND d.state = 'pending')
           AND NOT EXISTS (SELECT 1 FROM notification_reminders m WHERE m.thread_id = t.id AND m.state = 'pending')`,
        [iso(olderThan)],
      ).map((r) => Number(r.id));
      for (const id of ids) {
        run(this.db, 'DELETE FROM notification_replies WHERE thread_id = ? AND run_id IS NULL', [id]);
        run(this.db, 'DELETE FROM notification_threads WHERE id = ?', [id]);
      }
      return ids.length;
    });
  }
}

/** Repository for `notification_replies`. */
export class ReplyRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /**
   * Record a reply exactly once per `(chatChannel, ts)`. `created: false` if
   * the message was recorded before (redelivered event) – the existing row is returned.
   */
  record(input: NewReply): { reply: ReplyRecord; created: boolean } {
    return transaction(this.db, () => {
      const now = this.clock.now().toISOString();
      const res = run(
        this.db,
        `INSERT INTO notification_replies (channel_id, chat_channel, ts, thread_id, workflow_id, source_id, item_key, user_id, text,
           config_snapshot, status, reason, received_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_channel, ts) DO NOTHING`,
        [
          input.channelId,
          input.chatChannel,
          input.ts,
          input.threadId,
          input.workflowId,
          input.sourceId,
          input.itemKey,
          input.userId,
          input.text,
          input.configSnapshot === null || input.configSnapshot === undefined ? null : JSON.stringify(input.configSnapshot),
          input.status,
          input.reason ?? null,
          now,
          now,
        ],
      );
      const row = get(this.db, 'SELECT * FROM notification_replies WHERE chat_channel = ? AND ts = ?', [input.chatChannel, input.ts]);
      if (!row) throw new NotFoundError('notification_reply', `${input.chatChannel}/${input.ts}`);
      return { reply: toReply(row), created: res.changes === 1 };
    });
  }

  get(id: number): ReplyRecord | null {
    const row = get(this.db, 'SELECT * FROM notification_replies WHERE id = ?', [id]);
    return row ? toReply(row) : null;
  }

  require(id: number): ReplyRecord {
    const r = this.get(id);
    if (!r) throw new NotFoundError('notification_reply', id);
    return r;
  }

  /** Reply processed by the lifecycle run `runId`, or `null`. */
  forRun(runId: string): ReplyRecord | null {
    const row = get(this.db, 'SELECT * FROM notification_replies WHERE run_id = ?', [runId]);
    return row ? toReply(row) : null;
  }

  /** Oldest pending reply of (workflow, item), or `null` (FIFO per item). */
  pendingFor(workflowId: string, itemKey: string): ReplyRecord | null {
    const row = get(
      this.db,
      `SELECT * FROM notification_replies WHERE status = 'pending' AND workflow_id = ? AND item_key = ? ORDER BY id ASC LIMIT 1`,
      [workflowId, itemKey],
    );
    return row ? toReply(row) : null;
  }

  /** The oldest pending reply of every (workflow, item), oldest first. */
  listPendingHeads(limit = 100): ReplyRecord[] {
    return all(
      this.db,
      `SELECT * FROM notification_replies r WHERE r.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM notification_replies e WHERE e.status = 'pending' AND e.workflow_id = r.workflow_id
                           AND e.item_key = r.item_key AND e.id < r.id)
       ORDER BY r.id ASC LIMIT ?`,
      [limit],
    ).map(toReply);
  }

  /** `pending → running` with the reserved lifecycle run; the snapshot moves to the run. */
  assignRun(id: number, runId: string): ReplyRecord {
    run(this.db, `UPDATE notification_replies SET status = 'running', run_id = ?, config_snapshot = NULL, updated_at = ? WHERE id = ?`, [
      runId,
      this.clock.now().toISOString(),
      id,
    ]);
    return this.require(id);
  }

  /** Final status; `done`/`rejected` clear the text (processed), `failed` keeps it for a manual retry. */
  complete(id: number, status: 'done' | 'rejected' | 'failed', reason: string | null = null): ReplyRecord {
    run(
      this.db,
      `UPDATE notification_replies SET status = ?, reason = ?, text = CASE WHEN ? = 'failed' THEN text ELSE NULL END,
         config_snapshot = NULL, updated_at = ? WHERE id = ?`,
      [status, reason, status, this.clock.now().toISOString(), id],
    );
    return this.require(id);
  }

  /** Display name and permalink resolved when the run starts (best effort). */
  setAuthorInfo(id: number, info: { userName: string | null; permalink: string | null }): ReplyRecord {
    run(this.db, 'UPDATE notification_replies SET user_name = ?, permalink = ?, updated_at = ? WHERE id = ?', [
      info.userName,
      info.permalink,
      this.clock.now().toISOString(),
      id,
    ]);
    return this.require(id);
  }

  /** Replies of an item (history), newest first. */
  listForItem(itemKey: string, limit = 500): ReplyRecord[] {
    return all(this.db, 'SELECT * FROM notification_replies WHERE item_key = ? ORDER BY received_at DESC, id DESC LIMIT ?', [itemKey, limit]).map(
      toReply,
    );
  }

  /** Number of replies per status. */
  countByStatus(): Record<ReplyStatus, number> {
    const counts: Record<ReplyStatus, number> = { pending: 0, running: 0, done: 0, rejected: 0, failed: 0 };
    for (const row of all(this.db, 'SELECT status AS s, COUNT(*) AS n FROM notification_replies GROUP BY status')) {
      counts[row.s as ReplyStatus] = Number(row.n);
    }
    return counts;
  }
}

/** Repository for `notification_reminders`. */
export class ReminderRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** Schedule a reminder (one per `notify`). */
  create(input: {
    notificationId: number;
    threadId: number;
    channelId: string;
    workflowId: string;
    sourceId: string | null;
    itemKey: string;
    dueAt: Date | string;
    filter: FilterNode | null;
  }): ReminderRecord {
    const now = this.clock.now().toISOString();
    const res = run(
      this.db,
      `INSERT INTO notification_reminders (notification_id, thread_id, channel_id, workflow_id, source_id, item_key, due_at, filter_json,
         state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        input.notificationId,
        input.threadId,
        input.channelId,
        input.workflowId,
        input.sourceId,
        input.itemKey,
        iso(input.dueAt),
        input.filter ? JSON.stringify(input.filter) : null,
        now,
        now,
      ],
    );
    return this.require(res.lastInsertRowid);
  }

  get(id: number): ReminderRecord | null {
    const row = get(this.db, 'SELECT * FROM notification_reminders WHERE id = ?', [id]);
    return row ? toReminder(row) : null;
  }

  require(id: number): ReminderRecord {
    const r = this.get(id);
    if (!r) throw new NotFoundError('notification_reminder', id);
    return r;
  }

  /** Reminder of a `workflow_notify` notification, or `null`. */
  forNotification(notificationId: number): ReminderRecord | null {
    const row = get(this.db, 'SELECT * FROM notification_reminders WHERE notification_id = ?', [notificationId]);
    return row ? toReminder(row) : null;
  }

  /** Pending reminders due at `now`, oldest first. */
  listDue(now: Date, limit = 50): ReminderRecord[] {
    return all(this.db, `SELECT * FROM notification_reminders WHERE state = 'pending' AND due_at <= ? ORDER BY due_at ASC, id ASC LIMIT ?`, [
      iso(now),
      limit,
    ]).map(toReminder);
  }

  /** Earliest due time of a pending reminder, or `null`. */
  nextDue(): string | null {
    return str(get(this.db, `SELECT MIN(due_at) AS t FROM notification_reminders WHERE state = 'pending'`)?.t);
  }

  /** A reply arrived in the thread: cancel its pending reminders. Returns the number cancelled. */
  cancelForThread(threadId: number, reason: string): number {
    return run(this.db, `UPDATE notification_reminders SET state = 'cancelled', reason = ?, updated_at = ? WHERE thread_id = ? AND state = 'pending'`, [
      reason,
      this.clock.now().toISOString(),
      threadId,
    ]).changes;
  }

  /** Finish a pending reminder (`sent` with its notification, or `skipped` with the reason). `false` if no longer pending. */
  complete(id: number, state: 'sent' | 'skipped', reason: string | null, reminderNotificationId: number | null = null): boolean {
    return (
      run(
        this.db,
        `UPDATE notification_reminders SET state = ?, reason = ?, reminder_notification_id = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
        [state, reason, reminderNotificationId, this.clock.now().toISOString(), id],
      ).changes === 1
    );
  }
}

function toThread(row: Row): ChatThreadRecord {
  return {
    id: Number(row.id),
    channelId: String(row.channel_id),
    workflowId: String(row.workflow_id),
    sourceId: str(row.source_id),
    itemKey: String(row.item_key),
    chatChannel: String(row.chat_channel),
    threadTs: str(row.thread_ts),
    createdAt: String(row.created_at),
    lastMessageAt: String(row.last_message_at),
  };
}

function toReply(row: Row): ReplyRecord {
  return {
    id: Number(row.id),
    channelId: String(row.channel_id),
    chatChannel: String(row.chat_channel),
    ts: String(row.ts),
    threadId: num(row.thread_id),
    workflowId: String(row.workflow_id),
    sourceId: str(row.source_id),
    itemKey: String(row.item_key),
    userId: String(row.user_id),
    userName: str(row.user_name),
    permalink: str(row.permalink),
    text: str(row.text),
    configSnapshot: fromJson(row.config_snapshot),
    status: row.status as ReplyStatus,
    reason: str(row.reason),
    runId: str(row.run_id),
    receivedAt: String(row.received_at),
    updatedAt: String(row.updated_at),
  };
}

function toReminder(row: Row): ReminderRecord {
  return {
    id: Number(row.id),
    notificationId: Number(row.notification_id),
    threadId: Number(row.thread_id),
    channelId: String(row.channel_id),
    workflowId: String(row.workflow_id),
    sourceId: str(row.source_id),
    itemKey: String(row.item_key),
    dueAt: String(row.due_at),
    filter: fromJson<FilterNode>(row.filter_json),
    state: row.state as ReminderState,
    reason: str(row.reason),
    reminderNotificationId: num(row.reminder_notification_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
