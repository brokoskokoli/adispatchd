import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { openTestPersistence, reserveSource } from '../persistence/testing/helpers.js';
import type { Persistence } from '../persistence/index.js';
import { PersistedEventPublisher, RunEventBus } from '../runs/index.js';
import { EventHub } from './sse.js';

/** Minimal ServerResponse double with a controllable socket buffer. */
class FakeRes extends EventEmitter {
  chunks: string[] = [];
  writableLength = 0;
  destroyed = false;
  ended = false;
  status = 0;
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
  get text(): string {
    return this.chunks.join('');
  }
  ids(): number[] {
    return [...this.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  }
}

describe('EventHub', () => {
  let p: Persistence;
  let cleanup: () => void;
  let bus: RunEventBus;
  let publisher: PersistedEventPublisher;
  let clock: FakeClock;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
    bus = new RunEventBus();
    publisher = new PersistedEventPublisher(p, bus);
  });
  afterEach(() => cleanup());

  const hub = (opts: Partial<ConstructorParameters<typeof EventHub>[0]> = {}) =>
    new EventHub({ bus, events: p.events, lastPublishedId: () => publisher.lastPublishedId, clock, timers: clock, heartbeatMs: 1000, ...opts });
  const connect = (h: EventHub, options: { runId?: string; lastEventId?: number } = {}) => {
    const req = new EventEmitter();
    const res = new FakeRes();
    h.handle(req as never, res as never, options);
    return { req, res };
  };

  it('replays missed events after Last-Event-ID, then continues live without duplicates', () => {
    const run = reserveSource(p, 'wf', 'a:1');
    publisher.flush();
    const first = p.events.listSince(0).at(-1)!.id;
    p.events.append(run.id, 'progress', { n: 1 });
    p.events.append(run.id, 'progress', { n: 2 });
    const h = hub();
    const { res } = connect(h, { lastEventId: first });
    const replayed = res.ids();
    expect(replayed).toEqual(p.events.listSince(first).map((e) => e.id));
    // The publisher now publishes the same (already replayed) events live → skipped; a new one is sent.
    p.events.append(run.id, 'progress', { n: 3 });
    publisher.flush();
    const all = res.ids();
    expect(new Set(all).size).toBe(all.length);
    expect(all.at(-1)).toBe(p.events.latestId());
    expect(res.text).toContain('event: run.event');
    h.publish('notification', { id: 1 });
    expect(res.text).toContain('event: notification');
    h.close();
    expect(res.ended).toBe(true);
  });

  it('sends a baseline id without Last-Event-ID, filters by run and sends heartbeats', () => {
    const a = reserveSource(p, 'wf', 'a:1');
    const b = reserveSource(p, 'wf', 'a:2');
    publisher.flush();
    const h = hub();
    const { res } = connect(h, { runId: a.id });
    expect(res.ids()).toEqual([publisher.lastPublishedId]); // stream.open baseline
    p.events.append(b.id, 'progress', {});
    p.events.append(a.id, 'progress', {});
    publisher.flush();
    bus.publish({ type: 'run.output', runId: b.id, stream: 'stdout', data: 'other', at: clock.now().toISOString() });
    bus.publish({ type: 'run.output', runId: a.id, stream: 'stdout', data: 'mine', at: clock.now().toISOString() });
    expect(res.text).toContain('mine');
    expect(res.text).not.toContain('other');
    expect(res.text.match(/event: run.event/g)).toHaveLength(1);
    clock.advance(1000);
    expect(res.text).toContain(': heartbeat');
    h.close();
  });

  it('disconnects slow clients instead of buffering without bound', () => {
    const h = hub({ maxBufferBytes: 100 });
    const { res } = connect(h);
    expect(h.clientCount).toBe(1);
    res.writableLength = 1000; // socket not draining
    bus.publish({ type: 'run.output', runId: 'r', stream: 'stdout', data: 'x', at: clock.now().toISOString() });
    expect(res.destroyed).toBe(true);
    expect(h.clientCount).toBe(0);
    h.close();
  });

  it('resets the stream when the Last-Event-ID is newer than any known event', () => {
    const run = reserveSource(p, 'wf', 'a:1');
    publisher.flush();
    const latest = p.events.latestId();
    const h = hub();
    const { res } = connect(h, { lastEventId: latest + 1000 });
    expect(res.text).toContain('event: stream.reset');
    expect(res.text).toContain('unknown_last_event_id');
    expect(res.ids()).toEqual([latest]);
    // New events after the reset are delivered (not suppressed by the bogus high ID).
    p.events.append(run.id, 'progress', {});
    publisher.flush();
    expect(res.ids()).toEqual([latest, p.events.latestId()]);
    h.close();
  });

  it('resets the stream when too many events were missed', () => {
    const run = reserveSource(p, 'wf', 'a:1');
    for (let i = 0; i < 20; i++) p.events.append(run.id, 'progress', { i });
    const h = hub({ maxReplay: 5 });
    const { res } = connect(h, { lastEventId: 0 });
    expect(res.text).toContain('event: stream.reset');
    expect(res.ids()).toEqual([p.events.latestId()]);
    h.close();
  });
});
