/** Views (Spec §17): read-only tables from YAML, sorting in the browser only. */
import { api, seg } from '../api.js';
import { h, replaceChildren } from '../dom.js';
import { cellText, nextSort, objectText, sortRows, type SortDirection } from '../../shared/sort.js';
import { itemPanelLink } from './item.js';
import type { Page, PageContext } from '../page.js';
import type { ViewDef, ViewItems } from '../types.js';
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
  let sort: { column: number; direction: SortDirection } | null = null;
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

  const renderTable = (): void => {
    if (!data) return;
    const d = data;
    const rows = sort ? sortRows(d.rows, sort.column, d.columns[sort.column]?.type ?? 'string', sort.direction) : d.rows;
    const headers = d.columns.map((c, i) => {
      const active = sort?.column === i;
      const dir = active ? sort!.direction : null;
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'sort',
          title: 'Sort (in the browser only)',
          on: {
            click: () => {
              sort = nextSort(sort, i);
              renderTable();
            },
          },
        },
        c.label,
        dir ? (dir === 'asc' ? ' ▲' : ' ▼') : '',
      );
      // aria-sort belongs on the column header (<th>), not on the button inside it.
      return { cell: btn, attrs: { 'aria-sort': dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none' } };
    });
    replaceChildren(
      body,
      d.errors.length ? h('div', { class: 'alert alert-error' }, d.errors.map((e) => h('div', null, `Source ${e.sourceId}: ${e.message}`))) : null,
      d.filterUnknown > 0 ? h('div', { class: 'alert alert-info' }, `${d.filterUnknown} item(s) not shown because the filter could not be evaluated (unknown).`) : null,
      d.truncated ? h('div', { class: 'alert alert-warn' }, 'Result truncated.') : null,
      table(
        [...headers, ''],
        rows.map((r) => [
          ...r.cells.map((c, i) => cellNode(c, d.columns[i]?.field ?? '')),
          h('span', null, r.lastRunId ? runLink(r.lastRunId, 'last run') : '', r.lastRunId ? ' ' : '', itemPanelLink(r.sourceId, r.itemId, 'act…')),
        ]),
        { empty: 'No items match this view.' },
      ),
    );
  };

  const load = async (refresh = false): Promise<void> => {
    refreshBtn.disabled = true;
    try {
      data = await api.get<ViewItems>(`/api/v1/views/${seg(id)}/items${refresh ? '?refresh=true' : ''}`);
      title.textContent = data.view.title;
      ctx.setTitle(data.view.title);
      meta.textContent = `${data.rows.length} item(s) · sources ${data.view.sources.join(', ')} · fetched ${new Date(data.fetchedAt).toLocaleTimeString()}${data.cached ? ' (cached)' : ''}`;
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
