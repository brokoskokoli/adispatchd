/**
 * WI-21: the run controller resolves `{item.work_branch}` / `{item.work_pr}`
 * freshly before the start; unknown → `start_error` before `on_start`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_EVENTS, type StartRunOptions } from './controller.js';
import { ISSUE, REPO, createRunsEnv, workflowYaml, type RunsTestEnv } from './testing/helpers.js';

describe('RunController: linked branch / PR placeholders (WI-21)', () => {
  let env: RunsTestEnv;
  beforeEach(() => {
    env = createRunsEnv();
  });
  afterEach(() => env.cleanup());

  async function start(
    extraExecute: string,
    extraWorkflow = '',
    options: StartRunOptions = {},
  ): Promise<{ status: string; reason: string | null; runId: string }> {
    const script = env.script(
      'record.sh',
      `printf '%s|%s|%s' "$1" "$2" "$WORK_PR" > "${env.marks}/args.txt"
cat "$ADISPATCH_CONTEXT_FILE" > "${env.marks}/context.json"`,
    );
    const yaml = workflowYaml(script).replace('  cancel_grace: 300ms', `  cancel_grace: 300ms\n${extraExecute}`) + extraWorkflow;
    const snapshot = await env.snapshot(yaml);
    const h = env.harness();
    await h.controller.recover();
    const run = env.reserve(snapshot);
    const final = await h.controller.startRun(run.id, options).done;
    return { status: final.status, reason: final.finalReason, runId: run.id };
  }

  const graphqlCount = (): number => env.github.requests.filter((r) => r.graphql).length;
  const context = (): { source: { attributes: Record<string, unknown> } } =>
    JSON.parse(readFileSync(path.join(env.marks, 'context.json'), 'utf8')) as { source: { attributes: Record<string, unknown> } };

  it('renders work branch and PR into args/env and adds the linked fields to the worker context', async () => {
    env.github.linkBranch(REPO, ISSUE, 'feature/7-oauth');
    env.github.openPullRequest(REPO, { number: 20, headRef: 'feature/7-oauth', closes: [ISSUE] });
    const res = await start("  args: ['{item.work_branch}', '#{item.work_pr}']\n  env: { WORK_PR: '{item.work_pr}' }");
    expect(res.status).toBe('completed');
    expect(readFileSync(path.join(env.marks, 'args.txt'), 'utf8')).toBe('feature/7-oauth|#20|20');
    expect(context().source.attributes).toMatchObject({
      title: 'Implement OAuth',
      linked_branches: ['feature/7-oauth'],
      closing_prs: [{ number: 20, state: 'open', head_ref: 'feature/7-oauth', is_draft: false, url: 'https://github.com/example/a/pull/20' }],
      work_branch: 'feature/7-oauth',
      work_pr: 20,
    });
    const event = env.p.events.listForRun(res.runId).find((e) => e.type === RUN_EVENTS.linkedResolved);
    expect(event?.payload).toEqual({ known: ['linked_branches', 'closing_prs', 'work_branch', 'work_pr', 'work_pr_url'], unknown: [] });
  });

  it('a known null renders empty in args/env; in working_directory it is a start_error before on_start', async () => {
    const ok = await start("  args: ['{item.work_branch}', 'x']\n  env: { WORK_PR: '{item.work_pr}' }");
    expect(ok.status).toBe('completed');
    expect(readFileSync(path.join(env.marks, 'args.txt'), 'utf8')).toBe('|x|');
    env.github.setLabels(REPO, ISSUE, ['ready-for-coding', 'manual-label']);

    const failed = await start("  working_directory: '{workspace.base_dir}/{item.work_branch}'");
    expect(failed.status).toBe('start_error');
    expect(failed.reason).toBe('{item.work_branch} is empty (null) and cannot be used in working_directory');
    // No hooks: on_start never ran, so the labels are unchanged and nothing is journaled.
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-coding']);
    expect(env.p.actions.listForRun(failed.runId)).toEqual([]);
    expect(env.p.runs.require(failed.runId).error).toMatchObject({ code: 'run_linked_field_empty', field: 'work_branch' });
  });

  it('reuses linked fields resolved in the planning step (no second query); unknown ones are read again', async () => {
    env.github.linkBranch(REPO, ISSUE, 'feature/7');
    const prefetched = {
      linked_branches: { known: true as const, value: ['feature/7'] },
      closing_prs: { known: true as const, value: [] },
      work_branch: { known: true as const, value: 'feature/7' },
      work_pr: { known: true as const, value: null },
      work_pr_url: { known: true as const, value: null },
    };
    const before = graphqlCount();
    const reused = await start("  args: ['{item.work_branch}', 'x']", '', { linkedFields: prefetched });
    expect(reused.status).toBe('completed');
    expect(graphqlCount()).toBe(before);
    expect(readFileSync(path.join(env.marks, 'args.txt'), 'utf8')).toBe('feature/7|x|');
    expect(env.p.events.listForRun(reused.runId).find((e) => e.type === RUN_EVENTS.linkedResolved)?.payload).toMatchObject({ reused: true });

    const stale = { ...prefetched, work_pr: { known: false as const, reason: 'rate limit' } };
    const fresh = await start("  args: ['{item.work_branch}', 'x']", '', { linkedFields: stale });
    expect(fresh.status).toBe('completed');
    expect(graphqlCount()).toBe(before + 1);
  });

  it('unknown → start_error before on_start: no hook ran, no worker, counted as technical failure', async () => {
    env.github.denyLinked(REPO, ISSUE);
    const res = await start("  env: { WORK_PR: '{item.work_pr}' }");
    expect(res.status).toBe('start_error');
    expect(res.reason).toMatch(/^\{item\.work_pr\} is unknown: linked branches\/PRs of repo_a:7 not readable: GraphQL error: FORBIDDEN/);
    // on_start never ran (labels unchanged), the worker never started.
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-coding']);
    expect(env.p.events.listForRun(res.runId).some((e) => e.type === RUN_EVENTS.spawn)).toBe(false);
    expect(env.p.actions.listForRun(res.runId)).toEqual([]);
    expect(env.p.blocks.counter('wf', `repo_a:${ISSUE}`).consecutive).toBe(1);
    const run = env.p.runs.require(res.runId);
    expect(run.error).toMatchObject({ code: 'run_linked_field_unknown', field: 'work_pr' });
  });

  it('a workflow that does not use the fields does not query them; a filter use adds them to the context', async () => {
    const before = graphqlCount();
    expect((await start('')).status).toBe('completed');
    expect(graphqlCount()).toBe(before);
    expect(context().source.attributes).not.toHaveProperty('work_branch');

    env.github.linkBranch(REPO, ISSUE, 'feature/7');
    const filtered = await start('', 'filter:\n  field: work_branch\n  operator: equals\n  value: feature/7\n');
    expect(filtered.status).toBe('completed');
    expect(graphqlCount()).toBe(before + 1);
    expect(context().source.attributes).toMatchObject({ work_branch: 'feature/7', work_pr: null });
  });
});
