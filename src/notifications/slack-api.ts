/**
 * Minimal Slack Web API client (WI-39) over an injected `fetch`: the methods
 * the daemon needs (`chat.postMessage`, `chat.getPermalink`, `reactions.add`,
 * `reactions.remove`, `users.info`, `apps.connections.open`), a timeout per
 * call and the classification of failures (HTTP 429 with `Retry-After`,
 * 5xx/network errors retryable; `invalid_auth`, `channel_not_found`, … not).
 *
 * Tokens are passed per call and sent only as `Authorization: Bearer` header;
 * they never appear in a URL, in an error text or in a log line (error texts
 * are additionally passed through the shared redactor).
 */
import { errorMessage, SecretRedactor, systemTimers, type FetchLike, type Timers } from '../core/index.js';

/** Base URL of the Slack Web API. */
export const SLACK_API_BASE_URL = 'https://slack.com/api/';
/** Default timeout of one Web API call. */
export const DEFAULT_SLACK_TIMEOUT_MS = 10_000;
/** Max. text length of one message (Slack truncates at 40 000 characters). */
export const SLACK_MAX_TEXT_LENGTH = 39_000;

/** Slack `error` codes worth another attempt (everything else is permanent). */
const RETRYABLE_SLACK_ERRORS = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'team_added_to_org']);

/** A failed Web API call. `message` never contains a token. */
export class SlackApiError extends Error {
  /** Slack `error` code (`channel_not_found`) or `http_<status>`, `network`, `timeout`, `invalid_response`. */
  readonly code: string;
  /** HTTP status, if a response arrived. */
  readonly status: number | null;
  readonly retryable: boolean;
  /** Wait demanded by Slack (`Retry-After`), if any. */
  readonly retryAfterMs: number | null;

  constructor(method: string, code: string, options: { status?: number | null; retryable: boolean; retryAfterMs?: number | null; detail?: string }) {
    super(`Slack API ${method} failed: ${code}${options.detail ? ` (${options.detail})` : ''}`);
    this.name = 'SlackApiError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Options of {@link SlackWebClient}. */
export interface SlackWebClientOptions {
  fetch?: FetchLike;
  timers?: Timers;
  /** Shared redactor; tokens are registered before every call. */
  redactor?: SecretRedactor;
  timeoutMs?: number;
  /** Base URL (tests: a fake Slack). Default {@link SLACK_API_BASE_URL}. */
  baseUrl?: string;
}

/** Result of `chat.postMessage`. */
export interface PostedMessage {
  channel: string;
  ts: string;
}

/** See module docs. Stateless; one instance can serve every channel. */
export class SlackWebClient {
  private readonly fetchFn: FetchLike;
  private readonly timers: Timers;
  private readonly redactor: SecretRedactor;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly inflight = new Set<AbortController>();

  constructor(options: SlackWebClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timers = options.timers ?? systemTimers;
    this.redactor = options.redactor ?? new SecretRedactor();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS;
    this.baseUrl = options.baseUrl ?? SLACK_API_BASE_URL;
  }

  /** `chat.postMessage` (plain text, no unfurling); `threadTs` = reply in that thread. */
  async postMessage(token: string, input: { channel: string; text: string; threadTs?: string | null }): Promise<PostedMessage> {
    const body = await this.call(token, 'chat.postMessage', {
      channel: input.channel,
      text: truncateText(input.text),
      unfurl_links: 'false',
      unfurl_media: 'false',
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
    const ts = typeof body.ts === 'string' ? body.ts : null;
    if (!ts) throw new SlackApiError('chat.postMessage', 'invalid_response', { retryable: false, detail: 'no ts in the response' });
    return { channel: typeof body.channel === 'string' ? body.channel : input.channel, ts };
  }

  /** `chat.getPermalink` of a message. */
  async getPermalink(token: string, channel: string, ts: string): Promise<string> {
    const body = await this.call(token, 'chat.getPermalink', { channel, message_ts: ts });
    if (typeof body.permalink !== 'string') throw new SlackApiError('chat.getPermalink', 'invalid_response', { retryable: false });
    return body.permalink;
  }

  /** `reactions.add`; an existing reaction counts as success. */
  async addReaction(token: string, channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call(token, 'reactions.add', { channel, timestamp: ts, name });
    } catch (err) {
      if (!(err instanceof SlackApiError && err.code === 'already_reacted')) throw err;
    }
  }

  /** `reactions.remove`; a missing reaction counts as success. */
  async removeReaction(token: string, channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call(token, 'reactions.remove', { channel, timestamp: ts, name });
    } catch (err) {
      if (!(err instanceof SlackApiError && err.code === 'no_reaction')) throw err;
    }
  }

  /** Display name of a user (`users.info`, scope `users:read`): display name → real name → name. */
  async userName(token: string, user: string): Promise<string | null> {
    const body = await this.call(token, 'users.info', { user });
    const u = body.user as { name?: unknown; real_name?: unknown; profile?: { display_name?: unknown; real_name?: unknown } } | undefined;
    for (const v of [u?.profile?.display_name, u?.profile?.real_name, u?.real_name, u?.name]) {
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return null;
  }

  /** `apps.connections.open` with the app-level token: WebSocket URL of a Socket Mode connection. */
  async openConnection(appToken: string): Promise<string> {
    const body = await this.call(appToken, 'apps.connections.open', {});
    if (typeof body.url !== 'string' || !/^wss?:\/\//.test(body.url)) {
      throw new SlackApiError('apps.connections.open', 'invalid_response', { retryable: true, detail: 'no WebSocket URL in the response' });
    }
    this.redactor.add(body.url);
    return body.url;
  }

  /** Abort all running calls (shutdown). */
  abortAll(): void {
    for (const c of this.inflight) c.abort(new Error('aborted'));
  }

  /** One form-encoded POST; returns the JSON body of an `ok: true` response or throws {@link SlackApiError}. */
  private async call(token: string, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    if (!token) throw new SlackApiError(method, 'not_authed', { retryable: false, detail: 'token is not set' });
    this.redactor.add(token);
    const controller = new AbortController();
    this.inflight.add(controller);
    const timer = this.timers.setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${method}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
            'user-agent': 'adispatchd',
          },
          body: new URLSearchParams(params).toString(),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (err) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : 'aborted';
          throw new SlackApiError(method, reason === 'timeout' ? 'timeout' : 'aborted', {
            retryable: true,
            ...(reason === 'timeout' ? { detail: `no response within ${this.timeoutMs} ms` } : {}),
          });
        }
        const cause = (err as { cause?: unknown }).cause;
        const detail = this.redactor.redact(cause instanceof Error ? cause.message : errorMessage(err)).replaceAll(token, '[REDACTED]');
        throw new SlackApiError(method, 'network', { retryable: true, detail });
      }
      const text = await response.text().catch(() => '');
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (response.status === 429) throw new SlackApiError(method, 'ratelimited', { status: 429, retryable: true, retryAfterMs });
      if (response.status < 200 || response.status >= 300) {
        const retryable = response.status >= 500 || response.status === 408;
        throw new SlackApiError(method, `http_${response.status}`, { status: response.status, retryable, retryAfterMs });
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new SlackApiError(method, 'invalid_response', { status: response.status, retryable: true, detail: 'response is not JSON' });
      }
      if (body.ok === true) return body;
      const code = typeof body.error === 'string' && /^[a-z0-9_]{1,64}$/.test(body.error) ? body.error : 'unknown_error';
      throw new SlackApiError(method, code, { status: response.status, retryable: RETRYABLE_SLACK_ERRORS.has(code), retryAfterMs });
    } finally {
      this.timers.clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }
}

/** `Retry-After` in seconds (or an HTTP date) → milliseconds; `null` if absent/invalid. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function truncateText(text: string): string {
  return text.length <= SLACK_MAX_TEXT_LENGTH ? text : `${text.slice(0, SLACK_MAX_TEXT_LENGTH)} …`;
}
