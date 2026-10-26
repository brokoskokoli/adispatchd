import { describe, expect, it } from 'vitest';
import { createH, type DocLike, type ElementLike, type NodeLike } from './dom.js';
import {
  effectLines,
  entryItem,
  githubEntries,
  githubEventText,
  headSection,
  historyHash,
  historyNotes,
  parseEffect,
  parseGitHubEvents,
  parseHistory,
  pathBadge,
  pathSection,
  timelineControls,
  timelineEntries,
  triggerText,
  type EntryKind,
  type HistoryRender,
} from './item-history.js';

class FakeText implements NodeLike {
  readonly nodeType = 3;
  constructor(readonly data: string) {}
}
class FakeElement implements ElementLike {
  readonly nodeType = 1;
  attrs: Record<string, string> = {};
  children: Array<FakeElement | FakeText> = [];
  listeners: Record<string, unknown> = {};
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  appendChild(child: NodeLike): unknown {
    this.children.push(child as FakeElement | FakeText);
    return child;
  }
  addEventListener(type: string, listener: unknown): void {
    this.listeners[type] = listener;
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
  }
  find(tag: string): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(c.tag === tag ? [c] : []), ...c.find(tag)] : []));
  }
}
const doc: DocLike<FakeElement, FakeText> = { createElement: (t) => new FakeElement(t), createTextNode: (d) => new FakeText(d) };
const h = createH(doc);
const r: HistoryRender<FakeElement> = {
  time: (iso) => h('time', null, iso ?? '—'),
  runLink: (id, text) => h('a', { href: `#/runs/${id}` }, text ?? id),
  link: (url, text) => h('a', { href: url, target: '_blank' }, text),
  badge: (label) => h('span', { class: 'badge' }, label),
  routeLink: (hash, text) => h('a', { href: hash }, text),
};

const XSS = '<img src=x onerror=alert(1)>';

const RAW = {
  source: 'repo_a',
  itemId: '7',
  githubEvents: true,
  item: {
    ok: true,
    url: 'https://github.com/example/a/issues/7',
    type: 'issue',
    repository: 'example/a',
    title: `${XSS} Add search`,
    state: 'open',
    labels: ['ready', XSS],
    projectFields: [{ name: 'Status', known: true, value: 'Review', reason: null }],
    linked: { workBranch: { known: true, value: 'feature/7' }, workPr: { known: true, value: 12 }, workPrUrl: 'https://github.com/example/a/pull/12' },
  },
  runs: [
    { id: 'run-1', workflowId: 'coder', workflowName: 'Coder', triggerType: 'source', status: 'completed', active: false, outcome: 'success', finalStatus: 'completed', resultOutcome: 'approved', createdAt: '2026-10-26T10:00:00Z' },
    { id: 'run-2', workflowId: 'coder', workflowName: 'Coder', triggerType: 'source', status: 'crashed', active: false, outcome: 'technical_error', finalStatus: 'crashed', resultOutcome: null, createdAt: '2026-10-26T11:00:00Z' },
    { id: 'run-3', workflowId: 'coder', workflowName: null, triggerType: 'manual', status: 'running', active: true, outcome: 'active', finalStatus: null, resultOutcome: null, createdAt: '2026-10-26T12:00:00Z' },
  ],
  runsTotal: 53,
  truncated: true,
  entries: [
    {
      key: 'hook:run-1:on_result.approved',
      kind: 'hook',
      at: '2026-10-26T10:05:00Z',
      runId: 'run-1',
      workflowId: 'coder',
      workflowName: 'Coder',
      hook: 'on_result.approved',
      actions: [
        { id: 1, name: 'mark-done', type: 'source.update', status: 'succeeded', attempts: 2, effect: { labelsAdded: ['done'], labelsRemoved: ['coding'], projectFields: [{ name: 'Status', from: 'Todo', to: 'Review' }, { name: 'Notes', to: null }] }, effectSource: 'recorded', error: null },
        { id: 2, name: null, type: 'source.comment', status: 'succeeded', attempts: 1, effect: { comment: { id: '5', url: 'javascript:alert(1)' } }, effectSource: 'recorded', error: null },
        { id: 3, name: null, type: 'shell', status: 'failed', attempts: 1, effect: { exitCode: 2 }, effectSource: 'recorded', error: XSS },
      ],
    },
    { key: 'run:run-3:start', kind: 'run_started', at: '2026-10-26T12:00:00Z', runId: 'run-3', workflowId: 'coder', workflowName: null, trigger: 'manual', user: 'olga', parameters: { branch: 'main' }, active: true },
    { key: 'run:run-2:end', kind: 'run_finished', at: '2026-10-26T11:01:00Z', runId: 'run-2', workflowId: 'coder', workflowName: 'Coder', status: 'crashed', result: null, outcome: null, message: null, reason: 'exit code 3', durationMs: 1500, lifecycleStatus: 'succeeded' },
    { key: 'block:1:created', kind: 'block_created', at: '2026-10-26T11:02:00Z', runId: 'run-2', workflowId: 'coder', workflowName: null, blockId: 1, failureCount: 2, lastStatus: 'crashed', active: false },
    { key: 'block:1:cleared', kind: 'block_cleared', at: '2026-10-26T11:30:00Z', runId: 'run-u', workflowId: 'coder', workflowName: null, blockId: 1, clearedBy: 'olga', clearedRunId: 'run-u' },
    { key: 'ui:4', kind: 'ui_action', at: '2026-10-26T11:40:00Z', runId: null, workflowId: null, workflowName: null, actor: 'alice', identity: 'maintainer', action: 'labels', result: 'failed', errorCode: 'github_forbidden', errorMessage: 'nope', effect: null },
    { key: 'x', kind: 'bogus', at: '2026-10-26T11:40:00Z' },
  ],
  entriesTotal: 6,
  nextBefore: 'c1',
  retentionGap: { deletedRuns: 3, newestDeletedAt: '2026-01-02T00:00:00Z' },
  active: { runs: [{ id: 'run-3', workflowId: 'coder', workflowName: null, triggerType: 'manual', status: 'running', active: true, outcome: 'active', createdAt: '2026-10-26T12:00:00Z' }], blocks: [] },
};

describe('item history (WI-33, shared UI)', () => {
  it('parses untrusted data and drops unknown entry kinds', () => {
    expect(parseHistory(null)).toBeNull();
    expect(parseHistory({ entries: 'x', runs: [] })).toBeNull();
    const d = parseHistory(RAW)!;
    expect(d.entries.map((e) => e.kind)).toEqual(['hook', 'run_started', 'run_finished', 'block_created', 'block_cleared', 'ui_action']);
    expect(d).toMatchObject({ runsTotal: 53, truncated: true, nextBefore: 'c1', retentionGap: { deletedRuns: 3 } });
    expect(d.item).toMatchObject({ ok: true, labels: ['ready', XSS] });
    expect(parseHistory({ ...RAW, item: { ok: false, error: { code: 'item_not_found', message: 'gone' } } })?.item).toEqual({ ok: false, error: { code: 'item_not_found', message: 'gone' } });
    expect(parseEffect({ projectFields: [{ name: 'A', to: 1 }, { nope: 1 }] })?.projectFields).toEqual([{ name: 'A', to: 1 }]);
  });

  it('describes effects, triggers and path badges', () => {
    const d = parseHistory(RAW)!;
    const actions = d.entries[0]!.actions!;
    expect(effectLines(actions[0]!.effect)).toEqual(['label + done', 'label − coding', 'Status: Todo → Review', 'Notes: (empty)']);
    expect(effectLines(actions[1]!.effect)).toEqual(['comment written']);
    expect(effectLines(actions[2]!.effect, 'shell')).toEqual(['exit 2']);
    expect(effectLines(parseEffect({ unchanged: true }))).toEqual(['no change (already in this state)']);
    expect(effectLines(parseEffect({ exitCode: null, signal: 'SIGTERM' }), 'shell')).toEqual(['terminated by SIGTERM']);
    expect(effectLines(null)).toEqual([]);
    expect(triggerText('manual', 'olga')).toBe('manual (by olga)');
    expect(triggerText('manual', null)).toBe('manual');
    expect(triggerText('unblock', 'bob')).toBe('unblock (block removed by bob)');
    expect(triggerText('schedule', null)).toBe('schedule');
    expect(d.runs.map((x) => pathBadge(x).label)).toEqual(['approved', 'crashed', 'running']);
    expect(pathBadge({ active: false, status: 'completed', outcome: 'failure', finalStatus: 'completed', resultOutcome: null })).toEqual({ label: 'failure', tone: 'warn' });
    expect(pathBadge({ active: false, status: 'cancelled', outcome: 'cancelled', finalStatus: 'cancelled', resultOutcome: 'x' }).label).toBe('cancelled');
    expect(historyHash('repo a', '7')).toBe('#/items/repo%20a/7');
  });

  it('renders head, path and entries as text only (XSS), unsafe links dropped', () => {
    const d = parseHistory(RAW)!;
    const head = headSection(h, d, r);
    expect(head.textContent).toContain(`${XSS} Add search`);
    expect(head.find('img')).toEqual([]);
    expect(head.textContent).toContain('feature/7');
    expect(head.find('a').map((a) => a.attrs.href)).toContain('https://github.com/example/a/pull/12');
    expect(head.textContent).toContain('Active run: run-3');

    const path = pathSection(h, d, r);
    expect(path.textContent).toContain('older … (50)');
    expect(path.find('a').map((a) => a.attrs.href)).toEqual(['#/runs/run-1', '#/runs/run-2', '#/runs/run-3']);
    expect(pathSection(h, { ...d, runs: [], runsTotal: 0 }, r).textContent).toContain('No runs for this item yet.');

    const items = d.entries.map((e) => entryItem(h, e, r));
    const all = items.map((i) => i.textContent).join('\n');
    expect(all).toContain('Status: Todo → Review');
    expect(all).toContain('2 attempts');
    expect(all).toContain('trigger: manual (by olga) · parameters: branch=main');
    expect(all).toContain('status crashed · 1s');
    expect(all).toContain('2 technical failures, last crashed');
    expect(all).toContain('by olga');
    expect(all).toContain('by alice as maintainer');
    expect(all).toContain(XSS);
    for (const i of items) expect(i.find('img')).toEqual([]);
    // javascript: comment URL is not linked.
    expect(items[0]!.find('a').map((a) => a.attrs.href)).not.toContain('javascript:alert(1)');

    const ui = d.entries.find((e) => e.kind === 'ui_action')!;
    expect(entryItem(h, ui, r).textContent).toContain('github_forbidden');
  });

  it('merges GitHub events into the timeline, filters kinds and switches the order', () => {
    const d = parseHistory(RAW)!;
    const gh = parseGitHubEvents({
      events: [
        { kind: 'labeled', at: '2026-10-26T11:10:00Z', actor: 'octocat', own: false, external: true, label: 'ready' },
        { kind: 'cross-referenced', at: '2026-09-01T00:00:00Z', actor: 'octocat', own: false, external: true, ref: { name: 'example/a#5', title: 'Fix', url: 'https://github.com/example/a/pull/5', isPullRequest: true } },
        { kind: 'closed', at: '2026-10-26T11:20:00Z', actor: 'coder[bot]', own: true, external: false, stateReason: 'completed' },
        { nope: true },
      ],
      hiddenOwn: 4,
      truncated: false,
      limit: 300,
      fetchedAt: '2026-10-26T12:00:00Z',
      cached: true,
      notice: 'n',
    })!;
    expect(gh.events).toHaveLength(3);
    expect(githubEventText(gh.events[0]!)).toBe('label + ready by octocat');
    expect(githubEventText(gh.events[1]!)).toBe('referenced in pull request example/a#5 “Fix” by octocat');
    expect(githubEventText(gh.events[2]!)).toBe('closed (completed) by coder[bot]');
    const ext = githubEntries(gh.events);
    const enabled = new Set<EntryKind>(['run_started', 'run_finished', 'hook', 'github']);
    // Events older than the oldest loaded page entry wait for "load older".
    const desc = timelineEntries(d.entries, ext, enabled, false, '2026-10-26T10:05:00Z');
    expect(desc.map((e) => e.kind)).toEqual(['run_started', 'github', 'github', 'run_finished', 'hook']);
    expect(timelineEntries(d.entries, ext, enabled, true, null).map((e) => e.kind)).toEqual(['github', 'hook', 'run_finished', 'github', 'github', 'run_started']);
    const own = entryItem(h, desc[1]!, r);
    expect(own.textContent).toContain('own identity');
    expect(entryItem(h, desc[2]!, r).textContent).toContain('external');
  });

  it('controls and notes', () => {
    const toggled: string[] = [];
    const c = timelineControls(h, { enabled: new Set(['hook']), ascending: false, githubAvailable: false }, { toggleKind: (k) => toggled.push(k), toggleOrder: () => toggled.push('order') });
    const boxes = c.find('input');
    expect(boxes).toHaveLength(6); // no GitHub checkbox while the events are off
    expect(boxes.filter((b) => b.attrs.checked !== undefined)).toHaveLength(1);
    (boxes[0]!.listeners.change as () => void)();
    expect(toggled).toEqual(['run_started']);
    expect(c.textContent).toContain('Newest first');
    const d = parseHistory(RAW)!;
    expect(historyNotes(h, d).textContent).toContain('Older entries were deleted according to the retention settings (3 runs, the newest from 2026-01-02).');
    expect(historyNotes(h, { ...d, retentionGap: { deletedRuns: null, newestDeletedAt: null } }).textContent).toContain('retention settings.');
    expect(historyNotes(h, { ...d, retentionGap: null }).textContent).not.toContain('retention');
    expect(historyNotes(h, d).textContent).toContain('Planning decisions');
  });

  it('the head explains an unreadable item and still shows active blocks', () => {
    const d = parseHistory({ ...RAW, item: { ok: false, error: { code: 'github_forbidden', message: XSS } }, active: { runs: [], blocks: [{ id: 1, workflowId: 'coder', reason: '2 failures' }] } })!;
    const head = headSection(h, d, r);
    expect(head.textContent).toContain('The item could not be read');
    expect(head.textContent).toContain('The stored history is shown anyway.');
    expect(head.textContent).toContain('coder: 2 failures');
    expect(head.find('img')).toEqual([]);
  });
});
