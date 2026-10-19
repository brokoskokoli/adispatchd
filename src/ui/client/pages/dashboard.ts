/** Dashboard (Spec §16): scheduler state, limit/usage, pause/resume, drain, cancel all, active runs. */
import { api, qs, seg } from '../api.js';
import { h, replaceChildren, rerender } from '../dom.js';
import { createRefresher } from '../../shared/throttle.js';
import { formatDuration, formatRelative } from '../../shared/format.js';
import { isStateChange, type Page, type PageContext } from '../page.js';
import type { RunSummary, Status } from '../types.js';
import { act, badge, button, confirmDialog, errorBox, isEditing, kv, loading, routeLink, runLink, runOutcomeBadges, section, table, text, time, externalLink } from '../ui.js';

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

export function cancelRunButton(run: { id: string; status: string; active: boolean }, after: () => void): HTMLElement | null {
  if (!run.active || run.status === 'cancelling' || run.status === 'finalizing' || run.status === 'recovery_pending') return null;
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
    { kind: 'danger' },
  );
  return btn;
}

export const dashboardPage = (ctx: PageContext): Page => {
  ctx.setTitle('Dashboard');
  const el = h('div', { class: 'page' }, h('h1', null, 'Dashboard'));
  const body = h('div', { class: 'grid' }, loading());
  el.appendChild(body);

  const load = async (): Promise<void> => {
    if (isEditing(body)) {
      setTimeout(() => refresher.trigger(), 2000);
      return;
    }
    try {
      const [status, active, recent] = await Promise.all([
        api.get<Status>('/api/v1/status'),
        api.get<{ runs: RunSummary[]; total: number }>(`/api/v1/runs${qs({ active: 'true', limit: 100 })}`),
        api.get<{ runs: RunSummary[] }>(`/api/v1/runs${qs({ active: 'false', limit: 10 })}`),
      ]);
      render(status, active.runs, active.total, recent.runs);
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 1000);

  const render = (s: Status, active: RunSummary[], activeTotal: number, recent: RunSummary[]): void => {
    const sch = s.scheduler;
    const controls = h('div', { class: 'actions' });
    if (sch.paused) {
      const b: HTMLButtonElement = button('Resume', () => void act(b, () => api.post('/api/v1/scheduler/resume'), 'Scheduler resumed').then(() => refresher.now()), { kind: 'primary' });
      controls.appendChild(b);
    } else {
      const b: HTMLButtonElement = button('Pause', () => void act(b, () => api.post('/api/v1/scheduler/pause'), 'Automatic starts paused').then(() => refresher.now()), {
        disabled: sch.stopping || sch.draining,
        title: 'Pause automatic starts (manual starts still possible)',
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
          await refresher.now();
        })();
      },
      { kind: 'danger', disabled: sch.draining || sch.stopping },
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
          await refresher.now();
        })();
      },
      { kind: 'danger', disabled: sch.stopping },
    );
    controls.append(drain, cancelAll);

    const notices: HTMLElement[] = [];
    if (sch.draining) notices.push(h('div', { class: 'alert alert-warn' }, 'Drain in progress: no new runs; the process exits when active runs have finished.'));
    if (sch.stopping) notices.push(h('div', { class: 'alert alert-error' }, 'Shutdown in progress.'));
    if (!s.readiness.ready) notices.push(h('div', { class: 'alert alert-info' }, 'Not ready (recovery or startup in progress).'));
    if (!s.server.loopback) {
      notices.push(h('div', { class: 'alert alert-warn' }, `The API is bound to ${s.server.host} without authentication – only expose it behind an authenticating proxy/VPN.`));
    }

    // Global limit override
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
      void act(setLimit, () => api.patch('/api/v1/scheduler/runtime', { maxConcurrent: n }), 'Limit override set').then(() => refresher.now());
    });
    const resetLimit: HTMLButtonElement = button(
      'Reset to YAML',
      () => void act(resetLimit, () => api.patch('/api/v1/scheduler/runtime', { maxConcurrent: null }), 'Limit reset to YAML value').then(() => refresher.now()),
      { disabled: s.limits.override === null },
    );

    const byWf = Object.entries(s.usage.byWorkflow).map(([id, u]) => [routeLink(['workflows', id], id), meter(u.active, u.max)]);

    const counts = s.counts;
    const failedNotifications = counts.notifications.failed ?? 0;

    rerender(
      body,
      notices.length ? h('div', { class: 'span-all' }, notices) : null,
      section(
        'Scheduler',
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
      ),
      section(
        'Capacity',
        kv([
          ['Global', meter(s.usage.activeRuns, s.limits.maxConcurrent)],
          ['Limit', h('span', null, String(s.limits.maxConcurrent), s.limits.override !== null ? badge('override', 'info', `YAML value: ${s.limits.configuredMaxConcurrent}`) : ' (YAML)')],
          ['Override', h('span', { class: 'inline-form' }, limitInput, setLimit, resetLimit)],
          ['Recovery pending', s.usage.recoveryPending > 0 ? badge(String(s.usage.recoveryPending), 'warn') : '0'],
        ]),
        h('p', { class: 'hint' }, 'Runtime overrides are not persistent: they are lost on restart and reset by a configuration reload.'),
        byWf.length ? table(['Workflow', 'Active / max'], byWf) : null,
      ),
      section(
        'Attention',
        kv([
          ['Retry blocks', counts.activeBlocks > 0 ? routeLink(['blocked'], badge(String(counts.activeBlocks), 'warn')) : '0'],
          ['Failed actions', counts.failedActions > 0 ? routeLink(['actions'], badge(String(counts.failedActions), 'error')) : '0'],
          ['Failed notifications', failedNotifications > 0 ? routeLink(['config'], badge(String(failedNotifications), 'error'), { tab: 'notifications' }) : '0'],
        ]),
      ),
      h(
        'section',
        { class: 'card span-all' },
        h('h2', null, `Active runs (${activeTotal})`),
        table(
          ['Run', 'Workflow', 'Item', 'State', 'Started', 'Last status message', ''],
          active.map((r) => [
            runLink(r.id),
            r.workflowName ?? r.workflowId,
            r.sourceUrl ? externalLink(r.sourceUrl, r.sourceItemKey ?? r.sourceUrl) : text(r.sourceItemKey ?? r.triggerType),
            runOutcomeBadges(r),
            r.startedAt ? h('span', { title: r.startedAt }, formatRelative(r.startedAt, Date.now())) : text(null),
            text(r.statusMessage),
            cancelRunButton(r, () => refresher.trigger()),
          ]),
          { empty: 'No active runs.' },
        ),
        activeTotal > active.length ? h('p', null, routeLink(['runs'], `Show all ${activeTotal} active runs`, { scope: 'active' })) : null,
      ),
      h(
        'section',
        { class: 'card span-all' },
        h('h2', null, 'Recently finished'),
        table(
          ['Run', 'Workflow', 'Outcome', 'Finished', 'Duration', 'Message'],
          recent.map((r) => [
            runLink(r.id),
            r.workflowName ?? r.workflowId,
            runOutcomeBadges(r),
            time(r.finishedAt),
            formatDuration(r.durationMs),
            text(r.resultMessage ?? r.finalReason),
          ]),
          { empty: 'No finished runs yet.' },
        ),
        h('p', null, routeLink(['runs'], 'All runs →', { scope: 'history' })),
      ),
    );
  };

  void load();
  return {
    el,
    onLive: (msg) => {
      if (isStateChange(msg)) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
