/**
 * Shared UI widgets: badges, links, tables, JSON blocks, toasts and the
 * custom confirmation dialog (no `alert`/`confirm`/`prompt`).
 */
import { h, type Child } from './dom.js';
import { ApiError } from './api.js';
import { buildHash } from '../shared/route.js';
import { formatDateTime, formatRelative, prettyJson, runBadges, safeHttpUrl, type BadgeInfo, type Tone } from '../shared/format.js';
import type { RunSummary } from './types.js';

/** Small colored label. */
export function badge(label: string, tone: Tone = 'muted', title?: string): HTMLElement {
  return h('span', { class: `badge badge-${tone}`, title: title ?? null }, label);
}

/** Badges of a run outcome (business failure / technical error / cancelled / lifecycle failed). */
export function runOutcomeBadges(run: RunSummary): HTMLElement {
  return h('span', { class: 'badges' }, runBadges(run).map((b: BadgeInfo) => badge(b.label, b.tone, b.title)));
}

/** Link to an internal route. */
export function routeLink(segments: string[], text: Child, query: Record<string, string> = {}): HTMLElement {
  return h('a', { href: buildHash(segments, query) }, text);
}

/** Link to a run detail. */
export function runLink(id: string, text?: string): HTMLElement {
  return routeLink(['runs', id], h('code', null, text ?? id));
}

/** External link (only http(s); otherwise plain text). */
export function externalLink(url: string | null | undefined, text?: string): HTMLElement {
  const safe = safeHttpUrl(url);
  if (!safe) return h('span', { class: 'muted' }, text ?? url ?? '—');
  return h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, text ?? safe);
}

/** Timestamp with absolute time and relative tooltip. */
export function time(iso: string | null | undefined): HTMLElement {
  if (!iso) return h('span', { class: 'muted' }, '—');
  return h('time', { datetime: iso, title: `${iso} (${formatRelative(iso, Date.now())})` }, formatDateTime(iso));
}

/** Plain text or a muted dash. */
export function text(value: unknown): HTMLElement {
  if (value === null || value === undefined || value === '') return h('span', { class: 'muted' }, '—');
  return h('span', null, typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));
}

/** JSON in a scrollable pre block. */
export function jsonBlock(value: unknown, maxChars?: number): HTMLElement {
  if (value === null || value === undefined) return h('span', { class: 'muted' }, '—');
  return h('pre', { class: 'json' }, prettyJson(value, maxChars));
}

/** Key/value list. */
export function kv(rows: Array<[string, Child]>): HTMLElement {
  return h(
    'dl',
    { class: 'kv' },
    rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
  );
}

/** Card section with title. */
export function section(title: Child, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', null, title), ...children);
}

/** Header cell with extra attributes (e.g. `aria-sort`). */
export interface HeaderCell {
  cell: Child;
  attrs: Record<string, string | null>;
}

function isHeaderCell(x: unknown): x is HeaderCell {
  return typeof x === 'object' && x !== null && 'cell' in x && 'attrs' in x;
}

/** Table with header and rows (cells are already safe nodes/strings). */
export function table(headers: Array<Child | HeaderCell>, rows: Child[][], opts: { empty?: string; className?: string } = {}): HTMLElement {
  if (rows.length === 0) return h('p', { class: 'empty' }, opts.empty ?? 'Nothing here.');
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: opts.className ?? null },
      h('thead', null, h('tr', null, headers.map((x) => (isHeaderCell(x) ? h('th', { scope: 'col', ...x.attrs }, x.cell) : h('th', { scope: 'col' }, x))))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))),
    ),
  );
}

/** Button. */
export function button(label: string, onClick: () => void, opts: { kind?: 'primary' | 'danger' | 'plain'; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: `btn btn-${opts.kind ?? 'plain'}`, disabled: opts.disabled ?? false, title: opts.title ?? null, on: { click: () => onClick() } },
    label,
  ) as HTMLButtonElement;
}

/** Error message box. */
export function errorBox(err: unknown): HTMLElement {
  const msg = err instanceof ApiError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err);
  const details = err instanceof ApiError && err.details ? jsonBlock(err.details, 20_000) : null;
  return h('div', { class: 'alert alert-error', role: 'alert' }, h('strong', null, 'Error: '), msg, details);
}

/** True while the user edits a form control inside `root` (live refreshes are postponed). */
export function isEditing(root: HTMLElement): boolean {
  const a = document.activeElement;
  return !!a && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
}

/** Loading placeholder. */
export function loading(): HTMLElement {
  return h('p', { class: 'muted loading' }, 'Loading…');
}

// ---------------------------------------------------------------------------
// Toasts

let toastHost: HTMLElement | null = null;

/** Show a short message (auto-hides). */
export function toast(message: string, tone: Tone = 'info'): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: `toast toast-${tone}` }, message);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), tone === 'error' ? 8000 : 4000);
}

/** Toast for an error (API error text included). */
export function toastError(err: unknown): void {
  const msg = err instanceof ApiError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err);
  toast(msg, 'error');
}

// ---------------------------------------------------------------------------
// Confirmation dialog

/** Options of {@link confirmDialog}. */
export interface ConfirmOptions {
  title: string;
  message: Child;
  confirmLabel: string;
  danger?: boolean;
  /** Optional free-text input (e.g. a cancel reason). */
  input?: { label: string; placeholder?: string };
  /** Optional checkbox (e.g. "process is gone"). */
  checkbox?: { label: string };
}

/** Result of {@link confirmDialog}. */
export interface ConfirmResult {
  ok: boolean;
  value: string;
  checked: boolean;
}

/** Modal confirmation built on `<dialog>`; resolves when closed. */
export function confirmDialog(opts: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    const input = opts.input
      ? (h('input', { type: 'text', class: 'input', placeholder: opts.input.placeholder ?? null, maxlength: 500, 'aria-label': opts.input.label }) as HTMLInputElement)
      : null;
    const checkbox = opts.checkbox ? (h('input', { type: 'checkbox' }) as HTMLInputElement) : null;
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' }) as HTMLDialogElement;
    let result: ConfirmResult = { ok: false, value: '', checked: false };
    const close = (ok: boolean): void => {
      result = { ok, value: input?.value.trim() ?? '', checked: checkbox?.checked ?? false };
      dialog.close();
    };
    const form = h(
      'form',
      { method: 'dialog', on: { submit: (ev: Event) => { ev.preventDefault(); close(true); } } },
      h('h2', { id: 'dialog-title' }, opts.title),
      h('div', { class: 'dialog-body' }, opts.message),
      input ? h('label', { class: 'field' }, h('span', null, opts.input!.label), input) : null,
      checkbox ? h('label', { class: 'check' }, checkbox, ' ', opts.checkbox!.label) : null,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-plain', on: { click: () => close(false) } }, 'Cancel'),
        h('button', { type: 'submit', class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}` }, opts.confirmLabel),
      ),
    );
    dialog.appendChild(form);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.addEventListener('cancel', () => {
      result = { ok: false, value: '', checked: false };
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    (input ?? (form.querySelector('button.btn-plain') as HTMLElement | null))?.focus();
  });
}

/**
 * Run a mutating action with an in-flight-disabled button and toast feedback.
 * Returns the API result or `undefined` on error.
 */
export async function act<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  if (btn) btn.disabled = true;
  try {
    const res = await fn();
    if (success) toast(success, 'ok');
    return res;
  } catch (err) {
    toastError(err);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}
