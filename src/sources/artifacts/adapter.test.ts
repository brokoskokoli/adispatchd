import { describe, expect, it } from 'vitest';
import { SourceError, type ArtifactRecord } from '../../core/index.js';
import { createItemFieldSource, evaluateFilter } from '../../filters/index.js';
import { ArtifactSourceAdapter, artifactFields, createArtifactSourceFactory } from './adapter.js';
import { ARTIFACT_FIELD_DEFINITIONS } from './fields.js';

const record = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  id: 'art-20261029T100000000Z-aaaaaaaa',
  name: 'Weekly report',
  type: 'report',
  kind: 'file',
  fileName: 'report.pdf',
  size: 120,
  fileCount: 1,
  workflowId: 'make',
  runId: 'run-1',
  ordinal: 0,
  parentId: null,
  consumedBy: ['archive'],
  attemptedBy: ['archive'],
  createdAt: '2026-10-29T10:00:00.000Z',
  ...over,
});

describe('ArtifactSourceAdapter (WI-35)', () => {
  const a = record();
  const b = record({ id: 'art-20261029T110000000Z-bbbbbbbb', name: 'Logs', type: 'logs', kind: 'folder', fileName: 'logs', fileCount: 4, parentId: a.id, consumedBy: [] });
  const catalog = { list: () => [b, a], get: (id: string) => [a, b].find((r) => r.id === id) ?? null };
  const adapter = new ArtifactSourceAdapter('artifacts', catalog);

  it('lists every artifact as an item with the documented fields', async () => {
    const items = await adapter.listCandidates();
    expect(items.map((i) => i.itemId)).toEqual([b.id, a.id]);
    expect(items[1]).toMatchObject({
      sourceId: 'artifacts',
      key: `artifacts:${a.id}`,
      type: 'artifact',
      url: `#/artifacts/${a.id}`,
      createdAt: a.createdAt,
      fields: {
        id: a.id,
        name: 'Weekly report',
        type: 'report',
        kind: 'file',
        file_name: 'report.pdf',
        size: 120,
        file_count: 1,
        created_at: a.createdAt,
        workflow: 'make',
        run_id: 'run-1',
        parent: null,
        consumed_by: ['archive'],
        attempted_by: ['archive'],
      },
    });
    expect(Object.keys(artifactFields(a)).sort()).toEqual(ARTIFACT_FIELD_DEFINITIONS.map((d) => d.name).sort());
    expect(adapter.type).toBe('artifacts');
  });

  it('reads one item freshly and parses references', async () => {
    expect((await adapter.getItem(a.id))?.fields.name).toBe('Weekly report');
    expect(await adapter.getItem('art-20261029T100000000Z-cccccccc')).toBeNull();
    expect(await adapter.getItem('../etc')).toBeNull();
    expect(adapter.parseItemRef(a.id)).toBe(a.id);
    expect(adapter.parseItemRef(` ${a.id} `)).toBe(a.id);
    expect(adapter.parseItemRef(`http://localhost:8787/#/artifacts/${a.id}`)).toBe(a.id);
    for (const bad of ['12', 'owner/repo#1', '', `#/artifacts/${a.id}/files`, '#/artifacts/%E0%A4%A']) expect(adapter.parseItemRef(bad)).toBeNull();
  });

  it('resolves known fields and reports unknown ones as unknown (fail closed)', async () => {
    const [item] = await adapter.listCandidates();
    const res = await adapter.resolveFields(item!, ['name', 'nope']);
    expect(res.name).toEqual({ known: true, value: 'Logs' });
    expect(res.nope).toMatchObject({ known: false });
  });

  it('supports filters with consumed_by (not contains) and has nothing to write', async () => {
    const items = await adapter.listCandidates();
    const filter = { not: { field: 'consumed_by', operator: 'contains', value: 'archive' } } as const;
    const matches: string[] = [];
    for (const item of items) {
      const fields = createItemFieldSource(item, { definitions: adapter.fieldDefinitions() });
      if ((await evaluateFilter(filter, fields)).value === true) matches.push(item.itemId);
    }
    expect(matches).toEqual([b.id]);
    await expect(adapter.applyUpdate()).rejects.toBeInstanceOf(SourceError);
    await expect(adapter.postComment()).rejects.toThrow(/not supported/);
  });

  it('is created by its factory', () => {
    expect(createArtifactSourceFactory(catalog).create('docs', {}, {} as never)).toMatchObject({ sourceId: 'docs', type: 'artifacts' });
  });
});
