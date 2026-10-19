/**
 * Item panel (WI-27): act on an issue/PR as a configured identity – comment,
 * labels, project fields. DOM-free (unit-testable): parsing of the untrusted
 * API payloads, the pending edit state, request payloads, confirmation
 * texts and the panel built with the safe element builder. Everything coming
 * from the API or GitHub is rendered as text; the comment preview is plain
 * text (no Markdown/HTML rendering).
 */
import type { AuthMe } from './auth.js';
import type { Child, ElementLike, HFn, Listener } from './dom.js';

/** A project field of the item. */
export interface PanelProjectField {
  name: string;
  kind: 'single_select' | 'text' | 'number' | 'date' | 'iteration';
  known: boolean;
  value: string | number | null;
  reason: string | null;
  choices: string[];
  problem: string | null;
}

/** One audit entry. */
export interface PanelUiAction {
  id: number;
  createdAt: string;
  actor: string;
  identity: string;
  itemKey: string;
  itemUrl: string | null;
  kind: string;
  result: string;
  errorCode: string | null;
  errorMessage: string | null;
  commentUrl: string | null;
}

/** Parsed `GET /api/v1/items/:source/:item`. */
export interface PanelItem {
  source: string;
  itemId: string;
  key: string;
  url: string;
  type: string;
  repository: string | null;
  title: string;
  state: string | null;
  labels: string[];
  project: { owner: string; number: number; fields: PanelProjectField[]; error: string | null } | null;
  availableLabels: string[];
  labelsError: string | null;
  identities: Array<{ id: string; type: string }>;
  recentActions: PanelUiAction[];
}

const KINDS = ['single_select', 'text', 'number', 'date', 'iteration'] as const;
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strOrNull = (v: unknown, max = 2000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)) : []);

/** Parse one audit entry (untrusted). */
export function parseUiAction(v: unknown): PanelUiAction | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'number') return null;
  return {
    id: a.id,
    createdAt: str(a.createdAt, 40),
    actor: str(a.actor, 320),
    identity: str(a.identity, 200),
    itemKey: str(a.itemKey, 300),
    itemUrl: strOrNull(a.itemUrl),
    kind: str(a.kind, 20),
    result: str(a.result, 20),
    errorCode: strOrNull(a.errorCode, 100),
    errorMessage: strOrNull(a.errorMessage),
    commentUrl: strOrNull(a.commentUrl),
  };
}

/** Parse the item details (untrusted); `null` if unusable. */
export function parseItemDetails(v: unknown): PanelItem | null {
  if (typeof v !== 'object' || v === null) return null;
  const d = v as Record<string, unknown>;
  if (typeof d.source !== 'string' || typeof d.itemId !== 'string') return null;
  const p = d.project as Record<string, unknown> | null | undefined;
  const fields: PanelProjectField[] = [];
  if (p && Array.isArray(p.fields)) {
    for (const raw of p.fields as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const f = raw as Record<string, unknown>;
      if (typeof f.name !== 'string' || !(KINDS as readonly unknown[]).includes(f.kind)) continue;
      fields.push({
        name: f.name.slice(0, 200),
        kind: f.kind as PanelProjectField['kind'],
        known: f.known === true,
        value: typeof f.value === 'string' || typeof f.value === 'number' ? f.value : null,
        reason: strOrNull(f.reason),
        choices: strings(f.choices),
        problem: strOrNull(f.problem),
      });
    }
  }
  return {
    source: d.source,
    itemId: d.itemId,
    key: str(d.key, 300),
    url: str(d.url),
    type: str(d.type, 40),
    repository: strOrNull(d.repository, 300),
    title: str(d.title),
    state: strOrNull(d.state, 40),
    labels: strings(d.labels),
    project: p && typeof p === 'object' ? { owner: str(p.owner, 200), number: typeof p.number === 'number' ? p.number : 0, fields, error: strOrNull(p.error) } : null,
    availableLabels: strings(d.availableLabels),
    labelsError: strOrNull(d.labelsError),
    identities: Array.isArray(d.identities)
      ? (d.identities as unknown[]).flatMap((i) => (typeof i === 'object' && i !== null && typeof (i as { id?: unknown }).id === 'string' ? [{ id: (i as { id: string }).id, type: str((i as { type?: unknown }).type, 40) }] : []))
      : [],
    recentActions: Array.isArray(d.recentActions) ? (d.recentActions as unknown[]).map(parseUiAction).filter((a): a is PanelUiAction => a !== null) : [],
  };
}

/** Why UI actions are not available for this user, `null` if they are. */
export function uiActionsUnavailable(me: AuthMe): string | null {
  if (me.mode === 'none') return 'UI actions need a login: set auth.mode to password or trusted_header (config.yaml). With auth.mode none they are disabled.';
  if (!me.user) return 'Log in to use UI actions.';
  if (me.user.role !== 'admin') return `UI actions require the role admin (you are ${me.user.role}).`;
  return null;
}

// ---------------------------------------------------------------------------
// Pending edits

/** Pending edits of the panel (kept across re-renders until sent). */
export interface PanelState {
  identity: string;
  comment: string;
  /** Labels to add (as typed). */
  addLabels: string[];
  /** Current labels marked for removal (lower case). */
  removeLabels: Set<string>;
  /** Project field edits: name → `{ clear }` or `{ value }` (raw input). */
  fields: Record<string, { clear: true } | { value: string }>;
  /** Last result line. */
  result: { tone: 'ok' | 'error'; text: string; url?: string | null } | null;
}

/** Fresh state; keeps the selected identity if it is still offered. */
export function initialState(item: PanelItem, previous?: PanelState): PanelState {
  const keep = previous && item.identities.some((i) => i.id === previous.identity) ? previous.identity : (item.identities[0]?.id ?? '');
  return { identity: keep, comment: '', addLabels: [], removeLabels: new Set(), fields: {}, result: previous?.result ?? null };
}

/** Add typed label names (comma separated), ignoring duplicates and labels already on the item. */
export function addLabelInput(state: PanelState, item: PanelItem, input: string): void {
  const have = new Set([...item.labels, ...state.addLabels].map((l) => l.toLowerCase()));
  for (const raw of input.split(',')) {
    const name = raw.trim().slice(0, 100);
    if (!name) continue;
    if (have.has(name.toLowerCase())) {
      state.removeLabels.delete(name.toLowerCase());
      continue;
    }
    have.add(name.toLowerCase());
    state.addLabels.push(name);
  }
}

/** Body of `POST …/labels` (without identity), `null` if nothing changes. */
export function labelsRequest(state: PanelState, item: PanelItem): { add: string[]; remove: string[] } | null {
  const remove = item.labels.filter((l) => state.removeLabels.has(l.toLowerCase()));
  if (state.addLabels.length === 0 && remove.length === 0) return null;
  return { add: [...state.addLabels], remove };
}

/** Body of `POST …/project` (without identity) or the input problems. */
export function projectRequest(state: PanelState, item: PanelItem): { fields: Record<string, string | number | null> } | { problems: string[] } | null {
  const fields: Record<string, string | number | null> = {};
  const problems: string[] = [];
  for (const field of item.project?.fields ?? []) {
    const edit = state.fields[field.name];
    if (!edit) continue;
    if ('clear' in edit) {
      fields[field.name] = null;
      continue;
    }
    const raw = edit.value.trim();
    if (raw === '') continue;
    if (field.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) problems.push(`${field.name}: not a number`);
      else fields[field.name] = n;
    } else if (field.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      problems.push(`${field.name}: expected YYYY-MM-DD`);
    } else {
      fields[field.name] = raw;
    }
  }
  if (problems.length > 0) return { problems };
  return Object.keys(fields).length > 0 ? { fields } : null;
}

/** Title of the confirmation dialog. */
export function confirmTitle(item: PanelItem, identity: string): string {
  const type = item.identities.find((i) => i.id === identity)?.type;
  return `Send as ${identity}${type === 'github_app' ? ' (GitHub App)' : type === 'github_token' ? ' (token)' : ''}?`;
}

/** Lines describing what will be sent (confirmation dialog). */
export function confirmLines(kind: 'comment' | 'labels' | 'project', item: PanelItem, payload: unknown): string[] {
  const where = `${item.repository ?? item.source}#${item.itemId}`;
  if (kind === 'comment') {
    const text = String(payload);
    return [`Comment on ${where} (${text.length} characters):`, text.length > 400 ? `${text.slice(0, 400)}…` : text];
  }
  if (kind === 'labels') {
    const p = payload as { add: string[]; remove: string[] };
    return [`Labels on ${where}:`, ...(p.add.length ? [`add: ${p.add.join(', ')}`] : []), ...(p.remove.length ? [`remove: ${p.remove.join(', ')}`] : [])];
  }
  const p = payload as { fields: Record<string, string | number | null> };
  return [`Project fields of ${where}:`, ...Object.entries(p.fields).map(([k, v]) => `${k}: ${v === null ? '(clear)' : String(v)}`)];
}

/** Display text of a current project field value. */
export function fieldValueText(f: PanelProjectField): string {
  if (!f.known) return `unknown${f.reason ? ` (${f.reason})` : ''}`;
  return f.value === null ? '—' : String(f.value);
}

// ---------------------------------------------------------------------------
// Rendering

/** Callbacks of {@link itemPanel}. */
export interface PanelHandlers {
  onIdentity: Listener;
  onCommentInput: Listener;
  onSendComment: Listener;
  onToggleLabel(name: string): void;
  onDropAdded(name: string): void;
  onAddLabel: Listener;
  onApplyLabels: Listener;
  onFieldInput(name: string, ev: unknown): void;
  onFieldClear(name: string, ev: unknown): void;
  onApplyFields: Listener;
  /** Render a timestamp / external link (browser helpers). */
  time(iso: string): Child;
  link(url: string | null, text: string): Child;
}

const KIND_LABEL: Record<string, string> = { comment: 'Comment', labels: 'Labels', project: 'Project fields' };

/** Audit table rows (shared by the panel and the UI actions page). */
export function auditTable<E extends ElementLike>(h: HFn<E>, actions: readonly PanelUiAction[], opts: { time(iso: string): Child; link(url: string | null, text: string): Child; showItem: boolean }): E {
  if (actions.length === 0) return h('p', { class: 'empty' }, 'No UI actions yet.');
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, ['Time', 'User', 'Identity', ...(opts.showItem ? ['Item'] : []), 'Action', 'Result'].map((c) => h('th', { scope: 'col' }, c)))),
      h(
        'tbody',
        null,
        actions.map((a) =>
          h(
            'tr',
            null,
            h('td', null, opts.time(a.createdAt)),
            h('td', null, a.actor),
            h('td', null, h('code', null, a.identity)),
            opts.showItem ? h('td', null, h('a', { href: `#/items/${a.itemKey.split(':').map(encodeURIComponent).join('/')}` }, a.itemKey)) : null,
            h('td', null, KIND_LABEL[a.kind] ?? a.kind),
            h(
              'td',
              null,
              h('span', { class: `badge badge-${a.result === 'succeeded' ? 'ok' : a.result === 'unknown' ? 'warn' : 'error'}` }, a.result),
              a.commentUrl ? [' ', opts.link(a.commentUrl, 'comment')] : null,
              a.errorCode ? h('div', { class: 'error-text' }, `${a.errorCode}${a.errorMessage ? `: ${a.errorMessage}` : ''}`) : null,
            ),
          ),
        ),
      ),
    ),
  );
}

/** The whole panel for one item. */
export function itemPanel<E extends ElementLike>(h: HFn<E>, item: PanelItem, state: PanelState, on: PanelHandlers): E {
  const noIdentity = item.identities.length === 0;
  const disabled = noIdentity || state.identity === '';
  const datalistId = `labels-${item.source}-${item.itemId}`;

  const header = h(
    'div',
    { class: 'item-head' },
    h('h1', null, item.title || `${item.repository ?? item.source}#${item.itemId}`),
    h(
      'p',
      { class: 'muted' },
      `${item.repository ?? item.source}#${item.itemId} · ${item.type === 'pull_request' ? 'pull request' : 'issue'}${item.state ? ` · ${item.state}` : ''} · source ${item.source} · `,
      on.link(item.url, 'Open on GitHub'),
    ),
  );

  const identity = h(
    'section',
    { class: 'card' },
    h('h2', null, 'Act as'),
    noIdentity
      ? h('div', { class: 'alert alert-warn' }, 'No identity is enabled for UI actions. Set ui_actions: true for an identity in identities.yaml and reload the configuration.')
      : h(
          'label',
          { class: 'field identity-field' },
          h('span', null, 'Identity'),
          h(
            'select',
            { class: 'input', name: 'identity', on: { change: on.onIdentity } },
            item.identities.map((i) => h('option', { value: i.id, selected: i.id === state.identity }, `${i.id} (${i.type === 'github_app' ? 'GitHub App' : i.type})`)),
          ),
        ),
    h('p', { class: 'hint' }, 'Comments, labels and project fields are written by this identity, not by you. Every action is recorded in the audit log.'),
    state.result
      ? h('div', { class: `alert alert-${state.result.tone}`, role: state.result.tone === 'error' ? 'alert' : 'status' }, state.result.text, state.result.url ? [' ', on.link(state.result.url, 'Open comment')] : null)
      : null,
  );

  const comment = h(
    'section',
    { class: 'card' },
    h('h2', null, 'Comment'),
    h('textarea', { class: 'input comment-input', name: 'comment', rows: 6, maxlength: 65536, placeholder: 'Markdown; sent as is (secrets are redacted).', 'aria-label': 'Comment', on: { input: on.onCommentInput } }, state.comment),
    h('p', { class: 'hint' }, `${state.comment.length} / 65536 characters · preview (plain text):`),
    h('pre', { class: 'comment-preview' }, state.comment || '—'),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', disabled: disabled || state.comment.trim() === '', on: { click: on.onSendComment } }, 'Send comment…')),
  );

  const chips = item.labels.map((l) => {
    const removing = state.removeLabels.has(l.toLowerCase());
    return h(
      'span',
      { class: `chip${removing ? ' chip-remove' : ''}` },
      h('span', null, l),
      h('button', { type: 'button', class: 'chip-btn', title: removing ? 'Keep label' : 'Remove label', 'aria-label': `${removing ? 'Keep' : 'Remove'} ${l}`, on: { click: () => on.onToggleLabel(l) } }, removing ? '↺' : '×'),
    );
  });
  const added = state.addLabels.map((l) =>
    h('span', { class: 'chip chip-add' }, h('span', null, `+ ${l}`), h('button', { type: 'button', class: 'chip-btn', 'aria-label': `Do not add ${l}`, on: { click: () => on.onDropAdded(l) } }, '×')),
  );
  const labels = h(
    'section',
    { class: 'card' },
    h('h2', null, 'Labels'),
    h('div', { class: 'chips' }, chips.length || added.length ? [...chips, ...added] : h('span', { class: 'muted' }, 'No labels.')),
    h(
      'form',
      { class: 'inline-form', on: { submit: on.onAddLabel } },
      h('input', { class: 'input', name: 'label', list: datalistId, placeholder: 'Add label(s), comma separated', 'aria-label': 'Add label', maxlength: 500 }),
      h('button', { type: 'submit', class: 'btn' }, 'Add'),
    ),
    h('datalist', { id: datalistId }, item.availableLabels.filter((l) => !item.labels.includes(l)).map((l) => h('option', { value: l }))),
    item.labelsError ? h('p', { class: 'hint' }, `Repository labels unavailable: ${item.labelsError}`) : null,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', disabled: disabled || labelsRequest(state, item) === null, on: { click: on.onApplyLabels } }, 'Apply labels…')),
  );

  const fieldEditor = (f: PanelProjectField): E => {
    const edit = state.fields[f.name];
    const value = edit && 'value' in edit ? edit.value : '';
    const cleared = edit !== undefined && 'clear' in edit;
    const input =
      f.kind === 'single_select' || f.kind === 'iteration'
        ? h(
            'select',
            { class: 'input', name: `field-${f.name}`, disabled: cleared, 'aria-label': f.name, on: { change: (ev: unknown) => on.onFieldInput(f.name, ev) } },
            h('option', { value: '', selected: value === '' }, '— keep —'),
            f.choices.map((c) => h('option', { value: c, selected: c === value }, c)),
          )
        : h('input', {
            class: 'input',
            name: `field-${f.name}`,
            type: f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text',
            step: f.kind === 'number' ? 'any' : null,
            value,
            placeholder: 'keep',
            disabled: cleared,
            maxlength: f.kind === 'text' ? 1024 : null,
            'aria-label': f.name,
            on: { input: (ev: unknown) => on.onFieldInput(f.name, ev) },
          });
    return h(
      'tr',
      null,
      h('td', null, h('strong', null, f.name), h('div', { class: 'muted field-kind' }, f.kind)),
      h('td', null, fieldValueText(f)),
      h('td', null, input, f.problem ? h('div', { class: 'error-text' }, f.problem) : null),
      h('td', null, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cleared, on: { change: (ev: unknown) => on.onFieldClear(f.name, ev) } }), 'clear')),
    );
  };
  const fieldsRequest = projectRequest(state, item);
  const project = item.project
    ? h(
        'section',
        { class: 'card span-all' },
        h('h2', null, `Project fields (${item.project.owner}/${item.project.number})`),
        item.project.error ? h('div', { class: 'alert alert-warn' }, `Project metadata unavailable: ${item.project.error}`) : null,
        item.project.fields.length === 0
          ? h('p', { class: 'empty' }, 'No fields declared (sources.yaml: project.fields).')
          : h(
              'div',
              { class: 'table-wrap' },
              h('table', null, h('thead', null, h('tr', null, ['Field', 'Current', 'New value', ''].map((c) => h('th', { scope: 'col' }, c)))), h('tbody', null, item.project.fields.map(fieldEditor))),
            ),
        fieldsRequest && 'problems' in fieldsRequest ? h('div', { class: 'error-text' }, fieldsRequest.problems.join('; ')) : null,
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', disabled: disabled || fieldsRequest === null || 'problems' in fieldsRequest, on: { click: on.onApplyFields } }, 'Apply project fields…')),
      )
    : null;

  return h(
    'div',
    { class: 'item-panel' },
    header,
    h('div', { class: 'grid' }, identity, comment, labels, project),
    h('div', { class: 'spacer' }),
    h('section', { class: 'card' }, h('h2', null, 'Recent UI actions on this item'), auditTable(h, item.recentActions, { time: on.time, link: on.link, showItem: false })),
  );
}
