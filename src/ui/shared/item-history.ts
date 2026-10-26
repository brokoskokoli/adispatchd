/**
 * Item history page (WI-33), DOM-free so it can be unit-tested: parsing of
 * `GET /api/v1/items/:source/:item/history` and `…/github-events`, the texts
 * of path badges, entries and action effects, the merge of external GitHub
 * events into the timeline and the page sections built with the safe element
 * builder. Everything from the API or GitHub is rendered as text.
 */
import type { Child, ElementLike, HFn, Listener } from './dom.js';
import { formatDuration, type Tone } from './format.js';

/** Kinds of timeline entries (filter checkboxes); `github` = external GitHub events. */
export const ENTRY_KINDS = ['run_started', 'run_finished', 'hook', 'block_created', 'block_cleared', 'ui_action', 'github'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** Labels of the filter checkboxes. */
export const ENTRY_KIND_LABELS: Record<EntryKind, string> = {
  run_started: 'Run started',
  run_finished: 'Run finished',
  hook: 'Hooks and actions',
  block_created: 'Retry block created',
  block_cleared: 'Retry block removed',
  ui_action: 'UI actions',
  github: 'GitHub events',
};

/** Hash of the history page. */
export const historyHash = (source: string, itemId: string): string => `#/items/${encodeURIComponent(source)}/${encodeURIComponent(itemId)}`;

/** Effect of an action (see the API). */
export interface Effect {
  labelsAdded: string[];
  labelsRemoved: string[];
  projectFields: Array<{ name: string; from?: unknown; to: unknown }>;
  projectItemAdded: boolean;
  unchanged: boolean;
  comment: { url: string | null; reconciled: boolean } | null;
  exitCode?: number | null;
  signal?: string | null;
}

export interface HistoryAction {
  id: number;
  name: string | null;
  type: string;
  status: string;
  attempts: number;
  effect: Effect | null;
  effectSource: 'recorded' | 'journal' | null;
  error: string | null;
}

/** Path element (a run). */
export interface PathRun {
  id: string;
  workflowId: string;
  workflowName: string | null;
  triggerType: string;
  status: string;
  active: boolean;
  outcome: string;
  finalStatus: string | null;
  resultOutcome: string | null;
  createdAt: string;
}

/** A timeline entry (one shape for all kinds; fields not used by a kind stay empty). */
export interface Entry {
  key: string;
  kind: EntryKind;
  at: string;
  /** Pagination cursor (entries sort by it, newest = largest); empty for GitHub events. */
  cursor: string;
  runId: string | null;
  workflowId: string | null;
  workflowName: string | null;
  // run_started
  trigger?: string;
  user?: string | null;
  parameters?: Record<string, unknown> | null;
  active?: boolean;
  // run_finished
  status?: string;
  result?: string | null;
  outcome?: string | null;
  message?: string | null;
  reason?: string | null;
  durationMs?: number | null;
  lifecycleStatus?: string | null;
  // hook
  hook?: string;
  actions?: HistoryAction[];
  // blocks
  blockId?: number;
  failureCount?: number;
  lastStatus?: string | null;
  clearedBy?: string | null;
  clearedRunId?: string | null;
  // ui_action
  actor?: string;
  identity?: string;
  action?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  effect?: Effect | null;
  // github
  github?: GitHubEvent;
}

/** Fresh item state. */
export type HistoryItem =
  | {
      ok: true;
      url: string;
      type: string;
      repository: string | null;
      title: string;
      state: string | null;
      labels: string[];
      projectFields: Array<{ name: string; known: boolean; value: unknown; reason: string | null }> | null;
      linked: { workBranch: { known: boolean; value: unknown; reason?: string }; workPr: { known: boolean; value: unknown; reason?: string }; workPrUrl: string | null } | null;
    }
  | { ok: false; error: { code: string; message: string } };

/** Parsed history response. */
export interface HistoryData {
  source: string;
  itemId: string;
  item: HistoryItem | null;
  githubEvents: boolean;
  runs: PathRun[];
  runsTotal: number;
  truncated: boolean;
  entries: Entry[];
  entriesTotal: number;
  nextBefore: string | null;
  retentionGap: { deletedRuns: number | null; newestDeletedAt: string | null } | null;
  active: { runs: PathRun[]; blocks: Array<{ id: number; workflowId: string; reason: string }> };
}

/** External GitHub event. */
export interface GitHubEvent {
  kind: string;
  at: string;
  actor: string | null;
  own: boolean;
  external: boolean;
  label?: string;
  assignee?: string;
  from?: string;
  to?: string;
  stateReason?: string | null;
  ref?: { name: string; title: string | null; url: string | null; isPullRequest: boolean } | null;
  commit?: string | null;
}

/** Parsed `…/github-events`. */
export interface GitHubEventsData {
  events: GitHubEvent[];
  hiddenOwn: number;
  truncated: boolean;
  limit: number;
  fetchedAt: string;
  cached: boolean;
  notice: string;
}

// ---------------------------------------------------------------------------
// Parsing (untrusted JSON; strings are capped)

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const s = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const sn = (v: unknown, max = 2000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)) : []);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseEffect(v: unknown): Effect | null {
  const e = obj(v);
  if (!e) return null;
  const comment = obj(e.comment);
  return {
    labelsAdded: strings(e.labelsAdded),
    labelsRemoved: strings(e.labelsRemoved),
    projectFields: list(e.projectFields)
      .map(obj)
      .filter((f): f is Record<string, unknown> => f !== null && typeof f.name === 'string')
      .map((f) => ({ name: s(f.name, 200), ...('from' in f ? { from: f.from } : {}), to: f.to })),
    projectItemAdded: e.projectItemAdded === true,
    unchanged: e.unchanged === true,
    comment: comment ? { url: sn(comment.url), reconciled: comment.reconciled === true } : null,
    ...('exitCode' in e ? { exitCode: n(e.exitCode) } : {}),
    ...('signal' in e ? { signal: sn(e.signal, 40) } : {}),
  };
}

function parseRun(v: unknown): PathRun | null {
  const r = obj(v);
  if (!r || typeof r.id !== 'string') return null;
  return {
    id: s(r.id, 100),
    workflowId: s(r.workflowId, 200),
    workflowName: sn(r.workflowName, 200),
    triggerType: s(r.triggerType, 20),
    status: s(r.status, 40),
    active: r.active === true,
    outcome: s(r.outcome, 40),
    finalStatus: sn(r.finalStatus, 40),
    resultOutcome: sn(r.resultOutcome, 200),
    createdAt: s(r.createdAt, 40),
  };
}

function parseEntry(v: unknown): Entry | null {
  const e = obj(v);
  if (!e || typeof e.key !== 'string' || typeof e.kind !== 'string' || !(ENTRY_KINDS as readonly string[]).includes(e.kind)) return null;
  const out: Entry = {
    key: s(e.key, 300),
    kind: e.kind as EntryKind,
    at: s(e.at, 40),
    cursor: s(e.cursor, 400),
    runId: sn(e.runId, 100),
    workflowId: sn(e.workflowId, 200),
    workflowName: sn(e.workflowName, 200),
  };
  if (typeof e.trigger === 'string') out.trigger = s(e.trigger, 20);
  if ('user' in e) out.user = sn(e.user, 320);
  if ('parameters' in e) out.parameters = obj(e.parameters);
  if ('active' in e) out.active = e.active === true;
  if (typeof e.status === 'string') out.status = s(e.status, 40);
  if ('result' in e) out.result = sn(e.result, 40);
  if ('outcome' in e) out.outcome = sn(e.outcome, 200);
  if ('message' in e) out.message = sn(e.message);
  if ('reason' in e) out.reason = sn(e.reason);
  if ('durationMs' in e) out.durationMs = n(e.durationMs);
  if ('lifecycleStatus' in e) out.lifecycleStatus = sn(e.lifecycleStatus, 40);
  if (typeof e.hook === 'string') out.hook = s(e.hook, 200);
  if (Array.isArray(e.actions)) {
    out.actions = e.actions
      .map(obj)
      .filter((a): a is Record<string, unknown> => a !== null && typeof a.id === 'number')
      .map((a) => ({
        id: a.id as number,
        name: sn(a.name, 200),
        type: s(a.type, 40),
        status: s(a.status, 20),
        attempts: n(a.attempts) ?? 0,
        effect: parseEffect(a.effect),
        effectSource: a.effectSource === 'recorded' || a.effectSource === 'journal' ? a.effectSource : null,
        error: sn(a.error),
      }));
  }
  if (typeof e.blockId === 'number') out.blockId = e.blockId;
  if ('failureCount' in e) out.failureCount = n(e.failureCount) ?? 0;
  if ('lastStatus' in e) out.lastStatus = sn(e.lastStatus, 40);
  if ('clearedBy' in e) out.clearedBy = sn(e.clearedBy, 320);
  if ('clearedRunId' in e) out.clearedRunId = sn(e.clearedRunId, 100);
  if (typeof e.actor === 'string') out.actor = s(e.actor, 320);
  if (typeof e.identity === 'string') out.identity = s(e.identity, 200);
  if (typeof e.action === 'string') out.action = s(e.action, 20);
  if ('errorCode' in e) out.errorCode = sn(e.errorCode, 100);
  if ('errorMessage' in e) out.errorMessage = sn(e.errorMessage);
  if ('effect' in e) out.effect = parseEffect(e.effect);
  return out;
}

function parseItem(v: unknown): HistoryItem | null {
  const i = obj(v);
  if (!i) return null;
  if (i.ok !== true) {
    const err = obj(i.error);
    return { ok: false, error: { code: s(err?.code, 100), message: s(err?.message) } };
  }
  const linked = obj(i.linked);
  const res = (r: unknown) => {
    const x = obj(r);
    return { known: x?.known === true, value: x?.value ?? null, ...(typeof x?.reason === 'string' ? { reason: s(x.reason) } : {}) };
  };
  return {
    ok: true,
    url: s(i.url),
    type: s(i.type, 40),
    repository: sn(i.repository, 200),
    title: s(i.title),
    state: sn(i.state, 40),
    labels: strings(i.labels),
    projectFields: Array.isArray(i.projectFields)
      ? i.projectFields
          .map(obj)
          .filter((f): f is Record<string, unknown> => f !== null && typeof f.name === 'string')
          .map((f) => ({ name: s(f.name, 200), known: f.known === true, value: f.value ?? null, reason: sn(f.reason) }))
      : null,
    linked: linked ? { workBranch: res(linked.workBranch), workPr: res(linked.workPr), workPrUrl: sn(linked.workPrUrl) } : null,
  };
}

/** Parse the history response; `null` if it is not one. */
export function parseHistory(v: unknown): HistoryData | null {
  const d = obj(v);
  if (!d || !Array.isArray(d.entries) || !Array.isArray(d.runs)) return null;
  const gap = obj(d.retentionGap);
  const active = obj(d.active);
  return {
    source: s(d.source, 200),
    itemId: s(d.itemId, 40),
    item: parseItem(d.item),
    githubEvents: d.githubEvents === true,
    runs: d.runs.map(parseRun).filter((r): r is PathRun => r !== null),
    runsTotal: n(d.runsTotal) ?? 0,
    truncated: d.truncated === true,
    entries: d.entries.map(parseEntry).filter((e): e is Entry => e !== null),
    entriesTotal: n(d.entriesTotal) ?? 0,
    nextBefore: sn(d.nextBefore, 400),
    retentionGap: gap ? { deletedRuns: n(gap.deletedRuns), newestDeletedAt: sn(gap.newestDeletedAt, 40) } : null,
    active: {
      runs: list(active?.runs).map(parseRun).filter((r): r is PathRun => r !== null),
      blocks: list(active?.blocks)
        .map(obj)
        .filter((b): b is Record<string, unknown> => b !== null && typeof b.id === 'number')
        .map((b) => ({ id: b.id as number, workflowId: s(b.workflowId, 200), reason: s(b.reason) })),
    },
  };
}

/** Parse the GitHub events response. */
export function parseGitHubEvents(v: unknown): GitHubEventsData | null {
  const d = obj(v);
  if (!d || !Array.isArray(d.events)) return null;
  const events = d.events
    .map(obj)
    .filter((e): e is Record<string, unknown> => e !== null && typeof e.kind === 'string' && typeof e.at === 'string')
    .map((e): GitHubEvent => {
      const ref = obj(e.ref);
      return {
        kind: s(e.kind, 40),
        at: s(e.at, 40),
        actor: sn(e.actor, 200),
        own: e.own === true,
        external: e.external === true,
        ...(typeof e.label === 'string' ? { label: s(e.label, 200) } : {}),
        ...(typeof e.assignee === 'string' ? { assignee: s(e.assignee, 200) } : {}),
        ...(typeof e.from === 'string' ? { from: s(e.from, 1000) } : {}),
        ...(typeof e.to === 'string' ? { to: s(e.to, 1000) } : {}),
        ...('stateReason' in e ? { stateReason: sn(e.stateReason, 40) } : {}),
        ...(ref ? { ref: { name: s(ref.name, 300), title: sn(ref.title, 1000), url: sn(ref.url), isPullRequest: ref.isPullRequest === true } } : {}),
        ...('commit' in e ? { commit: sn(e.commit, 40) } : {}),
      };
    });
  return {
    events,
    hiddenOwn: n(d.hiddenOwn) ?? 0,
    truncated: d.truncated === true,
    limit: n(d.limit) ?? 0,
    fetchedAt: s(d.fetchedAt, 40),
    cached: d.cached === true,
    notice: s(d.notice, 500),
  };
}

// ---------------------------------------------------------------------------
// Texts

/** Badge of a run in the path: running / success / outcome / failure / technical status. */
export function pathBadge(run: Pick<PathRun, 'active' | 'status' | 'outcome' | 'finalStatus' | 'resultOutcome'>): { label: string; tone: Tone } {
  if (run.active) return { label: run.status === 'recovery_pending' ? 'recovery pending' : 'running', tone: 'info' };
  if (run.resultOutcome && run.outcome !== 'technical_error' && run.outcome !== 'cancelled') return { label: run.resultOutcome, tone: run.outcome === 'failure' ? 'warn' : 'ok' };
  switch (run.outcome) {
    case 'success':
      return { label: 'success', tone: 'ok' };
    case 'failure':
      return { label: 'failure', tone: 'warn' };
    case 'cancelled':
      return { label: 'cancelled', tone: 'muted' };
    case 'technical_error':
      return { label: run.finalStatus ?? run.status, tone: 'error' };
    default:
      return { label: run.status, tone: 'muted' };
  }
}

const value = (v: unknown): string => (v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v));

/** Lines describing an effect, e.g. `+ ready`, `Status: Todo → Review`, `comment written`. */
export function effectLines(effect: Effect | null | undefined, type?: string): string[] {
  if (!effect) return [];
  const lines: string[] = [];
  for (const l of effect.labelsAdded) lines.push(`label + ${l}`);
  for (const l of effect.labelsRemoved) lines.push(`label − ${l}`);
  if (effect.projectItemAdded) lines.push('added to the project');
  for (const f of effect.projectFields) lines.push(`${f.name}: ${'from' in f ? `${value(f.from)} → ` : ''}${value(f.to)}`);
  if (effect.comment) lines.push(effect.comment.reconciled ? 'comment found again (written before)' : 'comment written');
  if (effect.unchanged) lines.push('no change (already in this state)');
  if ('exitCode' in effect || 'signal' in effect) {
    if (effect.signal) lines.push(`terminated by ${effect.signal}`);
    else if (effect.exitCode !== null && effect.exitCode !== undefined) lines.push(`exit ${effect.exitCode}`);
    else if (type === 'shell') lines.push('not started');
  }
  return lines;
}

/** Text of a trigger (`manual by alice`, `source`, `schedule`, `unblock by bob`). */
export function triggerText(trigger: string | undefined, user: string | null | undefined): string {
  const t = trigger ?? '?';
  if (t === 'manual') return user ? `manual (by ${user})` : 'manual';
  if (t === 'unblock') return user ? `unblock (block removed by ${user})` : 'unblock (lifecycle run)';
  return t;
}

/** Title of a GitHub event. */
export function githubEventText(e: GitHubEvent): string {
  const by = e.actor ? ` by ${e.actor}` : '';
  switch (e.kind) {
    case 'labeled':
      return `label + ${e.label ?? '?'}${by}`;
    case 'unlabeled':
      return `label − ${e.label ?? '?'}${by}`;
    case 'closed':
      return `closed${e.stateReason ? ` (${e.stateReason})` : ''}${by}`;
    case 'reopened':
      return `reopened${by}`;
    case 'assigned':
      return `assigned to ${e.assignee ?? '?'}${by}`;
    case 'unassigned':
      return `unassigned ${e.assignee ?? '?'}${by}`;
    case 'renamed':
      return `renamed from “${e.from ?? ''}” to “${e.to ?? ''}”${by}`;
    case 'cross-referenced':
      return `referenced in ${e.ref?.isPullRequest ? 'pull request' : 'issue'} ${e.ref?.name ?? '?'}${e.ref?.title ? ` “${e.ref.title}”` : ''}${by}`;
    case 'connected':
      return `linked pull request / issue${by}`;
    case 'disconnected':
      return `link removed${by}`;
    case 'referenced':
      return `referenced in commit ${e.commit ?? '?'}${by}`;
    case 'merged':
      return `merged${e.commit ? ` (${e.commit})` : ''}${by}`;
    default:
      return `${e.kind}${by}`;
  }
}

/** Timeline entries of external GitHub events. */
export function githubEntries(events: readonly GitHubEvent[]): Entry[] {
  return events.map((e, i) => ({ key: `gh:${i}:${e.at}`, kind: 'github' as const, at: e.at, cursor: '', runId: null, workflowId: null, workflowName: null, github: e }));
}

/**
 * Live refresh (WI-33): the freshly loaded first page replaces the entries it
 * covers; already loaded older entries ("load older" pages) are kept, so the
 * list never shrinks. Returns the entries and the cursor for further paging.
 */
export function refreshEntries(loaded: readonly Entry[], loadedNext: string | null, fresh: readonly Entry[], freshNext: string | null): { entries: Entry[]; nextBefore: string | null } {
  const last = fresh.at(-1);
  if (!last || freshNext === null) return { entries: [...fresh], nextBefore: freshNext };
  const keys = new Set(fresh.map((e) => e.key));
  const older = loaded.filter((e) => e.cursor < last.cursor && !keys.has(e.key));
  return older.length > 0 ? { entries: [...fresh, ...older], nextBefore: loadedNext } : { entries: [...fresh], nextBefore: freshNext };
}

/** Merge entries (newest first, or oldest first with `ascending`), keeping only the enabled kinds. */
export function timelineEntries(entries: readonly Entry[], external: readonly Entry[], enabled: ReadonlySet<EntryKind>, ascending: boolean, oldestLoaded: string | null): Entry[] {
  // External events older than the oldest loaded page entry are held back until that page is loaded.
  const ext = oldestLoaded === null ? external : external.filter((e) => e.at >= oldestLoaded);
  const all = [...entries, ...ext].filter((e) => enabled.has(e.kind));
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return ascending ? all.reverse() : all;
}

// ---------------------------------------------------------------------------
// Rendering

/** Rendering helpers injected by the client (time, links). */
export interface HistoryRender<E extends ElementLike> {
  time(iso: string | null): E;
  runLink(id: string, text?: string): E;
  link(url: string, text: string): E;
  badge(label: string, tone: Tone, title?: string): E;
  routeLink(hash: string, text: string): E;
}

const workflowLabel = (e: Pick<Entry, 'workflowName' | 'workflowId'>): string => e.workflowName ?? e.workflowId ?? '';

/** Head: title, type, state, labels, project fields, work branch/PR, active run and blocks. */
export function headSection<E extends ElementLike>(h: HFn<E>, d: HistoryData, r: HistoryRender<E>): E {
  const item = d.item;
  const activeRuns = d.active.runs.length > 0 ? h('p', null, 'Active run: ', d.active.runs.map((run, i) => [i > 0 ? ', ' : '', r.runLink(run.id), ` (${run.workflowName ?? run.workflowId})`])) : null;
  const blocks =
    d.active.blocks.length > 0
      ? h('p', null, r.badge('blocked', 'warn'), ' ', d.active.blocks.map((b, i) => [i > 0 ? '; ' : '', `${b.workflowId}: ${b.reason} `, r.routeLink('#/blocked', 'Blocked →')]))
      : null;
  if (!item || !item.ok) {
    return h(
      'section',
      { class: 'card history-head' },
      h('h1', null, `${d.source}:${d.itemId}`),
      h('div', { class: 'alert alert-warn' }, 'The item could not be read', item && !item.ok ? `: ${item.error.message}` : '', '. The stored history is shown anyway.'),
      activeRuns,
      blocks,
    );
  }
  const rows: Child[] = [];
  const row = (k: string, v: Child): void => {
    rows.push(h('dt', null, k), h('dd', null, v));
  };
  row('Type', item.type === 'pull_request' ? 'pull request' : item.type);
  row('State', item.state ? r.badge(item.state, item.state === 'open' ? 'ok' : 'muted') : '—');
  row('Labels', item.labels.length > 0 ? h('span', { class: 'chips' }, item.labels.map((l) => h('span', { class: 'chip' }, l))) : h('span', { class: 'muted' }, 'none'));
  for (const f of item.projectFields ?? []) {
    row(f.name, f.known ? value(f.value) : h('span', { class: 'muted', title: f.reason ?? '' }, 'unknown'));
  }
  if (item.linked) {
    const res = (x: { known: boolean; value: unknown; reason?: string }): Child =>
      x.known ? (x.value === null || x.value === undefined ? h('span', { class: 'muted' }, 'none') : String(x.value)) : h('span', { class: 'muted', title: x.reason ?? '' }, 'unknown');
    row('Work branch', res(item.linked.workBranch));
    row('Work PR', item.linked.workPr.known && item.linked.workPr.value !== null && item.linked.workPrUrl ? r.link(item.linked.workPrUrl, `#${String(item.linked.workPr.value)}`) : res(item.linked.workPr));
  }
  return h(
    'section',
    { class: 'card history-head' },
    h('h1', null, item.url ? r.link(item.url, item.title || `${d.source}:${d.itemId}`) : item.title || `${d.source}:${d.itemId}`),
    h('p', { class: 'muted' }, `${item.repository ?? d.source}#${d.itemId} · source ${d.source}`),
    h('dl', { class: 'kv' }, rows),
    activeRuns,
    blocks,
  );
}

/** Path: chain of the item's runs (the latest ones, older ones summarised), each a link with its badge. */
export function pathSection<E extends ElementLike>(h: HFn<E>, d: HistoryData, r: HistoryRender<E>): E {
  if (d.runs.length === 0) {
    return h('section', { class: 'card' }, h('h2', null, 'Path'), h('p', { class: 'empty' }, 'No runs for this item yet.'));
  }
  const older = d.runsTotal - d.runs.length;
  return h(
    'section',
    { class: 'card' },
    h('h2', null, `Path (${d.runsTotal} run${d.runsTotal === 1 ? '' : 's'})`),
    h(
      'ol',
      { class: 'history-path', 'aria-label': 'Runs of the item in chronological order' },
      older > 0 ? h('li', { class: 'muted' }, `older … (${older})`) : null,
      d.runs.map((run) => {
        const b = pathBadge(run);
        return h('li', null, h('a', { href: `#/runs/${encodeURIComponent(run.id)}`, class: 'path-step', title: `${run.id} · ${run.createdAt}` }, h('span', null, run.workflowName ?? run.workflowId), ' ', r.badge(b.label, b.tone)));
      }),
    ),
  );
}

function actionRow<E extends ElementLike>(h: HFn<E>, a: HistoryAction, r: HistoryRender<E>): E {
  const tone: Tone = a.status === 'succeeded' ? 'ok' : a.status === 'failed' ? 'error' : a.status === 'skipped' ? 'muted' : 'info';
  const lines = effectLines(a.effect, a.type);
  return h(
    'li',
    { class: 'history-action' },
    h('code', null, a.type),
    a.name ? [' ', h('span', { class: 'muted' }, a.name)] : null,
    ' ',
    r.badge(a.status === 'succeeded' ? 'ok' : a.status, tone),
    a.attempts > 1 ? h('span', { class: 'muted' }, ` ${a.attempts} attempts`) : null,
    lines.length > 0 || (a.effect?.comment?.url ?? null)
      ? h(
          'ul',
          { class: 'effect' },
          lines.map((l) => h('li', null, l)),
          a.effect?.comment?.url ? h('li', null, r.link(a.effect.comment.url, 'open comment')) : null,
          a.effectSource === 'journal' ? h('li', { class: 'muted' }, '(from the journal of an older version; old values unknown)') : null,
        )
      : null,
    a.error ? h('div', { class: 'error-text' }, a.error) : null,
  );
}

/** One timeline entry as a list item. */
export function entryItem<E extends ElementLike>(h: HFn<E>, e: Entry, r: HistoryRender<E>): E {
  const run = e.runId ? [' · ', r.runLink(e.runId, 'run')] : null;
  const head = (title: Child, ...rest: Child[]): E => h('div', { class: 'entry-head' }, r.time(e.at), ' ', h('strong', null, title), ...rest);
  switch (e.kind) {
    case 'run_started': {
      const params = e.parameters && Object.keys(e.parameters).length > 0 ? Object.entries(e.parameters).map(([k, v]) => `${k}=${value(v)}`).join(', ') : null;
      return h(
        'li',
        { class: 'entry entry-run' },
        head(`${workflowLabel(e)} started`, run, e.active ? [' ', r.badge('running', 'info')] : null),
        h('div', { class: 'muted' }, `trigger: ${triggerText(e.trigger, e.user)}`, params ? ` · parameters: ${params}` : ''),
      );
    }
    case 'run_finished': {
      const b = pathBadge({ active: false, status: e.status ?? '', outcome: e.status === 'completed' ? (e.result === 'failure' ? 'failure' : 'success') : e.status === 'cancelled' ? 'cancelled' : 'technical_error', finalStatus: e.status ?? null, resultOutcome: e.outcome ?? null });
      return h(
        'li',
        { class: 'entry entry-run' },
        head(`${workflowLabel(e)} finished`, ' ', r.badge(b.label, b.tone), run),
        h(
          'div',
          { class: 'muted' },
          `status ${e.status ?? '?'}`,
          e.result ? ` · result ${e.result}` : '',
          e.outcome ? ` · outcome ${e.outcome}` : '',
          e.durationMs !== null && e.durationMs !== undefined ? ` · ${formatDuration(e.durationMs)}` : '',
          e.lifecycleStatus === 'failed' ? ' · lifecycle failed' : '',
        ),
        e.message ? h('div', null, e.message) : null,
        !e.message && e.reason ? h('div', { class: 'muted' }, e.reason) : null,
      );
    }
    case 'hook':
      return h('li', { class: 'entry entry-hook' }, head(h('code', null, e.hook ?? '?'), ` (${workflowLabel(e)})`, run), h('ul', { class: 'history-actions' }, (e.actions ?? []).map((a) => actionRow(h, a, r))));
    case 'block_created':
      return h(
        'li',
        { class: 'entry entry-block' },
        head(`Retry block created (${workflowLabel(e)})`, ' ', r.badge(e.active ? 'active' : 'removed', e.active ? 'warn' : 'muted'), run),
        h('div', { class: 'muted' }, `${e.failureCount ?? 0} technical failures${e.lastStatus ? `, last ${e.lastStatus}` : ''}`, ' · ', r.routeLink('#/blocked', 'Blocked →')),
      );
    case 'block_cleared':
      return h(
        'li',
        { class: 'entry entry-block' },
        head(`Retry block removed (${workflowLabel(e)})`, e.clearedRunId ? [' · ', r.runLink(e.clearedRunId, 'lifecycle run')] : null),
        h('div', { class: 'muted' }, e.clearedBy ? `by ${e.clearedBy}` : 'by unknown'),
      );
    case 'ui_action': {
      const lines = effectLines(e.effect);
      return h(
        'li',
        { class: 'entry entry-ui' },
        head(`UI action: ${e.action ?? '?'}`, ' ', r.badge(e.result === 'succeeded' ? 'ok' : (e.errorCode ?? e.result ?? '?'), e.result === 'succeeded' ? 'ok' : e.result === 'unknown' ? 'warn' : 'error')),
        h('div', { class: 'muted' }, `by ${e.actor ?? '?'} as ${e.identity ?? '?'}`),
        lines.length > 0 || e.effect?.comment?.url ? h('ul', { class: 'effect' }, lines.map((l) => h('li', null, l)), e.effect?.comment?.url ? h('li', null, r.link(e.effect.comment.url, 'open comment')) : null) : null,
        e.errorMessage ? h('div', { class: 'error-text' }, e.errorMessage) : null,
      );
    }
    case 'github': {
      const g = e.github as GitHubEvent;
      return h(
        'li',
        { class: 'entry entry-github' },
        head(githubEventText(g), ' ', g.external ? r.badge('external', 'muted', 'Not done by adispatchd or a UI action') : r.badge('own identity', 'info', 'Done by a configured identity; no matching history entry (e.g. deleted by retention)')),
        g.ref?.url ? h('div', null, r.link(g.ref.url, g.ref.name)) : null,
      );
    }
  }
}

/** Filter checkboxes (one per kind) and the order toggle. */
export function timelineControls<E extends ElementLike>(
  h: HFn<E>,
  state: { enabled: ReadonlySet<EntryKind>; ascending: boolean; githubAvailable: boolean },
  on: { toggleKind: (kind: EntryKind) => void; toggleOrder: Listener },
): E {
  const kinds = ENTRY_KINDS.filter((k) => k !== 'github' || state.githubAvailable);
  return h(
    'div',
    { class: 'history-controls' },
    h(
      'fieldset',
      { class: 'history-filter' },
      h('legend', null, 'Show'),
      kinds.map((k) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.enabled.has(k), on: { change: () => on.toggleKind(k) } }), ' ', ENTRY_KIND_LABELS[k]),
      ),
    ),
    h('button', { type: 'button', class: 'btn btn-plain', on: { click: on.toggleOrder } }, state.ascending ? 'Oldest first ↑' : 'Newest first ↓'),
  );
}

/** Retention / planning hints below the timeline. */
export function historyNotes<E extends ElementLike>(h: HFn<E>, d: HistoryData): E {
  const gap = d.retentionGap;
  return h(
    'div',
    { class: 'history-notes' },
    gap
      ? h(
          'div',
          { class: 'alert alert-info' },
          'Older entries were deleted according to the retention settings',
          gap.deletedRuns !== null ? ` (${gap.deletedRuns} run${gap.deletedRuns === 1 ? '' : 's'}${gap.newestDeletedAt ? `, the newest from ${gap.newestDeletedAt.slice(0, 10)}` : ''})` : '',
          '.',
        )
      : null,
    h('p', { class: 'muted' }, 'Planning decisions (filters, limits, skipped items) are not stored per item and do not appear here.'),
  );
}
