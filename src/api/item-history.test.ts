/**
 * Item history (WI-33) without the HTTP layer: building the timeline from the
 * database (older journal entries without structured effect, paging,
 * retention hints) and merging GitHub events with own changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CRASH, SUCCESS, completeRun, openTestPersistence, reserveSource } from '../persistence/testing/helpers.js';
import { buildItemHistory, mergeGitHubEvents } from './item-history.js';
import type { ItemEvent } from '../core/index.js';

describe('buildItemHistory (WI-33)', () => {
  let env: ReturnType<typeof openTestPersistence>;
  afterEach(() => env.cleanup());

  it('falls back to the journal events for actions without a recorded effect (before 0.9.0)', () => {
    env = openTestPersistence();
    const { p, clock } = env;
    const run = reserveSource(p, 'wf', 'repo_a:1');
    completeRun(p, run.id, SUCCESS);
    const [update, comment, shell] = p.actions.createJournal(run.id, 'on_success', [
      { type: 'source.update', config: {} },
      { type: 'source.comment', config: {} },
      { type: 'shell', config: {} },
    ]);
    for (const a of [update!, comment!, shell!]) p.actions.startAttempt(a.id);
    p.actions.setStatus(update!.id, 'succeeded');
    p.actions.setStatus(comment!.id, 'succeeded', { externalKey: '77' });
    p.actions.setStatus(shell!.id, 'failed', { error: { code: 'shell_exit', message: 'Shell action exited with code 2' } });
    const ev = (actionId: number, details: Record<string, unknown>) => p.events.append(run.id, 'lifecycle.action', { actionId, status: 'succeeded', details });
    ev(update!.id, { changed: true, applied: { labelsAdded: ['done'], projectFields: { Status: 'Review' } } });
    ev(comment!.id, { marker: 'm', url: 'https://github.com/example/a/issues/1#issuecomment-77' });
    clock.advance(1000);

    const h = buildItemHistory(p, 'repo_a:1');
    const hook = h.entries.find((e) => e.kind === 'hook');
    expect(hook).toMatchObject({ hook: 'on_success', runId: run.id });
    const actions = hook && hook.kind === 'hook' ? hook.actions : [];
    expect(actions[0]).toMatchObject({ effectSource: 'journal', effect: { labelsAdded: ['done'], projectFields: [{ name: 'Status', to: 'Review' }] } });
    expect(actions[0]?.effect?.projectFields?.[0]).not.toHaveProperty('from');
    expect(actions[1]).toMatchObject({ effectSource: 'journal', effect: { comment: { id: '77', url: 'https://github.com/example/a/issues/1#issuecomment-77' } } });
    expect(actions[2]).toMatchObject({ status: 'failed', effect: null, effectSource: null, error: 'Shell action exited with code 2' });
  });

  it('pages newest first and hints at deleted runs of older versions', () => {
    env = openTestPersistence();
    const { p, clock } = env;
    for (let i = 0; i < 3; i++) {
      const r = reserveSource(p, 'wf', 'repo_a:1');
      completeRun(p, r.id, i < 2 ? CRASH : SUCCESS, { maxTechnicalFailures: 5 });
      clock.advance(1000);
    }
    const all = buildItemHistory(p, 'repo_a:1', { limit: 500 });
    expect(all.entries).toHaveLength(6);
    expect(all.entries.map((e) => e.kind)).toEqual(['run_finished', 'run_started', 'run_finished', 'run_started', 'run_finished', 'run_started']);
    const first = buildItemHistory(p, 'repo_a:1', { limit: 4 });
    expect(first.entries.map((e) => e.key)).toEqual(all.entries.slice(0, 4).map((e) => e.key));
    const second = buildItemHistory(p, 'repo_a:1', { limit: 4, before: first.nextBefore! });
    expect(second.entries.map((e) => e.key)).toEqual(all.entries.slice(4).map((e) => e.key));
    expect(second.nextBefore).toBeNull();
    expect(buildItemHistory(p, 'repo_a:1', { before: '0000' }).entries).toEqual([]);

    // A block whose run is gone (deleted by an older version's retention) is a hint.
    p.db.exec(`INSERT INTO blocks (workflow_id, source_item_key, reason, run_id, failure_count, generation, created_at, cleared_at, cleared_by)
               VALUES ('wf', 'repo_a:3', 'x', NULL, 3, 0, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'ui')`);
    expect(buildItemHistory(p, 'repo_a:3').retentionGap).toEqual({ deletedRuns: null, newestDeletedAt: null });
    expect(buildItemHistory(p, 'repo_a:9')).toMatchObject({ runs: [], entries: [], entriesTotal: 0, retentionGap: null });
  });
});

describe('mergeGitHubEvents (WI-33)', () => {
  const ev = (kind: ItemEvent['kind'], at: string, own: boolean, label?: string): ItemEvent => ({ id: null, kind, at, actor: own ? 'coder[bot]' : 'octocat', own, ...(label ? { label } : {}) });
  const change = (label: string, added: boolean, at: string) => ({ label, added, at: Date.parse(at), used: false });

  it('hides own label events that match an own change (label, direction, ±5 min), marks the rest', () => {
    const own = [change('coding', true, '2026-10-26T10:00:01Z'), change('ready', false, '2026-10-26T10:00:01Z')];
    const res = mergeGitHubEvents(
      [
        ev('labeled', '2026-10-26T10:00:00Z', true, 'Coding'),
        ev('unlabeled', '2026-10-26T10:00:00Z', true, 'ready'),
        ev('labeled', '2026-10-26T10:00:00Z', true, 'ready'), // wrong direction
        ev('labeled', '2026-10-26T11:00:00Z', true, 'coding'), // too late, and the change is used up
        ev('labeled', '2026-10-26T10:00:00Z', false, 'coding'), // foreign actor
        ev('closed', '2026-10-26T10:00:00Z', true),
      ],
      own,
    );
    expect(res.hiddenOwn).toBe(2);
    expect(res.events.map((e) => [e.kind, e.label ?? null, e.own, e.external])).toEqual([
      ['labeled', 'ready', true, false],
      ['labeled', 'coding', true, false],
      ['labeled', 'coding', false, true],
      ['closed', null, true, false],
    ]);
  });
});
