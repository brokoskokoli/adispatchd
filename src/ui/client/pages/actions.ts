/** Failed Actions (Spec §10, §16): errors, attempts, manual retry / skip. */
import { api } from '../api.js';
import { h, replaceChildren, rerender } from '../dom.js';
import { createRefresher } from '../../shared/throttle.js';
import type { Page, PageContext } from '../page.js';
import type { Action } from '../types.js';
import { errorBox, loading } from '../ui.js';
import { actionsTable } from './run.js';

export const failedActionsPage = (ctx: PageContext): Page => {
  ctx.setTitle('Failed Actions');
  const body = h('div', null, loading());
  const el = h(
    'div',
    { class: 'page' },
    h('h1', null, 'Failed Actions'),
    h('p', { class: 'hint' }, 'Lifecycle actions whose attempts are exhausted ("lifecycle failed"). Retry starts a fresh attempt budget; the hook chain continues afterwards in the background.'),
    body,
  );
  const after = (): void => {
    ctx.refreshNav();
    refresher.trigger();
  };
  const load = async (): Promise<void> => {
    try {
      const res = await api.get<{ actions: Action[] }>('/api/v1/actions/failed');
      rerender(body, res.actions.length ? actionsTable(res.actions, after, { showRun: true }) : h('p', { class: 'empty' }, 'No failed lifecycle actions.'));
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 1000);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (msg.type === 'run.action' || (msg.type === 'run.event' && String(msg.payload.type).startsWith('lifecycle.'))) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
