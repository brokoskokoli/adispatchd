/**
 * Schema v5 (WI-30): trigger `unblock`, `runs.retry_block_hook`,
 * `run_actions.hook` with the retry-block hooks, `blocks.last_status` and
 * `blocks.cleared_run_id`; repository behaviour around lifecycle runs.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { openDatabase, schemaVersion } from './database.js';
import { BlockedError } from './errors.js';
import { openPersistence } from './persistence.js';
import { MIGRATIONS } from './schema.js';
import { CRASH, SUCCESS, completeRun, openTestPersistence, reserveSource, tempDataDir } from './testing/helpers.js';

describe('schema v5 – retry-block hooks (WI-30)', () => {
  const tmp = tempDataDir();
  afterEach(() => tmp.cleanup());

  it('migrates v4 → v5 with backup; runs, locks, journal, attempts and blocks stay valid', () => {
    const clock = new FakeClock('2026-10-22T10:00:00.000Z');
    const v4 = openDatabase(tmp.dir, { clock, migrations: MIGRATIONS.filter((m) => m.version <= 4) });
    const now = clock.now().toISOString();
    const crashed = { id: 'run-crashed' };
    const active = { id: 'run-active' };
    v4.db.exec(`INSERT INTO runs (id, workflow_id, trigger_type, source_id, source_item_key, lock_key, config_snapshot, status,
                  final_status, counted_technical_failure, block_generation, created_at, finished_at, updated_at)
                VALUES ('run-crashed', 'wf', 'source', 'repo_a', 'repo_a:1', 'item:repo_a:1', '{}', 'crashed',
                  'crashed', 1, 0, '${now}', '${now}', '${now}')`);
    v4.db.exec(`INSERT INTO runs (id, workflow_id, trigger_type, source_id, source_item_key, lock_key, config_snapshot, status, created_at, updated_at)
                VALUES ('run-active', 'wf', 'source', 'repo_a', 'repo_a:2', 'item:repo_a:2', '{}', 'reserved', '${now}', '${now}')`);
    v4.db.exec(`INSERT INTO locks (workflow_id, lock_key, run_id, source_item_key, acquired_at)
                VALUES ('wf', 'item:repo_a:2', 'run-active', 'repo_a:2', '${now}')`);
    v4.db.exec(`INSERT INTO run_events (run_id, sequence, timestamp, origin, type, payload_json)
                VALUES ('run-active', 1, '${now}', 'orchestrator', 'test.event', '{}')`);
    v4.db.exec(`INSERT INTO run_actions (id, run_id, hook, ordinal, action_type, action_config_json, status, attempts, created_at, updated_at)
                VALUES (7, 'run-crashed', 'on_crash', 0, 'shell', '{}', 'failed', 1, '${now}', '${now}')`);
    v4.db.exec(`INSERT INTO action_attempts (run_action_id, attempt, started_at) VALUES (7, 1, '${now}')`);
    v4.db.exec(`INSERT INTO blocks (id, workflow_id, source_item_key, reason, run_id, failure_count, generation, created_at)
                VALUES (3, 'wf', 'repo_a:1', '3 consecutive technical failures', 'run-crashed', 3, 0, '${now}')`);
    const action = { id: 7 };
    const blockBefore = { id: 3 };
    v4.close();

    clock.set('2026-10-22T11:00:00.000Z');
    const p = openPersistence(tmp.dir, { clock });
    try {
      expect(schemaVersion(p.db)).toBe(5);
      expect(p.migration.applied).toEqual([5]);
      expect(p.migration.backupPath).not.toBeNull();
      expect(existsSync(p.migration.backupPath!)).toBe(true);
      expect(p.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(p.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // Existing data is unchanged; the old block got the final status of its run.
      expect(p.runs.require(crashed.id)).toMatchObject({ status: 'crashed', retryBlockHook: false, countedTechnicalFailure: true });
      const block = p.blocks.activeFor('wf', 'repo_a:1');
      expect(block).toMatchObject({ id: blockBefore.id, runId: crashed.id, lastStatus: 'crashed', clearedRunId: null });
      expect(p.actions.listAttempts(action.id)).toHaveLength(1);
      expect(p.runs.activeLock('wf', 'item:repo_a:2')?.runId).toBe(active.id);
      expect(p.events.listForRun(active.id).map((e) => e.type)).toContain('test.event');

      // The lock and the active-lock unique index still hold.
      expect(() => reserveSource(p, 'wf', 'repo_a:2')).toThrow(/already has an active run/);
      expect(() =>
        p.db.exec(`INSERT INTO runs (id, workflow_id, trigger_type, lock_key, config_snapshot, status, created_at, updated_at)
                   VALUES ('run-dup', 'wf', 'source', 'item:repo_a:2', '{}', 'running', 'x', 'x')`),
      ).toThrow(/UNIQUE/);

      // New trigger and hook names are accepted, others still rejected.
      const unblock = p.runs.reserve({ workflowId: 'wf', triggerType: 'unblock', sourceItemKey: 'repo_a:1', configSnapshot: {} });
      p.blocks.clear(block!.id, 'olga', unblock.id);
      expect(p.blocks.get(block!.id)).toMatchObject({ clearedBy: 'olga', clearedRunId: unblock.id });
      expect(unblock).toMatchObject({ triggerType: 'unblock', lockKey: 'item:repo_a:1' });
      p.actions.createJournal(unblock.id, 'on_retry_unblock', [{ type: 'shell', config: {} }]);
      p.actions.createJournal(crashed.id, 'on_retry_block', [{ type: 'shell', config: {} }]);
      expect(() => p.actions.createJournal(unblock.id, 'on_whatever' as 'on_error', [{ type: 'shell', config: {} }])).toThrow(/CHECK/);
      expect(() => p.db.exec(`UPDATE runs SET trigger_type = 'bogus' WHERE id = '${unblock.id}'`)).toThrow(/CHECK/);

      // Cascades and SET NULL still work after the rebuild.
      p.db.exec(`DELETE FROM runs WHERE id = '${crashed.id}'`);
      expect(p.db.prepare('SELECT COUNT(*) AS n FROM action_attempts').get()).toEqual({ n: 0 });
      expect(p.blocks.get(block!.id)?.runId).toBeNull();
      p.db.exec(`DELETE FROM locks WHERE run_id = '${unblock.id}'`);
      p.db.exec(`DELETE FROM runs WHERE id = '${unblock.id}'`);
      expect(p.blocks.get(block!.id)?.clearedRunId).toBeNull();
      // Locks still restrict deleting their run.
      expect(() => p.db.exec(`DELETE FROM runs WHERE id = '${active.id}'`)).toThrow(/FOREIGN KEY/);
    } finally {
      p.close();
    }

    // The backup holds the v4 state.
    const backup = new DatabaseSync(p.migration.backupPath!, { readOnly: true });
    expect(backup.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 4 });
    backup.close();
  });

  it('a fresh database is created at v5', () => {
    const opened = openDatabase(tmp.dir);
    try {
      expect(schemaVersion(opened.db)).toBe(5);
    } finally {
      opened.close();
    }
  });
});

describe('repositories – lifecycle runs and retry-block hooks (WI-30)', () => {
  let env: ReturnType<typeof openTestPersistence>;
  afterEach(() => env.cleanup());

  it('marks the run for on_retry_block only when the block is created and the hook is requested', () => {
    env = openTestPersistence();
    const { p } = env;
    const first = reserveSource(p, 'wf', 'repo_a:1');
    completeRun(p, first.id, CRASH, { maxTechnicalFailures: 2, retryBlockHook: true });
    expect(p.runs.require(first.id).retryBlockHook).toBe(false);
    const second = reserveSource(p, 'wf', 'repo_a:1');
    p.runs.transition(second.id, 'starting');
    const res = p.runs.beginFinalization(second.id, CRASH, { blockPolicy: { maxTechnicalFailures: 2, retryBlockHook: true } });
    expect(res.blockCreated).toMatchObject({ runId: second.id, lastStatus: 'crashed', failureCount: 2 });
    expect(res.run.retryBlockHook).toBe(true);
    const status = p.events.listForRun(second.id).find((e) => e.type === 'run.status' && e.payload.to === 'finalizing');
    expect(status?.payload).toMatchObject({ blockId: res.blockCreated!.id, retryBlockHook: true });
    expect(p.blocks.createdByRun(second.id)?.id).toBe(res.blockCreated!.id);

    // Without the hook flag no mark.
    const other = reserveSource(p, 'wf2', 'repo_a:1');
    p.runs.transition(other.id, 'starting');
    const plain = p.runs.beginFinalization(other.id, CRASH, { blockPolicy: { maxTechnicalFailures: 1 } });
    expect(plain.blockCreated).not.toBeNull();
    expect(plain.run.retryBlockHook).toBe(false);
  });

  it('lifecycle runs neither count nor reset the counter, and do not count as active or as last run', () => {
    env = openTestPersistence();
    const { p } = env;
    completeRun(p, reserveSource(p, 'wf', 'repo_a:1').id, CRASH);
    expect(p.blocks.consecutiveTechnicalFailures('wf', 'repo_a:1')).toBe(1);
    const work = p.runs.lastRunForItem('repo_a:1');
    const unblock = p.runs.reserve({ workflowId: 'wf', triggerType: 'unblock', sourceItemKey: 'repo_a:1', configSnapshot: {} });
    expect(p.runs.countActive()).toBe(0);
    expect(p.runs.countActive('wf')).toBe(0);
    p.runs.transition(unblock.id, 'starting');
    p.runs.transition(unblock.id, 'running');
    p.runs.beginFinalization(unblock.id, SUCCESS, { countOutcome: false });
    const done = p.runs.finish(unblock.id);
    expect(done).toMatchObject({ status: 'completed', businessResult: 'success', countedTechnicalFailure: false });
    expect(p.blocks.consecutiveTechnicalFailures('wf', 'repo_a:1')).toBe(1);
    expect(p.runs.lastRunForItem('repo_a:1')?.id).toBe(work?.id);
  });

  it('refuses automatic reservations while a lifecycle run of the block scope is active', () => {
    env = openTestPersistence();
    const { p } = env;
    const block = p.blocks.create({ workflowId: 'cron', itemKey: null, reason: 'x', failureCount: 3 });
    const unblock = p.runs.reserve({ workflowId: 'cron', triggerType: 'unblock', configSnapshot: {} });
    expect(unblock.lockKey).toBe(`unblock:${unblock.id}`);
    p.blocks.clear(block.id, 'olga', unblock.id);
    expect(p.blocks.clearedByRun(unblock.id)).toMatchObject({ id: block.id, clearedBy: 'olga', clearedRunId: unblock.id });
    const slot = { workflowId: 'cron', triggerType: 'schedule' as const, scheduledFor: '2026-10-22T12:00:00.000Z', configSnapshot: {} };
    expect(() => p.runs.reserve({ ...slot, failIfBlocked: true })).toThrow(BlockedError);
    expect(p.runs.activeRunsInBlockScope('cron', null).map((r) => r.id)).toEqual([unblock.id]);
    // Manual starts (no failIfBlocked) are not refused.
    const manual = p.runs.reserve({ ...slot, failIfBlocked: false });
    expect(manual.status).toBe('reserved');
    p.runs.transition(unblock.id, 'starting');
    p.runs.beginFinalization(unblock.id, SUCCESS, { countOutcome: false });
    p.runs.finish(unblock.id);
    expect(p.runs.activeUnblockRun('cron', null)).toBeNull();
    expect(p.runs.reserve({ ...slot, scheduledFor: '2026-10-22T13:00:00.000Z', failIfBlocked: true }).status).toBe('reserved');
  });
});
