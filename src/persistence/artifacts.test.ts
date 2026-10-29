/** Schema v7 and `ArtifactRepository` (WI-35). */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { openDatabase, schemaVersion } from './database.js';
import { openPersistence } from './persistence.js';
import { MIGRATIONS } from './schema.js';
import { openTestPersistence, reserveSource, tempDataDir, completeRun, SUCCESS } from './testing/helpers.js';

const base = { name: 'report', type: 'report', kind: 'file', fileName: 'report.pdf', size: 10, fileCount: 1, workflowId: 'make', runId: 'run-1', ordinal: 0, parentId: null } as const;

describe('schema v7 – artifacts (WI-35)', () => {
  const tmp = tempDataDir();
  afterEach(() => tmp.cleanup());

  it('migrates v6 → v7 with backup; existing data stays valid', () => {
    const clock = new FakeClock('2026-10-29T10:00:00.000Z');
    const v6 = openDatabase(tmp.dir, { clock, migrations: MIGRATIONS.filter((m) => m.version <= 6) });
    const now = clock.now().toISOString();
    v6.db.exec(`INSERT INTO runs (id, workflow_id, trigger_type, lock_key, config_snapshot, status, created_at, updated_at)
                VALUES ('run-1', 'wf', 'manual', 'workflow', '{}', 'completed', '${now}', '${now}')`);
    expect(schemaVersion(v6.db)).toBe(6);
    v6.close();

    clock.set('2026-10-29T11:00:00.000Z');
    const p = openPersistence(tmp.dir, { clock });
    try {
      expect(schemaVersion(p.db)).toBe(7);
      expect(p.migration).toMatchObject({ fromVersion: 6, toVersion: 7, applied: [7] });
      expect(p.migration.backupPath).not.toBeNull();
      expect(existsSync(p.migration.backupPath!)).toBe(true);
      expect(p.runs.get('run-1')).not.toBeNull();
      expect(p.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const created = p.artifacts.insert({ id: 'art-1', ...base });
      expect(created).toMatchObject({ id: 'art-1', consumedBy: [], createdAt: '2026-10-29T11:00:00.000Z' });
    } finally {
      p.close();
    }
  });
});

describe('ArtifactRepository (WI-35)', () => {
  it('inserts, lists newest first and enforces constraints', () => {
    const { p, clock, cleanup } = openTestPersistence();
    try {
      p.artifacts.insert({ id: 'art-a', ...base, name: 'first' });
      clock.advance(1000);
      p.artifacts.insert({ id: 'art-b', ...base, name: 'second', ordinal: 1, kind: 'folder', fileName: 'out', fileCount: 3, parentId: 'art-a' });
      expect(p.artifacts.list().map((a) => a.id)).toEqual(['art-b', 'art-a']);
      expect(p.artifacts.get('art-b')).toMatchObject({ kind: 'folder', fileCount: 3, parentId: 'art-a' });
      expect(p.artifacts.get('missing')).toBeNull();
      expect(p.artifacts.getByRun('run-1', 1)?.id).toBe('art-b');
      expect(() => p.artifacts.insert({ id: 'art-c', ...base })).toThrow(/UNIQUE/); // (run, ordinal)
      expect(() => p.artifacts.insert({ id: 'art-d', ...base, ordinal: 5, kind: 'bundle' as never })).toThrow(/CHECK/);
    } finally {
      cleanup();
    }
  });

  it('filters by type, workflow, kind, parent and text; pages; lists facets', () => {
    const { p, clock, cleanup } = openTestPersistence();
    try {
      p.artifacts.insert({ id: 'art-1', ...base, name: 'Weekly Report', type: 'report', workflowId: 'make', runId: 'r1' });
      clock.advance(1000);
      p.artifacts.insert({ id: 'art-2', ...base, name: 'logs_100%', type: 'logs', workflowId: 'collect', runId: 'r2', kind: 'folder', fileName: 'logs' });
      clock.advance(1000);
      p.artifacts.insert({ id: 'art-3', ...base, name: 'summary', type: 'report', workflowId: 'summarize', runId: 'r3', parentId: 'art-1' });
      expect(p.artifacts.query().total).toBe(3);
      expect(p.artifacts.query({ type: 'report' }).artifacts.map((a) => a.id)).toEqual(['art-3', 'art-1']);
      expect(p.artifacts.query({ workflowId: 'collect' }).artifacts.map((a) => a.id)).toEqual(['art-2']);
      expect(p.artifacts.query({ kind: 'folder' }).total).toBe(1);
      expect(p.artifacts.query({ parentId: 'art-1' }).artifacts.map((a) => a.id)).toEqual(['art-3']);
      expect(p.artifacts.query({ q: 'WEEKLY' }).artifacts.map((a) => a.id)).toEqual(['art-1']);
      // LIKE wildcards in the search text are literal.
      expect(p.artifacts.query({ q: '%' }).artifacts.map((a) => a.id)).toEqual(['art-2']);
      expect(p.artifacts.query({ q: '_' }).artifacts.map((a) => a.id)).toEqual(['art-2']);
      expect(p.artifacts.query({ limit: 1, offset: 1 })).toMatchObject({ total: 3, artifacts: [{ id: 'art-2' }] });
      expect(p.artifacts.facets()).toEqual({ types: ['logs', 'report'], workflows: ['collect', 'make', 'summarize'] });
      expect(p.artifacts.children('art-1').map((a) => a.id)).toEqual(['art-3']);
    } finally {
      cleanup();
    }
  });

  it('marks consumption idempotently and keeps the order', () => {
    const { p, cleanup } = openTestPersistence();
    try {
      p.artifacts.insert({ id: 'art-1', ...base });
      expect(p.artifacts.markConsumed('art-1', 'summarize')?.consumedBy).toEqual(['summarize']);
      expect(p.artifacts.markConsumed('art-1', 'summarize')?.consumedBy).toEqual(['summarize']);
      expect(p.artifacts.markConsumed('art-1', 'archive')?.consumedBy).toEqual(['summarize', 'archive']);
      expect(p.artifacts.markConsumed('gone', 'x')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('records every completed attempt in attempted_by, successes also in consumed_by (idempotent)', () => {
    const { p, cleanup } = openTestPersistence();
    try {
      p.artifacts.insert({ id: 'art-1', ...base });
      expect(p.artifacts.markCompleted('art-1', 'wf', false)).toMatchObject({ attemptedBy: ['wf'], consumedBy: [] });
      expect(p.artifacts.markCompleted('art-1', 'wf', false)).toMatchObject({ attemptedBy: ['wf'], consumedBy: [] });
      expect(p.artifacts.markCompleted('art-1', 'wf', true)).toMatchObject({ attemptedBy: ['wf'], consumedBy: ['wf'] });
      expect(p.artifacts.markCompleted('art-1', 'other', true)).toMatchObject({ attemptedBy: ['wf', 'other'], consumedBy: ['wf', 'other'] });
      expect(p.artifacts.markCompleted('gone', 'x', true)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('finds active runs that use an artifact as their item', () => {
    const { p, cleanup } = openTestPersistence();
    try {
      p.artifacts.insert({ id: 'art-1', ...base });
      expect(p.artifacts.activeRunsUsing('art-1')).toEqual([]);
      const run = reserveSource(p, 'summarize', 'artifacts:art-1');
      reserveSource(p, 'summarize', 'artifacts:art-10');
      expect(p.artifacts.activeRunsUsing('art-1')).toEqual([run.id]);
      expect(p.artifacts.activeRunsUsing('art-_')).toEqual([]);
      expect(p.artifacts.activeRunsUsing('art-%')).toEqual([]);
      completeRun(p, run.id, SUCCESS);
      expect(p.artifacts.activeRunsUsing('art-1')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('deletes rows and lists retention candidates by age', () => {
    const { p, clock, cleanup } = openTestPersistence();
    try {
      p.artifacts.insert({ id: 'art-old', ...base });
      clock.advance(10_000);
      p.artifacts.insert({ id: 'art-new', ...base, ordinal: 1 });
      const cutoff = new Date(clock.now().getTime() - 5_000);
      expect(p.artifacts.olderThan(cutoff).map((a) => a.id)).toEqual(['art-old']);
      expect(p.artifacts.delete('art-old')).toBe(true);
      expect(p.artifacts.delete('art-old')).toBe(false);
      expect(p.artifacts.list().map((a) => a.id)).toEqual(['art-new']);
    } finally {
      cleanup();
    }
  });
});
