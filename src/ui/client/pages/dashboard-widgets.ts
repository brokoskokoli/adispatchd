/**
 * Dashboard widgets (WI-32): the former fixed areas of the dashboard
 * (Spec §16) as mountable widgets. Every widget renders into its own card,
 * shows its errors only there and releases its subscriptions on dispose
 * (widgets in inactive tabs are not mounted at all).
 */
import { currentAuth } from '../auth.js';
import { api, seg } from '../api.js';
import { h, replaceChildren, rerender, svg } from '../dom.js';
import { formatDuration, formatRelative } from '../../shared/format.js';
import { buildHash } from '../../shared/route.js';
import type { LiveMessage } from '../../shared/sse.js';
import { createStripFeed, renderResourceStrip } from '../../shared/resource-strip.js';
import type { MetricsResponse } from '../../shared/metrics.js';
import { narrowForWidget, widgetTitle, type DashboardWidget } from '../../shared/dashboard-layout.js';
import type { RunSummary, Status, ViewItems } from '../types.js';
import {
  act,
  badge,
  button,
  confirmDialog,
  errorBox,
  externalLink,
  isEditing,
  kv,
  loading,
  routeLink,
  runLink,
  runOutcomeBadges,
  table,
  text,
  time,
} from '../ui.js';
import { createViewRenderer } from '../view-render.js';
import { createInfoSection } from './dashboard-info.js';
import { historyLinkForKey } from './item.js';
import type { DashboardFeeds, FeedState } from './dashboard-feeds.js';
import { serverSection } from './server.js';

/** A mounted widget (or layout). */
export interface Mounted {
  el: HTMLElement;
  onLive?(msg: LiveMessage): void;
  onResync?(): void;
  /** The selected tabs in the URL changed (back button, link). */
  onRoute?(): void;
  dispose?(): void;
}

export function schedulerStateBadge(s: Status['scheduler']): HTMLElement {
  const tone = s.state === 'running' ? 'ok' : s.state === 'paused' ? 'warn' : s.state === 'recovering' ? 'info' : 'error';
  return badge(s.state, tone, 'Scheduler state');
}

function meter(active: number, max: number): HTMLElement {
  const pct = max > 0 ? Math.min(100, Math.round((active / max) * 100)) : 0;
  return h(
    'span',
    { class: 'meter-wrap' },
    h('meter', { min: 0, max: Math.max(1, max), value: active, high: Math.max(1, max) - 0.5, title: `${active}/${max} (${pct}%)` }),
    ` ${active} / ${max}`,
  );
}

export function cancelRunButton(run: { id: string; status: string; active: boolean; triggerType?: string }, after: () => void): HTMLElement | null {
  if (!run.active || run.status === 'cancelling' || run.status === 'finalizing' || run.status === 'recovery_pending') return null;
  // Lifecycle runs of removed blocks (WI-30) only run on_retry_unblock and cannot be cancelled.
  if (run.triggerType === 'unblock') return null;
  const btn: HTMLButtonElement = button(
    'Cancel',
    () => {
      void (async () => {
        const r = await confirmDialog({
          title: 'Cancel run?',
          message: h('p', null, 'The run ', h('code', null, run.id), ' will be cancelled (SIGTERM, then SIGKILL after the grace period). Its on_cancel hook (or on_error if on_cancel is not defined) runs afterwards.'),
          confirmLabel: 'Cancel run',
          danger: true,
          input: { label: 'Reason (optional)', placeholder: 'cancelled via UI' },
        });
        if (!r.ok) return;
        await act(btn, () => api.post(`/api/v1/runs/${seg(run.id)}/cancel`, r.value ? { reason: r.value } : {}), 'Cancel requested');
        after();
      })();
    },
    { kind: 'danger', requires: 'operator' },
  );
  return btn;
}

/** Notices shown above every layout (drain, shutdown, not ready, unprotected binding). */
export function statusNotices(s: Status): HTMLElement[] {
  const sch = s.scheduler;
  const notices: HTMLElement[] = [];
  if (sch.draining) notices.push(h('div', { class: 'alert alert-warn' }, 'Drain in progress: no new runs; the process exits when active runs have finished.'));
  if (sch.stopping) notices.push(h('div', { class: 'alert alert-error' }, 'Shutdown in progress.'));
  if (!s.readiness.ready) notices.push(h('div', { class: 'alert alert-info' }, 'Not ready (recovery or startup in progress).'));
  if (!s.server.loopback && currentAuth().mode === 'none') {
    notices.push(h('div', { class: 'alert alert-warn' }, `The API is bound to ${s.server.host} without authentication – only expose it behind an authenticating proxy/VPN.`));
  }
  return notices;
}

/** Card with a heading and a body that widgets re-render. */
function card(title: string | null, extraClass = ''): { el: HTMLElement; heading: HTMLElement; body: HTMLElement } {
  const heading = h('h2', null, title ?? '');
  const body = h('div', { class: 'widget-body' }, loading());
  const el = h('section', { class: `card widget${extraClass ? ` ${extraClass}` : ''}` }, title !== null ? heading : null, body);
  return { el, heading, body };
}

/**
 * A card following a feed: `render` runs for every update; while an input of
 * the card is being edited, updates wait (retried after 2 s), as in 0.7.0.
 */
function feedCard<T>(
  title: string | null,
  subscribe: (listener: (state: FeedState<T>) => void) => () => void,
  render: (data: T, body: HTMLElement) => void,
  extraClass = '',
): Mounted {
  const c = card(title, extraClass);
  let latest: FeedState<T> = { kind: 'loading' };
  let retry: ReturnType<typeof setTimeout> | null = null;
  const draw = (): void => {
    if (isEditing(c.body)) {
      if (retry === null) {
        retry = setTimeout(() => {
          retry = null;
          draw();
        }, 2000);
      }
      return;
    }
    if (latest.kind === 'loading') replaceChildren(c.body, loading());
    else if (latest.kind === 'error') replaceChildren(c.body, errorBox(latest.error));
    else render(latest.data, c.body);
  };
  const unsubscribe = subscribe((state) => {
    latest = state;
    draw();
  });
  return {
    el: c.el,
    dispose: () => {
      unsubscribe();
      if (retry !== null) clearTimeout(retry);
    },
  };
}

function schedulerWidget(feeds: DashboardFeeds, title: string | null): Mounted {
  return feedCard<Status>(title, (l) => feeds.status(l), (s, body) => {
    const sch = s.scheduler;
    const refresh = (): Promise<void> => feeds.refreshNow();
    const controls = h('div', { class: 'actions' });
    if (sch.paused) {
      const b: HTMLButtonElement = button('Resume', () => void act(b, () => api.post('/api/v1/scheduler/resume'), 'Scheduler resumed').then(refresh), { kind: 'primary', requires: 'operator' });
      controls.appendChild(b);
    } else {
      const b: HTMLButtonElement = button('Pause', () => void act(b, () => api.post('/api/v1/scheduler/pause'), 'Automatic starts paused').then(refresh), {
        disabled: sch.stopping || sch.draining,
        title: 'Pause automatic starts (manual starts still possible)',
        requires: 'operator',
      });
      controls.appendChild(b);
    }
    const drain: HTMLButtonElement = button(
      'Drain',
      () => {
        void (async () => {
          const r = await confirmDialog({
            title: 'Drain and stop the orchestrator?',
            message: h(
              'div',
              null,
              h('p', null, 'No new runs are started. Active runs (', String(s.usage.activeRuns), ') finish normally, then the orchestrator process exits.'),
              h('p', null, 'The UI is unavailable afterwards until the service is started again.'),
            ),
            confirmLabel: 'Start drain',
            danger: true,
          });
          if (r.ok) await act(drain, () => api.post('/api/v1/shutdown/drain'), 'Drain started');
          await refresh();
        })();
      },
      { kind: 'danger', disabled: sch.draining || sch.stopping, requires: 'operator' },
    );
    const cancelAll: HTMLButtonElement = button(
      'Cancel All',
      () => {
        void (async () => {
          const r = await confirmDialog({
            title: 'Cancel all runs and stop?',
            message: h(
              'div',
              null,
              h('p', null, 'All ', String(s.usage.activeRuns), ' active run(s) are cancelled (on_cancel hooks run, or on_error where on_cancel is not defined), then the orchestrator process exits.'),
              h('p', null, 'This cannot be undone.'),
            ),
            confirmLabel: 'Cancel all and stop',
            danger: true,
            input: { label: 'Reason (optional)', placeholder: 'cancel all via UI' },
          });
          if (r.ok) await act(cancelAll, () => api.post('/api/v1/shutdown/cancel-all', r.value ? { reason: r.value } : {}), 'Cancel all started');
          await refresh();
        })();
      },
      { kind: 'danger', disabled: sch.stopping, requires: 'operator' },
    );
    controls.append(drain, cancelAll);
    rerender(
      body,
      kv([
        ['State', schedulerStateBadge(sch)],
        ['Ready', s.readiness.ready ? badge('ready', 'ok') : badge('not ready', 'warn')],
        ['Polling interval', formatDuration(sch.pollingIntervalMs)],
        [
          'Last planning step',
          sch.lastPlanningStep
            ? h('span', null, time(sch.lastPlanningStep.finishedAt), sch.lastPlanningStep.skipped ? ` (skipped: ${sch.lastPlanningStep.skipped})` : ` – ${sch.lastPlanningStep.startedRunIds.length} run(s) started`)
            : text(null),
        ],
        ['Version', `${s.version}, up since ${formatRelative(s.startedAt, Date.now()).replace(' ago', '')}`],
      ]),
      controls,
    );
  });
}

function capacityWidget(feeds: DashboardFeeds, title: string | null): Mounted {
  return feedCard<Status>(title, (l) => feeds.status(l), (s, body) => {
    const refresh = (): Promise<void> => feeds.refreshNow();
    const limitInput = h('input', { type: 'number', min: 1, step: 1, class: 'input input-narrow', value: s.limits.override ?? '', placeholder: String(s.limits.configuredMaxConcurrent), 'aria-label': 'Global max concurrent override' }) as HTMLInputElement;
    const setLimit: HTMLButtonElement = button('Set', () => {
      const v = limitInput.value.trim();
      const n = Number(v);
      if (v === '' || !Number.isInteger(n) || n < 1) {
        limitInput.setCustomValidity('Integer ≥ 1');
        limitInput.reportValidity();
        return;
      }
      limitInput.setCustomValidity('');
      void act(setLimit, () => api.patch('/api/v1/scheduler/runtime', { maxConcurrent: n }), 'Limit override set').then(refresh);
    }, { requires: 'operator' });
    const resetLimit: HTMLButtonElement = button(
      'Reset to YAML',
      () => void act(resetLimit, () => api.patch('/api/v1/scheduler/runtime', { maxConcurrent: null }), 'Limit reset to YAML value').then(refresh),
      { disabled: s.limits.override === null, requires: 'operator' },
    );
    const byWf = Object.entries(s.usage.byWorkflow).map(([id, u]) => [routeLink(['workflows', id], id), meter(u.active, u.max)]);
    rerender(
      body,
      kv([
        ['Global', meter(s.usage.activeRuns, s.limits.maxConcurrent)],
        ['Limit', h('span', null, String(s.limits.maxConcurrent), s.limits.override !== null ? badge('override', 'info', `YAML value: ${s.limits.configuredMaxConcurrent}`) : ' (YAML)')],
        ['Override', h('span', { class: 'inline-form' }, limitInput, setLimit, resetLimit)],
        ['Recovery pending', s.usage.recoveryPending > 0 ? badge(String(s.usage.recoveryPending), 'warn') : '0'],
      ]),
      h('p', { class: 'hint' }, 'Runtime overrides are not persistent: they are lost on restart and reset by a configuration reload.'),
      byWf.length ? table(['Workflow', 'Active / max'], byWf) : null,
    );
  });
}

function attentionWidget(feeds: DashboardFeeds, title: string | null): Mounted {
  return feedCard<Status>(title, (l) => feeds.status(l), (s, body) => {
    const counts = s.counts;
    const failedNotifications = counts.notifications.failed ?? 0;
    rerender(
      body,
      kv([
        ['Retry blocks', counts.activeBlocks > 0 ? routeLink(['blocked'], badge(String(counts.activeBlocks), 'warn')) : '0'],
        ['Failed actions', counts.failedActions > 0 ? routeLink(['actions'], badge(String(counts.failedActions), 'error')) : '0'],
        ['Failed notifications', failedNotifications > 0 ? routeLink(['config'], badge(String(failedNotifications), 'error'), { tab: 'notifications' }) : '0'],
      ]),
    );
  });
}

/** Item of a run: link to the item (or its key, else the trigger) and to its history (WI-34, as on the runs page). */
function itemCell(r: RunSummary): HTMLElement {
  return h(
    'span',
    null,
    r.sourceUrl ? externalLink(r.sourceUrl, r.sourceItemKey ?? r.sourceUrl) : text(r.sourceItemKey ?? r.triggerType),
    r.sourceItemKey ? [' ', historyLinkForKey(r.sourceItemKey, 'history')] : null,
  );
}

function runsWidget(feeds: DashboardFeeds, w: Extract<DashboardWidget, { widget: 'active_runs' | 'recent_runs' }>): Mounted {
  const active = w.widget === 'active_runs';
  const base = w.title ?? (active ? 'Active runs' : 'Recently finished');
  const filtered = w.workflows !== null;
  let heading: HTMLElement | null = null;
  const m = feedCard<{ runs: RunSummary[]; total: number }>(
    base,
    (l) => feeds.runs({ active, limit: w.limit, workflows: w.workflows }, l),
    (page, body) => {
      if (active && heading) heading.textContent = `${base} (${page.total})`;
      const scope = active ? 'active' : 'history';
      // The runs page filters by one workflow; with a list the link opens all runs of the scope.
      const allQuery: Record<string, string> = { scope, ...(w.workflows?.length === 1 ? { workflow: w.workflows[0] as string } : {}) };
      if (active) {
        rerender(
          body,
          table(
            ['Run', 'Workflow', 'Item', 'State', 'Started', 'Last status message', ''],
            page.runs.map((r) => [
              runLink(r.id),
              r.workflowName ?? r.workflowId,
              itemCell(r),
              runOutcomeBadges(r),
              r.startedAt ? h('span', { title: r.startedAt }, formatRelative(r.startedAt, Date.now())) : text(null),
              text(r.statusMessage),
              cancelRunButton(r, () => feeds.stateChanged()),
            ]),
            { empty: filtered ? 'No active runs of these workflows.' : 'No active runs.' },
          ),
          page.total > page.runs.length ? h('p', null, routeLink(['runs'], `Show all ${page.total} active runs`, allQuery)) : null,
        );
      } else {
        rerender(
          body,
          table(
            ['Run', 'Workflow', 'Item', 'Outcome', 'Finished', 'Duration', 'Message'],
            page.runs.map((r) => [runLink(r.id), r.workflowName ?? r.workflowId, itemCell(r), runOutcomeBadges(r), time(r.finishedAt), formatDuration(r.durationMs), text(r.resultMessage ?? r.finalReason)]),
            { empty: 'No finished runs yet.' },
          ),
          h('p', null, routeLink(['runs'], 'All runs →', allQuery)),
        );
      }
    },
    'span-all',
  );
  heading = m.el.querySelector('h2');
  return m;
}

function resourcesWidget(): Mounted {
  // WI-29: compact strip (own data with few points, live via `system.metrics`); click → "Resources" tab.
  const el = h('div', { class: 'strip-slot widget' }, renderResourceStrip(h, svg, { kind: 'loading' }));
  const feed = createStripFeed({
    fetch: (path) => api.get<MetricsResponse>(path),
    onChange: (state) => replaceChildren(el, renderResourceStrip(h, svg, state)),
  });
  void feed.load();
  return { el, onLive: (msg) => feed.onLive(msg), onResync: () => feed.onResync(), dispose: () => feed.dispose() };
}

function resourcesFullWidget(title: string | null): Mounted {
  const server = serverSection(title !== null ? { title } : {});
  server.el.classList.add('widget');
  return { el: server.el, onLive: (msg) => server.onLive(msg), onResync: () => server.onResync(), dispose: () => server.dispose() };
}

function infoWidget(w: Extract<DashboardWidget, { widget: 'info' }>): Mounted {
  const info = createInfoSection({ ids: w.ids, ...(w.title !== null ? { title: w.title } : {}) });
  info.el.classList.add('widget');
  void info.load();
  return { el: info.el, onLive: (msg) => info.onLive(msg), onResync: () => void info.load() };
}

function viewWidget(feeds: DashboardFeeds, w: Extract<DashboardWidget, { widget: 'view' }>): Mounted {
  const href = buildHash(['views', w.view]);
  const titleText = h('span', null, w.title ?? w.view);
  const meta = h('span', { class: 'muted widget-meta' });
  const refreshBtn: HTMLButtonElement = button('Refresh', () => {
    refreshBtn.disabled = true;
    void feeds.refreshView(w.view).finally(() => {
      refreshBtn.disabled = false;
    });
  }, { title: 'Fetch the view now (bypasses the 30 s cache)' });
  refreshBtn.classList.add('btn-small');
  const heading = h('h2', { class: 'widget-head' }, titleText);
  const tools = h('div', { class: 'widget-tools' }, meta, refreshBtn, h('a', { href, class: 'widget-link' }, 'Open view →'));
  const body = h('div', { class: 'widget-body' }, loading());
  const el = h('section', { class: 'card widget view-widget', 'aria-label': w.title ?? w.view }, h('div', { class: 'widget-header' }, heading, tools), body);
  const renderer = createViewRenderer({ headingTag: 'h3', jumpLinks: false, moreHref: href });
  const unsubscribe = feeds.view(w.view, { sections: w.sections, limit: w.limit, refreshMs: w.refreshMs }, (state) => {
    if (state.kind === 'loading') return replaceChildren(body, loading());
    if (state.kind === 'error') return replaceChildren(body, errorBox(state.error));
    const data = narrowView(state.data, w);
    if (w.title === null) titleText.textContent = data.view.title;
    el.setAttribute('aria-label', titleText.textContent ?? w.view);
    meta.textContent = `fetched ${new Date(data.fetchedAt).toLocaleTimeString()}${data.cached ? ' (cached)' : ''}`;
    replaceChildren(body, ...renderer.render(data));
  });
  return { el, dispose: unsubscribe };
}

function narrowView(data: ViewItems, w: Extract<DashboardWidget, { widget: 'view' }>): ViewItems {
  return narrowForWidget(data, { sections: w.sections, limit: w.limit });
}

/** Mount a non-container widget (`tabs` is mounted by the layout, see dashboard.ts). */
export function mountWidget(feeds: DashboardFeeds, w: Exclude<DashboardWidget, { widget: 'tabs' }>): Mounted {
  const title = widgetTitle(w);
  switch (w.widget) {
    case 'resources':
      return resourcesWidget();
    case 'resources_full':
      return resourcesFullWidget(w.title);
    case 'info':
      return infoWidget(w);
    case 'scheduler':
      return schedulerWidget(feeds, title);
    case 'capacity':
      return capacityWidget(feeds, title);
    case 'attention':
      return attentionWidget(feeds, title);
    case 'active_runs':
    case 'recent_runs':
      return runsWidget(feeds, w);
    case 'view':
      return viewWidget(feeds, w);
  }
}
