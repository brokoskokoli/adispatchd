/**
 * Item history page `#/items/<source>/<item>` (WI-33): current state of the
 * item, the path of its runs and a filterable timeline (newest first,
 * switchable) with "load older" paging; optionally the item's GitHub timeline.
 * Rendering lives in shared/item-history.ts (text only).
 */
import { api, seg } from '../api.js';
import { h, replaceChildren, rerender } from '../dom.js';
import type { Page, PageContext } from '../page.js';
import { isStateChange, messageRunId } from '../page.js';
import { createRefresher } from '../../shared/throttle.js';
import {
  ENTRY_KINDS,
  entryItem,
  githubEntries,
  headSection,
  historyNotes,
  parseGitHubEvents,
  parseHistory,
  pathSection,
  timelineControls,
  timelineEntries,
  type Entry,
  type EntryKind,
  type GitHubEventsData,
  type HistoryData,
  type HistoryRender,
} from '../../shared/item-history.js';
import { ApiError } from '../api.js';
import { itemPanelLink } from './item.js';
import { badge, errorBox, externalLink, loading, routeLink, runLink, time } from '../ui.js';

const PAGE_SIZE = 100;

const render: HistoryRender<HTMLElement> = {
  time: (iso) => time(iso),
  runLink: (id, text) => runLink(id, text),
  link: (url, text) => externalLink(url, text),
  badge: (label, tone, title) => badge(label, tone, title),
  routeLink: (hash, text) => h('a', { href: hash }, text),
};

const errorText = (err: unknown): string => (err instanceof ApiError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err));

/** `#/items/<source>/<item>`: the item history. */
export const historyPage = (ctx: PageContext, source: string, itemId: string): Page => {
  ctx.setTitle(`History ${source}:${itemId}`);
  const path = `/api/v1/items/${seg(source)}/${seg(itemId)}`;
  const head = h('div', null, loading());
  const pathEl = h('div');
  const timeline = h('section', { class: 'card' });
  const notes = h('div');
  const el = h(
    'div',
    { class: 'page history' },
    h('p', { class: 'crumbs' }, routeLink(['runs'], '← Runs'), ' · ', h('span', null, `Item history ${source}:${itemId}`)),
    head,
    pathEl,
    timeline,
    notes,
  );

  let data: HistoryData | null = null;
  let entries: Entry[] = [];
  let nextBefore: string | null = null;
  const enabled = new Set<EntryKind>(ENTRY_KINDS.filter((k) => k !== 'github'));
  let ascending = false;
  let github: { on: boolean; loading: boolean; data: GitHubEventsData | null; error: string | null } = { on: false, loading: false, data: null, error: null };
  let loadingMore = false;

  const drawTimeline = (): void => {
    if (!data) return;
    const d = data;
    const external = github.on && github.data ? githubEntries(github.data.events) : [];
    const oldest = nextBefore !== null ? (entries.at(-1)?.at ?? null) : null;
    const shown = timelineEntries(entries, external, enabled, ascending, oldest);
    const githubToggle = d.githubEvents
      ? h(
          'label',
          { class: 'check history-github' },
          h('input', {
            type: 'checkbox',
            checked: github.on,
            on: {
              change: (ev: Event) => {
                github.on = (ev.target as HTMLInputElement).checked;
                if (github.on) enabled.add('github');
                else enabled.delete('github');
                if (github.on && !github.data) void loadGitHub();
                drawTimeline();
              },
            },
          }),
          ' Show GitHub events',
        )
      : null;
    const githubInfo = github.on
      ? github.loading
        ? h('p', { class: 'muted' }, 'Loading GitHub events…')
        : github.error
          ? h('div', { class: 'alert alert-error', role: 'alert' }, 'GitHub events could not be loaded: ', github.error, ' ', h('button', { type: 'button', class: 'btn btn-plain', on: { click: () => void loadGitHub(true) } }, 'Try again'))
          : github.data
            ? h(
                'p',
                { class: 'muted' },
                `${github.data.events.length} GitHub event(s)`,
                github.data.hiddenOwn > 0 ? `, ${github.data.hiddenOwn} own change(s) merged with the entries above` : '',
                github.data.truncated ? `; only the first ${github.data.limit} events of the item were read` : '',
                `. ${github.data.notice}`,
                github.data.cached ? ' (cached)' : '',
              )
            : null
      : null;
    const more =
      nextBefore !== null
        ? h('p', null, h('button', { type: 'button', class: 'btn btn-plain', disabled: loadingMore, on: { click: () => void loadMore() } }, loadingMore ? 'Loading…' : `Load older entries (${entries.length} of ${d.entriesTotal} shown)`))
        : null;
    const list =
      d.entriesTotal === 0 && external.length === 0
        ? h('p', { class: 'empty' }, 'No entries yet: no run, retry block or UI action for this item.')
        : shown.length === 0
          ? h('p', { class: 'empty' }, 'No entries of the selected kinds.')
          : h('ol', { class: 'history-timeline', reversed: !ascending }, shown.map((e) => entryItem(h, e, render)));
    rerender(
      timeline,
      h('h2', null, 'Timeline'),
      timelineControls(h, { enabled, ascending, githubAvailable: github.on }, {
        toggleKind: (kind) => {
          if (enabled.has(kind)) enabled.delete(kind);
          else enabled.add(kind);
          drawTimeline();
        },
        toggleOrder: () => {
          ascending = !ascending;
          drawTimeline();
        },
      }),
      githubToggle,
      githubInfo,
      ascending ? more : null,
      list,
      ascending ? null : more,
    );
  };

  const loadGitHub = async (refresh = false): Promise<void> => {
    github = { ...github, loading: true, error: null };
    drawTimeline();
    try {
      const parsed = parseGitHubEvents(await api.get<unknown>(`${path}/github-events${refresh ? '?refresh=true' : ''}`));
      if (!parsed) throw new Error('Unexpected answer from the server');
      github = { ...github, loading: false, data: parsed };
    } catch (err) {
      github = { ...github, loading: false, error: errorText(err) };
    }
    drawTimeline();
  };

  const load = async (): Promise<void> => {
    try {
      // Reload as many entries as are shown (live refresh keeps "load older" pages).
      const limit = Math.max(PAGE_SIZE, Math.min(500, entries.length));
      const parsed = parseHistory(await api.get<unknown>(`${path}/history?limit=${limit}`));
      if (!parsed) throw new Error('Unexpected answer from the server');
      data = parsed;
      entries = parsed.entries;
      nextBefore = parsed.nextBefore;
      const it = parsed.item;
      if (it?.ok) ctx.setTitle(`History ${it.repository ?? source}#${itemId}`);
      rerender(head, headSection(h, parsed, render), h('p', { class: 'history-links' }, it?.ok && it.url ? externalLink(it.url, 'Open on GitHub') : null, ' ', itemPanelLink(source, itemId)));
      replaceChildren(pathEl, pathSection(h, parsed, render));
      replaceChildren(notes, historyNotes(h, parsed));
      drawTimeline();
    } catch (err) {
      replaceChildren(head, errorBox(err));
    }
  };

  const loadMore = async (): Promise<void> => {
    if (!nextBefore || loadingMore) return;
    loadingMore = true;
    drawTimeline();
    try {
      const parsed = parseHistory(await api.get<unknown>(`${path}/history?limit=${PAGE_SIZE}&before=${encodeURIComponent(nextBefore)}`));
      if (!parsed) throw new Error('Unexpected answer from the server');
      const known = new Set(entries.map((e) => e.key));
      entries = [...entries, ...parsed.entries.filter((e) => !known.has(e.key))];
      nextBefore = parsed.nextBefore;
    } catch (err) {
      replaceChildren(notes, errorBox(err), data ? historyNotes(h, data) : null);
    } finally {
      loadingMore = false;
    }
    drawTimeline();
  };

  const refresher = createRefresher(load, 3000);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (!isStateChange(msg)) return;
      const runId = messageRunId(msg);
      const p = msg.payload as { itemKey?: unknown; type?: unknown; payload?: { to?: unknown } };
      const known = runId !== null && (data?.runs.some((r) => r.id === runId) || data?.active.runs.some((r) => r.id === runId));
      // A new run may belong to this item (the status event does not name the item): reload, throttled.
      const reserved = msg.type === 'run.event' && p.type === 'run.status' && p.payload?.to === 'reserved';
      if (known || reserved || p.itemKey === `${source}:${itemId}`) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
