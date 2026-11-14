/**
 * Fake Slack for tests (WI-39, excluded from the build): the Web API over an
 * injected `fetch` and Socket Mode over an injected WebSocket factory. No
 * test talks to the real Slack.
 */
import type { FetchLike } from '../../core/index.js';
import type { SocketEnvelope, WebSocketFactory, WebSocketLike } from '../slack-socket.js';

/** Base URL the fake answers on. */
export const FAKE_SLACK_URL = 'https://slack.test/api/';

/** One recorded Web API call. */
export interface FakeSlackCall {
  method: string;
  params: Record<string, string>;
  /** Token of the `Authorization` header. */
  token: string;
}

/** A scripted failure of the next call of a method. */
export type FakeSlackFailure = { status: number; retryAfter?: number } | { error: string } | { network: string };

/** A posted message. */
export interface FakeSlackMessage {
  channel: string;
  ts: string;
  text: string;
  threadTs: string | null;
}

/** See module docs. */
export class FakeSlack {
  readonly calls: FakeSlackCall[] = [];
  readonly messages: FakeSlackMessage[] = [];
  readonly reactions: Array<{ op: 'add' | 'remove'; channel: string; ts: string; name: string }> = [];
  /** Display names by user ID (`users.info`); unknown users → `user_not_found`. */
  readonly users: Record<string, string> = {};
  /** Scope `users:read` granted. */
  usersScope = true;
  private readonly failures = new Map<string, FakeSlackFailure[]>();
  private seq = 0;

  constructor(private readonly tokens: { bot: string; app?: string }) {}

  /** Fail the next call(s) of `method`. */
  failNext(method: string, ...failures: FakeSlackFailure[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...failures]);
  }

  /** Calls of one method. */
  callsOf(method: string): FakeSlackCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** The `fetch` to inject (base URL {@link FAKE_SLACK_URL}). */
  readonly fetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(FAKE_SLACK_URL)) return new Response('not found', { status: 404 });
    const method = url.slice(FAKE_SLACK_URL.length);
    const headers = init?.headers as Record<string, string>;
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    this.calls.push({ method, params, token });
    const failure = this.failures.get(method)?.shift();
    if (failure) {
      if ('network' in failure) throw new TypeError(failure.network, { cause: new Error(failure.network) });
      if ('status' in failure) {
        return new Response('{}', { status: failure.status, headers: failure.retryAfter !== undefined ? { 'retry-after': String(failure.retryAfter) } : {} });
      }
      return json({ ok: false, error: failure.error });
    }
    const expected = method === 'apps.connections.open' ? this.tokens.app : this.tokens.bot;
    if (token !== expected) return json({ ok: false, error: 'invalid_auth' });
    switch (method) {
      case 'chat.postMessage': {
        const ts = `1700000000.${String(++this.seq).padStart(6, '0')}`;
        this.messages.push({ channel: params.channel ?? '', ts, text: params.text ?? '', threadTs: params.thread_ts ?? null });
        return json({ ok: true, channel: params.channel, ts });
      }
      case 'chat.getPermalink':
        return json({ ok: true, permalink: `https://acme.slack.test/archives/${params.channel}/p${(params.message_ts ?? '').replace('.', '')}` });
      case 'reactions.add':
      case 'reactions.remove':
        this.reactions.push({ op: method === 'reactions.add' ? 'add' : 'remove', channel: params.channel ?? '', ts: params.timestamp ?? '', name: params.name ?? '' });
        return json({ ok: true });
      case 'users.info': {
        if (!this.usersScope) return json({ ok: false, error: 'missing_scope' });
        const name = this.users[params.user ?? ''];
        return name ? json({ ok: true, user: { name: name.toLowerCase(), profile: { display_name: name } } }) : json({ ok: false, error: 'user_not_found' });
      }
      case 'apps.connections.open':
        return json({ ok: true, url: `wss://wss.slack.test/link/?ticket=secret-ticket-${++this.seq}` });
      default:
        return json({ ok: false, error: 'unknown_method' });
    }
  };

  /** Messages in the thread of `threadTs` (replies only). */
  thread(threadTs: string): FakeSlackMessage[] {
    return this.messages.filter((m) => m.threadTs === threadTs);
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

type Listener = (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void;

/** A fake WebSocket: the test plays the Slack side. */
export class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Slack sends an envelope. */
  push(envelope: object): void {
    this.emit('message', { data: JSON.stringify(envelope) });
  }

  hello(): void {
    this.push({ type: 'hello', num_connections: 1 });
  }

  /** Slack drops the connection. */
  drop(code = 1006): void {
    if (this.closed) return;
    this.closed = { code };
    this.emit('close', { code, reason: '' });
  }

  /** Acknowledged envelope IDs. */
  acks(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { envelope_id?: string }).envelope_id ?? '').filter(Boolean);
  }

  private emit(type: string, event: Parameters<Listener>[0]): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

/** Factory of {@link FakeSocket}s; `sockets` in creation order. */
export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];
  readonly create: WebSocketFactory = (url) => {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    const s = this.sockets.at(-1);
    if (!s) throw new Error('no socket created');
    return s;
  }
}

/** An `events_api` envelope with a `message` event. */
export function messageEnvelope(id: string, event: Record<string, unknown>): SocketEnvelope {
  return {
    envelope_id: id,
    type: 'events_api',
    payload: { type: 'event_callback', event: { type: 'message', ...event } },
  } as SocketEnvelope;
}
