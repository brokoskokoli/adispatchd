import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeClock } from '../core/index.js';
import type { Persistence } from './persistence.js';
import { openTestPersistence } from './testing/helpers.js';

describe('NotificationRepository', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  it('persists, lists due notifications and records attempts', () => {
    const n = p.notifications.create('retry_block_created', { blockId: 1 });
    expect(n).toMatchObject({ deliveryState: 'pending', attempts: 0 });
    expect(p.notifications.listDue().map((x) => x.id)).toEqual([n.id]);

    const retry = p.notifications.recordAttempt(n.id, { success: false, error: 'HTTP 500', nextAttemptAt: '2026-10-16T19:01:00Z' });
    expect(retry).toMatchObject({ deliveryState: 'pending', attempts: 1, lastError: 'HTTP 500' });
    expect(p.notifications.listDue()).toHaveLength(0);
    clock.advance(60_000);
    expect(p.notifications.listDue()).toHaveLength(1);

    const ok = p.notifications.recordAttempt(n.id, { success: true });
    expect(ok).toMatchObject({ deliveryState: 'delivered', attempts: 2, nextAttemptAt: null });
    expect(ok.deliveredAt).toBe('2026-10-16T19:01:00.000Z');

    const m = p.notifications.create('recovery_failed', {});
    const failed = p.notifications.recordAttempt(m.id, { success: false, error: 'timeout', nextAttemptAt: null });
    expect(failed.deliveryState).toBe('failed');
    expect(p.notifications.list({ state: 'failed' }).map((x) => x.id)).toEqual([m.id]);
  });
});

describe('CronFiringRepository', () => {
  let p: Persistence;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  it('records at most one firing per slot', () => {
    const slot = new Date('2026-10-17T03:00:00Z');
    const first = p.cronFirings.record({ workflowId: 'nightly', scheduledFor: slot, decision: 'pending' });
    expect(first.inserted).toBe(true);
    const dup = p.cronFirings.record({ workflowId: 'nightly', scheduledFor: '2026-10-17T03:00:00.000Z', decision: 'started' });
    expect(dup.inserted).toBe(false);
    expect(dup.firing.decision).toBe('pending');

    const run = p.runs.reserve({ workflowId: 'nightly', triggerType: 'schedule', scheduledFor: slot, configSnapshot: {} });
    const updated = p.cronFirings.update('nightly', slot, { decision: 'started', runId: run.id });
    expect(updated).toMatchObject({ decision: 'started', runId: run.id });

    p.cronFirings.record({ workflowId: 'nightly', scheduledFor: '2026-10-18T03:00:00Z', decision: 'skipped_limit', reason: 'max_concurrent' });
    expect(p.cronFirings.latest('nightly')?.decision).toBe('skipped_limit');
    expect(p.cronFirings.listForWorkflow('nightly')).toHaveLength(2);
    // a different workflow may use the same slot
    expect(p.cronFirings.record({ workflowId: 'other', scheduledFor: slot, decision: 'started' }).inserted).toBe(true);
  });
});
