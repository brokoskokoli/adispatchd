import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeClock } from '../core/index.js';
import { schemaVersion } from './database.js';
import type { Persistence } from './persistence.js';
import { openTestPersistence } from './testing/helpers.js';

describe('UiActionRepository (schema v4, WI-27)', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  const base = { actor: 'alice', actorVia: 'password', identity: 'maintainer', sourceId: 'repo_a', itemId: '1', itemKey: 'repo_a:1' } as const;

  it('migrates to v4 and records entries (newest first, filters, paging)', () => {
    expect(schemaVersion(p.db)).toBeGreaterThanOrEqual(4);
    const a = p.uiActions.record({ ...base, kind: 'comment', result: 'succeeded', commentId: '9', commentUrl: 'https://github.com/x/y/issues/1#issuecomment-9' });
    clock.advance(1000);
    p.uiActions.record({ ...base, kind: 'labels', result: 'failed', errorCode: 'github_forbidden', errorMessage: 'no', details: { add: ['x'] } });
    p.uiActions.record({ ...base, itemId: '2', itemKey: 'repo_a:2', kind: 'project', result: 'unknown' });
    expect(a).toMatchObject({ id: 1, kind: 'comment', result: 'succeeded', commentId: '9', details: null });
    const all = p.uiActions.list();
    expect(all.total).toBe(3);
    expect(all.actions.map((x) => x.id)).toEqual([3, 2, 1]);
    expect(p.uiActions.list({ itemKey: 'repo_a:1' }).actions.map((x) => x.kind)).toEqual(['labels', 'comment']);
    expect(p.uiActions.list({ itemKey: 'repo_a:1' }).actions[0]?.details).toEqual({ add: ['x'] });
    expect(p.uiActions.list({ sourceId: 'other' }).total).toBe(0);
    expect(p.uiActions.list({ limit: 1, offset: 1 }).actions.map((x) => x.id)).toEqual([2]);
  });

  it('rejects unknown kinds/results (CHECK constraints)', () => {
    expect(() => p.uiActions.record({ ...base, kind: 'close' as never, result: 'succeeded' })).toThrow();
    expect(() => p.uiActions.record({ ...base, kind: 'comment', result: 'maybe' as never })).toThrow();
  });

  it('retention deletes old entries of every result with one cut-off', () => {
    p.uiActions.record({ ...base, kind: 'comment', result: 'succeeded' });
    p.uiActions.record({ ...base, kind: 'comment', result: 'failed' });
    p.uiActions.record({ ...base, kind: 'comment', result: 'unknown' });
    clock.advance(10_000);
    p.uiActions.record({ ...base, kind: 'labels', result: 'succeeded' });
    expect(p.uiActions.deleteOlderThan(null)).toBe(0);
    expect(p.uiActions.deleteOlderThan(new Date(clock.now().getTime() - 5_000))).toBe(3);
    expect(p.uiActions.list().actions.map((x) => x.kind)).toEqual(['labels']);
  });
});
