/**
 * Replies in chat threads (WI-39): Socket Mode connections, intake of reply
 * events, reactions and the answer in the thread.
 *
 * Connections: one Socket Mode connection per app-token variable
 * (`app_token_env`), shared by every Slack channel with that variable – Slack
 * spreads the events of an app over its open connections, so a second
 * connection of the same app would lose events. A reload re-uses the
 * connection unless the set of app-token variables changed; routing to the
 * channels (Slack channel ID, `allowed_users`) always uses the live config.
 *
 * Intake (P2): event checked → reply recorded synchronously (unique
 * `(channel, ts)`, a redelivered event is recorded once) → acknowledged →
 * processed (⏳ reaction, the run controller is woken). A reply counts only
 * if channel and Slack channel match, `thread_ts` belongs to a stored thread
 * of that channel, the author is in `allowed_users` and the message is new
 * (no `subtype` except `thread_broadcast` and `file_share` with text – files are ignored – and no bot). Everything else is
 * acknowledged and ignored (log on debug). A reply that counts cancels the
 * pending reminders of its thread – also when the workflow has no
 * `on_reply` (then it is ignored otherwise, P6). Texts that look like a
 * secret are rejected before anything is stored (only the reason is kept).
 */
import {
  describeFindings,
  errorMessage,
  noopLogger,
  scanSecrets,
  SecretRedactor,
  systemClock,
  systemTimers,
  type ChatReplyFeedback,
  type ChatReplyRef,
  type Clock,
  type Logger,
  type ReplyOutcome,
  type Timers,
} from '../core/index.js';
import type { NotificationsConfig, SlackChannelConfig, WorkflowSnapshot } from '../config/index.js';
import type { Repositories } from '../persistence/index.js';
import type { NotificationService } from './service.js';
import type { SlackWebClient } from './slack-api.js';
import { SocketModeClient, type SocketEnvelope, type SocketStatus, type WebSocketFactory } from './slack-socket.js';
import { replyPlainText } from './slack-text.js';

/** Reactions on a reply. */
export const REPLY_REACTIONS = { received: 'hourglass_flowing_sand', done: 'white_check_mark', failed: 'x' } as const;

/** Status of a notification channel (API / UI). */
export interface ChannelStatus {
  id: string;
  type: 'webhook' | 'slack';
  /** Slack channel ID (Slack only). */
  channel: string | null;
  /** Replies possible: Socket Mode configured (`app_token_env`). */
  replies: boolean;
  /** Socket Mode state; `disabled` = send only (no `app_token_env`), `null` for webhooks. */
  state: SocketStatus['state'] | 'disabled' | null;
  since: string | null;
  lastConnectedAt: string | null;
  /** Last connection problem (redacted). */
  lastError: string | null;
  nextAttemptAt: string | null;
  /** `allowed_users` configured (count), Slack only. */
  allowedUsers: number;
}

/** Result of the workflow lookup for a reply. */
export type ReplyTarget = { snapshot: WorkflowSnapshot } | { ignore: string };

/** Options of {@link ChatReplyService}. */
export interface ChatReplyServiceOptions {
  repositories: Pick<Repositories, 'threads' | 'replies' | 'reminders' | 'transaction'>;
  settings: () => NotificationsConfig;
  /**
   * Snapshot of the workflow loaded now for a reply in its thread; `ignore`
   * when the workflow is gone or has no `on_reply` (P6).
   */
  target: (workflowId: string, sourceId: string | null) => ReplyTarget;
  notifications: Pick<NotificationService, 'enqueueReplyFeedback'>;
  slack: SlackWebClient;
  /** A reply was recorded (wake the run controller). */
  onReply?: () => void;
  env?: Readonly<Record<string, string | undefined>>;
  webSocket?: WebSocketFactory;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  redactor?: SecretRedactor;
  /** Reconnect backoff (tests). */
  socket?: { minBackoffMs?: number; maxBackoffMs?: number; helloTimeoutMs?: number };
  /** Timeout of `describe` (default 10 s). */
  describeTimeoutMs?: number;
  /** Called whenever a channel status changed (SSE). */
  onStatus?: (status: ChannelStatus[]) => void;
}

/** Slack `message` event (the fields used). */
interface MessageEvent {
  type?: unknown;
  subtype?: unknown;
  channel?: unknown;
  user?: unknown;
  bot_id?: unknown;
  text?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
}

/** See module docs. */
export class ChatReplyService implements ChatReplyFeedback {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly redactor: SecretRedactor;
  private readonly env: Readonly<Record<string, string | undefined>>;
  /** Socket Mode client per app-token variable. */
  private readonly sockets = new Map<string, SocketModeClient>();
  /** Display names by Slack user ID (`null` = unknown, e.g. scope `users:read` missing). */
  private readonly names = new Map<string, string | null>();
  private started = false;
  private stopped = false;

  constructor(private readonly options: ChatReplyServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'chat-replies' });
    this.redactor = options.redactor ?? new SecretRedactor();
    this.env = options.env ?? process.env;
  }

  /** Open the Socket Mode connections of the configured channels. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.sync();
  }

  /** After a reload: open / close connections when the app-token variables changed. */
  refresh(): void {
    if (!this.started || this.stopped) return;
    this.sync();
  }

  /** Close all connections. */
  stop(): void {
    this.stopped = true;
    for (const socket of this.sockets.values()) socket.stop();
    this.sockets.clear();
  }

  /** Status of every configured channel. */
  status(): ChannelStatus[] {
    return this.options.settings().channels.map((c): ChannelStatus => {
      if (c.type !== 'slack') {
        return { id: c.id, type: 'webhook', channel: null, replies: false, state: null, since: null, lastConnectedAt: null, lastError: null, nextAttemptAt: null, allowedUsers: 0 };
      }
      const socket = c.appTokenEnv ? this.sockets.get(c.appTokenEnv) : undefined;
      const st = socket?.status();
      return {
        id: c.id,
        type: 'slack',
        channel: c.channel,
        replies: c.appTokenEnv !== null,
        state: c.appTokenEnv === null ? 'disabled' : (st?.state ?? 'disconnected'),
        since: st?.since ?? null,
        lastConnectedAt: st?.lastConnectedAt ?? null,
        lastError: st?.lastError ?? null,
        nextAttemptAt: st?.nextAttemptAt ?? null,
        allowedUsers: c.allowedUsers.length,
      };
    });
  }

  private sync(): void {
    const wanted = new Set(
      this.options.settings().channels.flatMap((c) => (c.type === 'slack' && c.appTokenEnv !== null ? [c.appTokenEnv] : [])),
    );
    for (const [key, socket] of this.sockets) {
      if (!wanted.has(key)) {
        socket.stop();
        this.sockets.delete(key);
        this.logger.info('Socket Mode connection closed (no channel uses it any more)', { appTokenEnv: key });
      }
    }
    for (const key of wanted) {
      if (this.sockets.has(key)) continue;
      const socket = new SocketModeClient({
        api: this.options.slack,
        appToken: () => this.env[key],
        onEvent: (envelope) => this.handleEnvelope(key, envelope),
        onStatus: () => this.emitStatus(),
        ...(this.options.webSocket ? { webSocket: this.options.webSocket } : {}),
        clock: this.clock,
        timers: this.timers,
        logger: this.logger,
        redactor: this.redactor,
        ...(this.options.socket ?? {}),
      });
      this.sockets.set(key, socket);
      socket.start();
    }
  }

  private emitStatus(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch (err) {
      this.logger.warn('channel status listener failed', { error: errorMessage(err) });
    }
  }

  /**
   * Intake of one `events_api` envelope of the connection of `appTokenEnv`.
   * Synchronous part: check and record; the returned follow-up (after the
   * ack) adds the ⏳ reaction / the answer and wakes the controller.
   * Throws only if recording failed (the envelope is then not acknowledged).
   */
  handleEnvelope(appTokenEnv: string, envelope: SocketEnvelope): (() => void) | void {
    const payload = envelope.payload as { type?: unknown; event?: MessageEvent } | undefined;
    const event = payload?.event;
    if (payload?.type !== 'event_callback' || !event || event.type !== 'message') {
      this.logger.debug('reply ignored: not a message event', { type: typeof event?.type === 'string' ? event.type : null });
      return;
    }
    const chatChannel = typeof event.channel === 'string' ? event.channel : '';
    const ts = typeof event.ts === 'string' ? event.ts : '';
    const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : '';
    const ignore = (reason: string, level: 'debug' | 'info' = 'debug'): void => {
      this.logger[level]('reply ignored', { reason, channel: chatChannel, ts });
    };
    const channels = this.options
      .settings()
      .channels.filter((c): c is SlackChannelConfig => c.type === 'slack' && c.appTokenEnv === appTokenEnv && c.channel === chatChannel);
    if (channels.length === 0) return ignore('other channel');
    if (!ts || !threadTs || threadTs === ts) return ignore('not a reply in a thread');
    if (event.subtype !== undefined && event.subtype !== 'thread_broadcast' && event.subtype !== 'file_share') return ignore(`subtype ${String(event.subtype)}`);
    // A reply with attached files counts with its text only (files are ignored); files without text do not count.
    if (event.subtype === 'file_share' && (typeof event.text !== 'string' || event.text.trim() === '')) return ignore('file without text');
    if (event.bot_id !== undefined) return ignore('bot message');
    const user = typeof event.user === 'string' ? event.user : '';
    if (!user) return ignore('no user');
    const thread = this.options.repositories.threads.findByTs(chatChannel, threadTs);
    if (!thread) return ignore('unknown thread');
    const channel = channels.find((c) => c.id === thread.channelId);
    if (!channel) return ignore(`thread of channel '${thread.channelId}', which is no longer configured`, 'info');
    if (!channel.allowedUsers.includes(user)) return ignore('user not in allowed_users');

    // A reply that counts: no reminder in this thread any more.
    const cancelled = this.options.repositories.reminders.cancelForThread(thread.id, 'reply received');
    this.options.repositories.threads.touch(thread.id);
    if (cancelled > 0) this.logger.info('reminder cancelled by a reply', { threadId: thread.id, count: cancelled });

    const target = this.options.target(thread.workflowId, thread.sourceId);
    if ('ignore' in target) return ignore(target.ignore);

    const raw = typeof event.text === 'string' ? event.text : '';
    const { text } = replyPlainText(raw);
    const rawFindings = scanSecrets(raw);
    const findings = rawFindings.length > 0 ? rawFindings : scanSecrets(text);
    const secret = findings.length > 0 || this.redactor.redact(text) !== text;
    const base = {
      channelId: channel.id,
      chatChannel,
      ts,
      threadId: thread.id,
      workflowId: thread.workflowId,
      sourceId: thread.sourceId,
      itemKey: thread.itemKey,
      userId: user,
    };
    if (secret) {
      const kinds = findings.length > 0 ? describeFindings(findings) : 'a known secret value';
      const reason = `looks like it contains a secret (${kinds})`;
      const { reply, created } = this.options.repositories.replies.record({ ...base, text: null, configSnapshot: null, status: 'rejected', reason });
      if (!created) return ignore('already recorded');
      this.logger.warn('reply rejected: looks like a secret', { replyId: reply.id, workflowId: reply.workflowId, itemKey: reply.itemKey });
      return () => this.finished(reply, 'rejected', `${reason}; nothing was done – please never post secrets`, null);
    }
    const { reply, created } = this.options.repositories.replies.record({ ...base, text, configSnapshot: target.snapshot, status: 'pending' });
    if (!created) return ignore('already recorded (event delivered again)');
    this.logger.info('reply recorded', { replyId: reply.id, workflowId: reply.workflowId, itemKey: reply.itemKey });
    return () => {
      this.react(reply, REPLY_REACTIONS.received, 'add');
      this.options.onReply?.();
    };
  }

  /** {@link ChatReplyFeedback.describe}: display name (cached) and permalink, best effort with a timeout. */
  async describe(reply: ChatReplyRef): Promise<{ userName: string | null; permalink: string | null }> {
    const token = this.botToken(reply.channelId);
    if (!token) return { userName: null, permalink: null };
    const limit = this.options.describeTimeoutMs ?? 10_000;
    const within = <T>(p: Promise<T>): Promise<T | null> =>
      new Promise((resolve) => {
        const timer = this.timers.setTimeout(() => resolve(null), limit);
        p.then(
          (v) => {
            this.timers.clearTimeout(timer);
            resolve(v);
          },
          () => {
            this.timers.clearTimeout(timer);
            resolve(null);
          },
        );
      });
    let userName = this.names.has(reply.userId) ? (this.names.get(reply.userId) ?? null) : undefined;
    if (userName === undefined) {
      userName = await within(
        this.options.slack.userName(token, reply.userId).catch((err: unknown) => {
          // Without the optional scope `users:read` the name stays the user ID (P7).
          this.logger.debug('user name not available', { error: this.redactor.redact(errorMessage(err)) });
          return null;
        }),
      );
      this.names.set(reply.userId, userName);
    }
    const permalink = await within(this.options.slack.getPermalink(token, reply.chatChannel, reply.ts));
    return { userName, permalink };
  }

  /** {@link ChatReplyFeedback.finished}: reactions and, for rejected/failed replies, a short answer in the thread. */
  finished(reply: ChatReplyRef, outcome: ReplyOutcome, detail: string | null, runId: string | null): void {
    try {
      this.react(reply, REPLY_REACTIONS.received, 'remove');
      this.react(reply, outcome === 'done' ? REPLY_REACTIONS.done : REPLY_REACTIONS.failed, 'add');
      if (outcome === 'done') return;
      const text =
        outcome === 'rejected'
          ? `:x: Reply rejected${detail ? `: ${detail}` : ''}.`
          : `:x: The reply could not be processed${detail ? ` (${detail})` : ''}.${runId ? ` Lifecycle run ${runId}.` : ''}`;
      this.options.notifications.enqueueReplyFeedback({
        channelId: reply.channelId,
        threadId: reply.threadId,
        workflowId: reply.workflowId,
        itemKey: reply.itemKey,
        replyId: reply.id,
        runId,
        text,
      });
    } catch (err) {
      this.logger.warn('reply feedback failed', { replyId: reply.id, error: errorMessage(err) });
    }
  }

  /** Best-effort reaction (not persisted, not retried). */
  private react(reply: ChatReplyRef, name: string, op: 'add' | 'remove'): void {
    const token = this.botToken(reply.channelId);
    if (!token) return;
    const call = op === 'add' ? this.options.slack.addReaction(token, reply.chatChannel, reply.ts, name) : this.options.slack.removeReaction(token, reply.chatChannel, reply.ts, name);
    call.catch((err: unknown) => this.logger.debug('reaction failed', { replyId: reply.id, name, op, error: this.redactor.redact(errorMessage(err)) }));
  }

  private botToken(channelId: string): string | undefined {
    const channel = this.options.settings().channels.find((c) => c.id === channelId);
    if (!channel || channel.type !== 'slack') return undefined;
    const token = this.env[channel.botTokenEnv];
    if (token) this.redactor.add(token);
    return token || undefined;
  }
}
