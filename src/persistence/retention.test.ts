import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeClock } from '../core/index.js';
import type { Persistence } from './persistence.js';
import { CANCELLED, CRASH, FAILURE, SUCCESS, completeRun, openTestPersistence, reserveSource } from './testing/helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('RetentionRepository', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  it('selects old runs by category and protects active runs, open blocks and unfinished action chains', () => {
    const oldSuccess = completeRun(p, reserveSource(p, 'coder', 'a:1').id, SUCCESS);
    const oldFailure = completeRun(p, reserveSource(p, 'coder', 'a:2').id, FAILURE);
    const oldCancelled = completeRun(p, reserveSource(p, 'coder', 'a:3').id, CANCELLED);
    const active = reserveSource(p, 'coder', 'a:4');
    p.runs.transition(active.id, 'starting');
    const policy = { maxTechnicalFailures: 1 };
    const blocked = completeRun(p, reserveSource(p, 'coder', 'a:5').id, CRASH, policy);
    expect(p.blocks.isBlocked('coder', 'a:5')).toBe(true);

    // unfinished chain: pending action
    const chain = completeRun(p, reserveSource(p, 'coder', 'a:6').id, SUCCESS);
    p.actions.createJournal(chain.id, 'on_success', [{ type: 'shell', config: {} }]);
    // lifecycle failed
    const lifecycleFailed = completeRun(p, reserveSource(p, 'coder', 'a:7').id, SUCCESS);
    p.runs.update(lifecycleFailed.id, { lifecycleStatus: 'failed' });
    // finished chain: succeeded action, lifecycle succeeded → deletable
    const chainDone = completeRun(p, reserveSource(p, 'coder', 'a:8').id, SUCCESS);
    const [act] = p.actions.createJournal(chainDone.id, 'on_success', [{ type: 'shell', config: {} }]);
    p.actions.startAttempt(act!.id);
    p.actions.setStatus(act!.id, 'succeeded');
    p.runs.update(chainDone.id, { lifecycleStatus: 'succeeded' });

    clock.advance(31 * DAY);
    const recent = completeRun(p, reserveSource(p, 'coder', 'a:9').id, SUCCESS);
    const cutoff = new Date(clock.now().getTime() - 30 * DAY);

    const successful = p.retention.runCandidates('successful', cutoff).map((c) => c.runId);
    expect(successful.sort()).toEqual([oldSuccess.id, chainDone.id].sort());
    expect(successful).not.toContain(recent.id);
    const failed = p.retention.runCandidates('failed', cutoff).map((c) => c.runId);
    expect(failed.sort()).toEqual([oldFailure.id, oldCancelled.id].sort());

    for (const protectedId of [active.id, blocked.id, chain.id, lifecycleFailed.id]) {
      expect(p.retention.isRunProtected(protectedId)).toBe(true);
      expect(p.retention.deleteRun(protectedId)).toBe(false);
      expect(p.runs.get(protectedId)).not.toBeNull();
    }

    p.events.append(oldSuccess.id, 'progress', { value: 1 });
    expect(p.retention.deleteRun(oldSuccess.id)).toBe(true);
    expect(p.runs.get(oldSuccess.id)).toBeNull();
    expect(p.events.listForRun(oldSuccess.id)).toHaveLength(0);
    expect(p.retention.deleteRun(chainDone.id)).toBe(true);
    expect(p.actions.listForRun(chainDone.id)).toHaveLength(0);

    // clearing the block releases its runs for retention (category `blocked` since WI-10: `retention.blocked_runs`)
    p.blocks.clear(p.blocks.activeFor('coder', 'a:5')!.id);
    expect(p.retention.runCandidates('blocked', cutoff).map((c) => c.runId)).toContain(blocked.id);
    expect(p.retention.runCandidates('failed', cutoff).map((c) => c.runId)).not.toContain(blocked.id);
  });

  it('deletes only cleared blocks, non-pending notifications and old cron firings', () => {
    const active = p.blocks.create({ workflowId: 'coder', itemKey: 'a:1', reason: 'x' });
    const old = p.blocks.create({ workflowId: 'coder', itemKey: 'a:2', reason: 'x' });
    p.blocks.clear(old.id);
    const pending = p.notifications.create('recovery_failed', {});
    const delivered = p.notifications.create('recovery_failed', {});
    p.notifications.recordAttempt(delivered.id, { success: true });
    p.cronFirings.record({ workflowId: 'nightly', scheduledFor: '2026-10-15T03:00:00Z', decision: 'started' });
    p.cronFirings.record({ workflowId: 'nightly', scheduledFor: '2026-10-16T03:00:00Z', decision: 'started' });

    clock.advance(100 * DAY);
    const cutoff = clock.now();
    expect(p.retention.deleteClearedBlocks(cutoff)).toBe(1);
    expect(p.blocks.get(active.id)).not.toBeNull();
    expect(p.retention.deleteNotifications(cutoff)).toBe(1);
    expect(p.notifications.get(pending.id)).not.toBeNull();
    expect(p.retention.deleteCronFirings(cutoff)).toBe(1);
    expect(p.cronFirings.latest('nightly')?.scheduledFor).toBe('2026-10-16T03:00:00.000Z');
  });
});
