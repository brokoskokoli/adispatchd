/**
 * Dashboard widget `info` (WI-24, WI-32): info tiles from `dashboard.yaml`.
 * Values are fetched by the daemon in the background; this widget only reads
 * them (`GET /api/v1/dashboard/info`), follows `dashboard.info` live events and
 * offers a throttled per-tile refresh button. Without `dashboard.yaml` the
 * widget stays empty (hidden). `ids` limits it to some tiles (layout option).
 */
import { api, seg } from '../api.js';
import { h, replaceChildren } from '../dom.js';
import { formatInfoValue, infoStatusLabel, infoStatusTone } from '../../shared/checks.js';
import { formatDuration, formatRelative } from '../../shared/format.js';
import type { LiveMessage } from '../../shared/sse.js';
import type { InfoTile } from '../types.js';
import { act, badge, button, errorBox, time } from '../ui.js';

/** The mounted section. */
export interface InfoSection {
  el: HTMLElement;
  load(): Promise<void>;
  onLive(msg: LiveMessage): void;
}

/** Options of {@link createInfoSection}. */
export interface InfoSectionOptions {
  /** Heading (default "Information"). */
  title?: string;
  /** Only these tiles, in this order (`null`: all in file order). */
  ids?: readonly string[] | null;
}

/** Element IDs must stay unique when the widget is used several times. */
let instances = 0;

function tileElement(t: InfoTile, prefix: string, onRefresh: (btn: HTMLButtonElement) => void): HTMLElement {
  const tone = infoStatusTone(t.status);
  const titleId = `${prefix}-title-${t.id}`;
  const value = formatInfoValue(t.value, t.unit);
  const refresh: HTMLButtonElement = button(t.refreshing ? 'Refreshing…' : 'Refresh', () => onRefresh(refresh), {
    disabled: t.refreshing,
    title: 'Fetch the value now (throttled)',
    requires: 'operator',
  });
  refresh.setAttribute('aria-label', `Refresh ${t.title}`);
  refresh.setAttribute('data-info-refresh', t.id);
  const pct = t.type === 'percent' && typeof t.value === 'number' ? Math.max(0, Math.min(100, t.value)) : null;
  return h(
    'li',
    { class: `info-tile info-tile-${tone}`, 'aria-labelledby': titleId, 'data-info-id': t.id },
    h('div', { class: 'info-head' }, h('span', { class: 'info-title', id: titleId }, t.title), badge(infoStatusLabel(t.status, t.stale), tone)),
    h('div', { class: `info-value${t.stale ? ' info-stale' : ''}`, 'aria-live': 'polite' }, value),
    pct !== null
      ? h('progress', { class: `info-bar info-bar-${tone}`, max: 100, value: pct, 'aria-label': `${t.title}: ${value}` })
      : null,
    h(
      'div',
      { class: 'info-meta muted' },
      t.updatedAt ? h('span', null, 'updated ', time(t.updatedAt)) : h('span', null, t.status === 'pending' ? 'not fetched yet' : 'no valid value yet'),
      t.durationMs !== null ? ` · ${formatDuration(t.durationMs)}` : null,
      t.nextAttemptAt && !t.refreshing
        ? h('span', { title: t.nextAttemptAt }, ` · ${t.status === 'error' ? 'retry' : 'next'} ${formatRelative(t.nextAttemptAt, Date.now()).replace(' ago', '')}`)
        : null,
    ),
    t.error ? h('div', { class: 'error-text info-error' }, t.error) : null,
    h('div', { class: 'info-actions' }, refresh),
  );
}

/** Create the section; call `load()` once and forward live messages. */
export function createInfoSection(options: InfoSectionOptions = {}): InfoSection {
  const prefix = `info${++instances}`;
  const ids = options.ids ?? null;
  const list = h('ul', { class: 'info-tiles' });
  const status = h('div');
  const el = h(
    'section',
    { class: 'card span-all info-section', hidden: true, 'aria-labelledby': `${prefix}-heading` },
    h('h2', { id: `${prefix}-heading` }, options.title ?? 'Information'),
    status,
    list,
  );
  const tiles = new Map<string, InfoTile>();
  const items = new Map<string, HTMLElement>();

  const refresh = (id: string, btn: HTMLButtonElement): void => {
    void act(btn, () => api.post<{ tile: InfoTile }>(`/api/v1/dashboard/info/${seg(id)}/refresh`), 'Refresh started').then((res) => {
      if (res?.tile) update(res.tile);
    });
  };

  const render = (t: InfoTile): HTMLElement => tileElement(t, prefix, (btn) => refresh(t.id, btn));

  const update = (t: InfoTile): void => {
    if (!tiles.has(t.id)) return; // unknown tile (e.g. before the reload event): wait for the next load
    tiles.set(t.id, t);
    const old = items.get(t.id);
    const next = render(t);
    items.set(t.id, next);
    if (!old) return;
    const hadFocus = old.contains(document.activeElement);
    old.replaceWith(next);
    if (hadFocus) next.querySelector<HTMLButtonElement>('[data-info-refresh]')?.focus();
  };

  const load = async (): Promise<void> => {
    try {
      const res = await api.get<{ configured: boolean; info: InfoTile[] }>('/api/v1/dashboard/info');
      el.hidden = !res.configured;
      tiles.clear();
      items.clear();
      const byId = new Map(res.info.map((t) => [t.id, t]));
      const shown = ids ? ids.map((id) => byId.get(id)).filter((t): t is InfoTile => t !== undefined) : res.info;
      for (const t of shown) {
        tiles.set(t.id, t);
        items.set(t.id, render(t));
      }
      replaceChildren(status, res.configured && shown.length === 0 ? h('p', { class: 'muted' }, ids ? 'None of the selected info tiles is defined.' : 'dashboard.yaml defines no info tiles.') : null);
      replaceChildren(list, [...items.values()]);
    } catch (err) {
      el.hidden = false;
      replaceChildren(status, errorBox(err));
    }
  };

  return {
    el,
    load,
    onLive(msg) {
      if (msg.type === 'dashboard.info') update(msg.payload as unknown as InfoTile);
      else if (msg.type === 'config.reloaded') void load();
    },
  };
}
