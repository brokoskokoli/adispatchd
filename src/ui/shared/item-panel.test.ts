import { describe, expect, it } from 'vitest';
import { UNKNOWN_ME, type AuthMe } from './auth.js';
import { createH, type DocLike, type ElementLike, type NodeLike } from './dom.js';
import {
  addLabelInput,
  auditTable,
  confirmLines,
  confirmTitle,
  fieldValueText,
  initialState,
  itemPanel,
  labelsRequest,
  parseItemDetails,
  projectRequest,
  uiActionsUnavailable,
  type PanelHandlers,
  type PanelItem,
} from './item-panel.js';

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

const RAW = {
  source: 'repo_a',
  itemId: '7',
  key: 'repo_a:7',
  url: 'https://github.com/example/a/issues/7',
  type: 'issue',
  repository: 'example/a',
  title: '<img src=x onerror=alert(1)> Fix it',
  state: 'open',
  labels: ['bug', 'ready'],
  project: {
    owner: 'example',
    number: 2,
    error: null,
    fields: [
      { name: 'Status', kind: 'single_select', known: true, value: 'Ready', reason: null, choices: ['Ready', 'Review'], problem: null },
      { name: 'Estimate', kind: 'number', known: false, value: null, reason: 'rate limited', choices: [], problem: null },
      { name: 'Due', kind: 'date', known: true, value: null, reason: null, choices: [], problem: null },
      { name: 'Bogus', kind: 'evil', known: true },
    ],
  },
  availableLabels: ['bug', 'ready', 'wontfix'],
  labelsError: null,
  identities: [{ id: 'maintainer', type: 'github_app' }, { nope: 1 }],
  recentActions: [
    { id: 3, createdAt: '2026-10-19T10:00:00Z', actor: 'alice', identity: 'maintainer', itemKey: 'repo_a:7', kind: 'comment', result: 'succeeded', errorCode: null, errorMessage: null, commentUrl: 'https://github.com/example/a/issues/7#issuecomment-1' },
    { id: 2, createdAt: '2026-10-19T09:00:00Z', actor: 'alice', identity: 'maintainer', itemKey: 'repo_a:7', kind: 'labels', result: 'failed', errorCode: 'github_forbidden', errorMessage: 'locked', commentUrl: null },
    { bad: true },
  ],
};

const item = (): PanelItem => parseItemDetails(RAW) as PanelItem;
const noop = (): void => undefined;
const handlers: PanelHandlers = {
  onIdentity: noop,
  onCommentInput: noop,
  onSendComment: noop,
  onToggleLabel: noop,
  onDropAdded: noop,
  onAddLabel: noop,
  onApplyLabels: noop,
  onFieldInput: noop,
  onFieldClear: noop,
  onApplyFields: noop,
  time: (iso) => h('time', null, iso),
  link: (url, text) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text),
};
const button = (root: FakeElement, label: string): FakeElement => root.find('button').find((b) => b.textContent === label) as FakeElement;

describe('parsing (untrusted API data)', () => {
  it('parses item details and drops malformed parts', () => {
    const it = item();
    expect(it.identities).toEqual([{ id: 'maintainer', type: 'github_app' }]);
    expect(it.project?.fields.map((f) => f.name)).toEqual(['Status', 'Estimate', 'Due']);
    expect(it.recentActions.map((a) => a.id)).toEqual([3, 2]);
    expect(parseItemDetails(null)).toBeNull();
    expect(parseItemDetails({ source: 1 })).toBeNull();
    expect(fieldValueText(it.project!.fields[1]!)).toBe('unknown (rate limited)');
    expect(fieldValueText(it.project!.fields[2]!)).toBe('—');
  });

  it('explains when UI actions are unavailable', () => {
    const me = (o: Partial<AuthMe>): AuthMe => ({ ...UNKNOWN_ME, ...o });
    expect(uiActionsUnavailable(me({ mode: 'none', role: 'admin' }))).toMatch(/auth\.mode/);
    expect(uiActionsUnavailable(me({ mode: 'password' }))).toMatch(/Log in/);
    expect(uiActionsUnavailable(me({ mode: 'password', user: { name: 'o', role: 'operator', via: 'password' }, role: 'operator' }))).toMatch(/admin/);
    expect(uiActionsUnavailable(me({ mode: 'trusted_header', user: { name: 'a', role: 'admin', via: 'trusted_header' }, role: 'admin' }))).toBeNull();
  });
});

describe('pending edits → requests', () => {
  it('builds label changes (case-insensitive, no duplicates)', () => {
    const it = item();
    const s = initialState(it);
    expect(s.identity).toBe('maintainer');
    expect(labelsRequest(s, it)).toBeNull();
    addLabelInput(s, it, ' wontfix, BUG , wontfix,, new ');
    s.removeLabels.add('ready');
    expect(labelsRequest(s, it)).toEqual({ add: ['wontfix', 'new'], remove: ['ready'] });
    addLabelInput(s, it, 'Ready'); // re-adding a label marked for removal keeps it
    expect(labelsRequest(s, it)?.remove).toEqual([]);
  });

  it('builds project field values per kind, with clear and input problems', () => {
    const it = item();
    const s = initialState(it);
    expect(projectRequest(s, it)).toBeNull();
    s.fields = { Status: { value: 'Review' }, Estimate: { value: ' 2.5 ' }, Due: { clear: true } };
    expect(projectRequest(s, it)).toEqual({ fields: { Status: 'Review', Estimate: 2.5, Due: null } });
    s.fields = { Estimate: { value: 'lots' }, Due: { value: '19.10.2026' }, Status: { value: '' } };
    expect(projectRequest(s, it)).toEqual({ problems: ['Estimate: not a number', 'Due: expected YYYY-MM-DD'] });
  });

  it('confirmation names the identity and lists what is sent', () => {
    const it = item();
    expect(confirmTitle(it, 'maintainer')).toBe('Send as maintainer (GitHub App)?');
    expect(confirmLines('labels', it, { add: ['x'], remove: [] })).toEqual(['Labels on example/a#7:', 'add: x']);
    expect(confirmLines('project', it, { fields: { Status: 'Review', Due: null } })).toEqual(['Project fields of example/a#7:', 'Status: Review', 'Due: (clear)']);
    expect(confirmLines('comment', it, 'y'.repeat(500))[1]).toHaveLength(401);
  });
});

describe('panel rendering', () => {
  it('renders everything as text, with a GitHub link in a new tab and per-section buttons', () => {
    const it = item();
    const s = initialState(it);
    const panel = itemPanel(h, it, s, handlers);
    expect(panel.find('h1')[0]?.textContent).toBe('<img src=x onerror=alert(1)> Fix it');
    expect(panel.find('img')).toEqual([]);
    const gh = panel.find('a').find((a) => a.textContent === 'Open on GitHub');
    expect(gh?.attrs).toMatchObject({ href: 'https://github.com/example/a/issues/7', target: '_blank', rel: 'noopener noreferrer' });
    expect(panel.find('option').map((o) => o.textContent)).toEqual(expect.arrayContaining(['maintainer (GitHub App)', '— keep —', 'Ready', 'Review']));
    expect(panel.find('datalist')[0]?.find('option').map((o) => o.attrs.value)).toEqual(['wontfix']);
    // Nothing pending: send/apply disabled.
    for (const label of ['Send comment…', 'Apply labels…', 'Apply project fields…']) expect(button(panel, label).attrs.disabled, label).toBe('');
    // Audit: comment link and error text.
    expect(panel.textContent).toContain('github_forbidden: locked');
    expect(panel.find('a').some((a) => a.textContent === 'comment' && a.attrs.href?.includes('issuecomment-1'))).toBe(true);
  });

  it('enables buttons for pending edits and shows the plain-text preview', () => {
    const it = item();
    const s = initialState(it);
    s.comment = '**bold** <b>x</b>';
    s.removeLabels.add('bug');
    s.fields = { Status: { value: 'Review' } };
    const panel = itemPanel(h, it, s, handlers);
    for (const label of ['Send comment…', 'Apply labels…', 'Apply project fields…']) expect(button(panel, label).attrs.disabled, label).toBeUndefined();
    expect(panel.find('pre')[0]?.textContent).toBe('**bold** <b>x</b>');
    expect(panel.find('b')).toEqual([]);
    expect(panel.find('span').some((sp) => sp.attrs.class === 'chip chip-remove' && sp.textContent.startsWith('bug'))).toBe(true);
  });

  it('without enabled identities shows a hint and disables all actions', () => {
    const it = { ...item(), identities: [] };
    const panel = itemPanel(h, it, { ...initialState(it), comment: 'x' }, handlers);
    expect(panel.textContent).toContain('No identity is enabled for UI actions');
    expect(button(panel, 'Send comment…').attrs.disabled).toBe('');
    expect(panel.find('select').some((sel) => sel.attrs.name === 'identity')).toBe(false);
  });

  it('audit table links items to their panel', () => {
    const table = auditTable(h, item().recentActions, { time: handlers.time, link: handlers.link, showItem: true });
    expect(table.find('a')[0]?.attrs.href).toBe('#/items/repo_a/7');
    expect(auditTable(h, [], { time: handlers.time, link: handlers.link, showItem: true }).textContent).toBe('No UI actions yet.');
  });
});
