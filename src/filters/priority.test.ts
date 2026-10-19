import { describe, expect, it } from 'vitest';
import type { FieldResolution } from '../core/index.js';
import type { FieldSource } from './evaluate.js';
import {
  naturalCompare,
  resolveItemPriority,
  sortCandidates,
  type ItemPriorityConfig,
  type PrioritizedCandidate,
} from './priority.js';

function source(fields: Record<string, FieldResolution>): FieldSource {
  return { resolve: (f) => fields[f] ?? { known: false, reason: 'unknown field' } };
}

const config: ItemPriorityConfig = {
  rules: [
    { when: { field: 'labels', operator: 'contains', value: 'priority:critical' }, value: 100 },
    { when: { field: 'labels', operator: 'contains', value: 'priority:high' }, value: 50 },
  ],
  default: 0,
};

describe('resolveItemPriority', () => {
  it('first matching rule wins, later rules are not evaluated', async () => {
    const r = await resolveItemPriority(
      config,
      source({ labels: { known: true, value: ['priority:critical', 'priority:high'] } }),
    );
    expect(r.priority).toBe(100);
    expect(r.matchedRule).toBe(0);
    expect(r.traces.map((t) => t.value)).toEqual([true, 'not_evaluated']);
  });

  it('falls back to default when no rule matches', async () => {
    const r = await resolveItemPriority(config, source({ labels: { known: true, value: ['bug'] } }));
    expect(r).toMatchObject({ priority: 0, matchedRule: null });
  });

  it('unknown does not match', async () => {
    const r = await resolveItemPriority(
      {
        rules: [
          { when: { field: 'secret', operator: 'equals', value: 1 }, value: 99 },
          { when: { field: 'labels', operator: 'contains', value: 'priority:high' }, value: 50 },
        ],
        default: 5,
      },
      source({ labels: { known: true, value: ['priority:high'] } }),
    );
    expect(r).toMatchObject({ priority: 50, matchedRule: 1 });
    expect(r.traces.map((t) => t.value)).toEqual(['unknown', true]);
    const none = await resolveItemPriority({ rules: config.rules, default: 7 }, source({}));
    expect(none.priority).toBe(7);
  });

  it('no config means priority 0', async () => {
    expect((await resolveItemPriority(undefined, source({}))).priority).toBe(0);
  });
});

describe('sortCandidates', () => {
  const c = (
    workflowId: string,
    workflowPriority: number,
    itemPriority: number,
    itemKey?: string,
    createdAt?: string,
  ): PrioritizedCandidate => ({ workflowId, workflowPriority, itemPriority, itemKey, createdAt });

  it('priority:high in the coder does not overtake a reviewer with higher workflow priority', () => {
    const coderHigh = c('coder', 50, 50, 'project_a:1', '2026-01-01T00:00:00Z');
    const reviewer = c('reviewer', 60, 0, 'project_a:2', '2026-02-01T00:00:00Z');
    const coderNormal = c('coder', 50, 0, 'project_a:3', '2025-01-01T00:00:00Z');
    expect(sortCandidates([coderNormal, coderHigh, reviewer])).toEqual([reviewer, coderHigh, coderNormal]);
  });

  it('tie-breaker: creation time asc, then item key asc (natural), then workflow id', () => {
    const older = c('w', 1, 1, 'project_a:20', '2026-01-01T00:00:00Z');
    const newer = c('w', 1, 1, 'project_a:3', '2026-01-02T00:00:00Z');
    const sameTime9 = c('w', 1, 1, 'project_a:9', '2026-01-03T00:00:00Z');
    const sameTime10 = c('w', 1, 1, 'project_a:10', '2026-01-03T00:00:00Z');
    const noTime = c('w', 1, 1, 'project_a:1');
    const otherWf = c('a', 1, 1, 'project_a:1');
    const expected = [older, newer, sameTime9, sameTime10, otherWf, noTime];
    expect(sortCandidates([noTime, sameTime10, otherWf, newer, sameTime9, older])).toEqual(expected);
  });

  it('is deterministic for every input permutation', () => {
    const list = [
      c('coder', 50, 0, 'b:2', '2026-01-01T00:00:00Z'),
      c('coder', 50, 0, 'a:2', '2026-01-01T00:00:00Z'),
      c('review', 60, 0, 'a:1'),
      c('coder', 50, 100, 'a:5'),
      c('coder', 50, 0, 'a:10', '2026-01-01T00:00:00Z'),
    ];
    const expected = sortCandidates(list);
    const permute = (arr: PrioritizedCandidate[]): PrioritizedCandidate[][] =>
      arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of permute(list)) expect(sortCandidates(p)).toEqual(expected);
    expect(expected.map((x) => `${x.workflowId}/${x.itemKey}`)).toEqual([
      'review/a:1',
      'coder/a:5',
      'coder/a:2',
      'coder/a:10',
      'coder/b:2',
    ]);
  });

  it('non-ISO creation times sort like missing ones (not via Date.parse)', () => {
    const iso = c('w', 1, 1, 'k:2', '2026-01-02T00:00:00Z');
    const noOffset = c('w', 1, 1, 'k:3', '2026-01-01T00:00:00');
    const junk = c('w', 1, 1, 'k:1', 'Jan 1, 2020');
    expect(sortCandidates([junk, iso, noOffset])).toEqual([noOffset, iso, junk]);
  });

  it('source rank (position in "sources", WI-20) breaks ties after the item priority, before creation time', () => {
    const fromB = { ...c('w', 1, 5, 'repo_b:1', '2025-01-01T00:00:00Z'), sourceRank: 1 };
    const fromA = c('w', 1, 5, 'repo_a:9', '2026-01-01T00:00:00Z');
    const fromAExplicit = { ...c('w', 1, 5, 'repo_a:8', '2026-06-01T00:00:00Z'), sourceRank: 0 };
    const higherFromB = { ...c('w', 1, 6, 'repo_b:2', '2026-09-01T00:00:00Z'), sourceRank: 1 };
    expect(sortCandidates([fromB, fromAExplicit, higherFromB, fromA])).toEqual([higherFromB, fromA, fromAExplicit, fromB]);
  });

  it('does not mutate the input', () => {
    const list = [c('a', 1, 0), c('b', 2, 0)];
    sortCandidates(list);
    expect(list.map((x) => x.workflowId)).toEqual(['a', 'b']);
  });
});

describe('naturalCompare', () => {
  it('orders digit runs numerically', () => {
    expect(['x:10', 'x:9', 'x:1', 'w:100'].sort(naturalCompare)).toEqual(['w:100', 'x:1', 'x:9', 'x:10']);
    expect(naturalCompare('x:01', 'x:1')).not.toBe(0);
    expect(naturalCompare('a', 'a')).toBe(0);
  });
});
