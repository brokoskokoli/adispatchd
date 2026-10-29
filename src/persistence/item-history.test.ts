/**
 * Schema v6 (WI-33): `run_actions.effect_json`, index `blocks_item` and
 * `item_history_gaps`; repository helpers for the item history.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { openDatabase, schemaVersion } from './database.js';
import { openPersistence } from './persistence.js';
import { MIGRATIONS } from './schema.js';
import { CRASH, SUCCESS, completeRun, openTestPersistence, reserveSource, tempDataDir } from './testing/helpers.js';

describe('schema v6 – item history (WI-33)', () => {
  const tmp = tempDataDir();
  afterEach(() => tmp.cleanup());

  it('migrates v5 → v6 with backup; old journal entries stay readable without effect', () => {
    const clock = new FakeClock('2026-10-26T10:00:00.000Z');
    const v5 = openDatabase(tmp.dir, { clock, migrations: MIGRATIONS.filter((m) => m.version <= 5) });
    const now = clock.now().toISOString();
    v5.db.exec(`INSERT INTO runs (id, workflow_id, trigger_type, source_id, source_item_key, lock_key, config_snapshot, status,
                  final_status, business_result, created_at, finished_at, updated_at)
                VALUES ('run-old', 'wf', 'source', 'repo_a', 'repo_a:1', 'item:repo_a:1', '{}', 'completed', 'completed', 'success', '${now}', '${now}', '${now}')`);
    v5.db.exec(`INSERT INTO run_actions (id, run_id, hook, ordinal, action_type, action_config_json, status, attempts, created_at, updated_at)
                VALUES (11, 'run-old', 'on_success', 0, 'source.update', '{}', 'succeeded', 1, '${now}', '${now}')`);
    v5.close();

    const p = openPersistence(tmp.dir, { clock });
    try {
      expect(schemaVersion(p.db)).toBeGreaterThanOrEqual(6);
      expect(p.migration.applied[0]).toBe(6);
      expect(existsSync(p.migration.backupPath!)).toBe(true);
      expect(p.actions.get(11)).toMatchObject({ status: 'succeeded', effect: null });
      const indexes = p.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'blocks'`).all().map((r) => r.name);
      expect(indexes).toContain('blocks_item');
      expect(p.retention.itemGap('repo_a:1')).toBeNull();
    } finally {
      p.close();
    }
    const backup = new DatabaseSync(p.migration.backupPath!, { readOnly: true });
    expect(backup.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 5 });
    backup.close();
  });
});

describe('repositories – item history (WI-33)', () => {
  let env: ReturnType<typeof openTestPersistence>;
  afterEach(() => env.cleanup());

  it('stores the structured effect of an action and lists actions/events/blocks per item', () => {
    env = openTestPersistence();
    const { p } = env;
    const a = reserveSource(p, 'wf', 'repo_a:1');
    const b = reserveSource(p, 'wf2', 'repo_a:1');
    const other = reserveSource(p, 'wf', 'repo_a:2');
    const [action] = p.actions.createJournal(a.id, 'on_start', [{ type: 'source.update', config: {} }]);
    p.actions.createJournal(b.id, 'on_start', [{ type: 'shell', config: {} }]);
    p.actions.createJournal(other.id, 'on_start', [{ type: 'shell', config: {} }]);
    p.actions.startAttempt(action!.id);
    const effect = { labelsAdded: ['coding'], projectFields: [{ name: 'Status', from: 'Todo', to: 'Review' }] };
    expect(p.actions.setStatus(action!.id, 'succeeded', { effect }).effect).toEqual(effect);
    expect(p.actions.listForRuns([a.id, b.id]).map((x) => [x.runId, x.type])).toEqual(
      [
        [a.id, 'source.update'],
        [b.id, 'shell'],
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    expect(p.actions.listForRuns([])).toEqual([]);

    p.events.append(a.id, 'audit.user_action', { action: 'start', actor: 'olga' });
    p.events.append(a.id, 'other', {});
    expect(p.events.listTypesForRuns([a.id, b.id], ['audit.user_action']).map((e) => e.payload.actor)).toEqual(['olga']);
    expect(p.events.listTypesForRuns([a.id], [])).toEqual([]);

    completeRun(p, other.id, CRASH, { maxTechnicalFailures: 1 });
    expect(p.blocks.listForItem('repo_a:2').map((x) => x.runId)).toEqual([other.id]);
    expect(p.blocks.listForItem('repo_a:1')).toEqual([]);
  });

  it('remembers runs of an item deleted by retention', () => {
    env = openTestPersistence();
    const { p, clock } = env;
    const first = reserveSource(p, 'wf', 'repo_a:1');
    completeRun(p, first.id, SUCCESS);
    clock.advance(60_000);
    const second = reserveSource(p, 'wf', 'repo_a:1');
    completeRun(p, second.id, SUCCESS);
    const cron = p.runs.reserve({ workflowId: 'cron', triggerType: 'schedule', scheduledFor: '2026-10-16T19:00:00.000Z', configSnapshot: {} });
    completeRun(p, cron.id, SUCCESS);

    expect(p.retention.deleteRun(first.id)).toBe(true);
    expect(p.retention.itemGap('repo_a:1')).toEqual({ deletedRuns: 1, newestDeletedAt: first.createdAt });
    expect(p.retention.deleteRun(second.id)).toBe(true);
    expect(p.retention.itemGap('repo_a:1')).toEqual({ deletedRuns: 2, newestDeletedAt: second.createdAt });
    // Runs without an item leave no gap row; a missing run changes nothing.
    expect(p.retention.deleteRun(cron.id)).toBe(true);
    expect(p.retention.deleteRun('run-missing')).toBe(false);
    expect(p.db.prepare('SELECT COUNT(*) AS n FROM item_history_gaps').get()).toEqual({ n: 1 });
  });
});
