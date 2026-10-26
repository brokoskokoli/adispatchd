/**
 * Entry point of the web UI (WI-11, Spec §16): navigation, hash router, one
 * shared SSE connection with reconnect + REST resync. With authentication
 * (WI-26) `/api/v1/auth/me` decides first: app, login page or "access denied".
 */
import { api, ApiError } from './api.js';
import { currentAuth, loadAuth, UNAUTHORIZED_EVENT } from './auth.js';
import { authScreen, deniedPage, loginPage, userEntry } from '../shared/auth.js';
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
import { toolPage } from './pages/tools.js';
import { itemPage, uiActionsPage } from './pages/item.js';
import { externalLinks, reloadExternalLinks } from './external-links.js';
import { externalNavItem, TOOLS_ROUTE } from '../shared/external-links.js';
import { isNavActive, NAV_ENTRIES } from '../shared/nav.js';
import { RESOURCES_ROUTE } from '../shared/resource-strip.js';
import { resourcesPage } from './pages/server.js';

/** Views listed directly in the menu up to this count (more → only "All Views"). */
const MAX_DIRECT_VIEWS = 8;

const main = $('#main');
const nav = $('#nav');
const liveIndicator = $('#live');
const userSlot = $('#user');
let current: Page | null = null;
let appStarted = false;

// ----------------------------------------------------------------- auth
/** Show the login page (password mode) in place of the app. */
function showLogin(opts: { error?: string | null; notice?: string | null; name?: string } = {}): void {
  current?.dispose?.();
  current = null;
  const me = currentAuth();
  const page = loginPage(h, {
    error: opts.error ?? null,
    notice: opts.notice ?? null,
    canSkip: appStarted && me.role !== null,
    onSubmit: (ev: Event) => {
      ev.preventDefault();
      const form = ev.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const name = String(data.get('name') ?? '').trim();
      const password = String(data.get('password') ?? '');
      if (!name || !password) {
        showLogin({ error: 'Enter user name and password.', name });
        return;
      }
      const submit = form.querySelector('button[type=submit]') as HTMLButtonElement | null;
      if (submit) submit.disabled = true;
      void api
        .post('/api/v1/auth/login', { name, password })
        .then(() => {
          // Fresh start with the session cookie (SSE, roles, navigation).
          if (location.hash.startsWith('#/login')) location.hash = '#/';
          location.reload();
        })
        .catch((err: unknown) => {
          const msg =
            err instanceof ApiError && err.status === 429
              ? 'Too many failed attempts. Please wait a few minutes and try again.'
              : err instanceof ApiError && err.status === 401
                ? 'Invalid user name or password.'
                : err instanceof Error
                  ? err.message
                  : String(err);
          showLogin({ error: msg, name });
        });
    },
  });
  replaceChildren(main, page);
  document.title = 'Sign in · adispatchd';
  const nameInput = main.querySelector('input[name=name]') as HTMLInputElement | null;
  const passwordInput = main.querySelector('input[name=password]') as HTMLInputElement | null;
  if (nameInput && opts.name) nameInput.value = opts.name;
  (opts.name ? passwordInput : nameInput)?.focus();
}

/** Toolbar: logged-in user, role and logout (WI-26). */
function renderUser(): void {
  replaceChildren(
    userSlot,
    userEntry(h, currentAuth(), {
      onLogout: () => {
        void api
          .post('/api/v1/auth/logout')
          .catch(() => undefined)
          .then(() => {
            location.hash = '#/';
            location.reload();
          });
      },
    }),
  );
}

// ------------------------------------------------------------------ nav
const counters = { blocks: h('span', { class: 'count' }), actions: h('span', { class: 'count' }) };
const viewsMenu = h('ul', { class: 'submenu' });
const navItem = (key: string, href: string, label: string, extra?: Node): HTMLElement => h('li', null, h('a', { href, 'data-nav': key }, label, extra ?? null));

replaceChildren(
  nav,
  h(
    'ul',
    { class: 'menu' },
    NAV_ENTRIES.map((e) =>
      e.submenu
        ? h('li', { class: 'has-sub' }, h('details', { class: 'views-menu' }, h('summary', { 'data-nav': e.key }, e.label), viewsMenu))
        : navItem(e.key, e.href, e.label, e.counter ? counters[e.counter] : undefined),
    ),
  ),
);

/** External tools (WI-25, `ui.external_links`): appended to the menu, replaced after every config reload. */
const renderExternalLinks = async (): Promise<void> => {
  const links = await externalLinks();
  const menu = $('ul.menu', nav);
  menu.querySelectorAll('li.ext-link').forEach((li) => li.remove());
  for (const link of links) menu.appendChild(externalNavItem(h, link));
  markActiveNav();
};

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
  nav.querySelectorAll('[data-nav]').forEach((a) => {
    const key = a.getAttribute('data-nav') ?? '';
    const active = isNavActive(key, r, a.tagName === 'A');
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
    case 'login': {
      if (currentAuth().mode !== 'password' || currentAuth().user) return dashboardPage(ctx);
      const holder = h('div');
      queueMicrotask(() => showLogin());
      return { el: holder };
    }
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
    case RESOURCES_ROUTE:
      return resourcesPage(ctx);
    case 'config':
      return configPage(ctx);
    case 'items':
      return itemPage(ctx, b ?? '', route.segments[2] ?? '');
    case 'ui-actions':
      return uiActionsPage(ctx);
    case TOOLS_ROUTE:
      return toolPage(ctx, b ?? '');
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

// ----------------------------------------------------------------- live
const STATE_LABEL: Record<LiveState, string> = { connecting: 'connecting…', open: 'live', reconnecting: 'reconnecting…', closed: 'offline' };
let live: LiveConnection | null = null;
const createLive = (): LiveConnection => new LiveConnection({
  url: '/api/v1/events',
  // The DOM EventSource is structurally compatible (handler parameter types differ only nominally).
  create: (url) => new EventSource(url) as unknown as EventSourceLike,
  onMessage: (msg) => {
    if (msg.type === 'config.reloaded') {
      void reloadExternalLinks();
      void renderExternalLinks();
    }
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
window.addEventListener('online', () => live?.reconnectNow());

// A 401 while the app runs (session expired, logged out in another tab): back to the login page.
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  if (!appStarted) return;
  void loadAuth().then((me) => {
    renderUser();
    if (authScreen(me) === 'app' && me.user) return; // e.g. a stale request; still logged in
    live?.stop();
    liveIndicator.textContent = STATE_LABEL.closed;
    liveIndicator.className = 'live live-closed';
    if (me.mode === 'password') showLogin({ notice: 'Your session has ended. Please sign in again.' });
    else replaceChildren(main, deniedPage(h, me));
  });
});

function startApp(): void {
  appStarted = true;
  // UI actions (WI-27): admins only; with auth.mode none the page explains how to enable them.
  const me = currentAuth();
  if (me.mode === 'none' || me.user?.role === 'admin') {
    const config = nav.querySelector('a[data-nav="config"]')?.parentElement ?? null;
    $('ul.menu', nav).insertBefore(navItem('ui-actions', '#/ui-actions', 'UI Actions'), config);
  }
  nav.hidden = false;
  window.addEventListener('hashchange', () => {
    // Pages may apply query changes of their own route (dashboard tabs, WI-32) without a rebuild.
    if (current?.onRouteChange?.(parseHash(location.hash))) {
      markActiveNav();
      return;
    }
    render();
  });
  live = createLive();
  void reloadExternalLinks();
  render();
  void loadNav();
  void renderExternalLinks();
  live.start();
}

void loadAuth().then((me) => {
  renderUser();
  const screen = authScreen(me);
  if (screen === 'app') startApp();
  else {
    nav.hidden = true;
    liveIndicator.hidden = true;
    if (screen === 'login') showLogin();
    else replaceChildren(main, deniedPage(h, me));
  }
});
