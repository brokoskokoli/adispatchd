import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Persistence } from './persistence.js';
import { afterCommit, transaction } from './sqlite.js';
import { openTestPersistence, reserveSource } from './testing/helpers.js';

describe('transaction / afterCommit', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  });
  afterEach(() => db.close());

  const count = () => Number((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n);

  it('runs callbacks only after the outermost commit, in registration order', () => {
    const calls: string[] = [];
    transaction(db, () => {
      db.exec(`INSERT INTO t (v) VALUES ('a')`);
      afterCommit(db, () => calls.push('outer'));
      transaction(db, () => {
        afterCommit(db, () => calls.push('inner'));
      });
      expect(calls).toEqual([]);
    });
    expect(calls).toEqual(['outer', 'inner']);
  });

  it('discards callbacks on rollback, also of a nested savepoint only', () => {
    const calls: string[] = [];
    expect(() =>
      transaction(db, () => {
        afterCommit(db, () => calls.push('x'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(calls).toEqual([]);

    transaction(db, () => {
      db.exec(`INSERT INTO t (v) VALUES ('kept')`);
      afterCommit(db, () => calls.push('outer'));
      expect(() =>
        transaction(db, () => {
          db.exec(`INSERT INTO t (v) VALUES ('dropped')`);
          afterCommit(db, () => calls.push('inner'));
          throw new Error('inner boom');
        }),
      ).toThrow('inner boom');
    });
    expect(calls).toEqual(['outer']);
    expect(count()).toBe(1);
  });

  it('runs immediately outside a transaction', () => {
    const calls: number[] = [];
    afterCommit(db, () => calls.push(1));
    expect(calls).toEqual([1]);
  });

  it('re-throws the original error even if the savepoint rollback fails', () => {
    expect(() =>
      transaction(db, () => {
        transaction(db, () => {
          db.exec('ROLLBACK'); // aborts the whole transaction → ROLLBACK TO will fail
          throw new Error('original');
        });
      }),
    ).toThrow('original');
    // connection usable afterwards
    transaction(db, () => db.exec(`INSERT INTO t (v) VALUES ('ok')`));
    expect(count()).toBe(1);
  });
});

describe('afterCommit with repositories (event IDs)', () => {
  let p: Persistence;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  it('publishes only committed events; a rolled-back event ID is never seen by subscribers', () => {
    const run = reserveSource(p, 'coder', 'project_a:1');
    const published: number[] = [];
    const appendAndPublish = (fail: boolean) =>
      p.transaction(() => {
        const ev = p.events.append(run.id, 'progress', { value: 1 });
        p.afterCommit(() => published.push(ev.id));
        if (fail) throw new Error('rollback');
      });
    expect(() => appendAndPublish(true)).toThrow('rollback');
    expect(published).toEqual([]);
    appendAndPublish(false);
    expect(published).toHaveLength(1);
    expect(p.events.listSince(0).map((e) => e.id)).toContain(published[0]);
  });
});
