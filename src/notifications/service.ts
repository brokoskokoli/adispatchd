/**
 * Central orchestrator notifications (Spec §18): `retry_block_created`,
 * `lifecycle_action_failed`, `recovery_failed`, `retry_block_cleared` (WI-30, opt-in),
 * and explicit chat messages (WI-39): `workflow_notify` (lifecycle action
 * `notify`), `workflow_reminder` (`remind_after`) and `reply_feedback`.
 *
 * Channels: `webhook` (JSON `POST`) and `slack` (Web API `chat.postMessage`).
 * On a Slack channel, messages about an item go into the thread of
 * (workflow, item): the first delivery posts the head message and stores its
 * `ts` before it posts its own text as a reply; deliveries of one thread are
 * delivered in order (a younger one waits for an older pending one), so a
 * thread never gets two heads and a retry after a partial success does not
 * post the head again.
 *
 * Flow: {@link NotificationService.notify} persists the notification plus one
 * delivery row per subscribed channel synchronously (a few SQLite writes,
 * never network I/O) and wakes the dispatcher; the dispatcher delivers due
 * deliveries asynchronously as JSON `POST` to the webhook channels with a
 * timeout, retries with backoff and stores every attempt. Delivery problems
 * are logged and persisted, never propagated: orchestration must not hang or
 * fail because a webhook is down.
 *
 * Secrets: webhook URLs (literal or from env) and header values are
 * registered with the shared {@link SecretRedactor}; error texts never
 * contain the URL and are redacted before they are stored or logged.
 */
import {
  errorMessage,
  noopLogger,
  OrchestratorError,
  SecretRedactor,
  systemClock,
  systemTimers,
  type ChatNotifier,
  type Clock,
  type FetchLike,
  type Logger,
  type NotificationEventType,
  type NotificationType,
  type Notifier,
  type SourceAdapter,
  type TimerHandle,
  type Timers,
  type TriValue,
  type WorkflowMessage,
} from '../core/index.js';
import type { NotificationChannelConfig, NotificationsConfig, SlackChannelConfig, WebhookChannelConfig } from '../config/index.js';
import { collectFields, createItemFieldSource, evaluateFilter } from '../filters/index.js';
import type {
  ChatThreadRecord,
  DeliveryTarget,
  NotificationDeliveryRecord,
  NotificationRecord,
  ReminderRecord,
  Repositories,
} from '../persistence/index.js';
import { parseRetryAfter, SlackApiError, SlackWebClient } from './slack-api.js';
import { messageText, threadHeadText } from './slack-text.js';

/** Default backoff between delivery attempts (attempt n failed → wait `delays[n-1]`). */
export const DEFAULT_NOTIFICATION_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];
/** Default request timeout of one webhook call. */
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 10_000;
/** Max deliveries processed per dispatcher pass. */
const BATCH = 50;
/** Upper bound for the dispatcher's wake-up timer (re-checks the DB at least this often). */
const MAX_TIMER_MS = 60 * 60_000;

/** Notification with its channel deliveries (API / SSE shape). */
export interface NotificationView extends NotificationRecord {
  deliveries: NotificationDeliveryRecord[];
}

/** Options of {@link NotificationService}. */
export interface NotificationServiceOptions {
  repositories: Pick<Repositories, 'notifications' | 'threads' | 'reminders' | 'transaction'>;
  /** Live notification settings (`config.global.notifications`). */
  settings: () => NotificationsConfig;
  /** Environment for `url_env` / `headers_env` (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** HTTP client (default global `fetch`). */
  fetch?: FetchLike;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** Shared redactor (URLs/header values are registered here). */
  redactor?: SecretRedactor;
  /** Request timeout per attempt (default 10 s). */
  timeoutMs?: number;
  /** Backoff delays; max attempts = `delays.length + 1` (default 5 s, 30 s, 2 min, 10 min, 30 min). */
  retryDelaysMs?: readonly number[];
  /** Called (after commit) whenever a notification or one of its deliveries changed (SSE). */
  onChange?: (notification: NotificationView) => void;
  /** Slack Web API client (WI-39); default over `fetch`. */
  slack?: SlackWebClient;
  /** Source adapters (WI-39): reminders re-read the item to evaluate `remind_while`. */
  sources?: (sourceId: string) => SourceAdapter | undefined;
  /** Upper bound of one `remind_while` evaluation (item read + fields), default 15 s; the dispatcher never waits longer. */
  reminderTimeoutMs?: number;
}

/** Default upper bound of one reminder evaluation. */
export const DEFAULT_REMINDER_TIMEOUT_MS = 15_000;

interface DeliveryFailure {
  message: string;
  status: number | null;
  retryable: boolean;
  /** Wait demanded by the receiver (HTTP 429 `Retry-After`). */
  retryAfterMs?: number | null;
}

/** Outcome of one delivery attempt. */
interface PostResult {
  failure: DeliveryFailure | null;
  status: number | null;
  /** Timestamp of the posted chat message (Slack). */
  messageTs?: string | null;
}

/** See module docs. Implements the core {@link Notifier} and {@link ChatNotifier} contracts. */
export class NotificationService implements Notifier, ChatNotifier {
  private readonly repos: NotificationServiceOptions['repositories'];
  private readonly slack: SlackWebClient;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly redactor: SecretRedactor;
  private readonly fetchFn: FetchLike;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly delays: readonly number[];
  private started = false;
  private stopped = false;
  private timer: TimerHandle | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private readonly inflight = new Set<AbortController>();

  constructor(private readonly options: NotificationServiceOptions) {
    this.repos = options.repositories;
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'notifications' });
    this.redactor = options.redactor ?? new SecretRedactor();
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
    this.delays = options.retryDelaysMs ?? DEFAULT_NOTIFICATION_RETRY_DELAYS_MS;
    this.slack =
      options.slack ??
      new SlackWebClient({ fetch: this.fetchFn, timers: this.timers, redactor: this.redactor, timeoutMs: this.timeoutMs });
    this.registerChannelSecrets();
  }

  /** Max attempts per delivery. */
  get maxAttempts(): number {
    return this.delays.length + 1;
  }

  /**
   * Persist a notification (if its event type is enabled) and schedule the
   * delivery. Synchronous, never throws.
   */
  notify(type: NotificationEventType, payload: Record<string, unknown>): void {
    try {
      const settings = this.options.settings();
      if (!settings.on.includes(type)) {
        this.logger.debug('notification event disabled', { type });
        return;
      }
      const channels = settings.channels.filter((c) => c.on.includes(type));
      const { notification, deliveries } = this.repos.transaction(() =>
        this.repos.notifications.createWithDeliveries(type, payload, channels.map((c) => this.eventTarget(c, payload))),
      );
      this.logger.info('notification recorded', { id: notification.id, type, channels: channels.map((c) => c.id) });
      this.emit({ ...notification, deliveries });
      if (deliveries.length > 0) this.kick();
    } catch (err) {
      this.logger.error('failed to record notification', { type, error: errorMessage(err) });
    }
  }

  /**
   * Target of an orchestrator event on a channel (WI-39, P4): on a Slack
   * channel an event with an item goes into the thread of (workflow, item),
   * created on demand; otherwise top-level / webhook.
   */
  private eventTarget(channel: NotificationChannelConfig, payload: Record<string, unknown>): DeliveryTarget {
    if (channel.type !== 'slack') return channel.id;
    const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
    const itemKey = typeof payload.itemKey === 'string' ? payload.itemKey : typeof payload.sourceItemKey === 'string' ? payload.sourceItemKey : null;
    if (!workflowId || !itemKey) return channel.id;
    const thread = this.repos.threads.resolve({
      channelId: channel.id,
      workflowId,
      sourceId: itemKey.includes(':') ? itemKey.slice(0, itemKey.indexOf(':')) : null,
      itemKey,
      chatChannel: channel.channel,
      mode: 'item',
    });
    return { channelId: channel.id, threadId: thread.id };
  }

  /**
   * Record a `notify` message (WI-39, {@link ChatNotifier}): one notification
   * of type `workflow_notify` with exactly one delivery to the named channel
   * (neither `notifications.on` nor the channel's `on` filter it), the thread
   * of (workflow, item) (or a new one) and an optional reminder – all in one
   * transaction. Idempotent per `dedupeKey`. Synchronous, no network I/O.
   *
   * @throws OrchestratorError `notify_channel_unknown`, `notify_channel_type`
   */
  enqueueMessage(message: WorkflowMessage): { notificationId: number; created: boolean } {
    const existing = this.repos.notifications.getByDedupeKey(message.dedupeKey);
    if (existing) return { notificationId: existing.id, created: false };
    const channel = this.options.settings().channels.find((c) => c.id === message.channelId);
    if (!channel) {
      throw new OrchestratorError('notify_channel_unknown', `Notification channel "${message.channelId}" is not configured`, {
        details: { channel: message.channelId },
      });
    }
    if (channel.type !== 'slack') {
      throw new OrchestratorError('notify_channel_type', `Notification channel "${message.channelId}" is of type "${channel.type}", "notify" needs "slack"`, {
        details: { channel: message.channelId },
      });
    }
    const payload: Record<string, unknown> = {
      workflowId: message.workflowId,
      workflowName: message.workflowName,
      runId: message.runId,
      itemKey: message.item?.key ?? null,
      sourceId: message.item?.sourceId ?? null,
      itemUrl: message.item?.url ?? null,
      itemTitle: message.item?.title ?? null,
      thread: message.item ? message.thread : null,
      text: this.redactor.redact(message.text),
    };
    const { notification, deliveries } = this.repos.transaction(() => {
      const thread = message.item
        ? this.repos.threads.resolve({
            channelId: channel.id,
            workflowId: message.workflowId,
            sourceId: message.item.sourceId,
            itemKey: message.item.key,
            chatChannel: channel.channel,
            mode: message.thread,
          })
        : null;
      const created = this.repos.notifications.createWithDeliveries('workflow_notify', payload, [{ channelId: channel.id, threadId: thread?.id ?? null }], {
        dedupeKey: message.dedupeKey,
      });
      if (thread && message.reminder && message.item) {
        this.repos.reminders.create({
          notificationId: created.notification.id,
          threadId: thread.id,
          channelId: channel.id,
          workflowId: message.workflowId,
          sourceId: message.item.sourceId,
          itemKey: message.item.key,
          dueAt: new Date(this.clock.now().getTime() + message.reminder.afterMs),
          filter: message.reminder.filter,
        });
      }
      return created;
    });
    this.logger.info('chat message recorded', { id: notification.id, channel: channel.id, workflowId: message.workflowId, runId: message.runId });
    this.emit({ ...notification, deliveries });
    this.kick();
    return { notificationId: notification.id, created: true };
  }

  /**
   * Short answer in a reply's thread (WI-39: rejected or failed reply):
   * notification `reply_feedback` with one delivery into the thread. Never throws.
   */
  enqueueReplyFeedback(input: { channelId: string; threadId: number | null; workflowId: string; itemKey: string; replyId: number; runId: string | null; text: string }): void {
    try {
      const payload = {
        workflowId: input.workflowId,
        itemKey: input.itemKey,
        replyId: input.replyId,
        runId: input.runId,
        text: this.redactor.redact(input.text),
      };
      const { notification, deliveries } = this.repos.notifications.createWithDeliveries(
        'reply_feedback',
        payload,
        [{ channelId: input.channelId, threadId: input.threadId }],
        { dedupeKey: `reply_feedback:${input.replyId}:${input.runId ?? 'none'}` },
      );
      this.emit({ ...notification, deliveries });
      this.kick();
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) return; // answered before
      this.logger.error('failed to record reply feedback', { replyId: input.replyId, error: errorMessage(err) });
    }
  }

  /** Start dispatching (also delivers notifications left pending by a previous process). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.kick();
  }

  /**
   * Stop the dispatcher: no new attempts; in-flight requests get `graceMs`
   * to finish, then they are aborted (they stay `pending` and are retried by
   * the next process).
   */
  async stop(graceMs = 2_000): Promise<void> {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    const running = this.running;
    if (!running) return;
    let graceTimer: TimerHandle | undefined;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        graceTimer = this.timers.setTimeout(() => {
          for (const c of this.inflight) c.abort(new Error('notification service stopping'));
          // WI-39: Slack calls too – an aborted delivery stays pending (no attempt recorded) and nothing is written
          // after the dispatcher pass ended (the caller closes the database afterwards).
          this.slack.abortAll();
          resolve();
        }, graceMs);
      }),
    ]);
    if (graceTimer) this.timers.clearTimeout(graceTimer);
    await running.catch(() => undefined);
  }

  /** Resolves when no dispatcher pass is running (tests). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  /** Notifications (newest first) with their deliveries. */
  list(options: { state?: NotificationRecord['deliveryState']; limit?: number; offset?: number } = {}): NotificationView[] {
    return this.repos.notifications.list(options).map((n) => ({ ...n, deliveries: this.repos.notifications.listDeliveries(n.id) }));
  }

  /** One notification with deliveries, or `null`. */
  get(id: number): NotificationView | null {
    const n = this.repos.notifications.get(id);
    return n ? { ...n, deliveries: this.repos.notifications.listDeliveries(id) } : null;
  }

  /**
   * Manually re-queue all `failed` deliveries of a notification. Returns the
   * updated notification, or `null` if it does not exist.
   */
  retry(id: number): { notification: NotificationView; requeued: number } | null {
    const n = this.repos.notifications.get(id);
    if (!n) return null;
    let requeued = 0;
    for (const d of this.repos.notifications.listDeliveries(id)) {
      if (d.state === 'failed' && this.repos.notifications.requeueDelivery(d.id)) requeued++;
    }
    const view = this.get(id) as NotificationView;
    if (requeued > 0) {
      this.emit(view);
      this.kick();
    }
    return { notification: view, requeued };
  }

  /** Wake the dispatcher (no-op before `start()` / after `stop()`). */
  kick(): void {
    if (!this.started || this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pass = this.dispatch()
      .catch((err: unknown) => this.logger.error('notification dispatcher failed', { error: errorMessage(err) }))
      .finally(() => {
        if (this.running === pass) this.running = undefined;
        if (this.again) {
          this.again = false;
          this.kick();
        } else {
          this.armTimer();
        }
      });
    this.running = pass;
  }

  private armTimer(): void {
    if (this.stopped) return;
    const candidates = [this.repos.notifications.nextDeliveryDue(), this.repos.reminders.nextDue()].filter((t): t is string => t !== null);
    if (candidates.length === 0) return;
    const next = candidates.sort()[0] as string;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(next) - this.clock.now().getTime()));
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, delay);
  }

  private async dispatch(): Promise<void> {
    await this.processReminders();
    for (;;) {
      if (this.stopped) return;
      const due = this.repos.notifications.listDueDeliveries(this.clock.now(), BATCH);
      if (due.length === 0) return;
      // A delivered/failed thread message may release the next one of its thread: query again.
      let released = false;
      for (const delivery of due) {
        if (this.stopped) return;
        const after = await this.deliver(delivery);
        if (delivery.threadId !== null && after !== 'pending') released = true;
      }
      if (due.length < BATCH && !released) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Reminders (WI-39)

  /**
   * Send due reminders: once per `notify`, only if `remind_while` (snapshot
   * of the filter) holds for the freshly read item; `false` or `unknown` →
   * skipped (logged), the reminder is not repeated.
   */
  private async processReminders(): Promise<void> {
    for (const reminder of this.repos.reminders.listDue(this.clock.now())) {
      if (this.stopped) return;
      try {
        const verdict = await this.evaluateReminder(reminder);
        if (this.repos.reminders.get(reminder.id)?.state !== 'pending') continue; // cancelled meanwhile (reply)
        if (verdict.value !== true) {
          this.repos.reminders.complete(reminder.id, 'skipped', verdict.reason);
          const log = verdict.value === 'unknown' ? 'warn' : 'info';
          this.logger[log]('reminder skipped', { reminderId: reminder.id, workflowId: reminder.workflowId, itemKey: reminder.itemKey, reason: verdict.reason });
          continue;
        }
        const original = this.repos.notifications.get(reminder.notificationId);
        const created = this.repos.transaction(() => {
          const n = this.repos.notifications.createWithDeliveries(
            'workflow_reminder',
            { ...(original?.payload ?? {}), reminderId: reminder.id, notificationId: reminder.notificationId },
            [{ channelId: reminder.channelId, threadId: reminder.threadId }],
            { dedupeKey: `reminder:${reminder.id}` },
          );
          this.repos.reminders.complete(reminder.id, 'sent', null, n.notification.id);
          return n;
        });
        this.logger.info('reminder recorded', { reminderId: reminder.id, notificationId: created.notification.id });
        this.emit({ ...created.notification, deliveries: created.deliveries });
      } catch (err) {
        this.logger.error('reminder failed', { reminderId: reminder.id, error: errorMessage(err) });
        this.repos.reminders.complete(reminder.id, 'skipped', `failed: ${this.redactor.redact(errorMessage(err))}`);
      }
    }
  }

  /**
   * `remind_while` of a reminder, bounded by {@link NotificationServiceOptions.reminderTimeoutMs}: a slow source must
   * not hold up the deliveries (the dispatcher is serial). Timeout → `unknown` (no reminder, logged); the read is aborted.
   */
  private async evaluateReminder(reminder: ReminderRecord): Promise<{ value: TriValue; reason: string | null }> {
    const limit = this.options.reminderTimeoutMs ?? DEFAULT_REMINDER_TIMEOUT_MS;
    const controller = new AbortController();
    this.inflight.add(controller);
    let timer: TimerHandle | undefined;
    const timeout = new Promise<{ value: TriValue; reason: string | null }>((resolve) => {
      timer = this.timers.setTimeout(() => {
        controller.abort(new Error('timeout'));
        resolve({ value: 'unknown', reason: `item could not be evaluated within ${limit} ms` });
      }, limit);
    });
    try {
      return await Promise.race([this.evaluateReminderNow(reminder, controller.signal), timeout]);
    } finally {
      if (timer) this.timers.clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  private async evaluateReminderNow(reminder: ReminderRecord, signal: AbortSignal): Promise<{ value: TriValue; reason: string | null }> {
    const channel = this.options.settings().channels.find((c) => c.id === reminder.channelId);
    if (!channel) return { value: false, reason: `channel '${reminder.channelId}' is no longer configured` };
    if (!reminder.filter) return { value: true, reason: null };
    const sourceId = reminder.sourceId ?? reminder.itemKey.slice(0, reminder.itemKey.indexOf(':'));
    const adapter = this.options.sources?.(sourceId);
    if (!adapter) return { value: 'unknown', reason: `source '${sourceId}' is not available` };
    let item;
    try {
      item = await adapter.getItem(reminder.itemKey.slice(sourceId.length + 1), { signal });
    } catch (err) {
      return { value: 'unknown', reason: `item could not be read: ${this.redactor.redact(errorMessage(err))}` };
    }
    if (!item) return { value: false, reason: 'item no longer exists' };
    const fields = createItemFieldSource(item, {
      definitions: adapter.fieldDefinitions(),
      resolveFields: (i, f) => adapter.resolveFields(i, f, { signal }),
      wantedFields: collectFields(reminder.filter),
    });
    const result = await evaluateFilter(reminder.filter, fields);
    if (result.value === true) return { value: true, reason: null };
    return { value: result.value, reason: result.value === false ? 'item no longer matches remind_while' : 'remind_while is unknown for the item' };
  }

  /** Deliver once; returns the delivery state afterwards. */
  private async deliver(delivery: NotificationDeliveryRecord): Promise<NotificationDeliveryRecord['state']> {
    const notification = this.repos.notifications.get(delivery.notificationId);
    if (!notification) return 'failed';
    const attempt = delivery.attempts + 1;
    let failure: DeliveryFailure | null;
    let status: number | null = null;
    let messageTs: string | null = null;
    const channel = this.options.settings().channels.find((c) => c.id === delivery.channelId);
    if (!channel) {
      failure = { message: `notification channel '${delivery.channelId}' is no longer configured`, status: null, retryable: false };
    } else {
      const result = channel.type === 'slack' ? await this.postSlack(channel, notification, delivery) : await this.post(channel, notification);
      failure = result.failure;
      status = result.status;
      messageTs = result.messageTs ?? null;
    }
    if (this.stopped && failure?.message === 'aborted') return 'pending'; // stays pending for the next process
    try {
      let updated: NotificationDeliveryRecord;
      if (!failure) {
        updated = this.repos.notifications.recordDeliveryAttempt(delivery.id, { success: true, status, messageTs });
        this.logger.info('notification delivered', { id: notification.id, channel: delivery.channelId, attempt });
      } else {
        const base = failure.retryable && attempt < this.maxAttempts ? (this.delays[attempt - 1] ?? null) : null;
        // HTTP 429: never retry earlier than the receiver asked for.
        const delay = base === null ? null : Math.max(base, failure.retryAfterMs ?? 0);
        const nextAttemptAt = delay === null ? null : new Date(this.clock.now().getTime() + delay);
        const error = this.redactor.redact(failure.message);
        updated = this.repos.notifications.recordDeliveryAttempt(delivery.id, {
          success: false,
          error,
          status: failure.status,
          nextAttemptAt,
        });
        this.logger.warn('notification delivery failed', {
          id: notification.id,
          channel: delivery.channelId,
          attempt,
          error,
          final: updated.state === 'failed',
          nextAttemptAt: updated.nextAttemptAt,
        });
      }
      const view = this.get(notification.id);
      if (view) this.emit(view);
      return updated.state;
    } catch (err) {
      this.logger.error('failed to record notification delivery attempt', { id: delivery.id, error: errorMessage(err) });
      return 'pending';
    }
  }

  /**
   * Slack delivery (WI-39): with a thread, post its head message first if it
   * has none yet (its `ts` is stored at once, so a retry never posts it
   * again), then the text as a reply in the thread; without a thread, the
   * text as a top-level message.
   */
  private async postSlack(channel: SlackChannelConfig, notification: NotificationRecord, delivery: NotificationDeliveryRecord): Promise<PostResult> {
    const token = this.env[channel.botTokenEnv];
    if (!token) {
      return { failure: { message: `Slack bot token is not set (environment variable ${channel.botTokenEnv})`, status: null, retryable: false }, status: null };
    }
    this.redactor.add(token);
    const text = messageText(slackText(notification));
    try {
      let thread: ChatThreadRecord | null = delivery.threadId !== null ? this.repos.threads.get(delivery.threadId) : null;
      if (thread && thread.chatChannel !== channel.channel) thread = null; // channel ID changed by a reload: top-level
      if (thread && thread.threadTs === null) {
        const p = notification.payload;
        const head = await this.slack.postMessage(token, {
          channel: channel.channel,
          text: threadHeadText({
            itemKey: thread.itemKey,
            itemUrl: str(p.itemUrl) ?? str(p.sourceUrl),
            itemTitle: str(p.itemTitle),
            workflowId: thread.workflowId,
            workflowName: str(p.workflowName),
            replies: channel.appTokenEnv !== null && channel.allowedUsers.length > 0,
          }),
        });
        thread = this.repos.threads.setThreadTs(thread.id, head.ts);
      }
      const posted = await this.slack.postMessage(token, { channel: channel.channel, text, threadTs: thread?.threadTs ?? null });
      if (thread) this.repos.threads.touch(thread.id);
      return { failure: null, status: 200, messageTs: posted.ts };
    } catch (err) {
      if (err instanceof SlackApiError) {
        if (this.stopped && err.code === 'aborted') return { failure: { message: 'aborted', status: null, retryable: true }, status: null };
        return {
          failure: { message: this.redactor.redact(err.message), status: err.status, retryable: err.retryable, retryAfterMs: err.retryAfterMs },
          status: err.status,
        };
      }
      return { failure: { message: `Slack delivery failed: ${this.redactor.redact(errorMessage(err))}`, status: null, retryable: true }, status: null };
    }
  }

  private async post(channel: WebhookChannelConfig, notification: NotificationRecord): Promise<PostResult> {
    const url = channel.url ?? (channel.urlEnv ? this.env[channel.urlEnv] : undefined);
    if (!url) {
      return {
        failure: { message: `webhook URL is not set (environment variable ${channel.urlEnv ?? '?'})`, status: null, retryable: false },
        status: null,
      };
    }
    this.redactor.add(url);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'adispatchd' };
    for (const [name, envName] of Object.entries(channel.headersEnv)) {
      const value = this.env[envName];
      if (value === undefined || value === '') {
        return {
          failure: { message: `header '${name}' is not set (environment variable ${envName})`, status: null, retryable: false },
          status: null,
        };
      }
      this.redactor.add(value);
      headers[name] = value;
    }
    const body = JSON.stringify(webhookBody(notification));
    const controller = new AbortController();
    this.inflight.add(controller);
    const timer = this.timers.setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
      // Drain the body so the connection can be reused/closed.
      await response.text().catch(() => '');
      if (response.status >= 200 && response.status < 300) return { failure: null, status: response.status };
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      const retryAfterMs = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after'), this.clock.now().getTime()) : null;
      return { failure: { message: `webhook responded with HTTP ${response.status}`, status: response.status, retryable, retryAfterMs }, status: response.status };
    } catch (err) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : 'aborted';
        if (reason === 'timeout') {
          return { failure: { message: `webhook request timed out after ${this.timeoutMs} ms`, status: null, retryable: true }, status: null };
        }
        return { failure: { message: 'aborted', status: null, retryable: true }, status: null };
      }
      // Never include the URL: fetch errors may echo it.
      const cause = (err as { cause?: unknown }).cause;
      const detail = cause instanceof Error ? cause.message : errorMessage(err);
      return {
        failure: { message: `webhook request failed: ${this.redactor.redact(detail).replaceAll(url, '[REDACTED]')}`, status: null, retryable: true },
        status: null,
      };
    } finally {
      this.timers.clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  private registerChannelSecrets(): void {
    try {
      for (const c of this.options.settings().channels) {
        if (c.type === 'slack') {
          this.redactor.add(this.env[c.botTokenEnv]);
          if (c.appTokenEnv) this.redactor.add(this.env[c.appTokenEnv]);
          continue;
        }
        if (c.url) this.redactor.add(c.url);
        if (c.urlEnv) this.redactor.add(this.env[c.urlEnv]);
        for (const envName of Object.values(c.headersEnv)) this.redactor.add(this.env[envName]);
      }
    } catch {
      // settings not available yet – values are registered on first delivery
    }
  }

  /** Re-register channel secrets after a configuration reload. */
  refreshSecrets(): void {
    this.registerChannelSecrets();
  }

  private emit(view: NotificationView): void {
    try {
      this.options.onChange?.(view);
    } catch (err) {
      this.logger.warn('notification change listener failed', { error: errorMessage(err) });
    }
  }
}

/** JSON body posted to webhook channels (Slack-compatible `text` + structured data). */
export function webhookBody(n: NotificationRecord): Record<string, unknown> {
  return {
    source: 'adispatchd',
    id: n.id,
    event: n.eventType,
    createdAt: n.createdAt,
    text: summarize(n.eventType, n.payload),
    payload: n.payload,
  };
}

/** Text of a notification on a Slack channel (WI-39): the message of explicit types, else the event summary. */
export function slackText(n: NotificationRecord): string {
  const text = typeof n.payload.text === 'string' ? n.payload.text : '';
  switch (n.eventType) {
    case 'workflow_notify':
    case 'reply_feedback':
      return text;
    case 'workflow_reminder':
      return `:alarm_clock: Reminder: ${text}`;
    default:
      return summarize(n.eventType, n.payload);
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** One-line human-readable summary of a notification. */
export function summarize(type: NotificationType, p: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '-');
  switch (type) {
    case 'retry_block_created':
      return `[adispatchd] Retry block created for workflow ${s(p.workflowId)} (item ${s(p.itemKey ?? 'workflow')}): ${s(p.reason)}`;
    case 'lifecycle_action_failed':
      return `[adispatchd] Lifecycle action ${s(p.actionName ?? p.actionId)} (${s(p.hook)}) of run ${s(p.runId)} failed finally`;
    case 'recovery_failed':
      return `[adispatchd] Recovery of run ${s(p.runId)} (workflow ${s(p.workflowId)}) failed: ${s(p.reason)}`;
    case 'retry_block_cleared':
      return `[adispatchd] Retry block ${s(p.blockId)} removed for workflow ${s(p.workflowId)} (item ${s(p.itemKey ?? 'workflow')}) by ${s(p.clearedBy ?? 'anonymous')}${p.runId ? `, lifecycle run ${s(p.runId)}` : ''}`;
    case 'workflow_notify':
      return `[adispatchd] Message of workflow ${s(p.workflowId)}${p.itemKey ? ` (item ${s(p.itemKey)})` : ''}: ${s(p.text)}`;
    case 'workflow_reminder':
      return `[adispatchd] Reminder of workflow ${s(p.workflowId)}${p.itemKey ? ` (item ${s(p.itemKey)})` : ''}: ${s(p.text)}`;
    case 'reply_feedback':
      return `[adispatchd] Answer to reply ${s(p.replyId)} (workflow ${s(p.workflowId)}, item ${s(p.itemKey)}): ${s(p.text)}`;
  }
}
