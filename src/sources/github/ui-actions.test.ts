/**
 * Adapter support for UI actions (WI-27): comments without marker that are
 * never retried, project writes strictly as the chosen identity, field
 * options for the item panel and repository labels.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, SourceError, type AccessToken, type CredentialProvider, type SourceItem } from '../../core/index.js';
import { FakeGitHub, createFakeGitHubSource, type FakeProject } from './testing/index.js';

const REPO = 'example/project-a';

let clock: FakeClock;
let github: FakeGitHub;
let project: FakeProject;

function perIdentityCredentials(): CredentialProvider {
  return {
    getToken: (identity): Promise<AccessToken> => Promise.resolve({ token: `tok-${identity}`, expiresAt: new Date('2999-01-01T00:00:00Z') }),
  };
}

const itemOf = (n: number): SourceItem => ({ sourceId: 'project_a', itemId: String(n), key: `project_a:${n}`, url: '', type: 'issue', fields: {} });

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SourceError) return err;
    throw err;
  }
  throw new Error('expected a SourceError');
}

beforeEach(() => {
  clock = new FakeClock('2026-10-19T12:00:00Z');
  github = new FakeGitHub({ clock });
  project = github.createProject('example', {
    number: 3,
    fields: [
      { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Todo', 'Review'] },
      { name: 'Sprint', dataType: 'ITERATION', iterations: ['Sprint 2'], completedIterations: ['Sprint 1'] },
      { name: 'Notes', dataType: 'TEXT' },
    ],
  });
  github.createIssue(REPO, { number: 1, labels: ['bug'] });
});

describe('postUserComment', () => {
  it('posts the body as is (no marker) and returns id and URL', async () => {
    const ref = await createFakeGitHubSource(github, { clock }).postUserComment(itemOf(1), 'Thanks <!-- x -->', 'maintainer');
    expect(ref.id).toMatch(/^\d+$/);
    expect(ref.url).toContain('/issues/1#issuecomment-');
    expect(github.comments(REPO, 1).map((c) => c.body)).toEqual(['Thanks <!-- x -->']);
  });

  it('is never retried: neither after a rate limit nor after a server error (outcome unknown)', async () => {
    const adapter = createFakeGitHubSource(github, { clock, maxRetries: 3 });
    github.failNext({ method: 'POST', path: /\/comments$/ }, { status: 429, headers: { 'retry-after': '1' } });
    const limited = await failure(adapter.postUserComment(itemOf(1), 'a', 'maintainer'));
    expect(limited.kind).toBe('rate_limited');
    github.failNext({ method: 'POST', path: /\/comments$/ }, { status: 502 });
    const broken = await failure(adapter.postUserComment(itemOf(1), 'b', 'maintainer'));
    expect(broken).toMatchObject({ kind: 'transient', outcomeUnknown: true });
    github.failNext({ method: 'POST', path: /\/comments$/ }, { network: true, afterApply: true });
    const lost = await failure(adapter.postUserComment(itemOf(1), 'c', 'maintainer'));
    expect(lost.outcomeUnknown).toBe(true);
    expect(github.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'))).toHaveLength(3);
    expect(github.comments(REPO, 1).map((c) => c.body)).toEqual(['c']);
  });

  it('refuses items of another source', async () => {
    const err = await failure(createFakeGitHubSource(github, { clock }).postUserComment({ ...itemOf(1), sourceId: 'other' }, 'x', 'maintainer'));
    expect(err.kind).toBe('invalid');
    expect(github.comments(REPO, 1)).toEqual([]);
  });
});

describe('exact identity for project writes', () => {
  it('ignores project.identity of the source with exactIdentity', async () => {
    github.addProjectItem(project, REPO, 1, { Status: 'Todo' });
    const adapter = createFakeGitHubSource(github, {
      clock,
      credentials: perIdentityCredentials(),
      project: { number: 3, identity: 'board', writeIdentity: 'board', fields: { Status: 'single_select' } },
    });
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Review' } }, 'maintainer', { exactIdentity: true });
    const graphql = github.requests.filter((r) => r.graphql);
    expect(graphql.length).toBeGreaterThan(0);
    expect(new Set(graphql.map((r) => r.token))).toEqual(new Set(['tok-maintainer']));
    expect(github.projectValues(project, REPO, 1)?.Status).toBe('Review');

    github.requests.length = 0;
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Todo' } }, 'maintainer');
    expect(new Set(github.requests.filter((r) => r.graphql).map((r) => r.token))).toEqual(new Set(['tok-board']));
  });
});

describe('item panel metadata', () => {
  it('lists declared fields with options, iterations (incl. completed) and problems', async () => {
    const adapter = createFakeGitHubSource(github, {
      clock,
      project: { number: 3, fields: { Status: 'single_select', Sprint: 'iteration', Notes: 'text', Missing: 'number', Estimate: 'date' } },
    });
    github.addProjectField(project, { name: 'Estimate', dataType: 'NUMBER' });
    expect(await adapter.projectFieldOptions()).toEqual([
      { name: 'Status', kind: 'single_select', choices: ['Todo', 'Review'], problem: null },
      { name: 'Sprint', kind: 'iteration', choices: ['Sprint 2', 'Sprint 1'], problem: null },
      { name: 'Notes', kind: 'text', choices: [], problem: null },
      { name: 'Missing', kind: 'number', choices: [], problem: 'not found in GitHub project example/3' },
      { name: 'Estimate', kind: 'date', choices: [], problem: 'has type NUMBER in GitHub project example/3, declared as date' },
    ]);
    expect(await createFakeGitHubSource(github, { clock }).projectFieldOptions()).toEqual([]);
  });

  it('lists repository labels (defined and used)', async () => {
    github.addRepoLabels(REPO, 'ready', 'wontfix');
    expect(await createFakeGitHubSource(github, { clock }).listLabels()).toEqual(['bug', 'ready', 'wontfix']);
  });
});
