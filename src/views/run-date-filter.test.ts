import { describe, expect, it } from 'vitest';
import type { SourceAdapter, SourceItem } from '../core/index.js';
import type { ConfigManager, ViewConfig } from '../config/index.js';
import type { RunRecord } from '../persistence/index.js';
import { GITHUB_FIELD_DEFINITIONS } from '../sources/index.js';
import { VIEW_RUN_FIELDS, ViewService } from './index.js';

function item(n: number): SourceItem {
  return {
    sourceId: 'repo',
    itemId: String(n),
    key: `repo:${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    type: 'issue',
    fields: { number: n, title: `#${n}`, state: 'open', labels: [] },
  };
}

const adapter = {
  type: 'github',
  sourceId: 'repo',
  fieldDefinitions: () => GITHUB_FIELD_DEFINITIONS,
  listCandidates: async () => [item(1), item(2)],
  resolveFields: async () => ({}),
} as unknown as SourceAdapter;

function view(filterValue: string): ViewConfig {
  return {
    id: 'v',
    title: 'v',
    file: 'views/v.yaml',
    sources: ['repo'],
    filter: { field: 'run.last_started_at', operator: 'greater_than', value: filterValue },
    fields: [{ field: 'number', label: 'number', link: null }],
    sort: null,
  };
}

describe('view run date fields (WI-13)', () => {
  it('are typed as date', () => {
    for (const name of ['run.last_started_at', 'run.last_finished_at']) {
      expect(VIEW_RUN_FIELDS.find((f) => f.name === name)?.type).toBe('date');
    }
  });

  it('compare as instants in view filters, not as strings', async () => {
    // 2026-03-01T11:00:00+02:00 = 09:00Z: run 1 (10:00Z) started after it, run 2 (08:00Z) before.
    // A plain string comparison would reject run 1 ("…T10" < "…T11").
    const runs = new Map<string, RunRecord>([
      ['repo:1', { id: 'run-1', workflowId: 'w', status: 'completed', startedAt: '2026-03-01T10:00:00.000Z' } as RunRecord],
      ['repo:2', { id: 'run-2', workflowId: 'w', status: 'completed', startedAt: '2026-03-01T08:00:00.000Z' } as RunRecord],
    ]);
    const config = { current: { version: 1, views: { v: view('2026-03-01T11:00:00+02:00') } } } as unknown as ConfigManager;
    const service = new ViewService({ config, sources: () => adapter, runs: { lastRunsForItems: () => runs } });
    const result = await service.items('v');
    expect(result.rows.map((r) => r.key)).toEqual(['repo:1']);
  });
});
