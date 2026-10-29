/**
 * Overview page of the hub (WI-37): one tile per workspace (state, runs,
 * blocks, failed actions, share of the slots), the shared slot limit, server
 * resources, start/stop/restart/drain per workspace and drain/stop/pause for
 * all. Updates live from `/api/v1/hub/events` (SSE) and reloads over REST
 * after a reconnect. Login, roles and the safe element builder are shared with
 * the workspace UI; control buttons are only shown to operators and admins.
 * Links lead to `./w/<id>/` (relative: the hub may sit behind a path prefix).
 */
import { api, ApiError, seg } from '../client/api.js';
import { currentAuth, loadAuth, UNAUTHORIZED_EVENT } from '../client/auth.js';
import { $, h, replaceChildren } from '../client/dom.js';
import { badge, button, confirmDialog, errorBox, loading, table, time, toast, act } from '../client/ui.js';
import { authScreen, deniedPage, loginPage, userEntry } from '../shared/auth.js';
import { appPath } from '../shared/base-path.js';
import { formatBytes, formatRelative } from '../shared/format.js';
import {
  applyLive,
  fullestDisk,
  hubConfirm,
  mayControl,
  parseAudit,
  parseModel,
  slotsText,
  stateBadge,
  visibleHubActions,
  workspaceActions,
  workspaceConfirm,
  workspaceNote,
  type HubModel,
  type HubResources,
  type HubWideAction,
  type HubWorkspace,
} from '../shared/hub.js';
import { LiveConnection, type EventSourceLike, type LiveState } from '../shared/sse.js';
import { createRefresher } from '../shared/throttle.js';

const HUB_EVENT_TYPES = ['stream.open', 'hub.snapshot', 'hub.status', 'hub.workspace', 'hub.resources'] as const;

const main = $('#main');
const userSlot = $('#user');
const liveIndicator = $('#live');

let model: HubModel = { status: null, workspaces: [] };
let live: LiveConnection | null = null;
let started = false;
let summaryEl: HTMLElement | null = null;
let resourcesEl: HTMLElement | null = null;
let tilesEl: HTMLElement | null = null;
let auditEl: HTMLElement | null = null;
const tileEls = new Map<string, HTMLElement>();

// ----------------------------------------------------------------- login
function showLogin(opts: { error?: string | null; notice?: string | null; name?: string } = {}): void {
  const page = loginPage(h, {
    error: opts.error ?? null,
    notice: opts.notice ?? null,
    onSubmit: (ev: Event) => {
      ev.preventDefault();
      const form = ev.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const name = String(data.get('name') ?? '').trim();
      const password = String(data.get('password') ?? '');
      if (!name || !password) return showLogin({ error: 'Enter user name and password.', name });
      const submit = form.querySelector('button[type=submit]') as HTMLButtonElement | null;
      if (submit) submit.disabled = true;
      void api
        .post('/api/v1/auth/login', { name, password })
        .then(() => location.reload())
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
  document.title = 'Sign in · adispatchd hub';
  const nameInput = main.querySelector('input[name=name]') as HTMLInputElement | null;
  const passwordInput = main.querySelector('input[name=password]') as HTMLInputElement | null;
  if (nameInput && opts.name) nameInput.value = opts.name;
  (opts.name ? passwordInput : nameInput)?.focus();
}

function renderUser(): void {
  replaceChildren(
    userSlot,
    userEntry(h, currentAuth(), {
      onLogout: () => {
        void api
          .post('/api/v1/auth/logout')
          .catch(() => undefined)
          .then(() => location.reload());
      },
    }),
  );
}

// ------------------------------------------------------------- rendering
const percent = (n: number): string => `${Math.round(n)}%`;

function meter(value: number, max: number, cls: string, label: string): HTMLElement {
  return h('meter', { class: cls, min: 0, max: Math.max(1, max), value: Math.min(value, Math.max(1, max)), 'aria-label': label });
}

function renderSummary(): void {
  if (!summaryEl) return;
  const status = model.status;
  if (!status) return void replaceChildren(summaryEl);
  const role = currentAuth().role;
  const stateTone = status.state === 'paused' ? 'warn' : status.state === 'stopping' ? 'warn' : 'ok';
  const stateText = status.state === 'paused' ? 'paused' : status.state === 'stopping' ? 'stopping' : 'running';
  const buttons = visibleHubActions(role, status.paused).map((action) => {
    const label = action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : action === 'drain-all' ? 'Drain all' : 'Stop all';
    return button(label, () => void runHubAction(action, label), { kind: action === 'stop-all' ? 'danger' : 'plain', title: HUB_ACTION_HINT[action] });
  });
  replaceChildren(
    summaryEl,
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'slots-title' },
      h('h2', { id: 'slots-title' }, 'Slots ', badge(stateText, stateTone)),
      h(
        'div',
        { class: 'slot-line' },
        h('span', { class: 'slot-count', title: 'Runs in progress / hub.max_concurrent' }, slotsText(status.slots.active, status.slots.max)),
        meter(status.slots.active, status.slots.max, 'slot-meter', `${status.slots.active} of ${status.slots.max} slots in use`),
      ),
      status.paused ? h('p', { class: 'hint' }, 'Paused: no workspace starts new automatic runs. Running runs and manual starts are not affected.') : null,
      status.state === 'stopping' ? h('p', { class: 'hint' }, 'The hub is shutting down: workspaces are draining.') : null,
      buttons.length > 0 ? h('div', { class: 'hub-actions', role: 'group', 'aria-label': 'Actions for all workspaces' }, buttons) : null,
    ),
  );
}

const HUB_ACTION_HINT: Record<HubWideAction, string> = {
  pause: 'No new automatic runs anywhere',
  resume: 'Allow new automatic runs again',
  'drain-all': 'Finish running runs, then stop every workspace',
  'stop-all': 'Cancel all runs and stop every workspace',
};

function resCell(label: string, value: string, bar?: HTMLElement): HTMLElement {
  return h('div', { class: 'res-cell' }, h('dt', null, label), h('dd', null, value, bar ?? null));
}

function renderResources(): void {
  if (!resourcesEl) return;
  const r: HubResources | null = model.status?.resources ?? null;
  if (!r) {
    replaceChildren(resourcesEl, h('section', { class: 'card' }, h('h2', null, 'Server'), h('p', { class: 'muted' }, 'Resource data appears after the first measurement.')));
    return;
  }
  const disk = fullestDisk(r);
  const memFraction = r.memory.totalBytes > 0 ? r.memory.usedBytes / r.memory.totalBytes : 0;
  replaceChildren(
    resourcesEl,
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'res-title' },
      h('h2', { id: 'res-title' }, 'Server'),
      h(
        'dl',
        { class: 'res-cells' },
        resCell(`CPU (${r.cpu.cores} cores)`, percent(r.cpu.percent), meter(r.cpu.percent, 100, 'strip-meter', `CPU ${percent(r.cpu.percent)}`)),
        resCell('Memory', `${formatBytes(r.memory.usedBytes)} / ${formatBytes(r.memory.totalBytes)}`, meter(memFraction * 100, 100, 'strip-meter', `Memory ${percent(memFraction * 100)}`)),
        disk
          ? resCell('Disk (fullest)', `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`, meter(disk.fraction * 100, 100, 'strip-meter', `Disk ${percent(disk.fraction * 100)} used`))
          : resCell('Disk', '—'),
        resCell('Load (1/5/15 min)', r.cpu.load.map((l) => l.toFixed(2)).join(' / ')),
      ),
    ),
  );
}

function stat(label: string, value: number | null, cls = ''): HTMLElement {
  return h('div', { class: cls }, h('dt', null, label), h('dd', null, value === null ? '—' : String(value)));
}

function renderTile(w: HubWorkspace): HTMLElement {
  const max = model.status?.slots.max ?? 1;
  const b = stateBadge(w);
  const a = w.activity;
  const note = workspaceNote(w);
  const control = mayControl(currentAuth().role);
  const actions = workspaceActions(w);
  return h(
    'li',
    null,
    h(
      'article',
      { class: 'card tile', 'aria-labelledby': `ws-${w.id}`, 'data-workspace': w.id },
      h('h2', { id: `ws-${w.id}` }, h('a', { href: `./w/${w.id}/`, title: `Open the UI of ${w.id}` }, w.id), badge(b.label, b.tone)),
      h(
        'dl',
        { class: 'tile-stats' },
        stat('Running', a ? a.activeRuns : null),
        stat('Blocked', a ? a.activeBlocks : null, a && a.activeBlocks > 0 ? 'attention' : ''),
        stat('Failed actions', a ? a.failedActions : null, a && a.failedActions > 0 ? 'problem' : ''),
      ),
      h(
        'div',
        { class: 'tile-slots' },
        h('span', null, `Slots ${slotsText(w.slots, max)}`),
        meter(w.slots, max, 'tile-meter', `${w.slots} of ${max} hub slots held by ${w.id}`),
      ),
      note ? h('p', { class: `alert alert-${w.state === 'failed' ? 'error' : 'warn'} tile-note`, role: w.state === 'failed' ? 'alert' : null }, note) : null,
      h(
        'p',
        { class: 'tile-meta' },
        w.state === 'running' && w.startedAt ? `Up since ${formatRelative(w.startedAt, Date.now())}` : w.nextRestartAt ? `Restart ${formatRelative(w.nextRestartAt, Date.now())}` : 'Not running',
        w.crashes > 0 ? ` · ${w.restarts} restart${w.restarts === 1 ? '' : 's'} after ${w.crashes} crash${w.crashes === 1 ? '' : 'es'}` : '',
        a?.version ? ` · v${a.version}` : '',
        a && a.scheduler.state !== 'running' ? ` · scheduler ${a.scheduler.state}` : '',
        a && a.recoveryPending > 0 ? ` · ${a.recoveryPending} run${a.recoveryPending === 1 ? '' : 's'} awaiting recovery` : '',
      ),
      h(
        'div',
        { class: 'tile-actions', role: 'group', 'aria-label': `Actions for ${w.id}` },
        h('a', { class: 'btn btn-primary', href: `./w/${w.id}/` }, 'Open'),
        control
          ? actions.map((spec) => {
              const btn = button(spec.label, () => void runWorkspaceAction(w, spec.action, btn), {
                kind: spec.action === 'stop' ? 'danger' : 'plain',
                disabled: !spec.enabled,
                title: spec.enabled ? `${spec.label} ${w.id}` : spec.reason,
              });
              btn.setAttribute('aria-label', `${spec.label} ${w.id}`);
              if (spec.enabled || !spec.reason) return btn;
              // The reason must not live in `title` only: screen readers get it as the button's description.
              const reasonId = `why-${w.id}-${spec.action}`;
              btn.setAttribute('aria-describedby', reasonId);
              return h('span', { class: 'btn-with-reason' }, btn, h('span', { id: reasonId, class: 'sr-only' }, spec.reason));
            })
          : null,
      ),
    ),
  );
}

function renderTiles(): void {
  if (!tilesEl) return;
  tileEls.clear();
  if (model.workspaces.length === 0) {
    replaceChildren(tilesEl, h('li', { class: 'empty' }, 'No workspaces are configured in hub.yaml.'));
    return;
  }
  const items = model.workspaces.map((w) => {
    const el = renderTile(w);
    tileEls.set(w.id, el);
    return el;
  });
  replaceChildren(tilesEl, items);
}

function updateTile(id: string): void {
  const w = model.workspaces.find((x) => x.id === id);
  const old = tileEls.get(id);
  if (!w || !old || !tilesEl) return renderTiles();
  const next = renderTile(w);
  // Keep keyboard focus on the same control if it still exists.
  const focused = document.activeElement instanceof HTMLElement && old.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
  old.replaceWith(next);
  tileEls.set(id, next);
  if (focused) {
    const again = Array.from(next.querySelectorAll('[aria-label]')).find((e) => e.getAttribute('aria-label') === focused) as HTMLElement | undefined;
    again?.focus();
  }
}

function renderAudit(rows: ReturnType<typeof parseAudit>): void {
  if (!auditEl) return;
  replaceChildren(
    auditEl,
    h(
      'details',
      { class: 'card audit' },
      h('summary', null, 'Audit log'),
      table(
        ['Time', 'User', 'Action', 'Workspace', 'Result'],
        rows.map((r) => [
          time(r.at),
          r.actor ? `${r.actor} (${r.role ?? '?'})` : h('span', { class: 'muted' }, 'no login'),
          h('code', null, r.action),
          r.workspace ?? h('span', { class: 'muted' }, '—'),
          r.result === 'ok' ? 'ok' : h('span', { class: 'failed-result' }, `failed${r.error ? ` (${r.error})` : ''}`),
        ]),
        { empty: 'No actions recorded yet.' },
      ),
    ),
  );
}

async function loadAudit(): Promise<void> {
  if (currentAuth().role !== 'admin' || !auditEl) return;
  try {
    renderAudit(parseAudit(await api.get('/api/v1/hub/audit?limit=25')));
  } catch {
    // the audit log is a convenience; errors show up on actions
  }
}

// --------------------------------------------------------------- actions
async function runWorkspaceAction(w: HubWorkspace, action: 'start' | 'stop' | 'restart' | 'drain', btn: HTMLButtonElement): Promise<void> {
  const spec = workspaceActions(w).find((s) => s.action === action);
  if (spec?.confirm) {
    const c = workspaceConfirm(action, w.id);
    const r = await confirmDialog({ title: c.title, message: c.message, confirmLabel: c.confirmLabel, danger: c.danger });
    if (!r.ok) return;
  }
  const done = await act(btn, () => api.post(`/api/v1/hub/workspaces/${seg(w.id)}/${action}`), `${spec?.label ?? action} requested for ${w.id}`);
  if (done !== undefined) afterAction();
}

async function runHubAction(action: HubWideAction, label: string): Promise<void> {
  const c = hubConfirm(action);
  if (c) {
    const r = await confirmDialog({ title: c.title, message: c.message, confirmLabel: c.confirmLabel, danger: c.danger });
    if (!r.ok) return;
  }
  const done = await act(null, () => api.post(`/api/v1/hub/${action}`), `${label} requested`);
  if (done !== undefined) afterAction();
}

/** Live events normally deliver the result; this makes the page right even if the stream is down. */
function afterAction(): void {
  refresher.trigger();
  auditRefresher.trigger();
}

// ------------------------------------------------------------------ data
async function load(): Promise<void> {
  const [status, workspaces] = await Promise.all([api.get('/api/v1/hub/status'), api.get('/api/v1/hub/workspaces')]);
  model = parseModel(status, workspaces);
  renderSummary();
  renderResources();
  renderTiles();
}
const auditRefresher = createRefresher(loadAudit, 2000);
const refresher = createRefresher(() => load().catch((err: unknown) => toast(err instanceof Error ? err.message : String(err), 'error')), 1000);

const STATE_LABEL: Record<LiveState, string> = { connecting: 'connecting…', open: 'live', reconnecting: 'reconnecting…', closed: 'offline' };

function startLive(): void {
  live = new LiveConnection({
    url: appPath('/api/v1/hub/events'),
    eventTypes: HUB_EVENT_TYPES,
    create: (url) => new EventSource(url) as unknown as EventSourceLike,
    onMessage: (msg) => {
      const result = applyLive(model, msg.type, msg.payload);
      model = result.model;
      switch (result.change.kind) {
        case 'all':
          renderSummary();
          renderResources();
          renderTiles();
          break;
        case 'status':
          auditRefresher.trigger();
          renderSummary();
          renderTiles(); // tiles show their slots relative to the hub limit
          break;
        case 'resources':
          renderResources();
          break;
        case 'workspace':
          auditRefresher.trigger();
          updateTile(result.change.id);
          renderSummary();
          break;
        case 'none':
          break;
      }
    },
    onResync: () => refresher.trigger(),
    onState: (state) => {
      liveIndicator.textContent = STATE_LABEL[state];
      liveIndicator.className = `live live-${state}`;
      liveIndicator.title = state === 'open' ? 'Live updates via SSE' : 'Live updates interrupted; data is reloaded after reconnecting';
    },
  });
  live.start();
}

window.addEventListener('online', () => live?.reconnectNow());
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  if (!started) return;
  void loadAuth().then((me) => {
    renderUser();
    if (authScreen(me) === 'app' && me.user) return;
    live?.stop();
    liveIndicator.textContent = STATE_LABEL.closed;
    liveIndicator.className = 'live live-closed';
    if (me.mode === 'password') showLogin({ notice: 'Your session has ended. Please sign in again.' });
    else replaceChildren(main, deniedPage(h, me));
  });
});

function startApp(): void {
  started = true;
  document.title = 'Hub · adispatchd';
  summaryEl = h('div', { class: 'hub-summary-slot' });
  resourcesEl = h('div', { class: 'hub-summary-slot' });
  tilesEl = h('ul', { class: 'tiles', 'aria-label': 'Workspaces' });
  auditEl = h('div', { class: 'audit-slot' });
  replaceChildren(
    main,
    h(
      'div',
      { class: 'hub-page' },
      h('h1', null, 'Workspaces'),
      h('div', { class: 'hub-summary' }, summaryEl, resourcesEl),
      tilesEl,
      auditEl,
    ),
  );
  replaceChildren(tilesEl, loading());
  void load()
    .then(() => loadAudit())
    .catch((err: unknown) => replaceChildren(main, errorBox(err)));
  startLive();
}

void loadAuth().then((me) => {
  renderUser();
  const screen = authScreen(me);
  if (screen === 'app') startApp();
  else {
    liveIndicator.hidden = true;
    if (screen === 'login') showLogin();
    else replaceChildren(main, deniedPage(h, me));
  }
});
