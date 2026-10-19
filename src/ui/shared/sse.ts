/**
 * Live connection to `GET /api/v1/events` (Spec §15, docs/api.md) with
 * reconnect logic, independent of the DOM (the browser passes
 * `url => new EventSource(url)`, tests pass a fake).
 *
 * - The browser's EventSource reconnects by itself after a dropped connection
 *   (`readyState` CONNECTING) and sends `Last-Event-ID`; the server replays
 *   missed persistent events.
 * - If the EventSource gives up (`readyState` CLOSED, e.g. HTTP 503 during a
 *   restart), a new one is created after an exponential backoff, passing the
 *   last seen ID as `?lastEventId=`.
 * - Non-persistent events (logs, actions, system status) are lost while
 *   disconnected: after every re-open (and on `stream.reset`) `onResync` is
 *   called so the current page reloads its state via REST.
 * - Persistent events already delivered (ID ≤ last seen ID) are dropped.
 */

/** Minimal EventSource surface. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: { data?: unknown; lastEventId?: string }) => void): void;
  close(): void;
}

/** EventSource `readyState` values. */
export const ES_CONNECTING = 0;
export const ES_OPEN = 1;
export const ES_CLOSED = 2;

/** All event types sent by the server (`event:` field). */
export const LIVE_EVENT_TYPES = [
  'stream.open',
  'stream.reset',
  'run.event',
  'run.output',
  'run.action',
  'block.created',
  'block.cleared',
  'system.status',
  'system.ready',
  'notification',
  'config.reloaded',
  'retention.finished',
  'system.metrics',
  'workflow.conditions',
  'dashboard.info',
] as const;

/** Parsed message. */
export interface LiveMessage {
  type: string;
  time: string | null;
  /** Persistent event ID (`run.event`, `stream.open`, `stream.reset`), else `null`. */
  id: number | null;
  payload: Record<string, unknown>;
}

/** Connection state for the UI indicator. */
export type LiveState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Why a resync is requested. */
export type ResyncReason = 'reconnected' | 'reset';

/** Timer functions (injectable for tests). */
export interface LiveTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Options of {@link LiveConnection}. */
export interface LiveConnectionOptions {
  /** Base URL, e.g. `/api/v1/events`. */
  url: string;
  create(url: string): EventSourceLike;
  onMessage(msg: LiveMessage): void;
  onResync(reason: ResyncReason): void;
  onState?(state: LiveState): void;
  timers?: LiveTimers;
  /** Backoff for manual reconnects (default 1 s doubling up to 30 s). */
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/** Parse one SSE message; `null` if the data is not a JSON object. */
export function parseLiveMessage(type: string, data: unknown): LiveMessage | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as { type?: unknown; time?: unknown; id?: unknown; payload?: unknown };
  // Only the `id` inside the data marks a persistent event. `MessageEvent.lastEventId` is NOT used: the
  // browser carries the last seen ID over to later non-persistent messages (they would look like duplicates).
  const id: number | null = typeof o.id === 'number' && Number.isInteger(o.id) && o.id >= 0 ? o.id : null;
  const payload = o.payload && typeof o.payload === 'object' && !Array.isArray(o.payload) ? (o.payload as Record<string, unknown>) : {};
  return { type: typeof o.type === 'string' ? o.type : type, time: typeof o.time === 'string' ? o.time : null, id, payload };
}

/** Reconnect delay for the n-th consecutive failed attempt (1-based). */
export function backoffDelay(attempt: number, initialMs = 1000, maxMs = 30_000): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, initialMs * 2 ** Math.min(n - 1, 20));
}

/** Build the stream URL with an optional `lastEventId`. */
export function streamUrl(base: string, lastEventId: number | null): string {
  if (lastEventId === null) return base;
  return `${base}${base.includes('?') ? '&' : '?'}lastEventId=${lastEventId}`;
}

/** See module comment. */
export class LiveConnection {
  private es: EventSourceLike | null = null;
  private timer: unknown = null;
  private attempts = 0;
  private opened = false;
  private stopped = true;
  private current: LiveState = 'closed';
  /** Highest persistent event ID seen. */
  lastEventId: number | null = null;
  private readonly timers: LiveTimers;

  constructor(private readonly opts: LiveConnectionOptions) {
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  get state(): LiveState {
    return this.current;
  }

  /** Connect (idempotent). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Disconnect and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.es?.close();
    this.es = null;
    this.setState('closed');
  }

  /** Reconnect now (e.g. browser came back online) if currently waiting for a retry. */
  reconnectNow(): void {
    if (this.stopped || this.timer === null) return;
    this.clearTimer();
    this.connect();
  }

  private connect(): void {
    this.setState(this.opened ? 'reconnecting' : 'connecting');
    const es = this.opts.create(streamUrl(this.opts.url, this.lastEventId));
    this.es = es;
    es.onopen = () => {
      if (this.es !== es) return;
      this.attempts = 0;
    };
    es.onerror = () => {
      if (this.es !== es || this.stopped) return;
      if (es.readyState === ES_CLOSED) {
        es.close();
        this.es = null;
        this.scheduleReconnect();
      } else {
        // The browser retries by itself (Last-Event-ID is sent automatically).
        this.setState('reconnecting');
      }
    };
    for (const type of LIVE_EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        if (this.es !== es || this.stopped) return;
        this.handle(type, ev);
      });
    }
  }

  private handle(type: string, ev: { data?: unknown; lastEventId?: string }): void {
    const msg = parseLiveMessage(type, ev.data);
    if (!msg) return;
    if (msg.type === 'stream.open') {
      const reopened = this.opened;
      this.opened = true;
      this.attempts = 0;
      if (msg.id !== null && (this.lastEventId === null || msg.id > this.lastEventId)) this.lastEventId = msg.id;
      this.setState('open');
      if (reopened) this.opts.onResync('reconnected');
      return;
    }
    if (msg.type === 'stream.reset') {
      // The server's baseline wins (it may be lower, e.g. after a data-dir restore).
      if (msg.id !== null) this.lastEventId = msg.id;
      this.opts.onResync('reset');
      return;
    }
    if (msg.id !== null) {
      if (this.lastEventId !== null && msg.id <= this.lastEventId) return; // duplicate
      this.lastEventId = msg.id;
    }
    if (this.current !== 'open') this.setState('open');
    this.opts.onMessage(msg);
  }

  private scheduleReconnect(): void {
    this.attempts++;
    this.setState('reconnecting');
    const delay = backoffDelay(this.attempts, this.opts.initialDelayMs ?? 1000, this.opts.maxDelayMs ?? 30_000);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private setState(state: LiveState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onState?.(state);
  }
}
