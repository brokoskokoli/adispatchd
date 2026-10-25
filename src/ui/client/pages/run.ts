/**
 * Run detail (Spec §16): all run fields, paged logs with tail/follow, events,
 * lifecycle actions, cancel / recovery retry.
 */
import { api, qs, seg } from '../api.js';
import { h, replaceChildren, rerender } from '../dom.js';
import { buildHash } from '../../shared/route.js';
import { createRefresher } from '../../shared/throttle.js';
import { LogWindow } from '../../shared/logs.js';
import { EventList, type EventListChange } from '../../shared/events.js';
import { eventSummary, formatBytes, formatDuration, stateTone } from '../../shared/format.js';
import { messageRunId, type Page, type PageContext } from '../page.js';
import type { Action, KeptListing, LogPage, RunDetail, RunEvent } from '../types.js';
import { act, badge, button, confirmDialog, errorBox, externalLink, jsonBlock, kv, loading, routeLink, runLink, runOutcomeBadges, section, table, text, time } from '../ui.js';
import { cancelRunButton } from './dashboard-widgets.js';
import { itemPanelLink } from './item.js';

type Tab = 'overview' | 'logs' | 'events' | 'actions' | 'files';
const TABS: Tab[] = ['overview', 'logs', 'events', 'actions', 'files'];

/** Lifecycle action table (shared with Failed Actions). */
export function actionButtons(a: Action, after: () => void): HTMLElement | null {
  if (a.status !== 'failed') return null;
  const retry: HTMLButtonElement = button(
    'Retry',
    () => void act(retry, () => api.post(`/api/v1/actions/${a.id}/retry`), 'Retry started').then(after),
    { kind: 'primary', disabled: a.busy === true, title: a.busy ? 'The lifecycle chain of this run is busy' : 'Run the action again (fresh attempt budget)', requires: 'operator' },
  );
  const skip: HTMLButtonElement = button(
    'Skip',
    () => {
      void (async () => {
        const r = await confirmDialog({
          title: 'Skip lifecycle action?',
          message: h('p', null, `Action #${a.id} (${a.hook} › ${a.name ?? a.type}) is marked as skipped and the hook chain continues with the next action.`),
          confirmLabel: 'Skip action',
          danger: true,
        });
        if (r.ok) await act(skip, () => api.post(`/api/v1/actions/${a.id}/skip`), 'Action skipped');
        after();
      })();
    },
    { disabled: a.busy === true, requires: 'operator' },
  );
  return h('span', { class: 'actions' }, retry, skip);
}

function errorText(e: unknown): string | null {
  if (e === null || e === undefined) return null;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return JSON.stringify(e);
}

export function actionsTable(actions: Action[], after: () => void, opts: { showRun?: boolean } = {}): HTMLElement {
  return table(
    [...(opts.showRun ? ['Run'] : []), 'Hook', '#', 'Action', 'State', 'Attempts', 'Last error', 'Updated', ''],
    actions.map((a) => [
      ...(opts.showRun ? [a.run ? h('span', null, runLink(a.runId), h('br'), h('small', { class: 'muted' }, a.run.workflowName ?? a.run.workflowId)) : runLink(a.runId)] : []),
      a.hook,
      String(a.ordinal + 1),
      h('span', null, a.name ?? a.type, a.name ? h('small', { class: 'muted' }, ` (${a.type})`) : null),
      badge(a.status, stateTone(a.status)),
      a.attemptsDetail && a.attemptsDetail.length > 0
        ? h(
            'details',
            null,
            h('summary', null, String(a.attempts)),
            h(
              'ol',
              { class: 'attempts' },
              a.attemptsDetail.map((t) => h('li', null, time(t.startedAt), ' ', badge(t.outcome ?? 'running', stateTone(t.outcome ?? 'running')), errorText(t.error) ? h('div', { class: 'error-text' }, errorText(t.error)!) : null)),
            ),
          )
        : String(a.attempts),
      errorText(a.lastError) ? h('div', { class: 'error-text' }, errorText(a.lastError)!) : text(null),
      time(a.updatedAt),
      actionButtons(a, after),
    ]),
    { empty: 'No lifecycle actions.' },
  );
}

export const runPage = (ctx: PageContext, runId: string): Page => {
  ctx.setTitle(`Run ${runId}`);
  const tab: Tab = TABS.includes(ctx.route.query.tab as Tab) ? (ctx.route.query.tab as Tab) : 'overview';
  const header = h('div', { class: 'run-header' }, loading());
  const tabs = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Run sections' },
    TABS.map((t) => h('a', { href: buildHash(['runs', runId], { tab: t }), class: t === tab ? 'active' : null, 'aria-current': t === tab ? 'page' : null }, t[0]!.toUpperCase() + t.slice(1))),
  );
  const body = h('div', null);
  const el = h('div', { class: 'page' }, h('p', { class: 'crumbs' }, routeLink(['runs'], '← Runs')), header, tabs, body);
  let detail: RunDetail | null = null;

  // ---------------------------------------------------------------- header
  const renderHeader = (d: RunDetail): void => {
    const btns = h('div', { class: 'actions' });
    const cancel = cancelRunButton(d, () => refresher.trigger());
    if (cancel) btns.appendChild(cancel);
    if (d.status === 'recovery_pending') {
      const b: HTMLButtonElement = button(
        'Retry recovery',
        () => {
          void (async () => {
            const r = await confirmDialog({
              title: 'Retry recovery?',
              message: h('p', null, 'Recovery checks again whether the worker process is still running. Only tick the box if you have verified that the process is gone.'),
              confirmLabel: 'Retry recovery',
              checkbox: { label: 'I verified the process is gone (assumeGone)' },
            });
            if (r.ok) await act(b, () => api.post(`/api/v1/runs/${seg(d.id)}/recovery/retry`, { assumeGone: r.checked }), 'Recovery retry started');
            refresher.trigger();
          })();
        },
        { kind: 'primary', requires: 'operator' },
      );
      btns.appendChild(b);
    }
    rerender(
      header,
      h('h1', null, d.workflowName ?? d.workflowId, ' ', h('small', { class: 'muted' }, h('code', null, d.id))),
      h('div', { class: 'run-status' }, runOutcomeBadges(d), d.statusMessage && d.active ? h('span', { class: 'status-message' }, d.statusMessage) : null),
      btns,
    );
  };

  // -------------------------------------------------------------- overview
  const renderOverview = (d: RunDetail): void => {
    const cmd = d.command ? [d.command.command ?? '', ...(Array.isArray(d.command.args) ? d.command.args.map((a) => String(a)) : [])].join(' ') : null;
    rerender(
      body,
      h(
        'div',
        { class: 'grid' },
        section(
          'Run',
          kv([
            ['Name', text(d.workflowName)],
            ['Run ID', h('code', null, d.id)],
            ['Workflow', routeLink(['workflows', d.workflowId], d.workflowId)],
            ['Identity / role', text(d.identity)],
            ['Trigger', h('span', null, d.triggerType === 'unblock' ? 'unblock (lifecycle run of a removed retry block)' : d.triggerType, d.scheduledFor ? ` (slot ${d.scheduledFor})` : '')],
            ['Source item', h('span', null, d.sourceUrl ? externalLink(d.sourceUrl) : text(d.sourceItemKey), d.sourceItemKey ? [' ', itemPanelLink(d.sourceId, d.sourceItemKey.slice(d.sourceItemKey.indexOf(':') + 1))] : null)],
            ['Technical state', badge(d.status, d.active ? 'info' : 'muted')],
            ['Business result', d.businessResult ? badge(d.businessResult, d.businessResult === 'success' ? 'ok' : 'warn') : text(null)],
            ['Outcome', d.resultOutcome ? badge(d.resultOutcome, 'info') : text(null)],
            ['Completion hook', d.completionHook || d.retryBlockHook
              ? h('span', null, d.completionHook ? h('code', null, d.completionHook) : '', d.retryBlockHook ? [d.completionHook ? ' + ' : '', h('code', null, 'on_retry_block')] : '')
              : text(null)],
            ['Final reason', text(d.finalReason)],
            ['Lifecycle', d.lifecycleStatus ? (d.lifecycleFailed ? badge('lifecycle failed', 'error') : badge(d.lifecycleStatus, stateTone(d.lifecycleStatus))) : text(null)],
            ['Exit code', text(d.exitCode)],
          ]),
        ),
        section(
          'Timing & process',
          kv([
            ['Created', time(d.createdAt)],
            ['Started', time(d.startedAt)],
            ['Finished', time(d.finishedAt)],
            ['Duration', formatDuration(d.durationMs ?? (d.startedAt && d.active ? Date.now() - Date.parse(d.startedAt) : null))],
            ['Working directory', d.workingDirectory ? h('code', null, d.workingDirectory) : text(null)],
            ['Command', cmd ? h('code', { class: 'wrap' }, cmd) : text(null)],
            ['PID', text(d.pid)],
            ['Lock', text(d.lockKey)],
            ['Config', d.configVersion !== null ? `v${d.configVersion}${d.configHash ? ` (${d.configHash.slice(0, 12)})` : ''}` : text(null)],
            ['Kept files', d.kept ? routeLink(['runs', d.id], `${d.kept.files} file(s), ${formatBytes(d.kept.bytes)}${d.kept.skippedCount ? `, ${d.kept.skippedCount} skipped` : ''}`, { tab: 'files' }) : text(null)],
            ['Logs', `stdout ${formatBytes(d.logs.stdout.size)}${d.logs.stdout.truncated ? ' (truncated)' : ''}, stderr ${formatBytes(d.logs.stderr.size)}${d.logs.stderr.truncated ? ' (truncated)' : ''}`],
          ]),
        ),
        d.block
          ? h(
              'section',
              { class: 'card span-all' },
              h('h2', null, 'Active retry block'),
              h('p', null, `Internal retry block #${d.block.id} of this scope (${d.block.failureCount} technical failures): ${d.block.reason} `, routeLink(['blocked'], 'Blocked →')),
            )
          : null,
        d.error ? h('section', { class: 'card span-all' }, h('h2', null, 'Technical diagnosis'), jsonBlock(d.error)) : null,
        h('section', { class: 'card span-all' }, h('h2', null, 'Parameters'), jsonBlock(d.parameters && Object.keys(d.parameters).length ? d.parameters : null)),
        h(
          'section',
          { class: 'card span-all' },
          h('h2', null, 'Result (result file)'),
          d.resultFileError ? h('div', { class: 'alert alert-warn' }, `Result file unreadable: ${d.resultFileError}`) : null,
          jsonBlock(d.resultFile ?? d.result),
        ),
        h(
          'section',
          { class: 'card span-all' },
          h('details', null, h('summary', null, h('strong', null, 'Input JSON (context.json)')), d.inputError ? h('div', { class: 'alert alert-warn' }, d.inputError) : null, jsonBlock(d.input)),
        ),
      ),
    );
  };

  // ------------------------------------------------------------------ logs
  let stream: 'stdout' | 'stderr' = ctx.route.query.stream === 'stderr' ? 'stderr' : 'stdout';
  const win = new LogWindow();
  let follow = true;
  /** Generation of the log window (bumped on stream switch / reset); in-flight responses of older generations are dropped. */
  let logGen = 0;
  /** Generation with a load in flight (-1 = none). */
  let logBusyGen = -1;
  const logPre = h('pre', { class: 'log', tabindex: 0, 'aria-label': 'Log output' });
  const logInfo = h('div', { class: 'log-info muted' });
  const logButtons = h('div', { class: 'actions' });
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const logUrl = (query: Record<string, number | string>): string => `/api/v1/runs/${seg(runId)}/logs${qs({ stream, ...query })}`;
  const atBottom = (): boolean => logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight < 30;

  const renderLog = (scrollToEnd: boolean): void => {
    logPre.textContent = win.text || (win.exists ? '' : '(no log output yet)');
    if (scrollToEnd) logPre.scrollTop = logPre.scrollHeight;
    logInfo.textContent = `bytes ${win.start.toLocaleString()}–${win.end.toLocaleString()} of ${win.size.toLocaleString()} (${formatBytes(win.size)})${win.trimmed ? ' · view trimmed to keep the page responsive' : ''}`;
    rerender(
      logButtons,
      h('span', { class: 'segmented' }, (['stdout', 'stderr'] as const).map((s) => button(s, () => switchStream(s), { kind: s === stream ? 'primary' : 'plain' }))),
      button('⇤ Start', () => void loadLog('start'), { disabled: win.start === 0 && !win.trimmed }),
      button('Load earlier', () => void loadLog('earlier'), { disabled: !win.hasEarlier }),
      button('Load newer', () => void loadLog('later'), { disabled: !win.hasLater }),
      button('End ⇥', () => void loadLog('tail')),
      h(
        'label',
        { class: 'check' },
        (() => {
          const cb = h('input', { type: 'checkbox', checked: follow, on: { change: () => { follow = cb.checked; if (follow) void loadLog('tail'); } } }) as HTMLInputElement;
          return cb;
        })(),
        ' Follow',
      ),
    );
  };

  const switchStream = (s: 'stdout' | 'stderr'): void => {
    if (s === stream) return;
    stream = s;
    void loadLog('tail');
  };

  /**
   * Load a log range. All requests are bounded pages (LOG_PAGE_BYTES).
   * `tail`/`start` (and a stream switch) start a new generation: responses of
   * older generations are discarded, so bytes of one stream never end up in
   * the window of another or of a newer range.
   */
  const loadLog = async (mode: 'tail' | 'earlier' | 'later' | 'start' | 'follow'): Promise<void> => {
    if (mode === 'tail' || mode === 'start') logGen++;
    const gen = logGen;
    if (logBusyGen === gen) return; // same generation already loading (follow/earlier/later)
    logBusyGen = gen;
    const get = async (query: Record<string, number | string>): Promise<LogPage | null> => {
      const page = await api.get<LogPage>(logUrl(query));
      return gen === logGen ? page : null;
    };
    try {
      if (mode === 'tail') {
        const page = await get(win.tailQuery());
        if (!page) return;
        win.reset(page);
        renderLog(true);
      } else if (mode === 'start') {
        follow = false;
        const page = await get({ offset: 0, limit: win.pageBytes });
        if (!page) return;
        win.reset(page);
        renderLog(false);
        logPre.scrollTop = 0;
      } else if (mode === 'earlier') {
        const q = win.earlierQuery();
        if (!q) return;
        const before = logPre.scrollHeight;
        const page = await get(q);
        if (!page) return;
        if (!win.prepend(page)) win.reset(page);
        if (win.hasLater) follow = false;
        renderLog(false);
        logPre.scrollTop += logPre.scrollHeight - before;
      } else {
        // later / follow: read on from `end` (several pages at most per call)
        const stick = atBottom();
        for (let i = 0; i < 4; i++) {
          const page = await get(win.laterQuery());
          if (!page) return;
          if (!win.append(page)) {
            const tail = await get(win.tailQuery());
            if (!tail) return;
            win.reset(tail);
            break;
          }
          if (page.eof || page.length === 0) break;
        }
        renderLog(mode === 'follow' ? stick : false);
      }
    } catch (err) {
      if (gen !== logGen) return;
      logInfo.textContent = '';
      logInfo.appendChild(errorBox(err));
    } finally {
      if (logBusyGen === gen) logBusyGen = -1;
    }
  };
  const followRefresher = createRefresher(() => (follow && tab === 'logs' ? loadLog('follow') : undefined), 1000);

  const renderLogs = (): void => {
    replaceChildren(body, h('section', { class: 'card' }, logButtons, logInfo, logPre));
    renderLog(false);
    void loadLog('tail');
    // Safety net: poll while the run is active and following (SSE triggers are the primary signal).
    pollTimer = setInterval(() => {
      if (detail?.active && follow) followRefresher.trigger();
    }, 5000);
  };

  // ---------------------------------------------------------------- events
  // Contiguous REST cursor + live events (see shared/events.ts): live events are appended only if they
  // continue the loaded range; otherwise "newer events" are offered and loaded via REST from the cursor.
  let evList = new EventList<RunEvent>();
  let evBusy = false;
  const eventsBody = h('tbody');
  const eventsMore = h('div');
  const eventsDropped = h('div');
  const eventRow = (e: RunEvent): HTMLElement =>
    h(
      'tr',
      null,
      h('td', null, String(e.sequence)),
      h('td', null, time(e.timestamp)),
      h('td', null, badge(e.origin, e.origin === 'worker' ? 'info' : 'muted')),
      h('td', null, h('code', null, e.type)),
      h('td', { class: 'event-message' }, eventSummary(e)),
      h('td', null, Object.keys(e.payload ?? {}).length ? h('details', null, h('summary', null, 'payload'), jsonBlock(e.payload, 50_000)) : null),
    );
  const applyEvents = (change: EventListChange<RunEvent> | null): void => {
    if (change) {
      for (const e of change.append) eventsBody.appendChild(eventRow(e));
      for (let i = 0; i < change.drop && eventsBody.firstElementChild; i++) eventsBody.firstElementChild.remove();
    }
    replaceChildren(
      eventsDropped,
      evList.dropped > 0 ? h('p', { class: 'hint' }, `${evList.dropped} older event(s) are not shown (at most ${evList.maxRows} rows are kept).`) : null,
    );
    replaceChildren(
      eventsMore,
      evList.pending
        ? h('div', { class: 'alert alert-info' }, 'Newer events are available. ', button(evBusy ? 'Loading…' : 'Load newer events', () => void loadMoreEvents(), { kind: 'primary', disabled: evBusy }))
        : null,
    );
  };
  const loadMoreEvents = async (): Promise<void> => {
    if (evBusy) return;
    evBusy = true;
    const list = evList;
    const q = list.nextQuery(1000);
    applyEvents(null);
    try {
      const res = await api.get<{ events: RunEvent[]; hasMore: boolean }>(`/api/v1/runs/${seg(runId)}/events${qs(q)}`);
      if (list === evList) applyEvents(list.page(res.events, res.hasMore, q.after));
    } catch (err) {
      replaceChildren(eventsMore, errorBox(err), button('Retry', () => void loadMoreEvents()));
      return;
    } finally {
      evBusy = false;
    }
    applyEvents(null);
  };
  const renderEvents = (d: RunDetail): void => {
    evList = new EventList<RunEvent>();
    eventsBody.replaceChildren();
    applyEvents(evList.page(d.events, d.eventsTruncated, 0));
    rerender(
      body,
      h(
        'section',
        { class: 'card' },
        h('p', { class: 'hint' }, 'Structured events (worker @@ADISPATCH_EVENT lines and orchestrator events). Events are informational only. Live updates append here.'),
        eventsDropped,
        h(
          'div',
          { class: 'table-wrap' },
          h('table', { class: 'events' }, h('thead', null, h('tr', null, ['#', 'Time', 'Origin', 'Type', 'Message', ''].map((x) => h('th', { scope: 'col' }, x)))), eventsBody),
        ),
        eventsMore,
      ),
    );
  };

  // --------------------------------------------------------------- actions
  const renderActions = (d: RunDetail): void => {
    rerender(
      body,
      h(
        'section',
        { class: 'card' },
        d.lifecycleFailed ? h('div', { class: 'alert alert-error' }, 'Lifecycle failed: a hook chain stopped at a failed action. Retry or skip it below.') : null,
        actionsTable(d.actions, () => refresher.trigger()),
      ),
    );
  };

  // ----------------------------------------------------------------- files
  // Files kept from the workspace (`execute.keep`, WI-22); loaded once per tab visit and when the run ends.
  let filesLoadedFor: string | null = null;
  const renderFiles = async (d: RunDetail): Promise<void> => {
    const key = `${d.status}:${d.kept?.files ?? -1}`;
    if (filesLoadedFor === key) return;
    filesLoadedFor = key;
    if (body.childElementCount === 0) replaceChildren(body, loading());
    try {
      const k = await api.get<KeptListing>(`/api/v1/runs/${seg(runId)}/kept`);
      const skipped = k.report?.skipped ?? [];
      rerender(
        body,
        h(
          'section',
          { class: 'card' },
          h('p', { class: 'hint' }, 'Files copied from the workspace after the run (execute.keep); known secrets are redacted (best effort, like logs). They are deleted together with the run (retention).'),
          k.report?.error ? h('div', { class: 'alert alert-warn' }, `Keeping files failed: ${k.report.error}`) : null,
          k.report?.unmatched?.length ? h('p', { class: 'muted' }, `No match: ${k.report.unmatched.join(', ')}`) : null,
          k.report?.notSearched?.length ? h('div', { class: 'alert alert-warn' }, `Not searched (directory entry limit reached): ${k.report.notSearched.join(', ')}`) : null,
          table(
            ['File', 'Size', ''],
            k.files.map((f) => [
              h('code', { class: 'wrap' }, f.path),
              formatBytes(f.size),
              h('a', { href: `/api/v1/runs/${seg(runId)}/kept/${f.path.split('/').map(seg).join('/')}`, download: f.path.split('/').pop() ?? 'file' }, 'Download'),
            ]),
            { empty: d.active ? 'Files are kept when the run ends.' : 'No kept files.' },
          ),
          k.truncated ? h('p', { class: 'hint' }, 'Listing truncated.') : null,
          skipped.length
            ? h(
                'div',
                null,
                h('h3', null, `Skipped (${k.report?.skippedCount ?? skipped.length})`),
                table(['File', 'Reason', 'Size'], skipped.map((x) => [h('code', { class: 'wrap' }, x.path), x.message ? `${x.reason}: ${x.message}` : x.reason, x.size !== undefined ? formatBytes(x.size) : text(null)])),
              )
            : null,
        ),
      );
    } catch (err) {
      filesLoadedFor = null;
      replaceChildren(body, errorBox(err));
    }
  };

  // ------------------------------------------------------------------ load
  let first = true;
  const load = async (): Promise<void> => {
    try {
      const d = await api.get<RunDetail>(`/api/v1/runs/${seg(runId)}`);
      const wasActive = detail?.active ?? true;
      detail = d;
      renderHeader(d);
      if (tab === 'overview') renderOverview(d);
      else if (tab === 'actions') renderActions(d);
      else if (tab === 'files') void renderFiles(d);
      else if (tab === 'events') {
        if (first) renderEvents(d);
      } else if (tab === 'logs') {
        if (first) renderLogs();
        else if (wasActive && !d.active) followRefresher.trigger(); // final bytes after the run ended
      }
      first = false;
    } catch (err) {
      replaceChildren(header, errorBox(err));
      if (first) body.replaceChildren();
    }
  };
  const refresher = createRefresher(load, 1000);
  void load();

  return {
    el,
    onLive: (msg) => {
      if (msg.type === 'system.status') {
        refresher.trigger();
        return;
      }
      if (messageRunId(msg) !== runId) return;
      if (msg.type === 'run.output') {
        if (tab === 'logs' && msg.payload.stream === stream) followRefresher.trigger();
        return;
      }
      if (msg.type === 'run.event' && tab === 'events') {
        applyEvents(evList.live(msg.payload as unknown as RunEvent));
        const t = msg.payload.type;
        if (t !== 'run.status' && t !== 'status' && t !== 'lifecycle.chain') return;
      }
      refresher.trigger();
    },
    onResync: () => {
      void refresher.now();
      if (tab === 'events') {
        // Events may have been missed while disconnected: continue from the contiguous cursor.
        evList.markPending();
        void loadMoreEvents();
      }
      if (tab === 'logs' && follow) void loadLog('tail');
    },
    dispose: () => {
      refresher.dispose();
      followRefresher.dispose();
      if (pollTimer) clearInterval(pollTimer);
    },
  };
};
