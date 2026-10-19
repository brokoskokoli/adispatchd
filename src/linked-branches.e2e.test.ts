/**
 * End-to-end (WI-21): complete app with configuration files and Fake-GitHub.
 * A workflow filters on `work_pr not_equals null` and hands
 * `{item.work_branch}` / `{item.work_pr}` to the worker; the dry-run shows the
 * values, a view shows `work_pr` (linked to the PR), `work_branch` and
 * `closing_prs` – with one GraphQL query per item.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';
import { formatDryRun } from './scheduler/index.js';

let env: AppEnv;

beforeAll(async () => {
  env = await startAppEnv({}, (e) => {
    const worker = e.script(
      'reviewer.sh',
      `printf '%s %s' "$1" "$2" > "${e.marks}/args-$ADISPATCH_SOURCE_ITEM_ID.txt"
printf '{"schema_version":1,"result":"success","message":"ok"}' > "$ADISPATCH_RESULT_FILE"`,
    );
    writeFileSync(
      path.join(e.configDir, 'workflows', 'reviewer.yaml'),
      [
        'id: reviewer',
        'name: Reviewer',
        'max_concurrent: 2',
        'trigger: { type: source, source: repo_a }',
        'filter: { field: work_pr, operator: not_equals, value: null }',
        'execute:',
        '  type: shell',
        `  command: ${worker}`,
        "  args: ['{item.work_branch}', '{item.work_pr}']",
        'on_success:',
        "  - { type: source.comment, message: 'Reviewed PR #{item.work_pr}' }",
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(e.configDir, 'views', 'work.yaml'),
      [
        'id: work',
        'sources: [repo_a]',
        'fields:',
        '  - { field: title, link: url }',
        '  - { field: work_pr, label: PR }',
        '  - { field: work_branch, label: Branch }',
        '  - { field: closing_prs, label: Closing PRs }',
        'sort: { field: work_pr }',
        '',
      ].join('\n'),
    );
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('linked branches and PRs end-to-end', () => {
  it('starts only the item with an open PR, passes branch and PR to worker and hook; dry-run and view show them', async () => {
    env.github.createIssue(REPO_A, { number: 1, title: 'with PR' });
    env.github.createIssue(REPO_A, { number: 2, title: 'branch only' });
    env.github.linkBranch(REPO_A, 1, 'feature/1');
    env.github.linkBranch(REPO_A, 2, 'feature/2');
    env.github.openPullRequest(REPO_A, { number: 3, headRef: 'feature/1', closes: [1] });

    const before = env.github.requests.filter((r) => r.graphql).length;
    const dry = await env.request('POST', '/api/v1/workflows/reviewer/dry-run');
    expect(dry.status).toBe(200);
    const byKey = new Map((dry.json.candidates as Array<{ itemKey: string; decision: string }>).map((c) => [c.itemKey, c]));
    expect(byKey.get('repo_a:1')?.decision).toBe('would_start');
    expect(byKey.get('repo_a:2')?.decision).toBe('filtered');
    // The PR itself is an item too: its own number while open.
    expect(byKey.get('repo_a:3')?.decision).toBe('would_start');
    expect(formatDryRun(dry.json)).toContain('work_pr not_equals null: true (actual 3)');
    // linkedFields block per candidate (workflow uses the fields), from the same batch as the filter.
    expect((dry.json.candidates as Array<{ itemKey: string; linkedFields?: unknown }>).find((c) => c.itemKey === 'repo_a:1')?.linkedFields).toEqual({
      linked_branches: { known: true, value: ['feature/1'] },
      closing_prs: { known: true, value: [{ number: 3, state: 'open', head_ref: 'feature/1', is_draft: false, url: 'https://github.com/example/a/pull/3' }] },
      work_branch: { known: true, value: 'feature/1' },
      work_pr: { known: true, value: 3 },
      work_pr_url: { known: true, value: 'https://github.com/example/a/pull/3' },
    });
    expect(formatDryRun(dry.json)).toContain('     linked fields:\n       linked_branches: ["feature/1"]');
    // One GraphQL query per candidate.
    expect(env.github.requests.filter((r) => r.graphql).length - before).toBe(3);

    const beforePlan = env.github.requests.filter((r) => r.graphql).length;
    const report = await env.app.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(2);
    for (const id of report.startedRunIds) expect((await env.waitTerminal(id)).status).toBe('completed');
    // Planning reads each candidate once; the starts reuse that (no second identical query) – only the
    // on_success comments of the two runs read again (fresh per action attempt).
    expect(env.github.requests.filter((r) => r.graphql).length - beforePlan).toBe(3 + 2);
    for (const id of report.startedRunIds) {
      const event = env.app.persistence.events.listForRun(id).find((e) => e.type === 'run.linked_resolved');
      expect(event?.payload).toMatchObject({ reused: true, unknown: [] });
    }
    expect(readFileSync(path.join(env.marks, 'args-1.txt'), 'utf8')).toBe('feature/1 3');
    expect(readFileSync(path.join(env.marks, 'args-3.txt'), 'utf8')).toBe('feature/1 3');
    expect(env.github.comments(REPO_A, 1).at(-1)?.body).toMatch(/^Reviewed PR #3/);

    const view = await env.request('GET', '/api/v1/views/work/items?refresh=1');
    expect(view.status).toBe(200);
    expect(view.json.columns.map((c: { field: string; type: string | null; link: string | null }) => [c.field, c.type, c.link])).toEqual([
      ['title', 'string', 'url'],
      ['work_pr', 'number', 'work_pr_url'],
      ['work_branch', 'string', null],
      ['closing_prs', 'object[]', null],
    ]);
    const rows = view.json.rows as Array<{ itemId: string; cells: Array<{ value: unknown; known: boolean; link: string | null }> }>;
    const row1 = rows.find((r) => r.itemId === '1');
    expect(row1?.cells[1]).toEqual({ value: 3, known: true, link: 'https://github.com/example/a/pull/3' });
    expect(row1?.cells[2]).toEqual({ value: 'feature/1', known: true, link: null });
    expect(row1?.cells[3]?.value).toEqual([
      { number: 3, state: 'open', head_ref: 'feature/1', is_draft: false, url: 'https://github.com/example/a/pull/3' },
    ]);
    expect(rows.find((r) => r.itemId === '2')?.cells[1]).toEqual({ value: null, known: true, link: null });
  });

  it('after the merge the PR is no work PR any more; without access the filter is unknown and nothing starts', async () => {
    env.github.mergePullRequest(REPO_A, 3);
    env.github.deleteBranch(REPO_A, 'feature/1');
    const dry = await env.request('POST', '/api/v1/workflows/reviewer/dry-run');
    const decisions = Object.fromEntries((dry.json.candidates as Array<{ itemKey: string; decision: string }>).map((c) => [c.itemKey, c.decision]));
    expect(decisions['repo_a:1']).toBe('filtered');

    env.github.createIssue(REPO_A, { number: 4, title: 'denied' });
    env.github.denyLinked(REPO_A, 4);
    const denied = await env.request('POST', '/api/v1/workflows/reviewer/dry-run');
    const c4 = (denied.json.candidates as Array<{ itemKey: string; decision: string }>).find((c) => c.itemKey === 'repo_a:4');
    expect(c4?.decision).toBe('filter_unknown');
    const report = await env.app.scheduler.planOnce();
    expect(report.startedRunIds).toEqual([]);
  });
});
