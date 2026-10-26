/**
 * Item panel and "UI Actions" page (WI-27): act on an issue/PR as a
 * configured identity (comment, labels, project fields) with a confirmation
 * dialog before every send; the audit list of all UI actions. Rendering and
 * request building live in shared/item-panel.ts (text only).
 */
import { api, qs, seg } from '../api.js';
import { currentAuth } from '../auth.js';
import { h, replaceChildren } from '../dom.js';
import type { Page, PageContext } from '../page.js';
import {
  addLabelInput,
  auditTable,
  confirmLines,
  confirmTitle,
  initialState,
  itemPanel,
  commentSecretWarning,
  commentSendable,
  labelsRequest,
  newLabels,
  parseItemDetails,
  parseUiAction,
  projectRequest,
  uiActionsUnavailable,
  type PanelItem,
  type PanelState,
} from '../../shared/item-panel.js';
import { ApiError } from '../api.js';
import { historyHash } from '../../shared/item-history.js';
import { confirmDialog, errorBox, externalLink, loading, routeLink, time, toast } from '../ui.js';

/** Hash of the item panel (WI-33: below the item history route). */
export const itemHash = (source: string, itemId: string): string => `${historyHash(source, itemId)}/act`;

/** Link to the item history (WI-33); every viewer may open it. */
export function historyLink(source: string | null | undefined, itemId: string | null | undefined, text = 'History →'): HTMLElement | null {
  if (!source || !itemId) return null;
  return h('a', { href: historyHash(source, itemId), class: 'item-history', title: 'Runs, hooks, retry blocks and UI actions of this item' }, text);
}

/** `source:id` → link to the item history. */
export function historyLinkForKey(itemKey: string | null | undefined, text?: string): HTMLElement | null {
  if (!itemKey) return null;
  const i = itemKey.indexOf(':');
  return i > 0 ? historyLink(itemKey.slice(0, i), itemKey.slice(i + 1), text) : null;
}

/** Link to the item panel, or `null` when UI actions are not available to the user. */
export function itemPanelLink(source: string | null | undefined, itemId: string | null | undefined, text = 'Act as identity…'): HTMLElement | null {
  if (!source || !itemId || uiActionsUnavailable(currentAuth()) !== null) return null;
  return h('a', { href: itemHash(source, itemId), class: 'item-act', title: 'Comment, labels and project fields as a configured identity' }, text);
}

const errorText = (err: unknown): string => (err instanceof ApiError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err));

/** Search box: URL, owner/repo#nr or source:nr → item panel. */
function searchForm(ctx: PageContext, initial = ''): HTMLElement {
  const input = h('input', { class: 'input', name: 'ref', value: initial, placeholder: 'https://github.com/owner/repo/issues/12, owner/repo#12 or source:12', 'aria-label': 'Item reference', maxlength: 2000, size: 48 }) as HTMLInputElement;
  const message = h('span', { class: 'error-text' });
  return h(
    'form',
    {
      class: 'inline-form item-search',
      on: {
        submit: (ev: Event) => {
          ev.preventDefault();
          const ref = input.value.trim();
          if (!ref) return;
          message.textContent = '';
          void api
            .get<{ source: string; item: string }>(`/api/v1/items/resolve${qs({ ref })}`)
            .then((r) => ctx.navigate(itemHash(r.source, r.item)))
            .catch((err: unknown) => {
              message.textContent = errorText(err);
            });
        },
      },
    },
    input,
    h('button', { type: 'submit', class: 'btn' }, 'Open'),
    message,
  );
}

/** `#/ui-actions`: search + audit list. */
export const uiActionsPage = (ctx: PageContext): Page => {
  ctx.setTitle('UI Actions');
  const body = h('div', null, loading());
  const unavailable = uiActionsUnavailable(currentAuth());
  const el = h(
    'div',
    { class: 'page' },
    h('h1', null, 'UI Actions'),
    h('p', { class: 'muted' }, 'Comment, set labels and project fields on an issue or pull request as a configured identity (identities.yaml: ui_actions: true).'),
    unavailable ? h('div', { class: 'alert alert-info' }, unavailable) : h('section', { class: 'card' }, h('h2', null, 'Open an item'), searchForm(ctx)),
    h('section', { class: 'card' }, h('h2', null, 'Audit log'), body),
  );
  const load = (): void => {
    if (unavailable) {
      replaceChildren(body, h('p', { class: 'empty' }, currentAuth().mode === 'none' ? 'Not available without a login.' : 'Only administrators can see the audit log.'));
      return;
    }
    void api
      .get<{ actions: unknown[]; total: number }>('/api/v1/ui-actions?limit=200')
      .then((res) => {
        const actions = res.actions.map(parseUiAction).filter((a) => a !== null);
        replaceChildren(body, h('p', { class: 'muted' }, `${res.total} entr${res.total === 1 ? 'y' : 'ies'} (newest first, at most 200 shown)`), auditTable(h, actions, { time, link: (u, t) => externalLink(u, t), showItem: true }));
      })
      .catch((err: unknown) => replaceChildren(body, errorBox(err)));
  };
  load();
  return { el, onResync: load };
};

/** `#/items/<source>/<item>/act`: the item panel (WI-33: below the item history route). */
export const itemPage = (ctx: PageContext, source: string, itemId: string): Page => {
  ctx.setTitle(`Item ${source}:${itemId}`);
  const body = h('div', null, loading());
  const el = h('div', { class: 'page' }, h('p', { class: 'crumbs' }, routeLink(['ui-actions'], '← UI Actions'), ' · ', historyLink(source, itemId, 'Item history →')), body);
  const unavailable = uiActionsUnavailable(currentAuth());
  if (unavailable) {
    replaceChildren(body, h('div', { class: 'alert alert-info' }, unavailable));
    return { el };
  }
  let item: PanelItem | null = null;
  let state: PanelState | null = null;
  let busy = false;
  const path = `/api/v1/items/${seg(source)}/${seg(itemId)}`;

  const render = (): void => {
    if (!item || !state) return;
    const s = state;
    const it = item;
    const panel = itemPanel(h, it, s, {
      time,
      link: (u, t) => externalLink(u, t),
      onIdentity: (ev: Event) => {
        s.identity = (ev.target as HTMLSelectElement).value;
        render();
      },
      onCommentInput: (ev: Event) => {
        // Patch in place: a re-render would lose the cursor position.
        s.comment = (ev.target as HTMLTextAreaElement).value;
        const preview = el.querySelector('.comment-preview');
        if (preview) preview.textContent = s.comment || '—';
        const hint = preview?.previousElementSibling;
        if (hint) hint.textContent = `${s.comment.length} / 65536 characters · preview (plain text):`;
        const send = preview?.nextElementSibling?.querySelector('button') as HTMLButtonElement | null | undefined;
        if (send) send.disabled = busy || s.identity === '' || !commentSendable(s.comment);
        const warning = el.querySelector('.secret-warning') as HTMLElement | null;
        if (warning) {
          const text = commentSecretWarning(s.comment);
          warning.textContent = text ?? '';
          warning.hidden = text === null;
        }
      },
      onSendComment: () => void send('comment', s.comment, () => ({ body: s.comment })),
      onToggleLabel: (name) => {
        const k = name.toLowerCase();
        if (s.removeLabels.has(k)) s.removeLabels.delete(k);
        else s.removeLabels.add(k);
        render();
      },
      onDropAdded: (name) => {
        s.addLabels = s.addLabels.filter((l) => l !== name);
        render();
      },
      onAddLabel: (ev: Event) => {
        ev.preventDefault();
        const input = (ev.currentTarget as HTMLFormElement).querySelector('input[name=label]') as HTMLInputElement | null;
        addLabelInput(s, it, input?.value ?? '');
        render();
        (el.querySelector('input[name=label]') as HTMLInputElement | null)?.focus();
      },
      onApplyLabels: () => {
        const req = labelsRequest(s, it);
        if (!req) return;
        const created = newLabels(req.add, it);
        if (created.length === 0) {
          void send('labels', req, () => req);
          return;
        }
        // Unknown labels are created by GitHub: a separate, explicit confirmation first.
        void confirmDialog({
          title: 'Create new label(s)?',
          message: h(
            'div',
            null,
            h('p', null, `These labels do not exist in ${it.repository ?? it.source} yet and will be created there:`),
            h('pre', { class: 'confirm-line' }, created.join('\n')),
          ),
          confirmLabel: 'Create and continue',
          danger: true,
        }).then((res) => {
          if (res.ok) void send('labels', req, () => ({ ...req, create: true }));
        });
      },
      onFieldInput: (name, ev) => {
        s.fields[name] = { value: ((ev as Event).target as HTMLInputElement | HTMLSelectElement).value };
        const req = projectRequest(s, it);
        const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Apply project fields…');
        if (btn) btn.disabled = busy || s.identity === '' || req === null || 'problems' in req;
      },
      onFieldClear: (name, ev) => {
        if (((ev as Event).target as HTMLInputElement).checked) s.fields[name] = { clear: true };
        else delete s.fields[name];
        render();
      },
      onApplyFields: () => {
        const req = projectRequest(s, it);
        if (req && 'fields' in req) void send('project', req, () => req);
      },
    });
    replaceChildren(body, panel);
  };

  const send = async (kind: 'comment' | 'labels' | 'project', summary: unknown, payload: () => Record<string, unknown>): Promise<void> => {
    if (!item || !state || busy) return;
    const it = item;
    const s = state;
    const res = await confirmDialog({
      title: confirmTitle(it, s.identity),
      message: h('div', null, confirmLines(kind, it, summary).map((line, i) => (i === 0 ? h('p', null, line) : h('pre', { class: 'confirm-line' }, line)))),
      confirmLabel: `Send as ${s.identity}`,
    });
    if (!res.ok) return;
    busy = true;
    el.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    try {
      const out = await api.post<{ comment?: { url: string | null }; changed?: boolean; auditWarning?: string }>(`${path}/${kind}`, { identity: s.identity, ...payload() });
      const done =
        kind === 'comment'
          ? `Comment posted as ${s.identity}.`
          : out.changed
            ? `${kind === 'labels' ? 'Labels' : 'Project fields'} updated as ${s.identity}.`
            : 'Nothing changed: the item already had this state.';
      const text = out.auditWarning ? `${done} Warning: ${out.auditWarning}` : done;
      s.result = { tone: out.auditWarning ? 'error' : 'ok', text, url: out.comment?.url ?? null };
      toast(text, 'ok');
      if (kind === 'comment') s.comment = '';
      if (kind === 'labels') {
        s.addLabels = [];
        s.removeLabels = new Set();
      }
      if (kind === 'project') s.fields = {};
    } catch (err) {
      s.result = { tone: 'error', text: errorText(err) };
      toast(errorText(err), 'error');
    } finally {
      busy = false;
    }
    await load();
  };

  const load = async (): Promise<void> => {
    try {
      const parsed = parseItemDetails(await api.get<unknown>(path));
      if (!parsed) throw new Error('Unexpected answer from the server');
      const previous = state;
      item = parsed;
      state = initialState(parsed, previous ?? undefined);
      if (previous) {
        // Keep unsent edits of the other sections.
        state.comment = previous.comment;
        state.addLabels = previous.addLabels;
        state.removeLabels = previous.removeLabels;
        state.fields = previous.fields;
      }
      ctx.setTitle(`${parsed.repository ?? parsed.source}#${parsed.itemId}`);
      render();
    } catch (err) {
      replaceChildren(body, errorBox(err), h('section', { class: 'card' }, h('h2', null, 'Open another item'), searchForm(ctx, `${source}:${itemId}`)));
    }
  };
  void load();
  return { el };
};
