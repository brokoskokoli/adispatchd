/**
 * Container widget `tabs` (WI-32): one nested layout per tab. Only the
 * selected tab is mounted – widgets of inactive tabs fetch, poll and
 * subscribe nothing; switching disposes the old tab and mounts the new one.
 *
 * The selection is part of the URL (`#/?tab=projekte/a`, shareable, back
 * button via `history.pushState`) and remembered per viewer in localStorage
 * (best effort). ARIA tablist with ←/→/Home/End.
 */
import { h } from '../dom.js';
import { tabFromPaths, tabKeyTarget, tabStorageKey, type DashboardRow, type DashboardWidget } from '../../shared/dashboard-layout.js';
import type { Mounted } from './dashboard-widgets.js';

/** Selection state shared by all tabs widgets of the dashboard page. */
export interface TabsContext {
  /** Selected tab paths of the current URL. */
  paths(): string[][];
  /** A user switched a tab: write the URL (`replace`: no new history entry, e.g. arrow keys). */
  changed(replace: boolean): void;
  /** Mounted tabs widgets report their selected path (for the URL). */
  register(widget: TabsHandle): () => void;
}

export interface TabsHandle {
  /** Selected tab IDs from the outermost tabs widget to this one. */
  path(): string[];
}

let instances = 0;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode, blocked): the URL still carries the selection
  }
}

export function tabsWidget(
  w: Extract<DashboardWidget, { widget: 'tabs' }>,
  ancestor: readonly string[],
  tabs: TabsContext,
  mountLayout: (rows: readonly DashboardRow[], ancestor: readonly string[]) => Mounted,
): Mounted {
  const prefix = `dtabs${++instances}`;
  const ids = w.tabs.map((t) => t.id);
  const storageKey = tabStorageKey(ancestor, ids);
  const fromUrl = (): string | null => tabFromPaths(tabs.paths(), ancestor, ids);
  const stored = readStored(storageKey);
  let selected = fromUrl() ?? (stored !== null && ids.includes(stored) ? stored : w.default);
  let mounted: Mounted | null = null;

  const buttons = w.tabs.map((t, i) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `${prefix}-tab-${i}`,
        class: 'dash-tab',
        'aria-controls': `${prefix}-panel`,
        on: {
          click: () => select(t.id, 'click'),
          keydown: (ev: Event) => {
            const k = ev as KeyboardEvent;
            const target = tabKeyTarget(k.key, i, w.tabs.length);
            if (target === null) return;
            k.preventDefault();
            const next = w.tabs[target];
            if (!next) return;
            select(next.id, 'key');
            buttons[target]?.focus();
          },
        },
      },
      t.title,
    ),
  );
  const list = h('div', { class: 'dash-tablist', role: 'tablist', 'aria-label': w.title ?? 'Dashboard tabs' }, buttons);
  const panel = h('div', { class: 'dash-tabpanel', role: 'tabpanel', id: `${prefix}-panel`, tabindex: '0' });
  const el = h('section', { class: 'dash-tabs widget' }, w.title !== null ? h('h2', { class: 'dash-tabs-title' }, w.title) : null, list, panel);

  const mount = (): void => {
    mounted?.dispose?.();
    const index = Math.max(0, ids.indexOf(selected));
    buttons.forEach((b, i) => {
      b.setAttribute('aria-selected', i === index ? 'true' : 'false');
      b.tabIndex = i === index ? 0 : -1;
      b.classList.toggle('active', i === index);
    });
    panel.setAttribute('aria-labelledby', `${prefix}-tab-${index}`);
    const tab = w.tabs[index];
    mounted = tab ? mountLayout(tab.layout, [...ancestor, tab.id]) : null;
    panel.replaceChildren(...(mounted ? [mounted.el] : []));
  };

  /** `click` adds a history entry, `key` (arrow keys) replaces it, `route` (back button) writes nothing. */
  const select = (id: string, how: 'click' | 'key' | 'route'): void => {
    if (id === selected && mounted) return;
    selected = id;
    mount();
    if (how !== 'route') {
      store(storageKey, id);
      tabs.changed(how === 'key');
    }
  };

  const unregister = tabs.register({ path: () => [...ancestor, selected] });
  mount();

  return {
    el,
    onLive: (msg) => mounted?.onLive?.(msg),
    onResync: () => mounted?.onResync?.(),
    onRoute: () => {
      // Back button / shared link: the URL decides, without an entry the default tab.
      const next = fromUrl() ?? w.default;
      if (next !== selected) select(next, 'route');
      mounted?.onRoute?.();
    },
    dispose: () => {
      unregister();
      mounted?.dispose?.();
      mounted = null;
    },
  };
}
