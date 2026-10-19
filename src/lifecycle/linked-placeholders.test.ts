/**
 * WI-21: `{item.work_branch}` / `{item.work_pr}` in lifecycle actions are
 * resolved freshly per attempt; unknown → the attempt fails (never an empty string).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceItem } from '../core/index.js';
import { ISSUE, ITEM_KEY, REPO, createEnv, drive, loadSnapshot, type LifecycleTestEnv } from './testing/helpers.js';

const ITEM: SourceItem = { sourceId: 'repo_a', itemId: String(ISSUE), key: ITEM_KEY, url: '', type: 'issue', fields: {} };

function workflow(out: string): string {
  return `id: wf
name: Coder WF
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
on_success:
  - type: source.comment
    message: 'Ready for review: PR #{item.work_pr} on {item.work_branch}'
  - type: shell
    command: /bin/sh
    args: ['-c', 'printf "%s|%s" "$1" "$2" > "${out}/args.txt"; cp "$ADISPATCH_CONTEXT_FILE" "${out}/context.json"', 'x', '{item.work_branch}', '{item.work_pr}']
`;
}

describe('lifecycle: linked placeholders (WI-21)', () => {
  let env: LifecycleTestEnv | undefined;
  let dir: string | undefined;
  afterEach(() => {
    env?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('renders the work branch / PR read at action time (e.g. the PR the worker opened)', async () => {
    env = createEnv();
    dir = mkdtempSync(path.join(os.tmpdir(), 'orch-linked-'));
    const snapshot = await loadSnapshot(workflow(dir));
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    // The worker opened the PR during the run: the hook must see it.
    env.github.linkBranch(REPO, ISSUE, 'feature/7-oauth');
    env.github.openPullRequest(REPO, { number: 12, headRef: 'feature/7-oauth', closes: [ISSUE] });

    const result = await drive(env.engine().runHook(run, 'on_success', snapshot, { item: ITEM }), env.clock);
    expect(result.status).toBe('succeeded');
    expect(env.github.comments(REPO, ISSUE).at(-1)?.body).toMatch(/^Ready for review: PR #12 on feature\/7-oauth/);
    expect(readFileSync(path.join(dir, 'args.txt'), 'utf8')).toBe('feature/7-oauth|12');
    const context = JSON.parse(readFileSync(path.join(dir, 'context.json'), 'utf8')) as { source: { attributes: Record<string, unknown> } };
    expect(context.source.attributes).toMatchObject({
      work_branch: 'feature/7-oauth',
      work_pr: 12,
      linked_branches: ['feature/7-oauth'],
      closing_prs: [{ number: 12, state: 'open', head_ref: 'feature/7-oauth', is_draft: false, url: 'https://github.com/example/a/pull/12' }],
    });
  });

  it('known null renders as an empty string', async () => {
    env = createEnv();
    dir = mkdtempSync(path.join(os.tmpdir(), 'orch-linked-'));
    const snapshot = await loadSnapshot(workflow(dir));
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot, { item: ITEM }), env.clock);
    expect(result.status).toBe('succeeded');
    expect(env.github.comments(REPO, ISSUE).at(-1)?.body).toMatch(/^Ready for review: PR # on\n/);
    expect(readFileSync(path.join(dir, 'args.txt'), 'utf8')).toBe('|');
  });

  it('unknown → the action fails (retryable), nothing is posted', async () => {
    env = createEnv();
    dir = mkdtempSync(path.join(os.tmpdir(), 'orch-linked-'));
    env.github.denyLinked(REPO, ISSUE);
    const snapshot = await loadSnapshot(workflow(dir));
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot, { item: ITEM }), env.clock);
    expect(result.status).toBe('failed');
    expect(result.actions[0]).toMatchObject({ status: 'failed', type: 'source.comment' });
    expect(result.actions[0]?.lastError).toMatchObject({
      code: 'lifecycle_linked_field_unknown',
      retryable: true,
      message: expect.stringMatching(/^\{item\.work_pr\} is unknown: linked branches\/PRs of repo_a:7 not readable: GraphQL error: FORBIDDEN/),
    });
    expect(env.github.comments(REPO, ISSUE)).toEqual([]);
  });
});
