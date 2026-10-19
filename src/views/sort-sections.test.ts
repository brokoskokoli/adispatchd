/**
 * WI-28: multiple sort keys with custom value order, grouping and sections
 * (unit level, with a fake adapter).
 */
import { describe, expect, it } from 'vitest';
import type { FieldDefinition, SourceAdapter, SourceItem } from '../core/index.js';
import type { ConfigManager, ViewConfig, ViewSectionConfig, ViewSortKey } from '../config/index.js';
import { GITHUB_FIELD_DEFINITIONS } from '../sources/index.js';
import { compareOrdered, ViewService } from './index.js';

const STATUS_DEF: FieldDefinition = { name: 'project.Status', type: 'string', operators: ['equals', 'not_equals', 'contains', 'in'] };

function item(n: number, status: string | null | undefined, extra: Partial<SourceItem['fields']> = {}): SourceItem {
  return {
    sourceId: 'repo',
    itemId: String(n),
    key: `repo:${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    type: 'issue',
    fields: {
      number: n,
      title: `#${n}`,
      state: 'open',
      labels: [],
      created_at: `2026-01-${String(30 - n).padStart(2, '0')}T00:00:00Z`,
      ...(status !== undefined ? { 'project.Status': status } : {}),
      ...extra,
    },
    ...(status === undefined ? { unknownFields: { 'project.Status': 'no project access' } } : {}),
  };
}

function adapter(items: SourceItem[], counter?: { listings: number }): SourceAdapter {
  return {
    type: 'github',
    sourceId: 'repo',
    fieldDefinitions: () => [...GITHUB_FIELD_DEFINITIONS, STATUS_DEF],
    listCandidates: async () => {
      if (counter) counter.listings++;
      return items;
    },
    resolveFields: async () => ({}),
  } as unknown as SourceAdapter;
}

function view(sort: ViewSortKey[], more: Partial<ViewConfig> = {}): ViewConfig {
  return {
    id: 'v',
    title: 'V',
    file: 'views/v.yaml',
    sources: ['repo'],
    filter: null,
    fields: [
      { field: 'number', label: 'Nr', link: null },
      { field: 'project.Status', label: 'Status', link: null },
    ],
    sort,
    groupByFirst: false,
    sections: null,
    exclusive: true,
    hideEmptySections: false,
    ...more,
  };
}

function service(v: ViewConfig, a: SourceAdapter): ViewService {
  const config = { current: { version: 1, views: { v } } } as unknown as ConfigManager;
  return new ViewService({ config, sources: () => a, runs: { lastRunsForItems: () => new Map() } });
}

const ORDER = ['open', 'ready_for_coding', 'coding', 'ready_for_review', 'review', 'merging'];
const ITEMS = [
  item(1, 'review'),
  item(2, 'open'),
  item(3, 'Zeta'), // not listed
  item(4, null), // empty
  item(5, 'coding'),
  item(6, 'open'),
  item(7, 'Alpha'), // not listed
  item(8, undefined), // unknown
  item(9, 'OPEN'), // case-sensitive: not listed
];

describe('view sort by custom value order (WI-28)', () => {
  it('sorts listed values by position, then unlisted alphabetically, empty/unknown last; second key breaks ties', async () => {
    const s = service(
      view([
        { field: 'project.Status', direction: 'asc', order: ORDER },
        { field: 'created_at', direction: 'asc', order: null },
      ]),
      adapter(ITEMS),
    );
    const res = await s.items('v');
    // open: #6 created before #2 (created_at = 30 - n) → 6, 2; then coding 5, review 1; unlisted Alpha 7, OPEN 9, Zeta 3;
    // empty/unknown last, among them again by created_at: 8, 4.
    expect(res.rows.map((r) => r.itemId)).toEqual(['6', '2', '5', '1', '7', '9', '3', '8', '4']);
    expect(res.warnings).toEqual([]);
    expect(res.groupBy).toBeUndefined();
    expect(res.rows[0]).not.toHaveProperty('group');
  });

  it('desc reverses only the listed order; unlisted and empty values stay behind', async () => {
    const s = service(view([{ field: 'project.Status', direction: 'desc', order: ORDER }, { field: 'number', direction: 'desc', order: null }]), adapter(ITEMS));
    const res = await s.items('v');
    expect(res.rows.map((r) => r.itemId)).toEqual(['1', '5', '6', '2', '7', '9', '3', '8', '4']);
  });

  it('several plain keys and the single-key behaviour stay as before', async () => {
    const s = service(view([{ field: 'project.Status', direction: 'asc', order: null }]), adapter(ITEMS));
    const res = await s.items('v');
    // Natural order as before 0.5.0 (code point based: upper case first).
    expect(res.rows.map((r) => r.itemId)).toEqual(['7', '9', '3', '5', '2', '6', '1', '4', '8']);
    const none = await service(view([]), adapter(ITEMS)).items('v');
    expect(none.rows.map((r) => r.itemId)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('compareOrdered: listed < unlisted < empty in both directions', () => {
    const order = new Map([
      ['a', 0],
      ['b', 1],
    ]);
    expect(compareOrdered('a', 'b', order, 1)).toBeLessThan(0);
    expect(compareOrdered('a', 'b', order, -1)).toBeGreaterThan(0);
    expect(compareOrdered('x', 'b', order, -1)).toBeGreaterThan(0);
    expect(compareOrdered(null, 'x', order, -1)).toBeGreaterThan(0);
    expect(compareOrdered('', 'x', order, 1)).toBeGreaterThan(0); // '' counts as empty
    expect(compareOrdered('', null, order, 1)).toBe(0);
    expect(compareOrdered('x', 'y', order, -1)).toBeLessThan(0);
  });

  it('group_by_first marks rows with the value of the first key', async () => {
    const s = service(view([{ field: 'project.Status', direction: 'asc', order: ORDER }], { groupByFirst: true }), adapter(ITEMS));
    const res = await s.items('v');
    expect(res.groupBy).toEqual({ field: 'project.Status', label: 'Status' });
    expect(res.rows.map((r) => r.group)).toEqual(['open', 'open', 'coding', 'review', 'Alpha', 'OPEN', 'Zeta', null, null]);
  });
});

describe('view sections (WI-28)', () => {
  const sections = (exclusive: boolean, list: ViewSectionConfig[]): Partial<ViewConfig> => ({ sections: list, exclusive });
  const S = (title: string, values: string[] | null, more: Partial<ViewSectionConfig> = {}): ViewSectionConfig => ({
    title,
    filter: values ? { field: 'project.Status', operator: 'in', value: values } : null,
    rest: values === null,
    sort: null,
    fields: null,
    ...more,
  });

  it('exclusive: first matching section wins, rest takes the others; own sort/fields; one listing; counts', async () => {
    const counter = { listings: 0 };
    const v = view([{ field: 'number', direction: 'asc', order: null }], {
      filter: { field: 'number', operator: 'less_than', value: 9 },
      ...sections(true, [
        S('Early', ['open', 'coding']),
        S('Open again', ['open'], { sort: [{ field: 'number', direction: 'desc', order: null }] }),
        S('Review', ['review'], { fields: [{ field: 'title', label: 'Title', link: null }] }),
        S('Rest', null),
      ]),
    });
    const res = await service(v, adapter(ITEMS, counter)).items('v');
    expect(counter.listings).toBe(1);
    expect(res.rows).toEqual([]);
    expect(res.filterUnknown).toBe(0);
    const byTitle = Object.fromEntries((res.sections ?? []).map((s) => [s.title, s]));
    expect(res.sections?.map((s) => s.title)).toEqual(['Early', 'Open again', 'Review', 'Rest']);
    expect(byTitle.Early?.rows.map((r) => r.itemId)).toEqual(['2', '5', '6']);
    expect(byTitle['Open again']?.rows).toEqual([]);
    expect(byTitle['Open again']?.sort).toEqual([{ field: 'number', direction: 'desc', order: null }]);
    expect(byTitle.Review?.fields.map((c) => c.field)).toEqual(['title']);
    expect(byTitle.Review?.rows.map((r) => r.cells.map((c) => c.value))).toEqual([['#1']]);
    // Rest: unlisted and empty values. #8 is unknown for the first section: counted there and shown nowhere
    // (it might belong to "Early"), neither in later sections nor in the rest.
    expect(byTitle.Rest?.rows.map((r) => r.itemId)).toEqual(['3', '4', '7']);
    expect(byTitle.Early?.counts).toEqual({ rows: 3, filterUnknown: 1, truncated: false });
    expect(byTitle.Review?.counts).toEqual({ rows: 1, filterUnknown: 0, truncated: false });
    expect(byTitle.Rest?.counts).toEqual({ rows: 3, filterUnknown: 0, truncated: false });
    expect(byTitle.Rest?.rest).toBe(true);
  });

  it('exclusive: an unknown verdict stops placement even if a later section would match', async () => {
    const v = view([], {
      ...sections(true, [
        { title: 'Labelled', filter: { field: 'labels', operator: 'contains', value: 'x' }, rest: false, sort: null, fields: null },
        S('Board', ['open']),
        { title: 'All', filter: { field: 'number', operator: 'less_than', value: 100 }, rest: false, sort: null, fields: null },
        S('Rest', null),
      ]),
    });
    const res = await service(v, adapter(ITEMS)).items('v');
    const all = res.sections?.find((s) => s.title === 'All');
    expect(all?.rows.map((r) => r.itemId)).not.toContain('8');
    expect(res.sections?.flatMap((s) => s.rows.map((r) => r.itemId))).not.toContain('8');
    expect(res.sections?.map((s) => s.counts.filterUnknown)).toEqual([0, 1, 0, 0]);
  });

  it('non-exclusive: an item can appear in several sections; rest = in no other section', async () => {
    const v = view([{ field: 'number', direction: 'asc', order: null }], {
      ...sections(false, [S('Early', ['open', 'coding']), S('Open', ['open']), S('Rest', null)]),
    });
    const res = await service(v, adapter(ITEMS)).items('v');
    expect(res.sections?.map((s) => [s.title, s.rows.map((r) => r.itemId)])).toEqual([
      ['Early', ['2', '5', '6']],
      ['Open', ['2', '6']],
      ['Rest', ['1', '3', '4', '7', '9']], // #8 (unknown) stays out of the rest
    ]);
    expect(res.sections?.map((s) => s.counts.filterUnknown)).toEqual([1, 1, 0]);
  });

  it('the view filter applies to all sections and counts its own unknowns', async () => {
    const v = view([], {
      filter: { field: 'project.Status', operator: 'not_equals', value: 'review' },
      ...sections(true, [S('All', null)]),
    });
    const res = await service(v, adapter(ITEMS)).items('v');
    expect(res.filterUnknown).toBe(1); // #8
    expect(res.sections?.[0]?.rows.map((r) => r.itemId)).toEqual(['2', '3', '4', '5', '6', '7', '9']);
  });

  it('groups sections whose first key has an order', async () => {
    const v = view([{ field: 'number', direction: 'asc', order: null }], {
      groupByFirst: true,
      ...sections(true, [S('Board', ['open', 'coding'], { sort: [{ field: 'project.Status', direction: 'asc', order: ORDER }] }), S('Rest', null)]),
    });
    const res = await service(v, adapter(ITEMS)).items('v');
    expect(res.sections?.[0]?.groupBy).toEqual({ field: 'project.Status', label: 'Status' });
    expect(res.sections?.[0]?.rows.map((r) => [r.itemId, r.group])).toEqual([
      ['2', 'open'],
      ['6', 'open'],
      ['5', 'coding'],
    ]);
    expect(res.sections?.[1]?.groupBy).toBeNull();
    expect(res.sections?.[1]?.rows[0]).not.toHaveProperty('group');
  });

  it('summary exposes sort as a list and the sections', () => {
    const v = view([{ field: 'number', direction: 'desc', order: null }], { ...sections(true, [S('A', ['open']), S('Rest', null)]) });
    const summary = service(v, adapter(ITEMS)).get('v');
    expect(summary?.sort).toEqual([{ field: 'number', direction: 'desc', order: null }]);
    expect(summary?.sections?.map((s) => [s.title, s.rest, s.sort.length, s.fields.length])).toEqual([
      ['A', false, 1, 2],
      ['Rest', true, 1, 2],
    ]);
    expect(service(view([]), adapter(ITEMS)).get('v')).toMatchObject({ sort: [], sections: null });
  });
});
