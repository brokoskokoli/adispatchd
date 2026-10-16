import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidTransitionError, LockConflictError, BlockedError } from './errors.js';
import { lockKeyFor } from './lock-keys.js';
import { finalizationTarget } from './runs.js';
import { CANCELLED, CRASH, FAILURE, SUCCESS, completeRun, openTestPersistence, reserveSource } from './testing/helpers.js';
import type { Persistence } from './persistence.js';
import type { FakeClock } from '../core/index.js';

describe('RunRepository', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  describe('reserve / locks', () => {
    it('creates a reserved run with lock and snapshot', () => {
      const run = reserveSource(p, 'coder', 'project_a:123', {
        sourceUrl: 'https://github.com/x/y/issues/123',
        parameters: { a: 1 },
        identity: 'coder-app',
        configSnapshot: { id: 'coder', execute: { command: 'x' } },
      });
      expect(run.status).toBe('reserved');
      expect(run.lockKey).toBe('item:project_a:123');
      expect(run.configSnapshot).toEqual({ id: 'coder', execute: { command: 'x' } });
      expect(run.parameters).toEqual({ a: 1 });
      expect(run.id).toMatch(/^run-20261016T190000000Z-[0-9a-f]{8}$/);
      expect(p.runs.activeLock('coder', 'item:project_a:123')?.runId).toBe(run.id);
      expect(p.runs.activeRunForItem('coder', 'project_a:123')?.id).toBe(run.id);
    });

    it('rejects a second reservation for the same workflow/item while active, allows it after finish', () => {
      const first = reserveSource(p, 'coder', 'project_a:1');
      expect(() => reserveSource(p, 'coder', 'project_a:1')).toThrow(LockConflictError);
      // manual start with the same item must not bypass the lock either (Spec §7)
      expect(() =>
        p.runs.reserve({ workflowId: 'coder', triggerType: 'manual', sourceItemKey: 'project_a:1', configSnapshot: {} }),
      ).toThrow(LockConflictError);
      try {
        reserveSource(p, 'coder', 'project_a:1');
      } catch (err) {
        expect((err as LockConflictError).code).toBe('lock_conflict');
        expect((err as LockConflictError).holderRunId).toBe(first.id);
      }
      expect(p.runs.countActive()).toBe(1);

      completeRun(p, first.id, SUCCESS);
      expect(p.runs.activeLock('coder', 'item:project_a:1')).toBeNull();
      const second = reserveSource(p, 'coder', 'project_a:1');
      expect(second.id).not.toBe(first.id);
    });

    it('keeps the lock through every active status incl. recovery_pending', () => {
      const run = reserveSource(p, 'coder', 'project_a:1');
      p.runs.transition(run.id, 'starting');
      p.runs.transition(run.id, 'running');
      p.runs.transition(run.id, 'recovery_pending');
      expect(() => reserveSource(p, 'coder', 'project_a:1')).toThrow(LockConflictError);
      p.runs.beginFinalization(run.id, CRASH);
      expect(() => reserveSource(p, 'coder', 'project_a:1')).toThrow(LockConflictError);
      p.runs.finish(run.id);
      expect(() => reserveSource(p, 'coder', 'project_a:1')).not.toThrow();
    });

    it('allows different workflows to reserve the same item concurrently', () => {
      const a = reserveSource(p, 'coder', 'project_a:7');
      const b = reserveSource(p, 'reviewer', 'project_a:7');
      expect(a.id).not.toBe(b.id);
      expect(p.runs.countActive()).toBe(2);
      expect(p.runs.countActive('coder')).toBe(1);
      expect(p.runs.countActive('reviewer')).toBe(1);
    });

    it('uses cron-slot lock keys for scheduled runs and unique keys for item-less manual runs', () => {
      const slot = '2026-10-17T03:00:00.000Z';
      const cron = p.runs.reserve({ workflowId: 'nightly', triggerType: 'schedule', scheduledFor: slot, configSnapshot: {} });
      expect(cron.lockKey).toBe(`cron:${slot}`);
      expect(cron.scheduledFor).toBe(slot);
      expect(() =>
        p.runs.reserve({ workflowId: 'nightly', triggerType: 'schedule', scheduledFor: new Date(slot), configSnapshot: {} }),
      ).toThrow(LockConflictError);
      // next slot is independent
      p.runs.reserve({ workflowId: 'nightly', triggerType: 'schedule', scheduledFor: '2026-10-18T03:00:00Z', configSnapshot: {} });

      const m1 = p.runs.reserve({ workflowId: 'deploy', triggerType: 'manual', configSnapshot: {} });
      const m2 = p.runs.reserve({ workflowId: 'deploy', triggerType: 'manual', configSnapshot: {} });
      expect(m1.lockKey).toBe(`manual:${m1.id}`);
      expect(m2.lockKey).toBe(`manual:${m2.id}`);
      expect(p.runs.countActive('deploy')).toBe(2);
    });

    it('lockKeyFor validates required inputs', () => {
      expect(() => lockKeyFor({ triggerType: 'source', runId: 'r' })).toThrow();
      expect(() => lockKeyFor({ triggerType: 'schedule', runId: 'r' })).toThrow();
      expect(lockKeyFor({ triggerType: 'schedule', runId: 'r', sourceItemKey: 's:1' })).toBe('item:s:1');
    });

    it('failIfBlocked refuses reservation atomically when an active block exists; manual ignores blocks', () => {
      const block = p.blocks.create({ workflowId: 'coder', itemKey: 'project_a:9', reason: 'test' });
      expect(() => reserveSource(p, 'coder', 'project_a:9', { failIfBlocked: true })).toThrow(BlockedError);
      expect(p.runs.countActive()).toBe(0);
      const manual = p.runs.reserve({
        workflowId: 'coder',
        triggerType: 'manual',
        sourceItemKey: 'project_a:9',
        configSnapshot: {},
      });
      expect(manual.status).toBe('reserved');
      expect(block.id).toBeGreaterThan(0);
    });
  });

  describe('state machine', () => {
    it('rejects invalid transitions', () => {
      const run = reserveSource(p, 'coder', 'project_a:1');
      expect(() => p.runs.transition(run.id, 'running')).toThrow(InvalidTransitionError); // reserved → running
      expect(() => p.runs.transition(run.id, 'reserved')).toThrow(InvalidTransitionError);
      // terminal / finalizing only through the dedicated methods
      expect(() => p.runs.transition(run.id, 'completed')).toThrow(InvalidTransitionError);
      expect(() => p.runs.transition(run.id, 'finalizing')).toThrow(InvalidTransitionError);
      // finish without finalizing
      expect(() => p.runs.finish(run.id)).toThrow(InvalidTransitionError);
      // expectedFrom guard
      expect(() => p.runs.transition(run.id, 'starting', { expectedFrom: 'running' })).toThrow(InvalidTransitionError);

      p.runs.transition(run.id, 'starting');
      p.runs.transition(run.id, 'running');
      expect(() => p.runs.transition(run.id, 'starting')).toThrow(InvalidTransitionError);
      p.runs.beginFinalization(run.id, SUCCESS);
      expect(() => p.runs.beginFinalization(run.id, SUCCESS)).toThrow(InvalidTransitionError); // finalizing → finalizing
      expect(() => p.runs.transition(run.id, 'cancelling')).toThrow(InvalidTransitionError);
      const done = p.runs.finish(run.id);
      expect(done.status).toBe('completed');
      // terminal is final
      expect(() => p.runs.transition(run.id, 'starting')).toThrow(InvalidTransitionError);
      expect(() => p.runs.beginFinalization(run.id, CRASH)).toThrow(InvalidTransitionError);
      expect(() => p.runs.finish(run.id)).toThrow(InvalidTransitionError);
    });

    it('validates finalization targets', () => {
      const run = reserveSource(p, 'coder', 'project_a:1');
      expect(() => p.runs.beginFinalization(run.id, { status: 'completed', businessResult: null, reason: 'x' })).toThrow(
        InvalidTransitionError,
      );
      expect(() => p.runs.beginFinalization(run.id, { status: 'crashed', businessResult: 'failure', reason: 'x' })).toThrow(
        InvalidTransitionError,
      );
      expect(() =>
        p.runs.beginFinalization(run.id, { status: 'running' as never, businessResult: null, reason: 'x' }),
      ).toThrow(InvalidTransitionError);
      expect(p.runs.require(run.id).status).toBe('reserved');
    });

    it('persists the finalization target and finishes to exactly that status, releasing the lock', () => {
      const run = reserveSource(p, 'coder', 'project_a:1');
      p.runs.transition(run.id, 'starting');
      clock.advance(1000);
      const running = p.runs.transition(run.id, 'running', {
        update: { pid: 99, processStartIdentity: { pid: 99, pgid: 99, token: 'darwin:x' } },
      });
      expect(running.startedAt).toBe('2026-10-16T19:00:01.000Z');
      expect(running.processStartIdentity).toEqual({ pid: 99, pgid: 99, token: 'darwin:x' });
      const fin = p.runs.beginFinalization(run.id, FAILURE, {
        update: { exitCode: 0, result: { schema_version: 1, result: 'failure', message: 'needs input' } },
      });
      expect(fin.run.status).toBe('finalizing');
      expect(finalizationTarget(fin.run)).toEqual(FAILURE);
      expect(fin.run.result).toEqual({ schema_version: 1, result: 'failure', message: 'needs input' });
      // lock still held while hooks run
      expect(p.runs.activeLock('coder', run.lockKey)).not.toBeNull();
      clock.advance(1000);
      const done = p.runs.finish(run.id, { update: { lifecycleStatus: 'succeeded' } });
      expect(done.status).toBe('completed');
      expect(done.businessResult).toBe('failure');
      expect(done.finishedAt).toBe('2026-10-16T19:00:02.000Z');
      expect(done.lifecycleStatus).toBe('succeeded');
      expect(p.runs.activeLock('coder', run.lockKey)).toBeNull();
      const statusEvents = p.events.listForRun(run.id).filter((e) => e.type === 'run.status');
      expect(statusEvents.map((e) => e.payload.to)).toEqual(['reserved', 'starting', 'running', 'finalizing', 'completed']);
    });

    it('supports cancel before start and recovery paths via finalizing', () => {
      const a = reserveSource(p, 'coder', 'project_a:1');
      p.runs.transition(a.id, 'cancelling');
      p.runs.beginFinalization(a.id, CANCELLED);
      expect(p.runs.finish(a.id).status).toBe('cancelled');

      const b = reserveSource(p, 'coder', 'project_a:2');
      p.runs.transition(b.id, 'starting');
      p.runs.beginFinalization(b.id, { status: 'start_error', businessResult: null, reason: 'on_start failed' });
      expect(p.runs.finish(b.id).status).toBe('start_error');
    });
  });

  describe('queries', () => {
    it('lists active runs and paged history with filters', () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        clock.advance(1000);
        const r = reserveSource(p, i % 2 === 0 ? 'coder' : 'reviewer', `project_a:${i}`);
        ids.push(r.id);
        if (i < 3) completeRun(p, r.id, i === 1 ? CRASH : SUCCESS);
      }
      expect(p.runs.listActive().map((r) => r.id)).toEqual([ids[3], ids[4]]);
      expect(p.runs.listActive('coder').map((r) => r.id)).toEqual([ids[4]]);

      const page1 = p.runs.list({ limit: 2 });
      expect(page1.total).toBe(5);
      expect(page1.runs.map((r) => r.id)).toEqual([ids[4], ids[3]]);
      const page2 = p.runs.list({ limit: 2, offset: 2 });
      expect(page2.runs.map((r) => r.id)).toEqual([ids[2], ids[1]]);
      expect(p.runs.list({ workflowId: 'coder' }).total).toBe(3);
      expect(p.runs.list({ statuses: ['crashed'] }).runs.map((r) => r.id)).toEqual([ids[1]]);
      expect(p.runs.list({ businessResult: 'success' }).total).toBe(2);
      expect(p.runs.list({ sourceItemKey: 'project_a:0' }).total).toBe(1);
    });

    it('returns the last run per item (views run.last_*)', () => {
      const r1 = reserveSource(p, 'coder', 'project_a:1');
      completeRun(p, r1.id, SUCCESS);
      clock.advance(1000);
      const r2 = reserveSource(p, 'reviewer', 'project_a:1');
      clock.advance(1000);
      const r3 = reserveSource(p, 'coder', 'project_b:5');
      completeRun(p, r3.id, FAILURE);

      const last = p.runs.lastRunsForItems(['project_a:1', 'project_b:5', 'project_c:9']);
      expect(last.get('project_a:1')?.id).toBe(r2.id);
      expect(last.get('project_b:5')?.id).toBe(r3.id);
      expect(last.has('project_c:9')).toBe(false);
      expect(p.runs.lastRunForItem('project_a:1', { finishedOnly: true })?.id).toBe(r1.id);
      expect(p.runs.lastRunForItem('project_a:1', { workflowId: 'coder' })?.id).toBe(r1.id);
      expect(p.runs.lastRunForItem('project_c:9')).toBeNull();
    });
  });
});
