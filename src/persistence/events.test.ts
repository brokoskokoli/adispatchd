import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from './errors.js';
import type { Persistence } from './persistence.js';
import { completeRun, openTestPersistence, reserveSource, SUCCESS } from './testing/helpers.js';

describe('EventRepository', () => {
  let p: Persistence;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  it('assigns globally monotonic IDs and per-run sequences; listSince returns missed events', () => {
    const a = reserveSource(p, 'coder', 'project_a:1'); // emits run.status (reserved)
    const b = reserveSource(p, 'coder', 'project_a:2');
    const e1 = p.events.append(a.id, 'progress', { value: 10 }, { origin: 'worker' });
    const e2 = p.events.append(b.id, 'progress', { value: 20 }, { origin: 'worker' });
    const e3 = p.events.append(a.id, 'progress', { value: 30 }, { origin: 'worker' });
    expect(e2.id).toBeGreaterThan(e1.id);
    expect(e3.id).toBeGreaterThan(e2.id);
    expect(e1.sequence).toBe(2);
    expect(e3.sequence).toBe(3);
    expect(e2.sequence).toBe(2);

    // client saw up to e1 → gets e2, e3
    expect(p.events.listSince(e1.id).map((e) => e.id)).toEqual([e2.id, e3.id]);
    expect(p.events.listSince(e1.id, { runId: a.id }).map((e) => e.id)).toEqual([e3.id]);
    expect(p.events.listSince(0, { limit: 2 })).toHaveLength(2);
    expect(p.events.listForRun(a.id).map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(p.events.listForRun(a.id, { afterSequence: 2 }).map((e) => e.id)).toEqual([e3.id]);
    expect(p.events.latestId()).toBe(e3.id);
  });

  it('never reuses event IDs after deletion', () => {
    const a = reserveSource(p, 'coder', 'project_a:1');
    completeRun(p, a.id, SUCCESS);
    const before = p.events.latestId();
    expect(p.retention.deleteRun(a.id)).toBe(true);
    expect(p.events.latestId()).toBe(before);
    const b = reserveSource(p, 'coder', 'project_a:2');
    expect(p.events.listForRun(b.id)[0]!.id).toBeGreaterThan(before);
  });

  it('updates the run status message from worker status events only', () => {
    const run = reserveSource(p, 'coder', 'project_a:1');
    p.events.appendWorkerEvent(run.id, {
      type: 'status',
      at: new Date('2026-10-16T19:00:05Z'),
      stream: 'stdout',
      data: { type: 'status', message: 'Tests laufen' },
    });
    expect(p.runs.require(run.id).statusMessage).toBe('Tests laufen');
    p.events.append(run.id, 'status', { message: 'spoof' }, { origin: 'orchestrator' });
    expect(p.runs.require(run.id).statusMessage).toBe('Tests laufen');
    const ev = p.events.listForRun(run.id).find((e) => e.type === 'status' && e.origin === 'worker');
    expect(ev?.timestamp).toBe('2026-10-16T19:00:05.000Z');
  });

  it('stores executor diagnostics as orchestrator events', () => {
    const run = reserveSource(p, 'coder', 'project_a:1');
    const ev = p.events.appendDiagnostic(run.id, {
      type: 'log_write_error',
      at: new Date('2026-10-16T19:00:06Z'),
      stream: 'stderr',
      message: 'ENOSPC',
    });
    expect(ev).toMatchObject({ origin: 'orchestrator', type: 'diagnostic.log_write_error', payload: { message: 'ENOSPC', stream: 'stderr' } });
  });

  it('rejects events for unknown runs', () => {
    expect(() => p.events.append('run-x', 'progress', {})).toThrow(NotFoundError);
  });
});
