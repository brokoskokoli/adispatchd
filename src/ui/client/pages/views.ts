/** Views (Spec §17): read-only tables from YAML, sorting in the browser only. */
import { api, seg } from '../api.js';
import { h, replaceChildren } from '../dom.js';
import { cellText, nextSort, objectText, sortRows, type SortDirection } from '../../shared/sort.js';
import { itemPanelLink } from './item.js';
import type { Page, PageContext } from '../page.js';
import { describeSort, groupLabel, groupRows, needsJumpLinks, sectionHeading, visibleSections } from '../../shared/view-layout.js';
import type { ViewColumnDef, ViewDef, ViewItems, ViewRowData } from '../types.js';
import { button, errorBox, externalLink, loading, routeLink, runLink, table, time } from '../ui.js';

export const viewsListPage = (ctx: PageContext): Page => {
  ctx.setTitle('All Views');
  const body = h('div', null, loading());
  const el = h('div', { class: 'page' }, h('h1', null, 'All Views'), body);
  void api
    .get<{ views: ViewDef[] }>('/api/v1/views')
    .then((res) =>
      replaceChildren(
        body,
        table(
          ['View', 'Sources', 'File'],
          res.views.map((v) => [routeLink(['views', v.id], v.title), v.sources.join(', '), v.file ? h('code', null, v.file) : '—']),
          { empty: 'No views configured (views/*.yaml).' },
        ),
      ),
    )
    .catch((err: unknown) => replaceChildren(body, errorBox(err)));
  return { el };
};

export const viewPage = (ctx: PageContext, id: string): Page => {
  ctx.setTitle(`View ${id}`);
  const title = h('h1', null, id);
  const meta = h('div', { class: 'muted' });
  const body = h('div', null, loading());
  let data: ViewItems | null = null;
  /** Browser-only column sort per table (view or section). */
  const sorts = new Map<string, { column: number; direction: SortDirection }>();
  const refreshBtn: HTMLButtonElement = button('Refresh', () => void load(true));
  const el = h('div', { class: 'page' }, h('p', { class: 'crumbs' }, routeLink(['views'], '← All Views')), title, h('div', { class: 'actions' }, refreshBtn, meta), body);

  const cellNode = (c: ViewItems['rows'][number]['cells'][number], field: string): Node => {
    if (!c.known) return h('span', { class: 'unknown', title: 'Field not available for this item' }, '—');
    const t = cellText(c);
    if (field === 'run.last_id' && typeof c.value === 'string') return runLink(c.value);
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
                h('tr', { class: 'group-row' }, h('th', { scope: 'colgroup', colspan: span }, groupLabel(g.group, g.rows.length))),
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

  const renderTable = (): void => {
    if (!data) return;
    const d = data;
    const alerts = [
      d.errors.length ? h('div', { class: 'alert alert-error' }, d.errors.map((e) => h('div', null, `Source ${e.sourceId}: ${e.message}`))) : null,
      (d.warnings ?? []).length ? h('div', { class: 'alert alert-warn' }, (d.warnings ?? []).map((w) => h('div', null, w))) : null,
      d.filterUnknown > 0 ? h('div', { class: 'alert alert-info' }, `${d.filterUnknown} item(s) not shown because the filter could not be evaluated (unknown).`) : null,
      d.truncated ? h('div', { class: 'alert alert-warn' }, 'Result truncated.') : null,
    ];
    if (!d.sections) {
      replaceChildren(body, ...alerts, renderTableFor('view', d.columns, d.rows, d.groupBy !== undefined, 'No items match this view.'));
      return;
    }
    const shown = visibleSections(d.sections, d.hideEmptySections ?? false);
    const headings: HTMLElement[] = [];
    const blocks = shown.map((s, i) => {
      const heading = h('h2', { class: 'view-section-title' }, sectionHeading(s.title, s.counts.rows));
      headings.push(heading);
      return h(
        'section',
        { class: 'view-section', 'aria-label': s.title },
        heading,
        h('p', { class: 'muted view-section-meta' }, `sorted by ${describeSort(s.sort)}`, s.counts.truncated ? ' · truncated' : ''),
        s.counts.filterUnknown > 0
          ? h('div', { class: 'alert alert-info' }, `${s.counts.filterUnknown} item(s) not placed here because the section filter could not be evaluated (unknown).`)
          : null,
        renderTableFor(`section-${i}`, s.fields, s.rows, s.groupBy !== null, 'No entries.'),
      );
    });
    // Jump links (buttons: hash links would change the route).
    const jumps = needsJumpLinks(shown.length)
      ? h(
          'nav',
          { class: 'view-jumps', 'aria-label': 'Sections' },
          shown.map((s, i) =>
            h('button', { type: 'button', class: 'btn btn-plain', on: { click: () => headings[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }, sectionHeading(s.title, s.counts.rows)),
          ),
        )
      : null;
    replaceChildren(body, ...alerts, jumps, ...blocks, shown.length === 0 ? h('p', { class: 'empty' }, 'No items match this view.') : null);
  };

  const load = async (refresh = false): Promise<void> => {
    refreshBtn.disabled = true;
    try {
      data = await api.get<ViewItems>(`/api/v1/views/${seg(id)}/items${refresh ? '?refresh=true' : ''}`);
      title.textContent = data.view.title;
      ctx.setTitle(data.view.title);
      const count = data.sections
        ? `${data.sections.length} section(s), ${data.sections.reduce((n, s) => n + s.counts.rows, 0)} row(s)`
        : `${data.rows.length} item(s)`;
      meta.textContent = `${count} · sources ${data.view.sources.join(', ')} · fetched ${new Date(data.fetchedAt).toLocaleTimeString()}${data.cached ? ' (cached)' : ''}`;
      renderTable();
    } catch (err) {
      replaceChildren(body, errorBox(err));
    } finally {
      refreshBtn.disabled = false;
    }
  };
  void load();
  // Views are loaded on open/refresh only (source API calls); no live auto-refresh.
  return { el, onResync: () => void load() };
};
