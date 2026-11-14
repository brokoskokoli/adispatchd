/**
 * Slack Socket Mode client (WI-39): an outgoing WebSocket connection (no
 * open port) through which Slack delivers the events of the app.
 *
 * - `apps.connections.open` with the app-level token yields the URL; the
 *   connection uses the global `WebSocket` of Node (≥ 22) or an injected
 *   factory (tests).
 * - Envelopes: `hello` → connected (backoff reset); `disconnect` → reconnect
 *   at once; `events_api` → the handler runs synchronously (it persists the
 *   event), then the envelope is acknowledged (`{envelope_id}`, well within
 *   Slack's 3 s), then the handler's follow-up runs. A handler that throws
 *   (e.g. the database failed) leaves the envelope unacknowledged so Slack
 *   delivers it again. Other envelopes with an `envelope_id` are acknowledged
 *   and ignored.
 * - Connection lost / no `hello` / opening failed → reconnect with backoff
 *   1 s, 2 s, 4 s … 60 s. The state is visible via {@link SocketModeClient.status}.
 *
 * The app token and the connection URL (it carries a ticket) are registered
 * with the redactor and never logged.
 */
import { errorMessage, noopLogger, SecretRedactor, systemClock, systemTimers, type Clock, type Logger, type TimerHandle, type Timers } from '../core/index.js';
import type { SlackWebClient } from './slack-api.js';

/** The part of the WebSocket API the client uses (the global `WebSocket` satisfies it). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void): void;
}

/** Creates a WebSocket for a URL (default: the global `WebSocket`). */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Default backoff bounds of reconnects. */
export const SOCKET_MIN_BACKOFF_MS = 1_000;
export const SOCKET_MAX_BACKOFF_MS = 60_000;
/** Wait for `hello` after the connection opened. */
export const SOCKET_HELLO_TIMEOUT_MS = 30_000;

/** State of a Socket Mode connection. */
export type SocketState = 'connecting' | 'connected' | 'disconnected' | 'stopped';

/** Status of a Socket Mode connection (API / UI). */
export interface SocketStatus {
  state: SocketState;
  /** Since when the state holds (ISO). */
  since: string;
  lastConnectedAt: string | null;
  /** Last problem (redacted, no token). */
  lastError: string | null;
  /** Connections opened since the start. */
  connects: number;
  /** Next reconnect (ISO), while waiting for it. */
  nextAttemptAt: string | null;
}

/** An `events_api` envelope. */
export interface SocketEnvelope {
  envelope_id: string;
  type: string;
  payload?: unknown;
  retry_attempt?: number;
  retry_reason?: string;
}

/**
 * Handler of an `events_api` envelope: runs synchronously before the ack
 * (persist only); the returned function runs after the ack (processing).
 */
export type EnvelopeHandler = (envelope: SocketEnvelope) => (() => void) | void;

/** Options of {@link SocketModeClient}. */
export interface SocketModeClientOptions {
  api: Pick<SlackWebClient, 'openConnection'>;
  /** App-level token (`xapp-…`), read at every connect; `undefined` → not connected (error). */
  appToken: () => string | undefined;
  onEvent: EnvelopeHandler;
  /** Called whenever the status changed. */
  onStatus?: (status: SocketStatus) => void;
  webSocket?: WebSocketFactory;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  redactor?: SecretRedactor;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  helloTimeoutMs?: number;
}

/** See module docs. */
export class SocketModeClient {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly redactor: SecretRedactor;
  private readonly factory: WebSocketFactory;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly helloTimeout: number;
  private ws: WebSocketLike | undefined;
  private timer: TimerHandle | undefined;
  private helloTimer: TimerHandle | undefined;
  private failures = 0;
  private started = false;
  private stopped = false;
  /** Increased per connection; events of an old connection are ignored. */
  private generation = 0;
  private current: SocketStatus;

  constructor(private readonly options: SocketModeClientOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'slack-socket' });
    this.redactor = options.redactor ?? new SecretRedactor();
    this.factory = options.webSocket ?? defaultWebSocketFactory;
    this.minBackoff = options.minBackoffMs ?? SOCKET_MIN_BACKOFF_MS;
    this.maxBackoff = options.maxBackoffMs ?? SOCKET_MAX_BACKOFF_MS;
    this.helloTimeout = options.helloTimeoutMs ?? SOCKET_HELLO_TIMEOUT_MS;
    this.current = { state: 'disconnected', since: this.clock.now().toISOString(), lastConnectedAt: null, lastError: null, connects: 0, nextAttemptAt: null };
  }

  /** Current status (copy). */
  status(): SocketStatus {
    return { ...this.current };
  }

  /** Connect (and keep reconnecting until {@link stop}). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.connect();
  }

  /** Close the connection; no reconnects afterwards. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.generation++;
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000, 'stopping');
    } catch {
      /* already closed */
    }
    this.setStatus({ state: 'stopped', nextAttemptAt: null });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.setStatus({ state: 'connecting', nextAttemptAt: null });
    const token = this.options.appToken();
    if (!token) {
      this.fail(generation, 'app-level token is not set (environment variable of app_token_env)');
      return;
    }
    this.redactor.add(token);
    let url: string;
    try {
      url = await this.options.api.openConnection(token);
    } catch (err) {
      this.fail(generation, `apps.connections.open failed: ${this.redactor.redact(errorMessage(err))}`);
      return;
    }
    if (this.stopped || generation !== this.generation) return;
    this.redactor.add(url);
    let ws: WebSocketLike;
    try {
      ws = this.factory(url);
    } catch (err) {
      this.fail(generation, `WebSocket could not be created: ${this.redactor.redact(errorMessage(err))}`);
      return;
    }
    this.ws = ws;
    this.helloTimer = this.timers.setTimeout(() => {
      this.helloTimer = undefined;
      if (generation === this.generation && this.current.state !== 'connected') this.drop(ws, `no hello within ${this.helloTimeout} ms`);
    }, this.helloTimeout);
    ws.addEventListener('message', (event) => {
      if (generation !== this.generation) return;
      this.onMessage(ws, event.data);
    });
    ws.addEventListener('close', (event) => {
      if (generation !== this.generation) return;
      this.ws = undefined;
      const reason = event.reason ? `: ${this.redactor.redact(String(event.reason))}` : '';
      this.fail(generation, `connection closed (code ${event.code ?? '?'})${reason}`);
    });
    ws.addEventListener('error', (event) => {
      if (generation !== this.generation) return;
      this.logger.warn('Socket Mode connection error', { error: this.redactor.redact(event.message ?? 'WebSocket error') });
    });
  }

  private onMessage(ws: WebSocketLike, data: unknown): void {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')) as Record<string, unknown>;
    } catch {
      this.logger.warn('Socket Mode: ignoring a message that is not JSON');
      return;
    }
    const type = typeof envelope.type === 'string' ? envelope.type : '';
    if (type === 'hello') {
      if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
      this.failures = 0;
      const now = this.clock.now().toISOString();
      this.setStatus({ state: 'connected', lastConnectedAt: now, lastError: null, connects: this.current.connects + 1 });
      this.logger.info('Socket Mode connected');
      return;
    }
    if (type === 'disconnect') {
      const reason = typeof envelope.reason === 'string' ? envelope.reason : 'unknown';
      this.logger.info('Socket Mode: disconnect requested by Slack, reconnecting', { reason });
      this.generation++;
      this.ws = undefined;
      try {
        ws.close(1000, 'disconnect requested');
      } catch {
        /* ignore */
      }
      this.setStatus({ state: 'disconnected', lastError: `disconnect requested by Slack (${reason})` });
      this.failures = 0;
      void this.connect();
      return;
    }
    const envelopeId = typeof envelope.envelope_id === 'string' ? envelope.envelope_id : null;
    if (!envelopeId) return;
    let after: (() => void) | void = undefined;
    if (type === 'events_api') {
      try {
        after = this.options.onEvent(envelope as unknown as SocketEnvelope);
      } catch (err) {
        // Not persisted: no ack, Slack delivers the event again.
        this.logger.error('Socket Mode: event could not be recorded; not acknowledged (Slack retries)', { error: errorMessage(err) });
        return;
      }
    }
    try {
      ws.send(JSON.stringify({ envelope_id: envelopeId }));
    } catch (err) {
      this.logger.warn('Socket Mode: acknowledgement failed', { error: this.redactor.redact(errorMessage(err)) });
    }
    if (after) {
      try {
        after();
      } catch (err) {
        this.logger.error('Socket Mode: processing of an event failed', { error: errorMessage(err) });
      }
    }
  }

  /** Close a connection that misbehaves and reconnect with backoff. */
  private drop(ws: WebSocketLike, reason: string): void {
    const generation = ++this.generation;
    this.ws = undefined;
    try {
      ws.close(4000, 'reconnecting');
    } catch {
      /* ignore */
    }
    this.fail(generation, reason);
  }

  private fail(generation: number, error: string): void {
    if (this.stopped || generation !== this.generation) return;
    if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    const delay = Math.min(this.maxBackoff, this.minBackoff * 2 ** Math.min(this.failures, 16));
    this.failures++;
    const next = new Date(this.clock.now().getTime() + delay).toISOString();
    this.setStatus({ state: 'disconnected', lastError: error, nextAttemptAt: next });
    this.logger.warn('Socket Mode disconnected, reconnecting', { error, delayMs: delay });
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.timer) this.timers.clearTimeout(this.timer);
    if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
    this.timer = undefined;
    this.helloTimer = undefined;
  }

  private setStatus(patch: Partial<SocketStatus>): void {
    const stateChanged = patch.state !== undefined && patch.state !== this.current.state;
    this.current = { ...this.current, ...patch, ...(stateChanged ? { since: this.clock.now().toISOString() } : {}) };
    try {
      this.options.onStatus?.(this.status());
    } catch (err) {
      this.logger.warn('Socket Mode status listener failed', { error: errorMessage(err) });
    }
  }
}

/** The global `WebSocket` of Node ≥ 22 (no dependency). */
export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('this Node.js has no global WebSocket (Node ≥ 22 required)');
  return new Ctor(url);
};
