/**
 * Item timeline (WI-33): `listItemEvents` reads `GET …/issues/{n}/timeline`
 * with the source identity, keeps only the kinds of the item history, marks
 * events of own identities (app ID via `performed_via_github_app`, login of
 * a token identity) and stops at the limit.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, type AccessToken, type CredentialProvider, type SourceItem } from '../../core/index.js';
import { FakeGitHub, createFakeGitHubSource } from './testing/index.js';

const REPO = 'example/project-a';
const itemOf = (n: number): SourceItem => ({ sourceId: 'project_a', itemId: String(n), key: `project_a:${n}`, url: '', type: 'issue', fields: {} });

let github: FakeGitHub;
let userToken: string;

function credentials(): CredentialProvider {
  return {
    getToken: (identity): Promise<AccessToken> =>
      Promise.resolve({ token: identity === 'pat' ? userToken : `tok-${identity}`, expiresAt: new Date('2999-01-01T00:00:00Z') }),
    describe: (identity) => (identity === 'app' ? { kind: 'github_app', appId: '42' } : identity === 'pat' ? { kind: 'github_token' } : undefined),
  };
}

beforeEach(() => {
  github = new FakeGitHub({ clock: new FakeClock('2026-10-26T12:00:00Z') });
  userToken = github.createUserToken('dev-user');
  github.createIssue(REPO, { number: 1, labels: [] });
});

describe('GitHub adapter: listItemEvents (WI-33)', () => {
  it('returns the history kinds with actor and own flag', async () => {
    github.setLabels(REPO, 1, ['ready']);
    github.addTimelineEvent(REPO, 1, { event: 'labeled', label: { name: 'coding' } }, { login: 'coder[bot]', type: 'Bot', viaAppId: '42' });
    github.addTimelineEvent(REPO, 1, { event: 'labeled', label: { name: 'other' } }, { login: 'other[bot]', type: 'Bot', viaAppId: '99' });
    github.addTimelineEvent(REPO, 1, { event: 'unlabeled', label: { name: 'ready' } }, { login: 'dev-user', type: 'User' });
    github.addTimelineEvent(REPO, 1, { event: 'commented', body: 'secret text' });
    github.addTimelineEvent(REPO, 1, { event: 'renamed', rename: { from: 'Old', to: 'New' } });
    github.addTimelineEvent(REPO, 1, { event: 'assigned', assignee: { login: 'octocat' } });
    github.addTimelineEvent(REPO, 1, {
      event: 'cross-referenced',
      source: { type: 'issue', issue: { number: 5, title: 'Fix', html_url: 'https://github.com/example/project-a/pull/5', pull_request: {}, repository: { full_name: REPO } } },
    });
    github.addTimelineEvent(REPO, 1, { event: 'cross-referenced', source: { issue: { number: 6, html_url: 'javascript:alert(1)' } } });
    github.closeIssue(REPO, 1);

    const adapter = createFakeGitHubSource(github, { credentials: credentials() });
    const page = await adapter.listItemEvents(itemOf(1), { limit: 100, ownIdentities: ['app', 'pat', 'unknown'] });
    expect(page.truncated).toBe(false);
    expect(page.events.map((e) => [e.kind, e.actor, e.own])).toEqual([
      ['labeled', 'octocat', false],
      ['labeled', 'coder[bot]', true],
      ['labeled', 'other[bot]', false],
      ['unlabeled', 'dev-user', true],
      ['renamed', 'octocat', false],
      ['assigned', 'octocat', false],
      ['cross-referenced', 'octocat', false],
      ['cross-referenced', 'octocat', false],
      ['closed', 'octocat', false],
    ]);
    expect(page.events[0]).toMatchObject({ label: 'ready', at: '2026-10-26T12:00:00.000Z' });
    expect(page.events[4]).toMatchObject({ from: 'Old', to: 'New' });
    expect(page.events[5]).toMatchObject({ assignee: 'octocat' });
    expect(page.events[6]?.ref).toEqual({ name: `${REPO}#5`, title: 'Fix', url: 'https://github.com/example/project-a/pull/5', isPullRequest: true });
    expect(page.events[7]?.ref).toMatchObject({ name: '#6', url: null, isPullRequest: false });
    expect(page.events[8]).toMatchObject({ stateReason: 'completed' });
    expect(JSON.stringify(page)).not.toContain('secret text');
    // Read with the source identity.
    const req = github.requests.find((r) => r.path.endsWith('/timeline'));
    expect(req).toBeDefined();
  });

  it('stops at the limit and reports truncation', async () => {
    for (let i = 0; i < 7; i++) github.addTimelineEvent(REPO, 1, { event: 'labeled', label: { name: `l${i}` } });
    const adapter = createFakeGitHubSource(github, { credentials: credentials() });
    const page = await adapter.listItemEvents(itemOf(1), { limit: 5, ownIdentities: [] });
    expect(page.events.map((e) => e.label)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4']);
    expect(page.truncated).toBe(true);
  });

  it('records label and state changes made through the API with their actor', async () => {
    const adapter = createFakeGitHubSource(github, { credentials: credentials() });
    await adapter.applyUpdate(itemOf(1), { labels: { add: ['x'] } }, 'pat');
    const page = await adapter.listItemEvents(itemOf(1), { limit: 10, ownIdentities: ['pat'] });
    expect(page.events).toEqual([expect.objectContaining({ kind: 'labeled', label: 'x', actor: 'dev-user', own: true })]);
  });
});
