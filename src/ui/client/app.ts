/**
 * Entry point of the web UI (WI-11, Spec §16): navigation, hash router, one
 * shared SSE connection with reconnect + REST resync.
 */
import { api } from './api.js';
import { h, replaceChildren, $ } from './dom.js';
import { parseHash, type Route } from '../shared/route.js';
import { LiveConnection, type EventSourceLike, type LiveState } from '../shared/sse.js';
import { createRefresher } from '../shared/throttle.js';
import type { Page, PageContext } from './page.js';
import type { Status, ViewDef } from './types.js';
import { badge, errorBox } from './ui.js';
import { dashboardPage } from './pages/dashboard.js';
import { runsPage } from './pages/runs.js';
import { runPage } from './pages/run.js';
import { workflowPage, workflowsPage } from './pages/workflows.js';
import { blockedPage } from './pages/blocked.js';
import { failedActionsPage } from './pages/actions.js';
import { viewPage, viewsListPage } from './pages/views.js';
import { configPage } from './pages/config.js';

/** Views listed directly in the menu up to this count (more → only "All Views"). */
const MAX_DIRECT_VIEWS = 8;

const main = $('#main');
const nav = $('#nav');
const liveIndicator = $('#live');
let current: Page | null = null;

// ------------------------------------------------------------------ nav
const counters = { blocks: h('span', { class: 'count' }), actions: h('span', { class: 'count' }) };
const viewsMenu = h('ul', { class: 'submenu' });
const navItem = (key: string, href: string, label: string, extra?: Node): HTMLElement => h('li', null, h('a', { href, 'data-nav': key }, label, extra ?? null));

replaceChildren(
  nav,
  h(
    'ul',
    { class: 'menu' },
    navItem('', '#/', 'Dashboard'),
    navItem('runs', '#/runs', 'Runs'),
    navItem('workflows', '#/workflows', 'Workflows'),
    navItem('blocked', '#/blocked', 'Blocked', counters.blocks),
    navItem('actions', '#/actions', 'Failed Actions', counters.actions),
    h('li', { class: 'has-sub' }, h('details', { class: 'views-menu' }, h('summary', { 'data-nav': 'views' }, 'Views'), viewsMenu)),
    navItem('config', '#/config', 'Configuration'),
  ),
);

const renderCount = (el: HTMLElement, n: number, tone: 'warn' | 'error'): void => {
  replaceChildren(el, n > 0 ? badge(String(n), tone) : null);
};

const loadNav = async (): Promise<void> => {
  try {
    const [status, views] = await Promise.all([api.get<Status>('/api/v1/status'), api.get<{ views: ViewDef[] }>('/api/v1/views')]);
    renderCount(counters.blocks, status.counts.activeBlocks, 'warn');
    renderCount(counters.actions, status.counts.failedActions, 'error');
    const direct = views.views.length <= MAX_DIRECT_VIEWS ? views.views : [];
    replaceChildren(
      viewsMenu,
      direct.map((v) => h('li', null, h('a', { href: `#/views/${encodeURIComponent(v.id)}`, 'data-nav': `views/${v.id}` }, v.title))),
      h('li', null, h('a', { href: '#/views', 'data-nav': 'views' }, 'All Views')),
    );
    markActiveNav();
  } catch {
    // shown by the live indicator / pages
  }
};
const navRefresher = createRefresher(loadNav, 2000);

const markActiveNav = (): void => {
  const r = parseHash(location.hash);
  const top = r.segments[0] ?? '';
  const full = r.segments.slice(0, 2).join('/');
  nav.querySelectorAll('[data-nav]').forEach((a) => {
    const key = a.getAttribute('data-nav') ?? '';
    const active = key === full || (key === top && !(top === 'views' && r.segments.length > 1 && a.tagName === 'A'));
    a.classList.toggle('active', active);
    if (a.tagName === 'A') {
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  });
};

// --------------------------------------------------------------- router
const ctxFor = (route: Route): PageContext => ({
  route,
  navigate: (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  },
  refreshNav: () => navRefresher.trigger(),
  setTitle: (title) => {
    document.title = `${title} · adispatchd`;
  },
});

function pageFor(route: Route, ctx: PageContext): Page {
  const [a, b] = route.segments;
  switch (a) {
    case undefined:
      return dashboardPage(ctx);
    case 'runs':
      return b ? runPage(ctx, b) : runsPage(ctx);
    case 'workflows':
      return b ? workflowPage(ctx, b) : workflowsPage(ctx);
    case 'blocked':
      return blockedPage(ctx);
    case 'actions':
      return failedActionsPage(ctx);
    case 'views':
      return b ? viewPage(ctx, b) : viewsListPage(ctx);
    case 'config':
      return configPage(ctx);
    default:
      return { el: h('div', { class: 'page' }, h('h1', null, 'Not found'), h('p', null, 'Unknown page. ', h('a', { href: '#/' }, 'Go to the dashboard'))) };
  }
}

function render(): void {
  current?.dispose?.();
  current = null;
  const route = parseHash(location.hash);
  try {
    current = pageFor(route, ctxFor(route));
    replaceChildren(main, current.el);
  } catch (err) {
    replaceChildren(main, errorBox(err));
  }
  nav.querySelectorAll('details').forEach((d) => {
    d.open = false;
  });
  markActiveNav();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);

// ----------------------------------------------------------------- live
const STATE_LABEL: Record<LiveState, string> = { connecting: 'connecting…', open: 'live', reconnecting: 'reconnecting…', closed: 'offline' };
const live = new LiveConnection({
  url: '/api/v1/events',
  // The DOM EventSource is structurally compatible (handler parameter types differ only nominally).
  create: (url) => new EventSource(url) as unknown as EventSourceLike,
  onMessage: (msg) => {
    if (msg.type === 'block.created' || msg.type === 'block.cleared' || msg.type === 'run.action' || msg.type === 'config.reloaded' || msg.type === 'system.status') navRefresher.trigger();
    try {
      current?.onLive?.(msg);
    } catch (err) {
      console.error('live handler failed', err);
    }
  },
  onResync: () => {
    navRefresher.trigger();
    current?.onResync?.();
  },
  onState: (state) => {
    liveIndicator.textContent = STATE_LABEL[state];
    liveIndicator.className = `live live-${state}`;
    liveIndicator.title = state === 'open' ? 'Live updates via SSE' : 'Live updates interrupted; data is reloaded after reconnecting';
  },
});
window.addEventListener('online', () => live.reconnectNow());

render();
void loadNav();
live.start();
