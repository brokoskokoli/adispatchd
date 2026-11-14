/**
 * Schema v8 (WI-39): trigger `reply`, hook `on_reply`, chat threads, replies,
 * reminders, ordered thread deliveries and the reply-pending reservation guard.
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { openDatabase, schemaVersion } from './database.js';
import { LockConflictError, ReplyPendingError } from './errors.js';
import { openPersistence } from './persistence.js';
import { MIGRATIONS } from './schema.js';
import { SUCCESS, completeRun, openTestPersistence, reserveSource, tempDataDir } from './testing/helpers.js';

describe('schema v8 – chat threads and replies (WI-39)', () => {
  const tmp = tempDataDir();
  afterEach(() => tmp.cleanup());

  it('migrates v7 → v8 with backup; runs, locks, journal, effects and deliveries stay valid', () => {
    const clock = new FakeClock('2026-11-14T10:00:00.000Z');
    const v7 = openDatabase(tmp.dir, { clock, migrations: MIGRATIONS.filter((m) => m.version <= 7) });
    const now = clock.now().toISOString();
    v7.db.exec(`INSERT INTO runs (id, workflow_id, trigger_type, source_id, source_item_key, lock_key, config_snapshot, status, created_at, updated_at, retry_block_hook)
                VALUES ('run-1', 'wf', 'source', 'repo', 'repo:1', 'item:repo:1', '{}', 'running', '${now}', '${now}', 1)`);
    v7.db.exec(`INSERT INTO locks (workflow_id, lock_key, run_id, source_item_key, acquired_at) VALUES ('wf', 'item:repo:1', 'run-1', 'repo:1', '${now}')`);
    v7.db.exec(`INSERT INTO run_actions (id, run_id, hook, ordinal, action_type, action_config_json, status, attempts, created_at, updated_at, effect_json)
                VALUES (5, 'run-1', 'on_start', 0, 'source.update', '{}', 'succeeded', 1, '${now}', '${now}', '{"labelsAdded":["a"]}')`);
    v7.db.exec(`INSERT INTO action_attempts (run_action_id, attempt, started_at) VALUES (5, 1, '${now}')`);
    v7.db.exec(`INSERT INTO notifications (id, event_type, payload_json, delivery_state, attempts, created_at, updated_at)
                VALUES (9, 'recovery_failed', '{}', 'pending', 0, '${now}', '${now}')`);
    v7.db.exec(`INSERT INTO notification_deliveries (notification_id, channel_id, state, attempts, created_at, updated_at)
                VALUES (9, 'ops', 'pending', 0, '${now}', '${now}')`);
    expect(schemaVersion(v7.db)).toBe(7);
    v7.close();

    clock.set('2026-11-14T11:00:00.000Z');
    const p = openPersistence(tmp.dir, { clock });
    try {
      expect(schemaVersion(p.db)).toBe(8);
      expect(p.migration).toMatchObject({ fromVersion: 7, toVersion: 8, applied: [8] });
      expect(p.migration.backupPath).not.toBeNull();
      expect(existsSync(p.migration.backupPath!)).toBe(true);
      expect(p.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(p.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(p.runs.require('run-1')).toMatchObject({ status: 'running', retryBlockHook: true });
      expect(p.runs.listLocks().map((l) => l.runId)).toEqual(['run-1']);
      expect(p.actions.require(5)).toMatchObject({ hook: 'on_start', effect: { labelsAdded: ['a'] } });
      expect(p.actions.listAttempts(5)).toHaveLength(1);
      expect(p.notifications.listDeliveries(9)).toEqual([expect.objectContaining({ channelId: 'ops', threadId: null, messageTs: null })]);
      // The unique active-lock index survived the rebuild.
      expect(() => reserveSource(p, 'wf', 'repo:1')).toThrow(LockConflictError);
    } finally {
      p.close();
    }
  });

  it('accepts trigger reply and hook on_reply', () => {
    const { p, cleanup } = openTestPersistence();
    try {
      const run = p.runs.reserve({ workflowId: 'wf', triggerType: 'reply', sourceId: 'repo', sourceItemKey: 'repo:1', configSnapshot: {} });
      expect(run).toMatchObject({ triggerType: 'reply', lockKey: 'item:repo:1' });
      p.actions.createJournal(run.id, 'on_reply', [{ type: 'reply_check', name: 'reply_check', config: { type: 'reply_check' } }]);
      expect(p.actions.listForHook(run.id, 'on_reply')).toHaveLength(1);
      // Lifecycle runs do not count towards max_concurrent.
      expect(p.runs.countActive('wf')).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe('chat repositories (WI-39)', () => {
  const setup = () => {
    const ctx = openTestPersistence();
    const thread = ctx.p.threads.resolve({ channelId: 'team', workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', chatChannel: 'C0123456789', mode: 'item' });
    return { ...ctx, thread };
  };

  it('resolves one thread per (channel, workflow, item); thread: new creates another one', () => {
    const { p, thread, cleanup } = setup();
    try {
      const again = p.threads.resolve({ channelId: 'team', workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', chatChannel: 'C0123456789', mode: 'item' });
      expect(again.id).toBe(thread.id);
      const other = p.threads.resolve({ channelId: 'team', workflowId: 'wf2', sourceId: 'repo', itemKey: 'repo:1', chatChannel: 'C0123456789', mode: 'item' });
      expect(other.id).not.toBe(thread.id);
      const fresh = p.threads.resolve({ channelId: 'team', workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', chatChannel: 'C0123456789', mode: 'new' });
      expect(fresh.id).not.toBe(thread.id);
      // The newest thread is the current one.
      expect(p.threads.resolve({ channelId: 'team', workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', chatChannel: 'C0123456789', mode: 'item' }).id).toBe(fresh.id);
      p.threads.setThreadTs(thread.id, '111.1');
      p.threads.setThreadTs(thread.id, '222.2'); // never replaced
      expect(p.threads.findByTs('C0123456789', '111.1')?.id).toBe(thread.id);
      expect(p.threads.findByTs('C0123456789', '222.2')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('delivers messages of a thread in order: a younger delivery waits for an older pending one', () => {
    const { p, clock, thread, cleanup } = setup();
    try {
      const a = p.notifications.createWithDeliveries('workflow_notify', { text: 'a' }, [{ channelId: 'team', threadId: thread.id }]);
      const b = p.notifications.createWithDeliveries('workflow_notify', { text: 'b' }, [{ channelId: 'team', threadId: thread.id }]);
      const hook = p.notifications.createWithDeliveries('recovery_failed', {}, ['ops']);
      const due = () => p.notifications.listDueDeliveries(clock.now()).map((d) => d.notificationId);
      expect(due()).toEqual([a.notification.id, hook.notification.id]);
      // First one in backoff: the second still waits (order), the next due time is the backoff end.
      const first = a.deliveries[0]!;
      p.notifications.recordDeliveryAttempt(first.id, { success: false, error: 'HTTP 503', nextAttemptAt: new Date(clock.now().getTime() + 5_000) });
      expect(due()).toEqual([hook.notification.id]);
      expect(p.notifications.nextDeliveryDue()).toBe(new Date(clock.now().getTime()).toISOString());
      p.notifications.recordDeliveryAttempt(hook.deliveries[0]!.id, { success: true, status: 200 });
      expect(p.notifications.nextDeliveryDue()).toBe(new Date(clock.now().getTime() + 5_000).toISOString());
      clock.advance(5_000);
      expect(due()).toEqual([a.notification.id]);
      p.notifications.recordDeliveryAttempt(first.id, { success: true, status: 200, messageTs: '333.3' });
      expect(p.notifications.getDelivery(first.id)).toMatchObject({ state: 'delivered', messageTs: '333.3', threadId: thread.id });
      expect(due()).toEqual([b.notification.id]);
    } finally {
      cleanup();
    }
  });

  it('notification dedupe keys make notify idempotent', () => {
    const { p, cleanup } = setup();
    try {
      p.notifications.createWithDeliveries('workflow_notify', {}, ['team'], { dedupeKey: 'run-1:7' });
      expect(p.notifications.getByDedupeKey('run-1:7')).not.toBeNull();
      expect(() => p.notifications.createWithDeliveries('workflow_notify', {}, ['team'], { dedupeKey: 'run-1:7' })).toThrow(/UNIQUE/);
    } finally {
      cleanup();
    }
  });

  it('records a reply once per (chat channel, ts) and walks pending → running → done (text cleared)', () => {
    const { p, thread, cleanup } = setup();
    try {
      const input = {
        channelId: 'team',
        chatChannel: 'C0123456789',
        ts: '1700000000.000100',
        threadId: thread.id,
        workflowId: 'wf',
        sourceId: 'repo',
        itemKey: 'repo:1',
        userId: 'U0123456789',
        text: 'Go ahead',
        configSnapshot: { workflow: { id: 'wf' } },
        status: 'pending' as const,
      };
      const first = p.replies.record(input);
      expect(first.created).toBe(true);
      const dup = p.replies.record({ ...input, text: 'other' });
      expect(dup.created).toBe(false);
      expect(dup.reply).toMatchObject({ id: first.reply.id, text: 'Go ahead' });
      const second = p.replies.record({ ...input, ts: '1700000001.000100', text: 'Second' });
      expect(p.replies.listPendingHeads().map((r) => r.id)).toEqual([first.reply.id]);
      expect(p.replies.pendingFor('wf', 'repo:1')?.id).toBe(first.reply.id);

      const run = p.runs.reserve({ workflowId: 'wf', triggerType: 'reply', sourceId: 'repo', sourceItemKey: 'repo:1', configSnapshot: {} });
      expect(p.replies.assignRun(first.reply.id, run.id)).toMatchObject({ status: 'running', runId: run.id, configSnapshot: null, text: 'Go ahead' });
      expect(p.replies.forRun(run.id)?.id).toBe(first.reply.id);
      expect(p.replies.listPendingHeads().map((r) => r.id)).toEqual([second.reply.id]);
      expect(p.replies.complete(first.reply.id, 'done')).toMatchObject({ status: 'done', text: null });
      expect(p.replies.complete(second.reply.id, 'failed', 'reply_check failed')).toMatchObject({ status: 'failed', text: 'Second', reason: 'reply_check failed' });
      expect(p.replies.countByStatus()).toMatchObject({ done: 1, failed: 1, pending: 0 });
    } finally {
      cleanup();
    }
  });

  it('a pending reply blocks every other run of (workflow, item) until its run is reserved (P1)', () => {
    const { p, thread, cleanup } = setup();
    try {
      const { reply } = p.replies.record({
        channelId: 'team',
        chatChannel: 'C0123456789',
        ts: '1.1',
        threadId: thread.id,
        workflowId: 'wf',
        sourceId: 'repo',
        itemKey: 'repo:1',
        userId: 'U0123456789',
        text: 'x',
        configSnapshot: {},
        status: 'pending',
      });
      expect(() => reserveSource(p, 'wf', 'repo:1')).toThrow(ReplyPendingError);
      expect(() => p.runs.reserve({ workflowId: 'wf', triggerType: 'manual', sourceId: 'repo', sourceItemKey: 'repo:1', configSnapshot: {} })).toThrow(
        expect.objectContaining({ code: 'reply_pending' }),
      );
      // Other workflows / items are not affected.
      expect(reserveSource(p, 'wf2', 'repo:1').workflowId).toBe('wf2');
      expect(reserveSource(p, 'wf', 'repo:2').sourceItemKey).toBe('repo:2');
      const run = p.runs.reserve({ workflowId: 'wf', triggerType: 'reply', sourceId: 'repo', sourceItemKey: 'repo:1', configSnapshot: {} });
      p.replies.assignRun(reply.id, run.id);
      expect(() => reserveSource(p, 'wf', 'repo:1')).toThrow(LockConflictError);
    } finally {
      cleanup();
    }
  });

  it('reminders: due, cancelled by a reply in the thread, completed once', () => {
    const { p, clock, thread, cleanup } = setup();
    try {
      const n = p.notifications.createWithDeliveries('workflow_notify', {}, [{ channelId: 'team', threadId: thread.id }]).notification;
      const due = new Date(clock.now().getTime() + 60_000);
      const r = p.reminders.create({ notificationId: n.id, threadId: thread.id, channelId: 'team', workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', dueAt: due, filter: { field: 'labels', operator: 'contains', value: 'x' } });
      expect(p.reminders.nextDue()).toBe(due.toISOString());
      expect(p.reminders.listDue(clock.now())).toEqual([]);
      clock.advance(60_000);
      expect(p.reminders.listDue(clock.now()).map((x) => x.id)).toEqual([r.id]);
      expect(p.reminders.require(r.id).filter).toEqual({ field: 'labels', operator: 'contains', value: 'x' });
      expect(p.reminders.complete(r.id, 'sent', null, n.id)).toBe(true);
      expect(p.reminders.complete(r.id, 'skipped', 'again')).toBe(false);
      const r2 = p.reminders.create({ notificationId: n.id, threadId: thread.id, channelId: 'team', workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', dueAt: due, filter: null });
      expect(p.reminders.cancelForThread(thread.id, 'reply received')).toBe(1);
      expect(p.reminders.require(r2.id)).toMatchObject({ state: 'cancelled', reason: 'reply received' });
    } finally {
      cleanup();
    }
  });

  it('retention: inactive threads go (with replies without run); replies with a run go with the run', () => {
    const { p, clock, thread, cleanup } = setup();
    try {
      const base = { channelId: 'team', chatChannel: 'C0123456789', threadId: thread.id, workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', userId: 'U0123456789', configSnapshot: null };
      const rejected = p.replies.record({ ...base, ts: '1.1', text: null, status: 'rejected', reason: 'looks like a secret' }).reply;
      const withRun = p.replies.record({ ...base, ts: '1.2', text: 'ok', status: 'pending' }).reply;
      const run = p.runs.reserve({ workflowId: 'wf', triggerType: 'reply', sourceId: 'repo', sourceItemKey: 'repo:1', configSnapshot: {} });
      p.replies.assignRun(withRun.id, run.id);
      // A running reply protects the thread.
      clock.advance(100 * 86_400_000);
      expect(p.threads.deleteInactive(clock.now())).toBe(0);
      completeRun(p, run.id, SUCCESS);
      p.replies.complete(withRun.id, 'done');
      expect(p.threads.deleteInactive(clock.now())).toBe(1);
      expect(p.threads.get(thread.id)).toBeNull();
      expect(p.replies.get(rejected.id)).toBeNull();
      expect(p.replies.get(withRun.id)).toMatchObject({ threadId: null, runId: run.id });
      expect(p.retention.deleteRun(run.id)).toBe(true);
      expect(p.replies.get(withRun.id)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('notification retention keeps notify notifications with a pending reminder', () => {
    const { p, clock, thread, cleanup } = setup();
    try {
      const n = p.notifications.createWithDeliveries('workflow_notify', {}, [{ channelId: 'team', threadId: thread.id }]);
      p.notifications.recordDeliveryAttempt(n.deliveries[0]!.id, { success: true });
      const r = p.reminders.create({ notificationId: n.notification.id, threadId: thread.id, channelId: 'team', workflowId: 'wf', sourceId: 'repo', itemKey: 'repo:1', dueAt: clock.now(), filter: null });
      clock.advance(1000);
      expect(p.retention.deleteNotifications(clock.now())).toBe(0);
      p.reminders.complete(r.id, 'skipped', 'no longer waiting');
      expect(p.retention.deleteNotifications(clock.now())).toBe(1);
    } finally {
      cleanup();
    }
  });
});
