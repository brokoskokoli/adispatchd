/** Runs list (Spec §16): active and historical runs with paging and simple filters. */
import { api, qs } from '../api.js';
import { h, replaceChildren } from '../dom.js';
import { buildHash } from '../../shared/route.js';
import { createRefresher } from '../../shared/throttle.js';
import { formatDuration } from '../../shared/format.js';
import { isStateChange, type Page, type PageContext } from '../page.js';
import type { RunSummary, Workflow } from '../types.js';
import { badge, errorBox, externalLink, loading, runLink, runOutcomeBadges, table, text, time } from '../ui.js';
import { cancelRunButton } from './dashboard-widgets.js';

const PAGE_SIZE = 50;

/** Trigger column: lifecycle runs of removed blocks (WI-30) as a badge. */
export function triggerLabel(trigger: string): HTMLElement | string {
  return trigger === 'unblock' ? badge('unblock', 'info', 'Lifecycle run of a removed retry block (on_retry_unblock)') : trigger;
}

export const runsPage = (ctx: PageContext): Page => {
  ctx.setTitle('Runs');
  const q = ctx.route.query;
  const scope = q.scope === 'active' || q.scope === 'history' ? q.scope : 'all';
  const workflow = q.workflow ?? '';
  const trigger = q.trigger ?? '';
  const result = q.result === 'success' || q.result === 'failure' ? q.result : '';
  const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);

  const go = (patch: Record<string, string | number>): void => {
    ctx.navigate(buildHash(['runs'], { scope, workflow, trigger, result, offset: 0, ...patch }));
  };

  const tabs = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Run scope' },
    (['all', 'active', 'history'] as const).map((s) =>
      h('a', { href: buildHash(['runs'], { scope: s, workflow, trigger, result }), class: s === scope ? 'active' : null, 'aria-current': s === scope ? 'page' : null }, s === 'all' ? 'All' : s === 'active' ? 'Active' : 'History'),
    ),
  );
  const wfSelect = h('select', { class: 'input', 'aria-label': 'Workflow', on: { change: () => go({ workflow: wfSelect.value }) } }, h('option', { value: '' }, 'All workflows')) as HTMLSelectElement;
  const trSelect = h(
    'select',
    { class: 'input', 'aria-label': 'Trigger', on: { change: () => go({ trigger: trSelect.value }) } },
    [['', 'All triggers'], ['source', 'source'], ['schedule', 'schedule'], ['manual', 'manual'], ['unblock', 'unblock (lifecycle)']].map(([v, l]) => h('option', { value: v!, selected: v === trigger }, l!)),
  ) as HTMLSelectElement;
  const resSelect = h(
    'select',
    { class: 'input', 'aria-label': 'Business result', on: { change: () => go({ result: resSelect.value }) } },
    [['', 'Any result'], ['success', 'result: success'], ['failure', 'result: failure (business)']].map(([v, l]) => h('option', { value: v!, selected: v === result }, l!)),
  ) as HTMLSelectElement;
  const filters = h('div', { class: 'filters' }, wfSelect, trSelect, resSelect);
  const body = h('div', null, loading());
  const el = h('div', { class: 'page' }, h('h1', null, 'Runs'), tabs, filters, body);

  void api
    .get<{ workflows: Workflow[] }>('/api/v1/workflows')
    .then((res) => {
      for (const wf of res.workflows) wfSelect.appendChild(h('option', { value: wf.id, selected: wf.id === workflow }, `${wf.name} (${wf.id})`));
      if (workflow && !res.workflows.some((w) => w.id === workflow)) wfSelect.appendChild(h('option', { value: workflow, selected: true }, workflow));
    })
    .catch(() => undefined);

  const load = async (): Promise<void> => {
    try {
      const res = await api.get<{ runs: RunSummary[]; total: number; limit: number; offset: number }>(
        `/api/v1/runs${qs({ active: scope === 'active' ? 'true' : scope === 'history' ? 'false' : null, workflow, trigger, result, limit: PAGE_SIZE, offset })}`,
      );
      const rows = res.runs.map((r) => [
        runLink(r.id),
        h('span', null, r.workflowName ?? r.workflowId, h('br'), h('small', { class: 'muted' }, r.workflowId)),
        triggerLabel(r.triggerType),
        r.sourceUrl ? externalLink(r.sourceUrl, r.sourceItemKey ?? undefined) : text(r.sourceItemKey ?? (r.scheduledFor ? `slot ${r.scheduledFor}` : null)),
        runOutcomeBadges(r),
        time(r.startedAt ?? r.createdAt),
        formatDuration(r.durationMs),
        text(r.active ? r.statusMessage : (r.resultMessage ?? r.finalReason)),
        cancelRunButton(r, () => refresher.trigger()),
      ]);
      const from = res.total === 0 ? 0 : res.offset + 1;
      const to = res.offset + res.runs.length;
      const pager = h(
        'div',
        { class: 'pager' },
        h('span', null, `${from}–${to} of ${res.total}`),
        offset > 0 ? h('a', { href: buildHash(['runs'], { scope, workflow, trigger, result, offset: Math.max(0, offset - PAGE_SIZE) }) }, '← Newer') : null,
        to < res.total ? h('a', { href: buildHash(['runs'], { scope, workflow, trigger, result, offset: offset + PAGE_SIZE }) }, 'Older →') : null,
      );
      replaceChildren(body, table(['Run', 'Workflow', 'Trigger', 'Item', 'Outcome', 'Started', 'Duration', 'Message', ''], rows, { empty: 'No runs match.' }), pager);
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 1500);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (isStateChange(msg) && (msg.type !== 'run.event' || msg.payload.type === 'run.status' || msg.payload.type === 'status')) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
