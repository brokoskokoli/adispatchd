/**
 * Workflows (Spec §16): status, priority, limits, usage; detail with runtime
 * overrides, manual start (source item + parameter form from the schema) and
 * dry-run (`unknown / not evaluated` for unexecuted checks).
 */
import { ApiError, api, qs, seg } from '../api.js';
import { h, replaceChildren, rerender } from '../dom.js';
import { createRefresher } from '../../shared/throttle.js';
import { buildRuntimeBody, buildStartBody, defaultOptionHint, filterOptions, OPTION_SEARCH_THRESHOLD, optionsSourceText, type ParameterDef, type ParameterOptionView, type ParameterOptionsView } from '../../shared/params.js';
import { checkValueLabel, decisionTone, formatBytes, formatDuration, triggerSummary, truncate } from '../../shared/format.js';
import { checkCountsText, checkCountsTone, checkTitle, conditionStatusInfo } from '../../shared/checks.js';
import { buildHash } from '../../shared/route.js';
import { isStateChange, type Page, type PageContext } from '../page.js';
import type { CheckCountsView, CheckDiagnosis, DryRunResult, FilterTrace, LastConditionCheck, RunSummary, SecretInfo, SourcePoll, Workflow, WorkflowConditions } from '../types.js';
import { act, badge, button, errorBox, externalLink, isEditing, jsonBlock, kv, loading, routeLink, runLink, runOutcomeBadges, section, table, text, time, toast } from '../ui.js';
import { triggerLabel } from './runs.js';
import { denied } from '../auth.js';

function timeoutText(t: unknown): string {
  const o = (t ?? {}) as { maxDurationMs?: unknown; idleTimeoutMs?: unknown };
  const fmt = (v: unknown): string => (typeof v === 'number' ? formatDuration(v) : 'none');
  return `max ${fmt(o.maxDurationMs)}, idle ${fmt(o.idleTimeoutMs)}`;
}

/**
 * Start-form control of an enum parameter with `options_from` or
 * `allow_custom` (WI-31): loads the options when the form opens; a select
 * (with search above {@link OPTION_SEARCH_THRESHOLD} options) or – with
 * `allow_custom` – a text input with suggestions (`datalist`); "Reload"
 * bypasses the cache; loading and error states as text (labels as text only).
 */
function dynamicEnumField(
  workflowId: string,
  name: string,
  def: ParameterDef,
  dflt: string | null,
): { control: HTMLInputElement | HTMLSelectElement; box: HTMLElement } {
  const custom = def.allowCustom === true;
  const listId = `start-options-${name}`;
  const datalist = h('datalist', { id: listId });
  const control = custom
    ? (h('input', { class: 'input', type: 'text', list: listId, placeholder: dflt ?? '', maxlength: 200, 'aria-label': name }) as HTMLInputElement)
    : (h('select', { class: 'input', 'aria-label': name }) as HTMLSelectElement);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search options…', hidden: true, 'aria-label': `Search options of ${name}` }) as HTMLInputElement;
  const status = h('small', { class: 'muted', 'aria-live': 'polite' }, 'Loading options…');
  let options: ParameterOptionView[] = [];
  const optionText = (o: ParameterOptionView): string => (o.label === o.value ? o.value : `${o.label} (${o.value})`);
  const render = (): void => {
    if (custom) {
      replaceChildren(datalist, options.map((o) => h('option', { value: o.value, label: o.label === o.value ? null : o.label })));
      return;
    }
    const select = control as HTMLSelectElement;
    const current = select.value;
    const shown = filterOptions(options, search.value, current);
    replaceChildren(
      select,
      h('option', { value: '' }, dflt !== null ? `default (${dflt})` : def.required ? '— choose —' : '(none)'),
      shown.map((o) => h('option', { value: o.value }, optionText(o))),
    );
    select.value = shown.some((o) => o.value === current) ? current : '';
  };
  search.addEventListener('input', render);
  const setStatus = (cls: string, message: string): void => {
    status.className = cls;
    status.textContent = message;
  };
  const load = async (refresh: boolean): Promise<void> => {
    reload.disabled = true;
    setStatus('muted', 'Loading options…');
    try {
      const res = await api.get<ParameterOptionsView>(`/api/v1/workflows/${seg(workflowId)}/parameters/${seg(name)}/options${qs({ refresh: refresh ? 'true' : null })}`);
      options = res.options;
      search.hidden = custom || options.length <= OPTION_SEARCH_THRESHOLD;
      render();
      if (res.error) {
        setStatus('error-text', `Options unavailable: ${res.error.message}${custom ? ' – you can still enter a value.' : ''}`);
        return;
      }
      const hint = defaultOptionHint(def, options);
      if (hint) {
        setStatus('error-text', hint);
        return;
      }
      const from = optionsSourceText(def);
      setStatus('muted', `${options.length} option${options.length === 1 ? '' : 's'}${from ? ` · ${from}` : ''}${res.cached ? ' · cached' : ''}${custom ? ' · other values allowed' : ''}`);
    } catch (err) {
      setStatus('error-text', `Options could not be loaded: ${err instanceof ApiError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err)}`);
    } finally {
      reload.disabled = false;
    }
  };
  const reload = button('Reload', () => void load(true), { title: 'Fetch the options again (bypasses the cache)' });
  // Options of a script are only fetched for roles that may start runs (the API answers 403 otherwise).
  const scriptDenied = def.optionsFrom?.type === 'command' ? denied('operator') : null;
  if (scriptDenied) {
    reload.disabled = true;
    render();
    setStatus('muted', `Options come from a script and are only loaded for users who may start runs (${scriptDenied}).`);
  } else void load(false);
  return {
    control,
    box: h('div', { class: 'option-field' }, search, h('div', { class: 'option-row' }, control, reload), custom ? datalist : null, status),
  };
}

function triggerText(wf: Workflow): string {
  return triggerSummary(wf.trigger);
}

/** One line per source with a problem (WI-20: the other sources were still planned). */
function sourceErrors(sources: readonly SourcePoll[] | undefined, fallback: string | null): HTMLElement | null {
  const failed = (sources ?? []).filter((x) => x.error);
  if (failed.length === 0) return fallback ? h('div', { class: 'error-text' }, fallback) : null;
  return h('div', null, failed.map((x) => h('div', { class: 'error-text' }, `${x.sourceId}: ${x.error ?? ''}`)));
}

function overridden(wf: Workflow, key: 'enabled' | 'priority' | 'maxConcurrent'): HTMLElement | null {
  if (wf.overrides[key] === undefined) return null;
  return badge('override', 'info', `YAML value: ${String(wf.configured[key])} (runtime overrides are lost on restart/reload)`);
}

function enabledBadge(wf: Workflow): HTMLElement {
  return h('span', null, wf.enabled ? badge('active', 'ok') : badge('inactive', 'muted'), overridden(wf, 'enabled'));
}

// ---------------------------------------------------------------------------
// Conditions (WI-24)

/** Compact badges for the workflow list: one per workflow condition (by last status), item conditions and shell filter as summary. */
function conditionBadges(c: WorkflowConditions | undefined): HTMLElement {
  if (!c || (c.workflow.length === 0 && c.item.length === 0 && !c.shellFilter)) return text(null);
  const badges: HTMLElement[] = c.workflow.map((cond) => {
    const s = conditionStatusInfo(cond.last?.status);
    return badge(truncate(cond.label, 24), s.tone, `Workflow condition ${cond.index + 1}: ${cond.label} – ${s.label}`);
  });
  if (c.shellFilter) {
    const last = c.shellFilter.last;
    badges.push(badge('shell filter', last ? checkCountsTone(last) : 'muted', `Shell filter ${c.shellFilter.label}: ${last ? checkCountsText(last) : 'not checked yet'}`));
  }
  if (c.item.length > 0) {
    const tone = c.item.reduce<'ok' | 'warn' | 'error' | 'muted'>((worst, i) => {
      const t = i.last ? checkCountsTone(i.last) : 'muted';
      const rank = { error: 3, warn: 2, ok: 1, muted: 0, info: 0 } as const;
      return rank[t] > rank[worst] ? (t as 'ok' | 'warn' | 'error') : worst;
    }, 'muted');
    badges.push(badge(`${c.item.length} item`, tone, c.item.map((i) => `Item condition ${i.index + 1}: ${i.label} – ${i.last ? checkCountsText(i.last) : 'not checked yet'}`).join('\n')));
  }
  return h('span', { class: 'cond-badges' }, badges);
}

function lastCheckDetail(last: LastConditionCheck | null): HTMLElement {
  if (!last) return h('span', { class: 'muted' }, 'not evaluated since start/reload');
  return h(
    'span',
    { class: 'cond-detail' },
    time(last.checkedAt),
    last.durationMs !== null ? ` · ${formatDuration(last.durationMs)}` : null,
    last.cached ? h('span', { title: last.ranAt ? `cached result from ${last.ranAt}` : 'cached result' }, ' · from cache') : null,
    last.exitCode !== null ? ` · exit ${last.exitCode}` : null,
    last.status === 'skipped' ? h('span', { class: 'muted' }, ' · an earlier condition decided') : null,
    last.error ? h('div', { class: 'error-text' }, last.error) : null,
    last.stderr ? h('div', null, h('span', { class: 'muted' }, 'stderr: '), h('code', { class: 'wrap' }, last.stderr)) : null,
  );
}

function countsCell(last: CheckCountsView | null): HTMLElement {
  if (!last) return h('span', { class: 'muted' }, 'not checked since start/reload');
  return h('span', { class: 'cond-detail' }, badge(checkCountsText(last), checkCountsTone(last)), ' ', h('small', { class: 'muted' }, 'last planning step '), time(last.at));
}

function timing(timeoutMs: number, cacheMs?: number | null): string {
  return `timeout ${formatDuration(timeoutMs)}${cacheMs ? ` · cache ${formatDuration(cacheMs)}` : ''}`;
}

function nameCell(c: { name: string | null; label: string; command: string; displayCommand?: string; args?: string[] }): HTMLElement {
  // Command relative to the config dir when inside it; the absolute command in the tooltip.
  const shown = [c.displayCommand ?? c.command, ...(c.args ?? [])].join(' ');
  return h(
    'span',
    null,
    c.name ? h('strong', null, c.name) : null,
    c.name ? h('br') : null,
    h('code', { class: 'wrap', title: [c.command, ...(c.args ?? [])].join(' ') }, c.name ? shown : c.label),
  );
}

/** Detail table of all shell checks with their last status. */
function conditionsTable(c: WorkflowConditions): HTMLElement {
  const rows: Array<HTMLElement[]> = [];
  for (const cond of c.workflow) {
    const s = conditionStatusInfo(cond.last?.status);
    rows.push([h('span', null, `Workflow #${cond.index + 1}`), nameCell(cond), h('span', null, timing(cond.timeoutMs, cond.cacheMs)), badge(s.label, s.tone), lastCheckDetail(cond.last)]);
  }
  if (c.shellFilter) {
    const last = c.shellFilter.last;
    rows.push([h('span', null, 'Shell filter'), nameCell(c.shellFilter), h('span', null, timing(c.shellFilter.timeoutMs)), last ? badge(last.items ? 'checked' : 'idle', checkCountsTone(last)) : badge('never checked', 'muted'), countsCell(last)]);
  }
  for (const cond of c.item) {
    const last = cond.last;
    rows.push([h('span', null, `Item #${cond.index + 1}`), nameCell(cond), h('span', null, timing(cond.timeoutMs)), last ? badge(last.items ? 'checked' : 'idle', checkCountsTone(last)) : badge('never checked', 'muted'), countsCell(last)]);
  }
  return table(['Kind', 'Check', 'Timing', 'Last status', 'Details'], rows, { empty: 'No conditions configured.' });
}

export const workflowsPage = (ctx: PageContext): Page => {
  ctx.setTitle('Workflows');
  const body = h('div', null, loading());
  const el = h('div', { class: 'page' }, h('h1', null, 'Workflows'), body);
  const load = async (): Promise<void> => {
    try {
      const res = await api.get<{ workflows: Workflow[] }>('/api/v1/workflows');
      rerender(
        body,
        table(
          ['Workflow', 'Trigger', 'Status', 'Priority', 'Active / max', 'Blocks', 'Conditions', 'Last planning / next slot'],
          res.workflows.map((wf) => [
            h('span', null, routeLink(['workflows', wf.id], wf.name), h('br'), h('small', { class: 'muted' }, wf.id)),
            triggerText(wf),
            enabledBadge(wf),
            h('span', null, String(wf.priority), overridden(wf, 'priority')),
            h('span', null, `${wf.activeRuns} / ${wf.maxConcurrent}`, overridden(wf, 'maxConcurrent')),
            wf.activeBlocks > 0 ? routeLink(['blocked'], badge(String(wf.activeBlocks), 'warn')) : '0',
            conditionBadges(wf.conditions),
            wf.cron
              ? h('span', null, 'next ', time(wf.cron.nextSlot))
              : wf.lastPlanning
                ? h('span', null, time(wf.lastPlanning.at), ` ${wf.lastPlanning.status}`, wf.lastPlanning.error ? sourceErrors(wf.lastPlanning.sources, wf.lastPlanning.error) : ` · ${wf.lastPlanning.polled} polled, ${wf.lastPlanning.started} started`)
                : text(null),
          ]),
          { empty: 'No workflows configured.' },
        ),
      );
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 2000);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (isStateChange(msg) && (msg.type !== 'run.event' || msg.payload.type === 'run.status')) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};

// ---------------------------------------------------------------------------
// Dry-run rendering

/** Display command of a diagnosed check (relative to the config dir), looked up in the workflow's `conditions`. */
export type CheckCommandLookup = (c: CheckDiagnosis) => string | undefined;

/** Lookup from a workflow view (WI-24). */
export function commandLookup(conds: WorkflowConditions | undefined): CheckCommandLookup {
  return (c) => {
    if (!conds) return undefined;
    if (c.kind === 'shell_filter') return conds.shellFilter?.displayCommand;
    const list = c.kind === 'item_condition' ? conds.item : conds.workflow;
    const entry = list[c.index];
    return entry && entry.command === c.command ? entry.displayCommand : undefined;
  };
}

function checkRow(c: CheckDiagnosis, lookup: CheckCommandLookup): HTMLElement {
  const shown = lookup(c) ?? c.command;
  const v = checkValueLabel(c.value);
  const what = c.kind === 'shell_filter' ? 'shell filter' : `${c.kind.replace('_', ' ')} #${c.index + 1}`;
  return h(
    'li',
    null,
    badge(v.label, v.tone),
    ' ',
    what,
    ': ',
    c.name ? h('span', { title: c.command }, checkTitle(c)) : h('code', { title: c.command }, shown),
    c.error ? h('span', { class: 'error-text' }, ` – ${c.error}`) : null,
  );
}

export function traceNode(t: FilterTrace): HTMLElement {
  const v = checkValueLabel(t.value);
  switch (t.kind) {
    case 'all':
    case 'any':
      return h('li', null, badge(v.label, v.tone), ` ${t.kind}`, h('ul', { class: 'trace' }, t.children.map(traceNode)));
    case 'not':
      return h('li', null, badge(v.label, v.tone), ' not', h('ul', { class: 'trace' }, traceNode(t.child)));
    case 'predicate':
      return h(
        'li',
        null,
        badge(v.label, v.tone),
        ' ',
        h('code', null, `${t.field} ${t.operator} ${JSON.stringify(t.expected)}`),
        t.actual !== undefined ? h('span', { class: 'muted' }, ` (actual ${JSON.stringify(t.actual)})`) : null,
        t.reason ? h('span', { class: 'muted' }, ` – ${t.reason}`) : null,
      );
    case 'invalid':
      return h('li', null, badge(v.label, v.tone), ` invalid rule – ${t.reason}`);
  }
}

/** Table of declared secrets (WI-18): where, name, identity, delivery, variable – never values. */
function secretsTable(secrets: readonly SecretInfo[]): HTMLElement {
  return table(
    ['Where', 'Secret', 'Identity', 'Delivery', 'Variable'],
    secrets.map((x) => [h('code', null, x.where), h('code', null, x.name), x.identity, x.delivery, h('code', null, x.variable)]),
    { empty: 'No secrets.' },
  );
}

export function renderDryRun(r: DryRunResult, lookup: CheckCommandLookup = () => undefined): HTMLElement {
  const row = (c: CheckDiagnosis): HTMLElement => checkRow(c, lookup);
  const parts: HTMLElement[] = [];
  parts.push(
    kv([
      ['Generated', time(r.generatedAt)],
      ['Enabled', r.enabled ? badge('yes', 'ok') : badge('no', 'muted')],
      ['Workflow priority', String(r.workflowPriority)],
      ['Capacity', `workflow ${r.capacity.workflow.active}/${r.capacity.workflow.max} · global ${r.capacity.global.active}/${r.capacity.global.max}`],
      ...(r.capacity.perSource
        ? ([['Per source', Object.entries(r.capacity.perSource.active).map(([sid, n]) => `${sid} ${n}/${r.capacity.perSource?.max ?? 0}`).join(' · ')]] as Array<[string, string]>)
        : []),
      ['Automatic starts', r.gate ? (r.gate.canStartAutomatically ? badge('possible', 'ok') : badge(`not possible (${r.gate.reason ?? 'unknown'})`, 'warn')) : text(null)],
      ...(r.hooks
        ? ([
            ['Named outcomes (on_result)', r.hooks.onResult.length ? h('span', null, r.hooks.onResult.map((o) => badge(o, 'info'))) : text(null)],
            ['Technical outcomes', h('ul', { class: 'plain' }, Object.entries(r.hooks.technical).map(([status, hook]) => h('li', null, `${status} → `, h('code', null, hook))))],
          ] as Array<[string, HTMLElement]>)
        : []),
    ]),
  );
  parts.push(
    h(
      'p',
      { class: 'hint' },
      'Dry-run: no workers, no lifecycle actions, no shell filters/conditions. Checks that were not executed are shown as "unknown / not evaluated", never as pass.',
    ),
  );
  if (r.conditions.length) parts.push(h('h3', null, 'Workflow conditions'), h('ul', { class: 'checks' }, r.conditions.map(row)));
  if (r.secrets?.length) parts.push(h('h3', null, 'Secrets'), secretsTable(r.secrets));
  if (r.container) {
    parts.push(
      h('h3', null, `Container (${r.container.engine}, image ${r.container.image})`),
      h('p', { class: 'hint' }, 'Engine command line of a run: templates unresolved, secrets by name only (values are passed via the engine environment).'),
      h('code', { class: 'wrap' }, [r.container.command, ...r.container.args].join(' ')),
    );
  }
  if (r.source) {
    const polls: SourcePoll[] = r.source.sources ?? [{ sourceId: r.source.sourceId, status: r.source.error ? 'source_error' : 'ok', error: r.source.error, polled: r.source.polled }];
    if (polls.length === 1) parts.push(h('h3', null, `Source ${r.source.sourceId}: ${r.source.polled} item(s) polled`));
    else {
      parts.push(
        h('h3', null, `Sources: ${r.source.polled} item(s) polled`),
        h('ul', { class: 'plain' }, polls.map((x) => h('li', null, `${x.sourceId}: ${x.polled} item(s) `, x.error ? badge('source error', 'warn') : badge('ok', 'ok')))),
      );
    }
    for (const x of polls) if (x.error) parts.push(h('div', { class: 'alert alert-error' }, `Source error${polls.length > 1 ? ` (${x.sourceId})` : ''}: ${x.error}`));
    parts.push(
      h('p', null, `${r.summary.candidates} candidate(s): ${r.summary.wouldStart} would start, ${r.summary.pendingChecks} pending checks, ${r.summary.notStartable} not startable`),
      table(
        ['Item', 'Priority', 'Decision', 'Details'],
        r.candidates.map((c) => [
          h('span', null, externalLink(c.url, c.itemKey), c.title ? h('div', null, c.title) : null),
          `${c.workflowPriority} / ${c.itemPriority}${c.matchedPriorityRule !== null ? ` (rule ${c.matchedPriorityRule + 1})` : ''}`,
          h('span', null, badge(c.decision, decisionTone(c.decision)), c.reason ? h('div', { class: 'muted' }, c.reason) : null, c.runId ? h('div', null, runLink(c.runId)) : null),
          c.filter || c.shellFilter || c.itemConditions.length || c.projectFields || c.linkedFields
            ? h(
                'details',
                null,
                h('summary', null, 'checks'),
                c.projectFields
                  ? h(
                      'ul',
                      { class: 'plain' },
                      Object.entries(c.projectFields).map(([name, r]) =>
                        h('li', null, `${name}: `, r.known ? JSON.stringify(r.value) : h('span', { class: 'muted' }, `unknown – ${r.reason}`)),
                      ),
                    )
                  : null,
                c.linkedFields
                  ? h(
                      'ul',
                      { class: 'plain' },
                      Object.entries(c.linkedFields).map(([name, r]) =>
                        h('li', null, `${name}: `, r.known ? JSON.stringify(r.value) : h('span', { class: 'muted' }, `unknown – ${r.reason}`)),
                      ),
                    )
                  : null,
                c.filter ? h('ul', { class: 'trace' }, traceNode(c.filter)) : null,
                c.shellFilter || c.itemConditions.length ? h('ul', { class: 'checks' }, c.shellFilter ? row(c.shellFilter) : null, c.itemConditions.map(row)) : null,
              )
            : text(null),
        ]),
        { empty: 'No candidates.' },
      ),
    );
  }
  if (r.cron) {
    parts.push(
      h('h3', null, `Schedule ${r.cron.cron} (${r.cron.timezone})`),
      kv([
        ['Next slot', h('span', null, badge(r.cron.nextSlotForecast, decisionTone(r.cron.nextSlotForecast)), r.cron.forecastReason ? ` – ${r.cron.forecastReason}` : '')],
        ['Next slots', r.cron.nextSlots.length ? h('ul', { class: 'plain' }, r.cron.nextSlots.map((s) => h('li', null, time(s)))) : text(null)],
      ]),
      r.cron.recentFirings.length
        ? table(
            ['Slot', 'Decision', 'Run', 'Reason'],
            r.cron.recentFirings.map((f) => [time(f.scheduledFor), badge(f.decision, decisionTone(f.decision)), f.runId ? runLink(f.runId) : text(null), text(f.reason)]),
          )
        : h('p', { class: 'muted' }, 'No recent slots.'),
    );
  }
  if (r.notes.length) parts.push(h('h3', null, 'Notes'), h('ul', null, r.notes.map((n) => h('li', null, n))));
  return h('div', { class: 'dry-run' }, parts);
}

// ---------------------------------------------------------------------------
// Detail

export const workflowPage = (ctx: PageContext, id: string): Page => {
  ctx.setTitle(`Workflow ${id}`);
  const header = h('div', null, loading());
  const info = h('div', { class: 'grid' });
  const overridesBox = h('section', { class: 'card' }, h('h2', null, 'Runtime overrides'));
  const startBox = h('section', { class: 'card' }, h('h2', null, 'Manual start'));
  const dryRunOut = h('div');
  const dryBtn: HTMLButtonElement = button('Run dry-run', () => void dryRun(), { kind: 'primary', requires: 'viewer' });
  const dryBox = h('section', { class: 'card span-all' }, h('h2', null, 'Dry-run'), h('div', { class: 'actions' }, dryBtn), dryRunOut);
  const runsBox = h('section', { class: 'card span-all' }, h('h2', null, 'Recent runs'), loading());
  const conditionsBox = h('section', { class: 'card span-all', hidden: true }, h('h2', null, 'Conditions'));
  const configBox = h('section', { class: 'card span-all' });
  const el = h(
    'div',
    { class: 'page' },
    h('p', { class: 'crumbs' }, routeLink(['workflows'], '← Workflows')),
    header,
    h('div', { class: 'grid' }, info, overridesBox, startBox, conditionsBox, dryBox, runsBox, configBox),
  );
  let formsBuilt = false;
  let lastConditions: WorkflowConditions | undefined;

  const dryRun = async (): Promise<void> => {
    replaceChildren(dryRunOut, loading());
    const res = await act(dryBtn, () => api.post<DryRunResult>(`/api/v1/workflows/${seg(id)}/dry-run`));
    replaceChildren(dryRunOut, res ? renderDryRun(res, commandLookup(lastConditions)) : h('p', { class: 'muted' }, 'Dry-run failed.'));
  };

  const buildOverrides = (wf: Workflow): void => {
    const enabled = h(
      'select',
      { class: 'input', id: 'ov-enabled' },
      h('option', { value: '', selected: wf.overrides.enabled === undefined }, `YAML (${wf.configured.enabled ? 'active' : 'inactive'})`),
      h('option', { value: 'true', selected: wf.overrides.enabled === true }, 'active'),
      h('option', { value: 'false', selected: wf.overrides.enabled === false }, 'inactive'),
    ) as HTMLSelectElement;
    const priority = h('input', { class: 'input input-narrow', id: 'ov-priority', type: 'number', step: 'any', value: wf.overrides.priority ?? '', placeholder: String(wf.configured.priority) }) as HTMLInputElement;
    const maxC = h('input', { class: 'input input-narrow', id: 'ov-max', type: 'number', min: 1, step: 1, value: wf.overrides.maxConcurrent ?? '', placeholder: String(wf.configured.maxConcurrent) }) as HTMLInputElement;
    const errors = h('div');
    const save: HTMLButtonElement = button(
      'Apply',
      () => {
        const res = buildRuntimeBody({ enabled: enabled.value, priority: priority.value, maxConcurrent: maxC.value });
        if (!res.ok) {
          replaceChildren(errors, h('div', { class: 'alert alert-error' }, res.errors.map((e) => h('div', null, `${e.field}: ${e.message}`))));
          return;
        }
        errors.replaceChildren();
        void act(save, () => api.patch(`/api/v1/workflows/${seg(id)}/runtime`, res.body), 'Overrides applied').then(() => refresher.now());
      },
      { kind: 'primary', requires: 'operator' },
    );
    const reset: HTMLButtonElement = button('Reset all to YAML', () => {
      enabled.value = '';
      priority.value = '';
      maxC.value = '';
      void act(reset, () => api.patch(`/api/v1/workflows/${seg(id)}/runtime`, { enabled: null, priority: null, maxConcurrent: null }), 'Overrides removed').then(() => refresher.now());
    }, { requires: 'operator' });
    overridesBox.append(
      h('div', { class: 'form' }, h('label', { class: 'field', for: 'ov-enabled' }, h('span', null, 'Enabled'), enabled), h('label', { class: 'field' }, h('span', null, 'Priority'), priority), h('label', { class: 'field' }, h('span', null, 'Max parallel'), maxC)),
      errors,
      h('div', { class: 'actions' }, save, reset),
      h('p', { class: 'hint' }, 'Empty = YAML value. Overrides are not persistent: they are lost on restart, and a configuration reload resets affected overrides to the YAML values.'),
    );
  };

  const buildStart = (wf: Workflow): void => {
    const fields: Record<string, HTMLInputElement | HTMLSelectElement> = {};
    const multi = (wf.trigger.sources?.length ?? 0) > 1;
    const placeholder = multi
      ? `https://github.com/owner/repo/issues/7 or ${wf.trigger.sources?.[0] ?? 'source'}:7`
      : 'https://github.com/owner/repo/issues/7 or #7';
    const item = h('input', { class: 'input', type: 'text', id: 'start-item', placeholder, maxlength: 2000 }) as HTMLInputElement;
    const rows: HTMLElement[] = [];
    if (wf.trigger.type === 'source') rows.push(h('label', { class: 'field' }, h('span', null, 'Source item (required)'), item));
    for (const [name, def] of Object.entries(wf.parameters)) {
      let input: HTMLInputElement | HTMLSelectElement;
      const dflt = def.default === null || def.default === undefined ? null : String(def.default);
      const head = h('span', null, name, def.required ? ' *' : '', h('small', { class: 'muted' }, ` ${def.type}`));
      if (def.type === 'enum' && (def.optionsFrom || def.allowCustom)) {
        // WI-31: options from GitHub / a script (loaded now), or free input with suggestions.
        const field = dynamicEnumField(id, name, def, dflt);
        fields[name] = field.control;
        rows.push(h('div', { class: 'field' }, head, field.box, def.description ? h('small', { class: 'muted' }, def.description) : null));
        continue;
      }
      if (def.type === 'enum' || def.type === 'boolean') {
        const values = def.type === 'enum' ? (def.values ?? []) : ['true', 'false'];
        input = h(
          'select',
          { class: 'input' },
          h('option', { value: '' }, dflt !== null ? `default (${dflt})` : def.required ? '— choose —' : '(none)'),
          values.map((v) => h('option', { value: v }, v)),
        ) as HTMLSelectElement;
      } else {
        input = h('input', { class: 'input', type: def.type === 'number' ? 'number' : 'text', step: def.type === 'number' ? 'any' : null, placeholder: dflt ?? '' }) as HTMLInputElement;
      }
      fields[name] = input;
      rows.push(
        h(
          'label',
          { class: 'field' },
          h('span', null, name, def.required ? ' *' : '', h('small', { class: 'muted' }, ` ${def.type}`)),
          input,
          def.description ? h('small', { class: 'muted' }, def.description) : null,
        ),
      );
    }
    const errors = h('div');
    const startBtn: HTMLButtonElement = button(
      'Start run',
      () => {
        const values: Record<string, string> = {};
        for (const [k, f] of Object.entries(fields)) values[k] = f.value;
        const res = buildStartBody(wf.trigger.type, item.value, wf.parameters, values);
        if (!res.ok) {
          replaceChildren(errors, h('div', { class: 'alert alert-error' }, res.errors.map((e) => h('div', null, `${e.field}: ${e.message}`))));
          return;
        }
        errors.replaceChildren();
        void (async () => {
          startBtn.disabled = true;
          try {
            const r = await api.post<{ run: RunSummary }>(`/api/v1/workflows/${seg(id)}/start`, res.body);
            toast(`Run ${r.run.id} started`, 'ok');
            ctx.navigate(buildHash(['runs', r.run.id], { tab: 'logs' }));
          } catch (err) {
            const parts: HTMLElement[] = [errorBox(err)];
            if (err instanceof ApiError && err.code === 'lock_conflict') {
              const holder = (err.details as { holderRunId?: unknown } | null)?.holderRunId;
              if (typeof holder === 'string') parts.push(h('p', null, 'Active run: ', runLink(holder)));
            }
            replaceChildren(errors, parts);
          } finally {
            startBtn.disabled = false;
          }
        })();
      },
      { kind: 'primary', requires: 'operator' },
    );
    startBox.append(
      h('p', { class: 'hint' }, 'A manual start bypasses filters, conditions, limits, blocks and pause – but not the active lock of an item.'),
      rows.length ? h('div', { class: 'form' }, rows) : h('p', { class: 'muted' }, 'No parameters.'),
      errors,
      h('div', { class: 'actions' }, startBtn),
    );
  };

  const load = async (): Promise<void> => {
    if (isEditing(el)) {
      setTimeout(() => refresher.trigger(), 2000);
      return;
    }
    try {
      const [wf, runs] = await Promise.all([
        api.get<Workflow>(`/api/v1/workflows/${seg(id)}`),
        api.get<{ runs: RunSummary[]; total: number }>(`/api/v1/runs${qs({ workflow: id, limit: 10 })}`),
      ]);
      replaceChildren(header, h('h1', null, wf.name, ' ', h('small', { class: 'muted' }, wf.id)));
      rerender(
        info,
        section(
          'Status',
          kv([
            ['Status', enabledBadge(wf)],
            ['Trigger', triggerText(wf)],
            ['Priority', h('span', null, String(wf.priority), overridden(wf, 'priority'))],
            ['Max parallel', h('span', null, String(wf.maxConcurrent), overridden(wf, 'maxConcurrent'))],
            ...(typeof wf.maxConcurrentPerSource === 'number' ? ([['Max parallel per source', String(wf.maxConcurrentPerSource)]] as Array<[string, string]>) : []),
            ['Current usage', `${wf.activeRuns} active`],
            ['Active blocks', wf.activeBlocks > 0 ? routeLink(['blocked'], badge(String(wf.activeBlocks), 'warn')) : '0'],
            ['Identity', text(wf.identity)],
            ...(wf.execute.container
              ? ([
                  ['Container', h('span', null, h('code', null, wf.execute.container.image), h('small', { class: 'muted' }, ` (${wf.execute.container.engine}, pull ${wf.execute.container.pull}, network ${wf.execute.container.network})`))],
                  ['Mounts', h('ul', { class: 'plain' }, wf.execute.container.mounts.map((m) => h('li', null, h('code', null, `${m.source} → ${m.target}`), ` (${m.mode})`)))],
                ] as Array<[string, HTMLElement]>)
              : []),
            ['Command', h('code', { class: 'wrap' }, [wf.execute.command, ...wf.execute.args.map(String)].join(' '))],
            ['Timeout', timeoutText(wf.execute.timeout)],
            [
              'Secrets',
              // `secrets` (execute + shell actions, WI-18) is missing on older instances.
              wf.secrets
                ? wf.secrets.length
                  ? secretsTable(wf.secrets)
                  : text(null)
                : wf.execute.secrets.length
                  ? wf.execute.secrets.join(', ')
                  : text(null),
            ],
            ['Kept files', wf.execute.keep?.length ? h('span', null, h('code', { class: 'wrap' }, wf.execute.keep.join(', ')), h('small', { class: 'muted' }, ` (max ${formatBytes(wf.execute.keepMaxSizeBytes ?? null)} per run)`)) : text(null)],
            ['Filter', `${wf.hasFilter ? 'declarative' : 'none'}${wf.hasShellFilter ? ' + shell filter' : ''}; conditions: ${wf.conditions.workflow.length} workflow, ${wf.conditions.item.length} item`],
            ['Max technical failures', String(wf.maxTechnicalFailures)],
            ['File', h('code', null, wf.file)],
            ...(wf.cron
              ? ([
                  ['Next slot', time(wf.cron.nextSlot)],
                  ['Last slot', wf.cron.lastFiring ? h('span', null, time(wf.cron.lastFiring.scheduledFor), ' ', badge(wf.cron.lastFiring.decision, decisionTone(wf.cron.lastFiring.decision))) : text(null)],
                ] as Array<[string, HTMLElement]>)
              : []),
            ...(wf.lastPlanning
              ? ([
                  [
                    'Last planning',
                    h(
                      'span',
                      null,
                      time(wf.lastPlanning.at),
                      ` ${wf.lastPlanning.status} · ${wf.lastPlanning.polled} polled · ${wf.lastPlanning.candidates} candidates · ${wf.lastPlanning.started} started`,
                      (wf.lastPlanning.sources?.length ?? 0) > 1
                        ? h('div', { class: 'muted' }, (wf.lastPlanning.sources ?? []).map((x) => `${x.sourceId}: ${x.status === 'ok' ? `${x.polled} polled` : x.status}`).join(' · '))
                        : null,
                      wf.lastPlanning.error ? sourceErrors(wf.lastPlanning.sources, wf.lastPlanning.error) : null,
                    ),
                  ],
                ] as Array<[string, HTMLElement]>)
              : []),
          ]),
        ),
      );
      const conds = wf.conditions;
      lastConditions = conds;
      const hasChecks = conds.workflow.length > 0 || conds.item.length > 0 || conds.shellFilter !== null;
      conditionsBox.hidden = !hasChecks;
      if (hasChecks) {
        rerender(
          conditionsBox,
          h('h2', null, 'Conditions'),
          h('p', { class: 'hint' }, 'Green = ok (exit 0), red = not now (exit 1), yellow = check error (exit ≥ 2, timeout, signal), grey = not evaluated / never checked. Item checks: counts over the items of the last planning step.'),
          conditionsTable(conds),
        );
      }
      if (!formsBuilt) {
        formsBuilt = true;
        buildOverrides(wf);
        buildStart(wf);
        replaceChildren(
          configBox,
          h('h2', null, 'Configuration'),
          h('details', null, h('summary', null, 'Declarative filter'), jsonBlock(wf.filter ?? null)),
          h('details', null, h('summary', null, 'Lifecycle hooks'), jsonBlock(wf.hooks ?? null)),
          h('details', null, h('summary', null, 'Last planning diagnosis'), jsonBlock(wf.diagnosis ?? null)),
        );
      }
      rerender(
        runsBox,
        h('h2', null, `Recent runs (${runs.total})`),
        table(
          ['Run', 'Trigger', 'Outcome', 'Started', 'Duration', 'Message'],
          runs.runs.map((r) => [runLink(r.id), triggerLabel(r.triggerType), runOutcomeBadges(r), time(r.startedAt ?? r.createdAt), formatDuration(r.durationMs), text(r.active ? r.statusMessage : (r.resultMessage ?? r.finalReason))]),
          { empty: 'No runs yet.' },
        ),
        runs.total > runs.runs.length ? h('p', null, routeLink(['runs'], 'All runs of this workflow →', { workflow: id })) : null,
      );
    } catch (err) {
      replaceChildren(header, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 1500);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (msg.type === 'config.reloaded') {
        // Parameter schema/overrides may have changed: rebuild the forms.
        formsBuilt = false;
        overridesBox.replaceChildren(h('h2', null, 'Runtime overrides'));
        startBox.replaceChildren(h('h2', null, 'Manual start'));
        refresher.trigger();
        return;
      }
      if (isStateChange(msg) && (msg.type !== 'run.event' || msg.payload.type === 'run.status')) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
