import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { openDatabase, schemaVersion } from './database.js';
import { openPersistence } from './persistence.js';
import { MIGRATIONS } from './schema.js';
import { completeRun, reserveSource, SUCCESS, tempDataDir } from './testing/helpers.js';

/** Schema v3 (WI-17): `runs.outcome`, `runs.completion_hook`, wider `run_actions.hook`. */
describe('schema v3 – run outcomes and completion hooks', () => {
  const tmp = tempDataDir();
  afterEach(() => tmp.cleanup());
  const clock = new FakeClock('2026-10-16T19:00:00.000Z');

  it('rebuilds run_actions without losing journal entries, attempts or foreign keys', () => {
    const v2 = openDatabase(tmp.dir, { clock, migrations: MIGRATIONS.filter((m) => m.version <= 2) });
    const now = clock.now().toISOString();
    v2.db.exec(`INSERT INTO runs (id, workflow_id, trigger_type, lock_key, config_snapshot, status, created_at, updated_at)
                VALUES ('run-1', 'wf', 'manual', 'run:run-1', '{}', 'completed', '${now}', '${now}')`);
    v2.db.exec(`INSERT INTO run_actions (id, run_id, hook, ordinal, action_type, action_config_json, status, attempts, created_at, updated_at)
                VALUES (7, 'run-1', 'on_crash', 0, 'shell', '{}', 'succeeded', 1, '${now}', '${now}')`);
    v2.db.exec(`INSERT INTO action_attempts (run_action_id, attempt, started_at, finished_at, outcome)
                VALUES (7, 1, '${now}', '${now}', 'succeeded')`);
    v2.close();

    const p = openPersistence(tmp.dir, { clock });
    try {
      expect(schemaVersion(p.db)).toBe(3);
      expect(p.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(p.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const [action] = p.actions.listForRun('run-1');
      expect(action).toMatchObject({ id: 7, hook: 'on_crash', status: 'succeeded', attempts: 1 });
      expect(p.actions.listAttempts(7)).toHaveLength(1);
      expect(p.runs.require('run-1')).toMatchObject({ outcome: null, completionHook: null });

      // New hook names are accepted, others are still rejected by the CHECK constraint.
      p.actions.createJournal('run-1', 'on_result.approved', [{ type: 'shell', config: {} }]);
      p.actions.createJournal('run-1', 'on_error', [{ type: 'shell', config: {} }]);
      expect(() => p.actions.createJournal('run-1', 'on_whatever' as 'on_error', [{ type: 'shell', config: {} }])).toThrow(/CHECK/);
      expect(() => p.actions.createJournal('run-1', 'on_result.' as 'on_error', [{ type: 'shell', config: {} }])).toThrow(/CHECK/);

      // Cascades still work after the rebuild.
      p.db.exec(`DELETE FROM runs WHERE id = 'run-1'`);
      expect(p.db.prepare('SELECT COUNT(*) AS n FROM action_attempts').get()).toEqual({ n: 0 });
    } finally {
      p.close();
    }
  });

  it('persists outcome and completion hook with → finalizing and reports them in the status event', () => {
    const p = openPersistence(tmp.dir, { clock });
    try {
      const run = reserveSource(p, 'reviewer', 'project_a:1');
      p.runs.transition(run.id, 'starting');
      p.runs.transition(run.id, 'running');
      p.runs.beginFinalization(run.id, SUCCESS, { update: { outcome: 'approved', completionHook: 'on_result.approved' } });
      const finished = p.runs.finish(run.id);
      expect(finished).toMatchObject({ outcome: 'approved', completionHook: 'on_result.approved' });
      const event = p.events.listForRun(run.id).find((e) => e.type === 'run.status' && e.payload.to === 'finalizing');
      expect(event?.payload).toMatchObject({ outcome: 'approved', hook: 'on_result.approved' });

      const plain = completeRun(p, reserveSource(p, 'reviewer', 'project_a:2').id, SUCCESS);
      expect(plain).toMatchObject({ outcome: null, completionHook: null });
    } finally {
      p.close();
    }
  });
});
