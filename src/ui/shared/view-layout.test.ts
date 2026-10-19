import { describe, expect, it } from 'vitest';
import { describeSort, groupLabel, groupRows, jumpTo, needsJumpLinks, sectionHeading, tableSortKey, visibleSections } from './view-layout.js';

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

  it('keys the browser column sort by section title, not position', () => {
    expect(tableSortKey(null)).toBe('view');
    expect(tableSortKey('Review')).toBe('section:Review');
    // Hiding an empty section before "Review" changes its index, not its key.
    const before = visibleSections([{ title: 'A', rows: [], counts: { rows: 0 } }, { title: 'Review', rows: [1], counts: { rows: 1 } }], false);
    const after = visibleSections(before, true);
    expect(tableSortKey(before[1]!.title)).toBe(tableSortKey(after[0]!.title));
  });

  it('jump links scroll to the heading and move the focus there', () => {
    const calls: string[] = [];
    jumpTo({
      scrollIntoView: (o) => calls.push(`scroll:${o?.block}`),
      focus: (o) => calls.push(`focus:${String(o?.preventScroll)}`),
    });
    expect(calls).toEqual(['scroll:start', 'focus:true']);
    expect(() => jumpTo(undefined)).not.toThrow();
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
