import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { openDatabase, schemaVersion } from './database.js';
import { MigrationError } from './errors.js';
import { MIGRATIONS, type Migration } from './schema.js';
import { tempDataDir } from './testing/helpers.js';

/** These tests exercise the migration mechanics on schema v1 plus an artificial v2. */
const V1: readonly Migration[] = MIGRATIONS.filter((m) => m.version === 1);

const V2: Migration = {
  version: 2,
  name: 'artificial_v2',
  up(db) {
    db.exec('CREATE TABLE artificial (id INTEGER PRIMARY KEY)');
  },
};

describe('openDatabase / migrations', () => {
  const tmp = tempDataDir();
  afterEach(() => tmp.cleanup());

  it('migrates an empty database without backup and is idempotent on re-open', () => {
    const clock = new FakeClock('2026-10-16T19:00:00.000Z');
    const first = openDatabase(tmp.dir, { clock, migrations: V1 });
    expect(first.migration).toEqual({ fromVersion: 0, toVersion: 1, applied: [1], backupPath: null });
    const tables = first.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'runs',
        'run_events',
        'run_actions',
        'action_attempts',
        'blocks',
        'locks',
        'notifications',
        'cron_firings',
        'failure_counters',
        'schema_migrations',
      ]),
    );
    expect(first.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(first.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    first.close();

    const second = openDatabase(tmp.dir, { clock, migrations: V1 });
    expect(second.migration).toEqual({ fromVersion: 1, toVersion: 1, applied: [], backupPath: null });
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
    second.close();
    expect(existsSync(path.join(tmp.dir, 'backups'))).toBe(false);
  });

  it('backs up an existing database before applying a pending migration', () => {
    const clock = new FakeClock('2026-10-16T19:00:00.000Z');
    const v1 = openDatabase(tmp.dir, { clock, migrations: V1 });
    v1.db.prepare(`INSERT INTO notifications (event_type, payload_json, delivery_state, created_at, updated_at)
      VALUES ('recovery_failed', '{}', 'pending', 'x', 'x')`).run();
    v1.close();

    clock.set('2026-10-17T08:30:00.123Z');
    const v2 = openDatabase(tmp.dir, { clock, migrations: [...V1, V2] });
    expect(v2.migration.fromVersion).toBe(1);
    expect(v2.migration.toVersion).toBe(2);
    expect(v2.migration.applied).toEqual([2]);
    expect(v2.migration.backupPath).toBe(path.join(tmp.dir, 'backups', 'adispatchd-1-20261017T083000123Z.sqlite'));
    expect(schemaVersion(v2.db)).toBe(2);
    v2.close();

    // Backup contains the pre-migration state (v1 data, no v2 table).
    const backup = new DatabaseSync(v2.migration.backupPath!, { readOnly: true });
    expect(backup.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 });
    expect(backup.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 1 });
    expect(backup.prepare(`SELECT name FROM sqlite_master WHERE name = 'artificial'`).get()).toBeUndefined();
    backup.close();

    // Re-open with v2: nothing pending, no further backup.
    const again = openDatabase(tmp.dir, { clock, migrations: [...V1, V2] });
    expect(again.migration.applied).toEqual([]);
    expect(again.migration.backupPath).toBeNull();
    again.close();
    expect(readdirSync(path.join(tmp.dir, 'backups'))).toHaveLength(1);
  });

  it('rolls back a failing migration and keeps the previous version', () => {
    const clock = new FakeClock();
    openDatabase(tmp.dir, { clock, migrations: V1 }).close();
    const broken: Migration = {
      version: 2,
      name: 'broken',
      up(db) {
        db.exec('CREATE TABLE half (id INTEGER)');
        db.exec('THIS IS NOT SQL');
      },
    };
    expect(() => openDatabase(tmp.dir, { clock, migrations: [...V1, broken] })).toThrow(MigrationError);
    const reopened = openDatabase(tmp.dir, { clock, migrations: V1 });
    expect(schemaVersion(reopened.db)).toBe(1);
    expect(reopened.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'half'`).get()).toBeUndefined();
    reopened.close();
  });

  it('refuses a database with a newer schema than the build knows', () => {
    const clock = new FakeClock();
    openDatabase(tmp.dir, { clock, migrations: [...V1, V2] }).close();
    expect(() => openDatabase(tmp.dir, { clock, migrations: V1 })).toThrow(/newer than this build/);
  });

  it('rejects non-increasing migration versions', () => {
    expect(() => openDatabase(tmp.dir, { migrations: [V2, ...V1] })).toThrow(MigrationError);
  });
});
