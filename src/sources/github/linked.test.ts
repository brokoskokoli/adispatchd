import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, type FieldResolution, type SourceItem } from '../../core/index.js';
import { createItemFieldSource, evaluateFilter } from '../../filters/index.js';
import { CLOSING_PRS_FIRST, LINKED_BRANCHES_FIRST, LINKED_FIELDS, LINKED_QUERY, type GitHubSourceAdapter } from './index.js';
import { FakeGitHub, createFakeGitHubSource } from './testing/index.js';

const REPO = 'example/project-a';
const OTHER = 'example/project-b';
const ALL = [...LINKED_FIELDS];

let clock: FakeClock;
let github: FakeGitHub;
let adapter: GitHubSourceAdapter;
let logger: MemoryLogger;

beforeEach(() => {
  clock = new FakeClock('2026-10-19T12:00:00Z');
  github = new FakeGitHub({ clock });
  logger = new MemoryLogger();
  adapter = createFakeGitHubSource(github, { clock, logger });
});

async function item(n: number): Promise<SourceItem> {
  const it = await adapter.getItem(String(n));
  if (!it) throw new Error(`item ${n} missing`);
  return it;
}

async function values(n: number): Promise<Record<string, FieldResolution>> {
  return adapter.resolveFields(await item(n), ALL);
}

function known(res: Record<string, FieldResolution>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(res).map(([k, v]) => {
      if (!v.known) throw new Error(`${k} unknown: ${v.reason}`);
      return [k, v.value];
    }),
  );
}

function graphqlRequests(): number {
  return github.requests.filter((r) => r.graphql).length;
}

describe('linked branches and closing PRs (WI-21)', () => {
  it('acceptance: linked branch → work_branch; open closing PR → work_pr; after merge + branch deletion the merged PR provides the branch', async () => {
    github.createIssue(REPO, { number: 1 });
    github.linkBranch(REPO, 1, 'feature/1-login');
    expect(known(await values(1))).toEqual({
      linked_branches: ['feature/1-login'],
      closing_prs: [],
      work_branch: 'feature/1-login',
      work_pr: null,
      work_pr_url: null,
    });

    github.openPullRequest(REPO, { number: 2, headRef: 'feature/1-login', closes: [1], isDraft: true });
    expect(known(await values(1))).toEqual({
      linked_branches: ['feature/1-login'],
      closing_prs: [{ number: 2, state: 'open', head_ref: 'feature/1-login', is_draft: true, url: 'https://github.com/example/project-a/pull/2' }],
      work_branch: 'feature/1-login',
      work_pr: 2,
      work_pr_url: 'https://github.com/example/project-a/pull/2',
    });

    github.mergePullRequest(REPO, 2);
    github.deleteBranch(REPO, 'feature/1-login');
    const after = known(await values(1));
    expect(after).toMatchObject({ linked_branches: [], work_branch: 'feature/1-login', work_pr: null, work_pr_url: null });
    expect(after.closing_prs).toEqual([expect.objectContaining({ number: 2, state: 'merged' })]);
  });

  it('sorts closing PRs open → merged → closed, each by number; work_branch prefers the first open PR', async () => {
    github.createIssue(REPO, { number: 1 });
    github.openPullRequest(REPO, { number: 9, headRef: 'b9', closes: [1] });
    github.openPullRequest(REPO, { number: 7, headRef: 'b7', closes: [1] });
    github.openPullRequest(REPO, { number: 5, headRef: 'b5', closes: [1] });
    github.openPullRequest(REPO, { number: 3, headRef: 'b3', closes: [1] });
    github.openPullRequest(REPO, { number: 8, headRef: 'b8', closes: [1] });
    github.mergePullRequest(REPO, 3);
    github.closeIssue(REPO, 5); // closed without merge
    const v = known(await values(1));
    expect((v.closing_prs as Array<{ number: number; state: string }>).map((p) => `${p.number}:${p.state}`)).toEqual([
      '7:open',
      '8:open',
      '9:open',
      '3:merged',
      '5:closed',
    ]);
    expect(v).toMatchObject({ work_branch: 'b7', work_pr: 7 });

    // Only merged/closed left: the merged PR provides the branch, no work PR.
    for (const n of [7, 8, 9]) github.closeIssue(REPO, n);
    expect(known(await values(1))).toMatchObject({ work_branch: 'b3', work_pr: null });
  });

  it('only closed (unmerged) PRs and no link → work_branch and work_pr are null', async () => {
    github.createIssue(REPO, { number: 1 });
    github.openPullRequest(REPO, { number: 2, headRef: 'abandoned', closes: [1] });
    github.closeIssue(REPO, 2);
    expect(known(await values(1))).toMatchObject({ work_branch: null, work_pr: null, closing_prs: [expect.objectContaining({ state: 'closed' })] });
  });

  it('ignores branches and PRs of other repositories; fork PRs count as work PR but not as work branch', async () => {
    github.createIssue(REPO, { number: 1 });
    github.createIssue(OTHER, { number: 1 });
    github.linkBranch(REPO, 1, 'elsewhere', OTHER);
    github.openPullRequest(OTHER, { number: 4, headRef: 'other-repo-pr' });
    github.addClosingReference(OTHER, 4, REPO, 1);
    github.openPullRequest(REPO, { number: 2, headRef: 'fork-branch', closes: [1], crossRepository: true });
    const v = known(await values(1));
    expect(v.linked_branches).toEqual([]);
    expect((v.closing_prs as Array<{ number: number }>).map((p) => p.number)).toEqual([2]);
    expect(v).toMatchObject({ work_pr: 2, work_branch: null });
  });

  it('pull request items: own head ref and own number while open; empty lists', async () => {
    github.openPullRequest(REPO, { number: 3, headRef: 'feature/x' });
    expect(known(await values(3))).toEqual({
      linked_branches: [],
      closing_prs: [],
      work_branch: 'feature/x',
      work_pr: 3,
      work_pr_url: 'https://github.com/example/project-a/pull/3',
    });
    github.mergePullRequest(REPO, 3);
    expect(known(await values(3))).toMatchObject({ work_branch: 'feature/x', work_pr: null, work_pr_url: null });
  });

  it('reads all fields with ONE GraphQL query; owner, name and number only as variables', async () => {
    github.createIssue(REPO, { number: 12 });
    const it12 = await item(12);
    const before = graphqlRequests();
    await adapter.resolveFields(it12, ['work_branch', 'work_pr', 'closing_prs', 'linked_branches']);
    expect(graphqlRequests() - before).toBe(1);
    const req = github.requests.filter((r) => r.graphql).at(-1);
    expect(req?.graphql?.variables).toEqual({ owner: 'example', name: 'project-a', number: 12 });
    expect(req?.graphql?.query).toBe(LINKED_QUERY);
    expect(LINKED_QUERY).not.toMatch(/project-a|example|\b12\b/);
    expect(LINKED_QUERY).toContain(`linkedBranches(first: ${LINKED_BRANCHES_FIRST})`);
    expect(LINKED_QUERY).toContain(`closedByPullRequestsReferences(first: ${CLOSING_PRS_FIRST}, includeClosedPrs: true)`);
    // Cheap fields and other expensive fields do not trigger the query.
    await adapter.resolveFields(it12, ['title', 'dependencies.status']);
    expect(graphqlRequests() - before).toBe(1);
  });

  it('partial GraphQL error → all fields unknown with reason (fail closed)', async () => {
    github.createIssue(REPO, { number: 1 });
    github.linkBranch(REPO, 1, 'b');
    github.denyLinked(REPO, 1);
    const res = await values(1);
    for (const f of ALL) {
      expect(res[f]).toEqual({ known: false, reason: expect.stringMatching(/project_a:1 not readable: GraphQL error: FORBIDDEN/) });
    }
    expect(logger.records.some((e) => e.msg === 'Could not read linked branches/PRs')).toBe(true);
  });

  it('HTTP errors, missing repository and missing item → unknown', async () => {
    github.createIssue(REPO, { number: 1 });
    const it1 = await item(1);
    github.failNext({ path: '/graphql' }, { status: 502 });
    expect((await adapter.resolveFields(it1, ['work_pr'])).work_pr).toEqual({ known: false, reason: expect.stringMatching(/transient/) });
    github.restrictRepo(REPO);
    expect((await adapter.resolveFields(it1, ['work_branch'])).work_branch).toMatchObject({ known: false });
    github.unrestrictRepo(REPO);
    const ghost: SourceItem = { ...it1, itemId: '99', key: 'project_a:99' };
    expect((await adapter.resolveFields(ghost, ['work_branch'])).work_branch).toEqual({
      known: false,
      reason: expect.stringMatching(/NOT_FOUND/),
    });
  });

  it('more results than read → unknown', async () => {
    github.createIssue(REPO, { number: 1 });
    for (let i = 0; i < LINKED_BRANCHES_FIRST + 1; i++) github.linkBranch(REPO, 1, `b${i}`);
    expect((await values(1)).work_branch).toEqual({ known: false, reason: expect.stringMatching(/more than 20 linked branches \(21\)/) });

    github.createIssue(REPO, { number: 50 });
    for (let i = 0; i < CLOSING_PRS_FIRST + 1; i++) github.openPullRequest(REPO, { headRef: `p${i}`, closes: [50] });
    expect((await values(50)).work_pr).toEqual({ known: false, reason: expect.stringMatching(/more than 20 closing pull requests/) });
  });

  it('a rate limit pauses the reads until the reset (no GitHub call meanwhile)', async () => {
    github.createIssue(REPO, { number: 1 });
    github.linkBranch(REPO, 1, 'b');
    const it1 = await item(1);
    github.failNext({ path: '/graphql' }, { status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } });
    expect((await adapter.resolveFields(it1, ['work_branch'])).work_branch).toEqual({
      known: false,
      reason: expect.stringMatching(/rate_limited/),
    });
    const before = graphqlRequests();
    clock.advance(30_000);
    expect((await adapter.resolveFields(it1, ['work_branch'])).work_branch).toEqual({
      known: false,
      reason: expect.stringMatching(/GitHub GraphQL rate limit until 2026-10-19T12:01:00.000Z/),
    });
    expect(graphqlRequests()).toBe(before);
    clock.advance(31_000);
    expect((await adapter.resolveFields(it1, ['work_branch'])).work_branch).toEqual({ known: true, value: 'b' });
    expect(logger.records.some((e) => e.msg === 'Linked branches/PRs readable again')).toBe(true);
  });

  it('filters: work_pr not_equals null is true/false/unknown', async () => {
    github.createIssue(REPO, { number: 1 });
    github.createIssue(REPO, { number: 2 });
    github.openPullRequest(REPO, { number: 3, headRef: 'x', closes: [1] });
    const filter = { field: 'work_pr', operator: 'not_equals' as const, value: null };
    const verdict = async (n: number): Promise<unknown> => {
      const it = await item(n);
      const source = createItemFieldSource(it, {
        definitions: adapter.fieldDefinitions(),
        resolveFields: (i, f) => adapter.resolveFields(i, f),
        wantedFields: ['work_pr'],
      });
      return (await evaluateFilter(filter, source)).value;
    };
    expect(await verdict(1)).toBe(true);
    expect(await verdict(2)).toBe(false);
    github.denyLinked(REPO, 2);
    expect(await verdict(2)).toBe('unknown');
  });
});
