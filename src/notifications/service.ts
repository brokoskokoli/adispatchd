/**
 * Central orchestrator notifications (Spec §18): `retry_block_created`,
 * `lifecycle_action_failed`, `recovery_failed`.
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
  SecretRedactor,
  systemClock,
  systemTimers,
  type Clock,
  type FetchLike,
  type Logger,
  type NotificationEventType,
  type Notifier,
  type TimerHandle,
  type Timers,
} from '../core/index.js';
import type { NotificationChannelConfig, NotificationsConfig } from '../config/index.js';
import type {
  NotificationDeliveryRecord,
  NotificationRecord,
  Repositories,
} from '../persistence/index.js';

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
  repositories: Pick<Repositories, 'notifications'>;
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
}

interface DeliveryFailure {
  message: string;
  status: number | null;
  retryable: boolean;
}

/** See module docs. Implements the core {@link Notifier} contract. */
export class NotificationService implements Notifier {
  private readonly repos: Pick<Repositories, 'notifications'>;
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
      const channels = settings.channels.filter((c) => c.on.includes(type)).map((c) => c.id);
      const { notification, deliveries } = this.repos.notifications.createWithDeliveries(type, payload, channels);
      this.logger.info('notification recorded', { id: notification.id, type, channels });
      this.emit({ ...notification, deliveries });
      if (deliveries.length > 0) this.kick();
    } catch (err) {
      this.logger.error('failed to record notification', { type, error: errorMessage(err) });
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
    const next = this.repos.notifications.nextDeliveryDue();
    if (next === null) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(next) - this.clock.now().getTime()));
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, delay);
  }

  private async dispatch(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const due = this.repos.notifications.listDueDeliveries(this.clock.now(), BATCH);
      if (due.length === 0) return;
      for (const delivery of due) {
        if (this.stopped) return;
        await this.deliver(delivery);
      }
      if (due.length < BATCH) return;
    }
  }

  private async deliver(delivery: NotificationDeliveryRecord): Promise<void> {
    const notification = this.repos.notifications.get(delivery.notificationId);
    if (!notification) return;
    const attempt = delivery.attempts + 1;
    let failure: DeliveryFailure | null;
    let status: number | null = null;
    const channel = this.options.settings().channels.find((c) => c.id === delivery.channelId);
    if (!channel) {
      failure = { message: `notification channel '${delivery.channelId}' is no longer configured`, status: null, retryable: false };
    } else {
      const result = await this.post(channel, notification);
      failure = result.failure;
      status = result.status;
    }
    if (this.stopped && failure?.message === 'aborted') return; // stays pending for the next process
    try {
      let updated: NotificationDeliveryRecord;
      if (!failure) {
        updated = this.repos.notifications.recordDeliveryAttempt(delivery.id, { success: true, status });
        this.logger.info('notification delivered', { id: notification.id, channel: delivery.channelId, attempt });
      } else {
        const delay = failure.retryable && attempt < this.maxAttempts ? (this.delays[attempt - 1] ?? null) : null;
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
    } catch (err) {
      this.logger.error('failed to record notification delivery attempt', { id: delivery.id, error: errorMessage(err) });
    }
  }

  private async post(
    channel: NotificationChannelConfig,
    notification: NotificationRecord,
  ): Promise<{ failure: DeliveryFailure | null; status: number | null }> {
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
      return { failure: { message: `webhook responded with HTTP ${response.status}`, status: response.status, retryable }, status: response.status };
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

/** One-line human-readable summary of a notification. */
export function summarize(type: NotificationEventType, p: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '-');
  switch (type) {
    case 'retry_block_created':
      return `[adispatchd] Retry block created for workflow ${s(p.workflowId)} (item ${s(p.itemKey ?? 'workflow')}): ${s(p.reason)}`;
    case 'lifecycle_action_failed':
      return `[adispatchd] Lifecycle action ${s(p.actionName ?? p.actionId)} (${s(p.hook)}) of run ${s(p.runId)} failed finally`;
    case 'recovery_failed':
      return `[adispatchd] Recovery of run ${s(p.runId)} (workflow ${s(p.workflowId)}) failed: ${s(p.reason)}`;
  }
}
