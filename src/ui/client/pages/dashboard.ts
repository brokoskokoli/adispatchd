/**
 * Dashboard (Spec §16, WI-32): renders the layout of `GET /api/v1/dashboard`
 * (rows of columns of widgets, `tabs` containers). Without `layout` in
 * `dashboard.yaml` the server sends the default layout, which is the 0.7.0
 * dashboard: resource strip, info tiles, scheduler/capacity/attention,
 * active and recent runs. Status notices (drain, not ready, unprotected
 * binding) always stay on top. After a config reload the layout is reloaded.
 */
import { api } from '../api.js';
import { h, replaceChildren } from '../dom.js';
import { buildHash } from '../../shared/route.js';
import {
  columnTemplate,
  formatTabParam,
  parseTabParam,
  TAB_QUERY,
  type DashboardLayoutResponse,
  type DashboardRow,
} from '../../shared/dashboard-layout.js';
import { isStateChange, type Page, type PageContext } from '../page.js';
import { errorBox, loading } from '../ui.js';
import { createDashboardFeeds, type DashboardFeeds } from './dashboard-feeds.js';
import { tabsWidget, type TabsContext, type TabsHandle } from './dashboard-tabs.js';
import { mountWidget, statusNotices, type Mounted } from './dashboard-widgets.js';

export { cancelRunButton, schedulerStateBadge } from './dashboard-widgets.js';

/** Combine several mounted parts into one. */
function group(el: HTMLElement, parts: Mounted[]): Mounted {
  return {
    el,
    onLive: (msg) => parts.forEach((p) => p.onLive?.(msg)),
    onResync: () => parts.forEach((p) => p.onResync?.()),
    onRoute: () => parts.forEach((p) => p.onRoute?.()),
    dispose: () => parts.forEach((p) => p.dispose?.()),
  };
}

/** Mount a (nested) layout. `ancestor` = selected tab IDs of the enclosing tabs widgets. */
function mountLayout(rows: readonly DashboardRow[], ancestor: readonly string[], feeds: DashboardFeeds, tabs: TabsContext): Mounted {
  const parts: Mounted[] = [];
  const rowEls = rows.map((row) => {
    const cols = h('div', { class: 'dash-cols' });
    cols.style.setProperty('--dash-cols', columnTemplate(row.columns));
    for (const column of row.columns) {
      const col = h('div', { class: 'dash-col' });
      for (const w of column.widgets) {
        let m: Mounted;
        try {
          m = w.widget === 'tabs' ? tabsWidget(w, ancestor, tabs, (r, a) => mountLayout(r, a, feeds, tabs)) : mountWidget(feeds, w);
        } catch (err) {
          // A broken widget only breaks its own card.
          m = { el: h('section', { class: 'card widget' }, errorBox(err)) };
        }
        parts.push(m);
        col.appendChild(m.el);
      }
      cols.appendChild(col);
    }
    return h('div', { class: 'dash-row' }, row.title !== null ? h('h2', { class: 'dash-row-title' }, row.title) : null, cols);
  });
  return group(h('div', { class: 'dash-layout' }, rowEls), parts);
}

export const dashboardPage = (ctx: PageContext): Page => {
  ctx.setTitle('Dashboard');
  const notices = h('div', { class: 'dash-notices' });
  const host = h('div', { class: 'dash-host' }, loading());
  const el = h('div', { class: 'page' }, h('h1', null, 'Dashboard'), notices, host);
  const feeds = createDashboardFeeds();
  let root: Mounted | null = null;
  let tabPaths = parseTabParam(ctx.route.query[TAB_QUERY]);
  const handles = new Set<TabsHandle>();
  const tabs: TabsContext = {
    paths: () => tabPaths,
    register: (handle) => {
      handles.add(handle);
      return () => handles.delete(handle);
    },
    changed: (replace) => {
      tabPaths = [...handles].map((t) => t.path());
      const { [TAB_QUERY]: _old, ...rest } = ctx.route.query;
      // `/` separates tab IDs of nested tabs; kept readable in the URL (`#/?tab=projects/a`).
      const hash = buildHash([], { ...rest, [TAB_QUERY]: formatTabParam(tabPaths) }).replace(/%2F/gi, '/');
      // pushState: a new history entry (back button) without a hashchange (no page re-render);
      // arrow keys replace the entry instead of adding one per key press.
      if (location.hash === hash) return;
      if (replace) history.replaceState(null, '', hash);
      else history.pushState(null, '', hash);
    },
  };

  // Notices are independent of the layout: they follow the status feed.
  const unsubscribeNotices = feeds.status((state) => {
    if (state.kind === 'ok') replaceChildren(notices, ...statusNotices(state.data));
  });

  let loadGen = 0;
  const loadLayout = async (): Promise<void> => {
    const gen = ++loadGen;
    try {
      const res = await api.get<DashboardLayoutResponse>('/api/v1/dashboard');
      if (gen !== loadGen) return;
      root?.dispose?.();
      root = mountLayout(res.layout, [], feeds, tabs);
      replaceChildren(host, root.el);
    } catch (err) {
      if (gen !== loadGen) return;
      root?.dispose?.();
      root = null;
      replaceChildren(host, errorBox(err));
    }
  };
  void loadLayout();

  return {
    el,
    onLive: (msg) => {
      if (msg.type === 'config.reloaded') {
        void loadLayout();
        feeds.stateChanged();
        return;
      }
      root?.onLive?.(msg);
      if (isStateChange(msg)) feeds.stateChanged();
    },
    onResync: () => {
      feeds.resync();
      root?.onResync?.();
    },
    onRouteChange: (route) => {
      if (route.segments.length !== 0) return false;
      ctx.route = route;
      tabPaths = parseTabParam(route.query[TAB_QUERY]);
      root?.onRoute?.();
      return true;
    },
    dispose: () => {
      loadGen++;
      unsubscribeNotices();
      root?.dispose?.();
      root = null;
      feeds.dispose();
    },
  };
};
