import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../core/index.js';
import { openTestPersistence, reserveSource } from '../persistence/testing/helpers.js';
import { PersistedEventPublisher, RunEventBus, type BusEvent } from './event-bus.js';

describe('RunEventBus', () => {
  it('delivers to matching subscribers, isolates throwing listeners, unsubscribes', () => {
    const logger = new MemoryLogger();
    const bus = new RunEventBus(logger);
    const all: BusEvent[] = [];
    const onlyStatus: BusEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    const off = bus.subscribe((e) => all.push(e));
    bus.subscribe((e) => onlyStatus.push(e), ['system.status']);
    const status = { ready: true, paused: false, draining: false, stopping: false, activeRuns: 0 };
    bus.publish({ type: 'system.status', status });
    bus.publish({ type: 'run.output', runId: 'r', stream: 'stdout', data: 'x', at: '2026-01-01T00:00:00.000Z' });
    expect(all.map((e) => e.type)).toEqual(['system.status', 'run.output']);
    expect(onlyStatus).toEqual([{ type: 'system.status', status }]);
    expect(logger.records.some((r) => r.msg === 'event bus listener failed')).toBe(true);
    off();
    bus.publish({ type: 'system.status', status });
    expect(all).toHaveLength(2);
    expect(bus.listenerCount).toBe(2);
  });
});

describe('PersistedEventPublisher', () => {
  let t: ReturnType<typeof openTestPersistence>;
  beforeEach(() => {
    t = openTestPersistence();
  });
  afterEach(() => t.cleanup());

  it('publishes committed events once, in ID order, never rolled-back ones, and starts at the current end', () => {
    const before = reserveSource(t.p, 'wf', 'src:1');
    const bus = new RunEventBus();
    const seen: number[] = [];
    bus.subscribe((e) => {
      if (e.type === 'run.event') seen.push(e.event.id);
    });
    const publisher = new PersistedEventPublisher(t.p, bus);
    publisher.flush();
    expect(seen).toEqual([]); // history (the reservation event) is not replayed

    expect(() =>
      t.p.transaction(() => {
        t.p.events.append(before.id, 'x', {});
        publisher.flush(); // inside a transaction: deferred, and dropped on rollback
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(seen).toEqual([]);

    t.p.transaction(() => {
      t.p.events.append(before.id, 'a', {});
      t.p.events.append(before.id, 'b', {});
      publisher.flush();
      expect(seen).toEqual([]); // not before commit
    });
    publisher.flush();
    const ids = t.p.events.listForRun(before.id).filter((e) => e.type !== 'run.status').map((e) => e.id);
    expect(seen).toEqual(ids);
    expect(publisher.lastPublishedId).toBe(ids[ids.length - 1]);
  });

  it('actionListener publishes pending events before the action change', () => {
    const run = reserveSource(t.p, 'wf', 'src:1');
    const bus = new RunEventBus();
    const types: string[] = [];
    bus.subscribe((e) => types.push(e.type === 'run.event' ? `event:${e.event.type}` : e.type));
    const publisher = new PersistedEventPublisher(t.p, bus);
    const [action] = t.p.actions.createJournal(run.id, 'on_success', [{ type: 'shell', config: {} }]);
    t.p.events.append(run.id, 'lifecycle.action', {});
    publisher.actionListener()(action!);
    expect(types).toEqual(['event:lifecycle.action', 'run.action']);
  });
});
