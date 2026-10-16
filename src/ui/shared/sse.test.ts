import { describe, expect, it } from 'vitest';
import {
  ES_CLOSED,
  ES_CONNECTING,
  ES_OPEN,
  LiveConnection,
  backoffDelay,
  parseLiveMessage,
  streamUrl,
  type EventSourceLike,
  type LiveMessage,
  type LiveState,
  type ResyncReason,
} from './sse.js';

type Listener = (ev: { data?: unknown; lastEventId?: string }) => void;

class FakeEventSource implements EventSourceLike {
  readyState = ES_CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  /** Mimics the browser: the last seen `id:` is kept for later messages without an id. */
  private lastId = '';
  private listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = ES_CLOSED;
  }
  open(): void {
    this.readyState = ES_OPEN;
    this.onopen?.({});
  }
  emit(type: string, body: { id?: number; payload?: Record<string, unknown> }): void {
    if (body.id !== undefined) this.lastId = String(body.id);
    const data = JSON.stringify({ type, time: '2026-10-17T00:00:00.000Z', ...body, payload: body.payload ?? {} });
    for (const l of this.listeners.get(type) ?? []) l({ data, lastEventId: this.lastId });
  }
  /** Network drop: the browser reconnects by itself. */
  drop(): void {
    this.readyState = ES_CONNECTING;
    this.onerror?.({});
  }
  /** Fatal error (e.g. HTTP 503): the browser gives up. */
  fail(): void {
    this.readyState = ES_CLOSED;
    this.onerror?.({});
  }
}

function setup() {
  const sources: FakeEventSource[] = [];
  const messages: LiveMessage[] = [];
  const resyncs: ResyncReason[] = [];
  const states: LiveState[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const conn = new LiveConnection({
    url: '/api/v1/events',
    create: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    onMessage: (m) => messages.push(m),
    onResync: (r) => resyncs.push(r),
    onState: (s) => states.push(s),
    timers: {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  });
  const fire = (): void => {
    const t = timers.filter((x) => !x.cleared).shift();
    if (!t) throw new Error('no timer');
    t.cleared = true;
    t.fn();
  };
  return { conn, sources, messages, resyncs, states, timers, fire, last: () => sources[sources.length - 1]! };
}

describe('parseLiveMessage', () => {
  it('parses persistent and non-persistent messages', () => {
    expect(parseLiveMessage('run.event', JSON.stringify({ type: 'run.event', time: 't', id: 5, payload: { a: 1 } }))).toEqual({
      type: 'run.event',
      time: 't',
      id: 5,
      payload: { a: 1 },
    });
    expect(parseLiveMessage('run.output', JSON.stringify({ type: 'run.output', payload: { data: 'x' } }))?.id).toBeNull();
  });
  it('rejects invalid data', () => {
    expect(parseLiveMessage('x', 'not json')).toBeNull();
    expect(parseLiveMessage('x', '[1,2]')).toBeNull();
    expect(parseLiveMessage('x', undefined)).toBeNull();
    expect(parseLiveMessage('x', JSON.stringify({ payload: [1] }))?.payload).toEqual({});
  });
});

describe('backoffDelay / streamUrl', () => {
  it('doubles up to the maximum', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, 1000, 30_000))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(1000)).toBe(30_000);
  });
  it('adds lastEventId', () => {
    expect(streamUrl('/api/v1/events', null)).toBe('/api/v1/events');
    expect(streamUrl('/api/v1/events', 42)).toBe('/api/v1/events?lastEventId=42');
    expect(streamUrl('/api/v1/events?run=r1', 42)).toBe('/api/v1/events?run=r1&lastEventId=42');
  });
});

describe('LiveConnection', () => {
  it('delivers messages and tracks the last persistent ID', () => {
    const t = setup();
    t.conn.start();
    expect(t.states).toEqual(['connecting']);
    const es = t.last();
    es.open();
    es.emit('stream.open', { id: 10, payload: { lastEventId: 10, replayed: 0 } });
    expect(t.states).toEqual(['connecting', 'open']);
    es.emit('run.event', { id: 11, payload: { type: 'status' } });
    expect(t.conn.lastEventId).toBe(11);
    expect(t.messages.map((m) => m.type)).toEqual(['run.event']);
    expect(t.resyncs).toEqual([]);
  });

  it('does not drop non-persistent messages that follow a persistent one (browser keeps lastEventId)', () => {
    const t = setup();
    t.conn.start();
    const es = t.last();
    es.open();
    es.emit('stream.open', { id: 10 });
    es.emit('run.event', { id: 11 });
    es.emit('run.action', { payload: { runId: 'r1' } });
    es.emit('system.status', { payload: { ready: true } });
    es.emit('run.output', { payload: { runId: 'r1', data: 'x' } });
    expect(t.messages.map((m) => m.type)).toEqual(['run.event', 'run.action', 'system.status', 'run.output']);
  });

  it('drops duplicate persistent events (ID ≤ last seen)', () => {
    const t = setup();
    t.conn.start();
    const es = t.last();
    es.emit('stream.open', { id: 10 });
    es.emit('run.event', { id: 11 });
    es.emit('run.event', { id: 11 });
    es.emit('run.event', { id: 9 });
    es.emit('run.event', { id: 12 });
    expect(t.messages.map((m) => m.id)).toEqual([11, 12]);
  });

  it('after a browser auto-reconnect: resync via REST, no new EventSource', () => {
    const t = setup();
    t.conn.start();
    const es = t.last();
    es.emit('stream.open', { id: 10 });
    es.drop();
    expect(t.conn.state).toBe('reconnecting');
    expect(t.sources).toHaveLength(1);
    es.emit('stream.open', { id: 10, payload: { lastEventId: 10, replayed: null } });
    expect(t.conn.state).toBe('open');
    expect(t.resyncs).toEqual(['reconnected']);
  });

  it('when the EventSource gives up: reconnects with backoff and lastEventId, then resyncs', () => {
    const t = setup();
    t.conn.start();
    const es1 = t.last();
    es1.emit('stream.open', { id: 10 });
    es1.emit('run.event', { id: 15 });
    es1.fail();
    expect(es1.closed).toBe(true);
    expect(t.conn.state).toBe('reconnecting');
    expect(t.timers.at(-1)!.ms).toBe(1000);
    t.fire();
    const es2 = t.last();
    expect(es2.url).toBe('/api/v1/events?lastEventId=15');
    es2.fail(); // still down → longer delay
    expect(t.timers.at(-1)!.ms).toBe(2000);
    t.fire();
    const es3 = t.last();
    expect(es3.url).toBe('/api/v1/events?lastEventId=15');
    es3.emit('stream.open', { payload: { lastEventId: 15, replayed: null } });
    es3.emit('run.event', { id: 16 });
    expect(t.resyncs).toEqual(['reconnected']);
    expect(t.messages.map((m) => m.id)).toEqual([15, 16]);
    // backoff reset after a successful open
    es3.fail();
    expect(t.timers.at(-1)!.ms).toBe(1000);
  });

  it('stream.reset triggers a resync and adopts the (possibly lower) server ID', () => {
    const t = setup();
    t.conn.start();
    const es = t.last();
    es.emit('stream.open', { id: 100 });
    es.emit('stream.reset', { id: 40, payload: { reason: 'unknown_last_event_id', lastEventId: 40 } });
    expect(t.resyncs).toEqual(['reset']);
    expect(t.conn.lastEventId).toBe(40);
    es.emit('run.event', { id: 41 });
    expect(t.messages.map((m) => m.id)).toEqual([41]);
  });

  it('stop() closes and cancels a pending reconnect; reconnectNow() skips the wait', () => {
    const t = setup();
    t.conn.start();
    t.last().fail();
    expect(t.sources).toHaveLength(1);
    t.conn.reconnectNow();
    expect(t.sources).toHaveLength(2);
    t.last().fail();
    t.conn.stop();
    expect(t.conn.state).toBe('closed');
    expect(t.timers.every((x) => x.cleared)).toBe(true);
    // events from a stale source are ignored
    t.sources[0]!.emit('run.event', { id: 1 });
    expect(t.messages).toEqual([]);
  });
});
