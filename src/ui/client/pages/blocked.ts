/**
 * Blocked (Spec §11, §16): internal retry blocks of the orchestrator after
 * repeated technical failures – explicitly NOT GitHub "blocked by" or labels.
 */
import { api } from '../api.js';
import { h, replaceChildren, rerender } from '../dom.js';
import { createRefresher } from '../../shared/throttle.js';
import type { Page, PageContext } from '../page.js';
import type { Block } from '../types.js';
import { act, button, confirmDialog, errorBox, externalLink, loading, routeLink, runLink, table, time } from '../ui.js';

export const blockedPage = (ctx: PageContext): Page => {
  ctx.setTitle('Blocked');
  const body = h('div', null, loading());
  const el = h(
    'div',
    { class: 'page' },
    h('h1', null, 'Blocked'),
    h(
      'div',
      { class: 'alert alert-info' },
      h('strong', null, 'Internal retry blocks only. '),
      'A block is created by the orchestrator after too many consecutive technical failures (crashed, start error, timeout) of a workflow/item. ',
      'This is unrelated to GitHub "blocked by" dependencies or GitHub labels. Removing a block starts a new counting period; history is kept.',
    ),
    body,
  );

  const clear = async (b: Block, btn: HTMLButtonElement): Promise<void> => {
    const r = await confirmDialog({
      title: 'Remove retry block?',
      message: h(
        'div',
        null,
        h('p', null, `Block #${b.id} for workflow ${b.workflowId}${b.itemKey ? `, item ${b.itemKey}` : ' (whole workflow)'} is removed.`),
        h('p', null, 'The scheduler may start the item again in the next planning step. The failure counter starts a new period.'),
      ),
      confirmLabel: 'Remove block',
      danger: true,
    });
    if (!r.ok) return;
    await act(btn, () => api.post(`/api/v1/blocks/${b.id}/clear`, { clearedBy: 'ui' }), 'Block removed');
    ctx.refreshNav();
    await refresher.now();
  };

  const load = async (): Promise<void> => {
    try {
      const res = await api.get<{ blocks: Block[] }>('/api/v1/blocks');
      rerender(
        body,
        table(
          ['Block key', 'Reason', 'Failures', 'Created', 'Runs', 'Source item', ''],
          res.blocks.map((b) => {
            const btn: HTMLButtonElement = button('Remove Block', () => void clear(b, btn), { kind: 'danger', requires: 'operator' });
            const runs = [...new Set([...(b.runId ? [b.runId] : []), ...b.affectedRunIds])];
            return [
              h('span', null, routeLink(['workflows', b.workflowId], b.workflowName ?? b.workflowId), h('br'), h('code', null, b.itemKey ?? '(workflow scope)')),
              b.reason,
              String(b.failureCount),
              time(b.createdAt),
              runs.length ? h('ul', { class: 'plain' }, runs.slice(0, 10).map((id) => h('li', null, runLink(id))), runs.length > 10 ? h('li', { class: 'muted' }, `+${runs.length - 10} more`) : null) : '—',
              externalLink(b.sourceUrl),
              btn,
            ];
          }),
          { empty: 'No active retry blocks.' },
        ),
      );
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 1000);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (msg.type === 'block.created' || msg.type === 'block.cleared') refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
