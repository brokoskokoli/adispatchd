/**
 * Rendering of a view result (Spec §17, WI-28), shared by the view page and
 * the dashboard view widget (WI-32): alerts, sections with headings and
 * optional jump links, grouped tables, browser-only column sort (state per
 * table, kept across re-renders of the same renderer) and the item panel
 * link per row. With `moreHref`, tables that were cut by a row limit end
 * with a note (sorting covers the shown rows only) and an "N more …" link.
 */
import { h, replaceChildren } from './dom.js';
import { cellText, nextSort, objectText, sortRows, type SortDirection } from '../shared/sort.js';
import { itemPanelLink } from './pages/item.js';
import {
  MAX_VIEW_ROWS,
  describeSort,
  groupLabel,
  groupRows,
  jumpTo,
  needsJumpLinks,
  sectionHeading,
  tableSortKey,
  visibleSections,
} from '../shared/view-layout.js';
import type { ViewColumnDef, ViewItems, ViewRowData } from './types.js';
import { button, externalLink, runLink, table, time } from './ui.js';

export interface ViewRenderOptions {
  /** Heading level of section titles (`h2` on the page, `h3` in a widget card). */
  headingTag: 'h2' | 'h3';
  /** Jump links above many sections (view page). */
  jumpLinks: boolean;
  /** Link target for "N more …" below tables cut by a limit (dashboard widget). */
  moreHref?: string;
}

/** A renderer keeps the browser-only sort state of its tables. */
export interface ViewRenderer {
  /** Nodes for the result (alerts, tables/sections). */
  render(data: ViewItems): Node[];
}

function cellNode(c: ViewRowData['cells'][number], field: string): Node {
  if (!c.known) return h('span', { class: 'unknown', title: 'Field not available for this item' }, '—');
  const t = cellText(c);
  if (field === 'run.last_id' && typeof c.value === 'string') return runLink(c.value);
  // WI-33: link column to the item history (value = UI route).
  if (field === 'history' && typeof c.value === 'string' && c.value.startsWith('#/items/')) return h('a', { href: c.value, class: 'item-history' }, 'History →');
  if (Array.isArray(c.value) && c.value.some((x) => typeof x === 'object' && x !== null)) {
    // object[] (e.g. closing_prs): one entry per object, linked to its `url` if it is http(s).
    const parts: Array<Node | string> = [];
    c.value.forEach((x: unknown, i: number) => {
      if (i > 0) parts.push(', ');
      const url = typeof x === 'object' && x !== null ? (x as { url?: unknown }).url : undefined;
      parts.push(typeof url === 'string' ? externalLink(url, objectText(x)) : objectText(x));
    });
    return h('span', null, ...parts);
  }
  if (c.link) return externalLink(c.link, t || c.link);
  if (/(_at|^run\.last_(started|finished)_at)$/.test(field) && typeof c.value === 'string' && !Number.isNaN(Date.parse(c.value))) return time(c.value);
  return document.createTextNode(t);
}

export function createViewRenderer(options: ViewRenderOptions): ViewRenderer {
  /** Browser-only column sort per table (view or section). */
  const sorts = new Map<string, { column: number; direction: SortDirection }>();

  /**
   * Below a table the widget limit cut: the rows come trimmed from the server
   * (first N in the configured order), so a column sort and the group counts
   * only cover these – say so, and link to the view page for the rest. `total`
   * is capped like the view page (`MAX_VIEW_ROWS`), so the link promises no more
   * than the page shows.
   */
  const more = (shown: number, total: number): HTMLElement | null => {
    const available = Math.min(total, MAX_VIEW_ROWS);
    if (!options.moreHref || available <= shown) return null;
    return h(
      'p',
      { class: 'view-more muted' },
      `First ${shown} of ${available} rows in the configured order; column sort and group counts cover these only. `,
      h('a', { href: options.moreHref }, `${available - shown} more …`),
    );
  };

  /**
   * One table (the view or a section). Column clicks sort in the browser only
   * (state per table); "Default order" restores the configured sort. Grouped
   * tables (WI-28) show a heading row per value of the first sort key while
   * the configured order is active.
   */
  const renderTableFor = (key: string, columns: ViewColumnDef[], rows: ViewRowData[], grouped: boolean, empty: string): HTMLElement => {
    const wrap = h('div', { class: 'view-table' });
    const draw = (): void => {
      const sort = sorts.get(key) ?? null;
      const shown = sort ? sortRows(rows, sort.column, columns[sort.column]?.type ?? 'string', sort.direction) : rows;
      const headers = columns.map((c, i) => {
        const dir = sort?.column === i ? sort.direction : null;
        const btn = h(
          'button',
          {
            type: 'button',
            class: 'sort',
            title: 'Sort (in the browser only)',
            on: {
              click: () => {
                sorts.set(key, nextSort(sort, i));
                draw();
              },
            },
          },
          c.label,
          dir ? (dir === 'asc' ? ' ▲' : ' ▼') : '',
        );
        // aria-sort belongs on the column header (<th>), not on the button inside it.
        return { cell: btn, attrs: { 'aria-sort': dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none' } };
      });
      const rowCells = (r: ViewRowData): Node[] => [
        ...r.cells.map((c, i) => cellNode(c, columns[i]?.field ?? '')),
        h('span', null, r.lastRunId ? runLink(r.lastRunId, 'last run') : '', r.lastRunId ? ' ' : '', itemPanelLink(r.sourceId, r.itemId, 'act…')),
      ];
      const reset = sort
        ? h('p', { class: 'view-sort-reset' }, button('Default order', () => {
            sorts.delete(key);
            draw();
          }, { title: 'Restore the sort configured in the view' }))
        : null;
      if (!grouped || sort || shown.length === 0) {
        replaceChildren(wrap, reset, table([...headers, ''], shown.map(rowCells), { empty }));
        return;
      }
      const span = String(columns.length + 1);
      replaceChildren(
        wrap,
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'grouped' },
            h('thead', null, h('tr', null, [...headers.map((x) => h('th', { scope: 'col', ...x.attrs }, x.cell)), h('th', { scope: 'col' })])),
            groupRows(shown).map((g) =>
              h(
                'tbody',
                null,
                h('tr', { class: 'group-row' }, h('th', { scope: 'rowgroup', colspan: span }, groupLabel(g.group, g.rows.length))),
                g.rows.map((r) => h('tr', null, rowCells(r).map((c) => h('td', null, c)))),
              ),
            ),
          ),
        ),
      );
    };
    draw();
    return wrap;
  };

  const render = (d: ViewItems): Node[] => {
    const alerts = [
      d.errors.length ? h('div', { class: 'alert alert-error' }, d.errors.map((e) => h('div', null, `Source ${e.sourceId}: ${e.message}`))) : null,
      (d.warnings ?? []).length ? h('div', { class: 'alert alert-warn' }, (d.warnings ?? []).map((w) => h('div', null, w))) : null,
      d.filterUnknown > 0 ? h('div', { class: 'alert alert-info' }, `${d.filterUnknown} item(s) not shown because the filter could not be evaluated (unknown).`) : null,
      d.truncated ? h('div', { class: 'alert alert-warn' }, 'Result truncated.') : null,
    ].filter((x): x is HTMLElement => x !== null);
    if (!d.sections) {
      const tableEl = renderTableFor(tableSortKey(null), d.columns, d.rows, d.groupBy !== undefined, 'No items match this view.');
      return [...alerts, tableEl, ...[more(d.rows.length, d.totalRows ?? d.rows.length)].filter((x): x is HTMLElement => x !== null)];
    }
    const shown = visibleSections(d.sections, d.hideEmptySections ?? false);
    const headings: HTMLElement[] = [];
    const blocks = shown.map((s) =>
      {
        // tabindex -1: jump links move the focus here (keyboard and screen reader users continue in the section).
        const heading = h(options.headingTag, { class: 'view-section-title', tabindex: '-1' }, sectionHeading(s.title, s.counts.rows));
        headings.push(heading);
        return h(
          'section',
          { class: 'view-section', 'aria-label': s.title },
          heading,
          h('p', { class: 'muted view-section-meta' }, `sorted by ${describeSort(s.sort)}`, s.counts.truncated ? ' · truncated' : ''),
          s.counts.filterUnknown > 0
            ? h('div', { class: 'alert alert-info' }, `${s.counts.filterUnknown} item(s) not placed here because the section filter could not be evaluated (unknown).`)
            : null,
          renderTableFor(tableSortKey(s.title), s.fields, s.rows, s.groupBy !== null, 'No entries.'),
          more(s.rows.length, s.counts.rows),
        );
      },
    );
    // Jump links (buttons: hash links would change the route).
    const jumps =
      options.jumpLinks && needsJumpLinks(shown.length)
        ? h(
            'nav',
            { class: 'view-jumps', 'aria-label': 'Sections' },
            shown.map((s, i) =>
              h('button', { type: 'button', class: 'btn btn-plain', on: { click: () => jumpTo(headings[i]) } }, sectionHeading(s.title, s.counts.rows)),
            ),
          )
        : null;
    return [...alerts, ...(jumps ? [jumps] : []), ...blocks, ...(shown.length === 0 ? [h('p', { class: 'empty' }, 'No items match this view.')] : [])];
  };

  return { render };
}
