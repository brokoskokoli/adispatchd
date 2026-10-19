import { describe, expect, it } from 'vitest';
import { describeSort, groupLabel, groupRows, needsJumpLinks, sectionHeading, visibleSections } from './view-layout.js';

describe('views page layout (WI-28)', () => {
  it('groups consecutive rows by their group value, empty as its own group', () => {
    const rows = [{ group: 'open', id: 1 }, { group: 'open', id: 2 }, { group: 'coding', id: 3 }, { group: null, id: 4 }, { id: 5 }];
    expect(groupRows(rows).map((g) => [g.group, g.rows.map((r) => r.id)])).toEqual([
      ['open', [1, 2]],
      ['coding', [3]],
      [null, [4, 5]],
    ]);
    expect(groupRows([])).toEqual([]);
    expect(groupLabel(null, 2)).toBe('(empty) · 2');
    expect(groupLabel('open', 1)).toBe('open · 1');
  });

  it('section headings, hidden empty sections and jump links', () => {
    const sections = [
      { title: 'A', rows: [1], counts: { rows: 1 } },
      { title: 'B', rows: [], counts: { rows: 0 } },
    ];
    expect(sectionHeading('Review', 3)).toBe('Review (3)');
    expect(visibleSections(sections, false).map((s) => s.title)).toEqual(['A', 'B']);
    expect(visibleSections(sections, true).map((s) => s.title)).toEqual(['A']);
    expect(needsJumpLinks(3)).toBe(false);
    expect(needsJumpLinks(4)).toBe(true);
  });

  it('describes the configured sort', () => {
    expect(describeSort([])).toBe('item key');
    expect(
      describeSort([
        { field: 'project.Status', direction: 'asc', order: ['a'] },
        { field: 'created_at', direction: 'desc', order: null },
      ]),
    ).toBe('project.Status (custom order) ↑, created_at ↓');
  });
});
