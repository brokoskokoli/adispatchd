import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor, commentMarker, type SourceItem } from '../../core/index.js';
import { GitHubAppCredentialProvider } from '../../identities/index.js';
import { DEPENDENCY_FIELDS, GitHubSourceAdapter, githubSourceFactory, pushdownQuery } from './index.js';
import { FakeGitHub, createFakeGitHubSource, staticCredentials } from './testing/index.js';

const REPO = 'example/project-a';
const OTHER = 'example/project-b';

let clock: FakeClock;
let github: FakeGitHub;
let adapter: GitHubSourceAdapter;

beforeEach(() => {
  clock = new FakeClock('2026-10-16T12:00:00Z');
  github = new FakeGitHub({ clock });
  adapter = createFakeGitHubSource(github, { clock });
});

async function item(n: number): Promise<SourceItem> {
  const it = await adapter.getItem(String(n));
  if (!it) throw new Error(`item ${n} missing`);
  return it;
}

describe('listCandidates / getItem', () => {
  it('maps issues and PRs with cheap fields and the core item key', async () => {
    github.createIssue(REPO, { title: 'Bug', labels: ['ready-for-coding', 'bug'], assignees: ['alice'], author: 'bob' });
    clock.advance(1000);
    github.createIssue(REPO, { title: 'PR', isPullRequest: true });
    github.createIssue(REPO, { title: 'Closed', state: 'closed' });

    const items = await adapter.listCandidates();
    expect(items.map((i) => i.itemId)).toEqual(['1', '2']);
    const [issue, pr] = items as [SourceItem, SourceItem];
    expect(issue).toMatchObject({
      sourceId: 'project_a',
      itemId: '1',
      key: 'project_a:1',
      type: 'issue',
      url: 'https://github.com/example/project-a/issues/1',
      createdAt: '2026-10-16T12:00:00.000Z',
    });
    expect(issue.fields).toEqual({
      number: 1,
      title: 'Bug',
      state: 'open',
      labels: ['ready-for-coding', 'bug'],
      assignees: ['alice'],
      author: 'bob',
      is_pull_request: false,
      created_at: '2026-10-16T12:00:00.000Z',
      updated_at: '2026-10-16T12:00:00.000Z',
      url: 'https://github.com/example/project-a/issues/1',
      repository: 'example/project-a',
    });
    for (const f of DEPENDENCY_FIELDS) expect(issue.fields).not.toHaveProperty(f);
    expect(pr).toMatchObject({ type: 'pull_request', url: 'https://github.com/example/project-a/pull/2' });
    expect(pr.fields.is_pull_request).toBe(true);
  });

  it('pushes label contains and state into query parameters', async () => {
    github.createIssue(REPO, { labels: ['ready-for-coding'] });
    github.createIssue(REPO, { labels: ['other'] });
    const items = await adapter.listCandidates({
      filter: {
        all: [
          { field: 'labels', operator: 'contains', value: 'ready-for-coding' },
          { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 },
        ],
      },
    });
    expect(items.map((i) => i.itemId)).toEqual(['1']);
    const req = github.requests.at(-1);
    expect(req?.query).toMatchObject({ state: 'open', labels: 'ready-for-coding', per_page: '100' });

    expect(pushdownQuery({ field: 'state', operator: 'equals', value: 'closed' }).state).toBe('closed');
    expect(pushdownQuery({ field: 'state', operator: 'in', value: ['open', 'closed'] }).state).toBe('all');
    // Disjunctions and negations are never pushed down.
    expect(pushdownQuery({ any: [{ field: 'labels', operator: 'contains', value: 'a' }] })).toEqual({ state: 'open', labels: [] });
    expect(pushdownQuery({ not: { field: 'labels', operator: 'contains', value: 'a' } })).toEqual({ state: 'open', labels: [] });
    expect(pushdownQuery({ field: 'labels', operator: 'contains', value: 'a,b' }).labels).toEqual([]);
  });

  it('getItem returns null for missing items and invalid ids', async () => {
    github.createIssue(REPO);
    expect(await adapter.getItem('1')).not.toBeNull();
    expect(await adapter.getItem('99')).toBeNull();
    expect(await adapter.getItem('../x')).toBeNull();
  });

  it('parses item references', () => {
    expect(adapter.parseItemRef('123')).toBe('123');
    expect(adapter.parseItemRef('#7')).toBe('7');
    expect(adapter.parseItemRef('https://github.com/example/project-a/issues/123')).toBe('123');
    expect(adapter.parseItemRef('https://github.com/Example/Project-A/pull/45/files#diff')).toBe('45');
    expect(adapter.parseItemRef('example/project-a#9')).toBe('9');
    expect(adapter.parseItemRef('https://github.com/example/project-b/issues/1')).toBeNull();
    expect(adapter.parseItemRef('https://evil.example/example/project-a/issues/1')).toBeNull();
    expect(adapter.parseItemRef('https://github.com/example/project-a/discussions/1')).toBeNull();
    expect(adapter.parseItemRef('0')).toBeNull();
    expect(adapter.parseItemRef('abc')).toBeNull();
  });

  it('is created through the factory', () => {
    const a = githubSourceFactory.create(
      'project_b',
      { owner: 'example', repository: 'project-b', identity: 'maintainer' },
      { credentials: staticCredentials(), logger: new MemoryLogger(), clock },
    );
    expect(a).toMatchObject({ type: 'github', sourceId: 'project_b', repository: 'example/project-b' });
    expect(a.fieldDefinitions().find((f) => f.name === 'dependencies.blocked_by_open')?.expensive).toBe(true);
  });
});

describe('resolveFields / dependencies', () => {
  it('scenario 3: cross-repo open blocker → blocked_by_open=1; after closing → 0', async () => {
    github.createIssue(REPO, { labels: ['ready-for-coding'] });
    github.createIssue(OTHER, { title: 'Blocker' });
    github.createIssue(OTHER, { title: 'Done blocker', state: 'closed' });
    github.addBlockedBy(REPO, 1, OTHER, 1);
    github.addBlockedBy(REPO, 1, OTHER, 2);

    const [candidate] = await adapter.listCandidates();
    const before = await adapter.resolveFields(candidate as SourceItem, [...DEPENDENCY_FIELDS]);
    expect(before).toEqual({
      'dependencies.blocked_by_total': { known: true, value: 2 },
      'dependencies.blocked_by_open': { known: true, value: 1 },
      'dependencies.blocked': { known: true, value: true },
      'dependencies.status': { known: true, value: 'ok' },
    });
    // One API round trip for all dependency fields.
    expect(github.requests.filter((r) => r.path.endsWith('/dependencies/blocked_by'))).toHaveLength(1);

    github.closeIssue(OTHER, 1);
    const [next] = await adapter.listCandidates();
    const after = await adapter.resolveFields(next as SourceItem, ['dependencies.blocked_by_open', 'dependencies.blocked']);
    expect(after).toEqual({
      'dependencies.blocked_by_open': { known: true, value: 0 },
      'dependencies.blocked': { known: true, value: false },
    });
  });

  it('does not cache across calls', async () => {
    github.createIssue(REPO);
    github.createIssue(OTHER);
    const it1 = await item(1);
    expect((await adapter.resolveFields(it1, ['dependencies.blocked_by_open']))['dependencies.blocked_by_open']).toEqual({
      known: true,
      value: 0,
    });
    github.addBlockedBy(REPO, 1, OTHER, 1);
    expect((await adapter.resolveFields(it1, ['dependencies.blocked_by_open']))['dependencies.blocked_by_open']).toEqual({
      known: true,
      value: 1,
    });
  });

  it('missing access (403) yields unknown, not 0', async () => {
    github.createIssue(REPO);
    github.denyDependencies(REPO, 1);
    const res = await adapter.resolveFields(await item(1), [...DEPENDENCY_FIELDS]);
    expect(res['dependencies.blocked_by_open']).toMatchObject({ known: false });
    expect(res['dependencies.blocked_by_total']).toMatchObject({ known: false });
    expect(res['dependencies.blocked']).toMatchObject({ known: false });
    expect(res['dependencies.status']).toEqual({ known: true, value: 'unknown' });
    expect((res['dependencies.blocked_by_open'] as { reason: string }).reason).toContain('forbidden');
  });

  it('blockers in an inaccessible repository yield unknown (fail closed)', async () => {
    github.createIssue(REPO);
    github.createIssue(OTHER);
    github.addBlockedBy(REPO, 1, OTHER, 1);
    github.restrictRepo(OTHER);
    const res = await adapter.resolveFields(await item(1), ['dependencies.blocked_by_open', 'dependencies.status']);
    expect(res['dependencies.blocked_by_open']).toMatchObject({ known: false, reason: expect.stringContaining('not visible') });
    expect(res['dependencies.status']).toEqual({ known: true, value: 'unknown' });
  });

  it('404 / 5xx / rate limit on the dependency endpoint yield unknown', async () => {
    github.createIssue(REPO);
    const it1 = await item(1);
    for (const status of [404, 500, 429]) {
      github.failNext({ path: /blocked_by$/ }, { status, headers: status === 429 ? { 'retry-after': '1' } : {} });
      const res = await adapter.resolveFields(it1, ['dependencies.blocked_by_open']);
      expect(res['dependencies.blocked_by_open']).toMatchObject({ known: false });
    }
  });

  it('returns cheap fields, and unknown names as known:false', async () => {
    github.createIssue(REPO, { labels: ['a'] });
    const res = await adapter.resolveFields(await item(1), ['labels', 'nope']);
    expect(res.labels).toEqual({ known: true, value: ['a'] });
    expect(res.nope).toMatchObject({ known: false });
    expect(github.requests.some((r) => r.path.endsWith('blocked_by'))).toBe(false);
  });
});

describe('applyUpdate', () => {
  it('is idempotent and preserves manually set foreign labels', async () => {
    github.createIssue(REPO, { labels: ['ready-for-coding', 'priority:high'] });
    const it1 = await item(1);
    // Manual change after the snapshot was taken.
    github.setLabels(REPO, 1, ['ready-for-coding', 'priority:high', 'manual-label']);

    const first = await adapter.applyUpdate(it1, { labels: { add: ['coding'], remove: ['ready-for-coding'] } }, 'coder');
    expect(first).toEqual({ changed: true, applied: { labelsAdded: ['coding'], labelsRemoved: ['ready-for-coding'] } });
    expect(github.labels(REPO, 1).sort()).toEqual(['coding', 'manual-label', 'priority:high']);

    const second = await adapter.applyUpdate(it1, { labels: { add: ['coding'], remove: ['ready-for-coding'] } }, 'coder');
    expect(second).toEqual({ changed: false });
    expect(github.labels(REPO, 1).sort()).toEqual(['coding', 'manual-label', 'priority:high']);
    const writes = github.requests.filter((r) => r.method !== 'GET');
    expect(writes).toHaveLength(2); // one POST + one DELETE in total
  });

  it('URL-encodes label names and compares case-insensitively', async () => {
    github.createIssue(REPO, { labels: ['Priority: High/Urgent', 'Coding'] });
    const it1 = await item(1);
    const res = await adapter.applyUpdate(it1, { labels: { add: ['coding'], remove: ['priority: high/urgent'] } }, 'coder');
    expect(res.applied).toEqual({ labelsAdded: [], labelsRemoved: ['Priority: High/Urgent'] });
    const del = github.requests.find((r) => r.method === 'DELETE');
    expect(del?.path).toBe('/repos/example/project-a/issues/1/labels/Priority%3A%20High%2FUrgent');
    expect(github.labels(REPO, 1)).toEqual(['Coding']);
  });

  it('treats a concurrently removed label as done', async () => {
    github.createIssue(REPO, { labels: ['x'] });
    const it1 = await item(1);
    github.failNext({ method: 'DELETE' }, { status: 404, body: { message: 'Label does not exist' } });
    await expect(adapter.applyUpdate(it1, { labels: { remove: ['x'] } }, 'coder')).resolves.toEqual({ changed: false });
  });

  it('uses the given identity for writes', async () => {
    github.createIssue(REPO);
    const creds = staticCredentials();
    const a = createFakeGitHubSource(github, { clock, credentials: creds });
    await a.applyUpdate((await a.getItem('1')) as SourceItem, { labels: { add: ['l'] } }, 'coder');
    expect(creds.calls).toEqual(['maintainer', 'coder', 'coder']);
  });
});

describe('comments with marker', () => {
  it('appends the marker as HTML comment and finds it again instead of duplicating', async () => {
    github.createIssue(REPO);
    const it1 = await item(1);
    const marker = commentMarker('run-20261016T120000000Z-3fa2c91b', 'a2');
    expect(await adapter.findCommentByMarker(it1, marker, 'coder')).toBeNull();

    // First attempt: the comment is created but the response is lost (outcome unknown).
    github.failNext({ method: 'POST', path: /comments$/ }, { network: true, afterApply: true });
    const err = await adapter.postComment(it1, 'Coder started.', marker, 'coder').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'transient', outcomeUnknown: true });

    // Retry path (WI-07): reconcile via marker → existing comment found, no duplicate.
    const found = await adapter.findCommentByMarker(it1, marker, 'coder');
    expect(found).not.toBeNull();
    const comments = github.comments(REPO, 1);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(`Coder started.\n\n<!-- ${marker} -->`);
    expect(found).toEqual({ id: String(comments[0]?.id), url: expect.stringContaining('#issuecomment-') });
  });

  it('returns a reference for posted comments and ignores other markers / quoted markers', async () => {
    github.createIssue(REPO);
    const it1 = await item(1);
    const marker = commentMarker('run-1', 'a1');
    github.addComment(REPO, 1, `> quoted\n> <!-- ${marker} -->`, 'human');
    github.addComment(REPO, 1, `<!-- ${commentMarker('run-1', 'a10')} -->`, 'bot');
    expect(await adapter.findCommentByMarker(it1, marker, 'coder')).toBeNull();
    const ref = await adapter.postComment(it1, 'hello', marker, 'coder');
    expect(await adapter.findCommentByMarker(it1, marker, 'coder')).toEqual(ref);
  });

  it('searches all comment pages', async () => {
    github.createIssue(REPO);
    for (let i = 0; i < 230; i++) github.addComment(REPO, 1, `comment ${i}`);
    const marker = commentMarker('run-x', '1');
    github.addComment(REPO, 1, `late\n<!-- ${marker} -->`);
    expect(await adapter.findCommentByMarker(await item(1), marker, 'coder')).not.toBeNull();
  });

  it('rejects markers that could break out of the HTML comment', async () => {
    github.createIssue(REPO);
    await expect(adapter.postComment(await item(1), 'x', 'orch:a --> <b>', 'coder')).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('with GitHub App credentials', () => {
  it('works end-to-end, refreshes after 401 and never logs tokens or keys', async () => {
    const coder = github.createApp({ login: 'coder-bot[bot]' });
    const maintainer = github.createApp({ login: 'maintainer-bot[bot]' });
    const redactor = new SecretRedactor();
    const logger = new MemoryLogger(redactor.asRedactor);
    const env = { CODER_KEY: coder.privateKeyPem, MAINT_KEY: maintainer.privateKeyPem.replace(/\n/g, '\\n') };
    const credentials = new GitHubAppCredentialProvider(
      {
        coder: { appId: coder.appId, installationId: coder.installationId, privateKeyEnv: 'CODER_KEY' },
        maintainer: { appId: maintainer.appId, installationId: maintainer.installationId, privateKeyEnv: 'MAINT_KEY' },
      },
      { clock, fetch: github.fetch, env, redactor, logger },
    );
    const a = createFakeGitHubSource(github, { clock, credentials, logger });
    github.createIssue(REPO, { labels: ['ready-for-coding'] });
    github.createIssue(OTHER);
    github.addBlockedBy(REPO, 1, OTHER, 1);

    const [it1] = await a.listCandidates();
    const deps = await a.resolveFields(it1 as SourceItem, ['dependencies.blocked_by_open']);
    expect(deps['dependencies.blocked_by_open']).toEqual({ known: true, value: 1 });
    await a.postComment(it1 as SourceItem, 'hi', commentMarker('run-1', 'a1'), 'coder');
    expect(github.comments(REPO, 1)[0]?.author).toBe('coder-bot[bot]');

    // Token revoked server-side → 401 → invalidate + one retry with a fresh token.
    const issuedBefore = github.tokenRequestCount();
    github.failNext({ method: 'POST', path: /\/labels$/ }, { status: 401, body: { message: 'Bad credentials' } });
    await a.applyUpdate(it1 as SourceItem, { labels: { add: ['coding'] } }, 'coder');
    expect(github.tokenRequestCount()).toBe(issuedBefore + 1);
    expect(github.labels(REPO, 1)).toContain('coding');

    // Force failures that end up in warn logs / errors.
    github.denyDependencies(REPO);
    await a.resolveFields(it1 as SourceItem, ['dependencies.status']);
    github.failNext({ path: /comments$/ }, { status: 500 });
    const err = await a.postComment(it1 as SourceItem, 'x', commentMarker('run-1', 'a2'), 'coder').catch((e: unknown) => e);

    const tokens = github.requests.map((r) => r.token).filter((t): t is string => typeof t === 'string');
    const haystack = `${JSON.stringify(logger.records)}\n${String(err)}\n${JSON.stringify(err)}`;
    for (const token of new Set(tokens)) expect(haystack).not.toContain(token);
    expect(haystack).not.toContain('PRIVATE KEY');
    expect(haystack).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
