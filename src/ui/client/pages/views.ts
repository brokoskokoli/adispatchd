/** Views (Spec §17): read-only tables from YAML, sorting in the browser only (rendering shared with the dashboard view widget, WI-32). */
import { api, seg } from '../api.js';
import { h, replaceChildren } from '../dom.js';
import type { Page, PageContext } from '../page.js';
import type { ViewDef, ViewItems } from '../types.js';
import { button, errorBox, loading, routeLink, table } from '../ui.js';
import { createViewRenderer } from '../view-render.js';

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
  const renderer = createViewRenderer({ headingTag: 'h2', jumpLinks: true });
  const refreshBtn: HTMLButtonElement = button('Refresh', () => void load(true));
  const el = h('div', { class: 'page' }, h('p', { class: 'crumbs' }, routeLink(['views'], '← All Views')), title, h('div', { class: 'actions' }, refreshBtn, meta), body);

  const renderTable = (): void => {
    if (data) replaceChildren(body, ...renderer.render(data));
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
