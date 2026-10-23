/** WI-31: branch/tag names of the repository (`listRefs`) for manual-start parameter options. */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, SourceError } from '../../core/index.js';
import { FakeGitHub, createFakeGitHubSource, staticCredentials } from './testing/index.js';

const REPO = 'example/project-a';

let clock: FakeClock;
let github: FakeGitHub;

beforeEach(() => {
  clock = new FakeClock('2026-10-23T12:00:00Z');
  github = new FakeGitHub({ clock });
});

describe('listRefs (WI-31)', () => {
  it('lists branches alphabetically with the default branch first, with the source identity', async () => {
    github.setRepoRefs(REPO, { defaultBranch: 'main', branches: ['zeta', 'main', 'feature/b', 'alpha'] });
    const credentials = staticCredentials();
    const adapter = createFakeGitHubSource(github, { clock, credentials, identity: 'reader' });
    expect(await adapter.listRefs('branches', { limit: 100 })).toEqual(['main', 'alpha', 'feature/b', 'zeta']);
    expect(credentials.calls.every((c) => c === 'reader')).toBe(true);
    expect(github.requests.every((r) => r.token === 'test-token')).toBe(true);
  });

  it('lists tags in API order and paginates up to the limit', async () => {
    const tags = Array.from({ length: 250 }, (_, i) => `v${250 - i}`);
    github.setRepoRefs(REPO, { tags });
    const adapter = createFakeGitHubSource(github, { clock });
    expect(await adapter.listRefs('tags', { limit: 500 })).toEqual(tags);
    expect(github.requests.filter((r) => r.path.endsWith('/tags'))).toHaveLength(3);

    github.requests.length = 0;
    const limited = await adapter.listRefs('tags', { limit: 120 });
    expect(limited).toEqual(tags.slice(0, 120));
    // Stops after the page that reached the limit.
    expect(github.requests.filter((r) => r.path.endsWith('/tags'))).toHaveLength(2);

    expect(await adapter.listRefs('tags', { limit: 5 })).toEqual(tags.slice(0, 5));
  });

  it('keeps the default branch within the limit even if it sorts late', async () => {
    const branches = Array.from({ length: 30 }, (_, i) => `b${String(i).padStart(2, '0')}`).concat(['trunk']);
    github.setRepoRefs(REPO, { defaultBranch: 'trunk', branches });
    const adapter = createFakeGitHubSource(github, { clock });
    const list = await adapter.listRefs('branches', { limit: 10 });
    expect(list).toHaveLength(10);
    expect(list[0]).toBe('trunk');
    expect(list.slice(1)).toEqual(branches.slice(0, 9));
  });

  it('reports errors as SourceError (not found, forbidden, rate limit)', async () => {
    github.setRepoRefs(REPO, { tags: ['v1'] });
    const adapter = createFakeGitHubSource(github, { clock });
    github.restrictRepo(REPO);
    await expect(adapter.listRefs('tags', { limit: 10 })).rejects.toMatchObject({ kind: 'not_found' });
    github.unrestrictRepo(REPO);
    github.failNext({ path: /\/tags$/ }, { status: 403, body: { message: 'Resource not accessible by integration' } });
    await expect(adapter.listRefs('tags', { limit: 10 })).rejects.toMatchObject({ kind: 'forbidden' });
    github.failNext({ path: /\/branches$/ }, { status: 429, body: { message: 'rate limit' }, headers: { 'retry-after': '120' } });
    const err = await adapter.listRefs('branches', { limit: 10, maxRetryWaitMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ kind: 'rate_limited' });
  });
});
