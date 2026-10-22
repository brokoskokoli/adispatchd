/**
 * End-to-end (WI-30): complete app with Fake-GitHub and a crashing shell
 * worker. Three crashes create a retry block, `on_retry_block` marks the issue
 * `agent-blocked`; "Remove Block" over the API starts a lifecycle run
 * (trigger `unblock`) whose `on_retry_unblock` puts `ready` back. The run is
 * visible in the run list like any other run.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';

let env: AppEnv;

beforeAll(async () => {
  env = await startAppEnv({ configExtra: 'notifications:\n  on: [retry_block_created, retry_block_cleared]\n' }, (e) => {
    const crash = e.script('crash.sh', 'echo "crashing on $ADISPATCH_SOURCE_ITEM_ID"\nexit 3');
    writeFileSync(
      path.join(e.configDir, 'workflows', 'coder.yaml'),
      [
        'id: coder',
        'name: Coder',
        'trigger: { type: source, source: repo_a }',
        'identity: coder',
        'filter: { all: [ { field: labels, operator: contains, value: ready } ] }',
        'execute:',
        '  type: shell',
        `  command: ${crash}`,
        'retry: { max_technical_failures: 3 }',
        'on_start:',
        '  - type: source.update',
        '    labels: { add: [coding], remove: [ready] }',
        'on_crash:',
        '  - type: source.update',
        '    labels: { add: [ready], remove: [coding] }',
        'on_retry_block:',
        '  - type: source.update',
        '    labels: { add: [agent-blocked], remove: [ready] }',
        '  - type: source.comment',
        "    message: 'Blocked after {block.failures} technical failures (last {block.last_status}, run {run.id}).'",
        'on_retry_unblock:',
        '  - type: source.update',
        '    labels: { add: [ready], remove: [agent-blocked] }',
        '  - type: source.comment',
        "    message: 'Block {block.id} removed by {block.cleared_by} ({run.trigger}).'",
        '',
      ].join('\n'),
    );
  });
});

afterAll(async () => env?.cleanup());

/** Trigger a planning step and wait for the next run of the issue to finish. */
async function planAndFinish(known: readonly string[]): Promise<string> {
  expect((await env.request('POST', '/api/v1/scheduler/resume', {})).status).toBe(200);
  const end = Date.now() + 15_000;
  for (;;) {
    const page = env.app.persistence.runs.list({ workflowId: 'coder', triggerType: 'source' });
    const next = page.runs.find((r) => !known.includes(r.id));
    if (next) return (await env.waitTerminal(next.id)).id;
    if (Date.now() > end) throw new Error('no new run was started');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('end-to-end: retry-block hooks (WI-30)', () => {
  it('3 crashes → agent-blocked → Remove Block → ready again, lifecycle run visible', async () => {
    env.github.createIssue(REPO_A, { number: 5, title: 'Flaky task', labels: ['ready'] });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await planAndFinish(ids));
    expect(env.github.labels(REPO_A, 5)).toEqual(['agent-blocked']);
    const comment = env.github.comments(REPO_A, 5).at(-1);
    expect(comment?.body).toContain(`Blocked after 3 technical failures (last crashed, run ${ids[2]}).`);

    // The blocked item is not picked up again (the label filter would not match anyway).
    const blocks = await env.request('GET', '/api/v1/blocks');
    expect(blocks.json.blocks).toHaveLength(1);
    const block = blocks.json.blocks[0];
    expect(block).toMatchObject({ workflowId: 'coder', itemKey: 'repo_a:5', runId: ids[2], lastStatus: 'crashed', clearedRunId: null });
    const blockedRun = await env.request('GET', `/api/v1/runs/${ids[2]}`);
    expect(blockedRun.json).toMatchObject({ completionHook: 'on_crash', retryBlockHook: true, retryBlock: { id: block.id } });

    // Remove Block → lifecycle run.
    const cleared = await env.request('POST', `/api/v1/blocks/${block.id}/clear`, { clearedBy: 'ui' });
    expect(cleared.status).toBe(200);
    const runId = cleared.json.runId as string;
    expect(runId).toMatch(/^run-/);
    expect(cleared.json.block).toMatchObject({ active: false, clearedBy: 'ui', clearedRunId: runId });
    expect(cleared.json.block.clearedAt).not.toBeNull();
    const final = await env.waitTerminal(runId);
    expect(final).toMatchObject({ triggerType: 'unblock', status: 'completed', businessResult: 'success', lifecycleStatus: 'succeeded' });
    // on_retry_unblock put `ready` back (the journal shows the change; the scheduler may already be picking it up).
    const unblockLabels = env.app.persistence.actions.listForHook(runId, 'on_retry_unblock')[0];
    expect(unblockLabels?.status).toBe('succeeded');
    expect(env.github.comments(REPO_A, 5).some((c) => c.body.includes(`Block ${block.id} removed by ui (unblock).`))).toBe(true);
    expect(env.github.labels(REPO_A, 5)).not.toContain('agent-blocked');

    // Visible like every run, filterable by trigger.
    const list = await env.request('GET', '/api/v1/runs?trigger=unblock');
    expect(list.status).toBe(200);
    expect(list.json.runs.map((r: { id: string; triggerType: string }) => [r.id, r.triggerType])).toEqual([[runId, 'unblock']]);
    const detail = await env.request('GET', `/api/v1/runs/${runId}`);
    expect(detail.json).toMatchObject({ triggerType: 'unblock', retryBlock: { id: block.id, clearedRunId: runId } });
    expect(detail.json.actions.map((a: { hook: string; status: string }) => [a.hook, a.status])).toEqual([
      ['on_retry_unblock', 'succeeded'],
      ['on_retry_unblock', 'succeeded'],
    ]);
    // retry_block_cleared was subscribed in this configuration.
    const notifications = env.app.persistence.notifications.list({ limit: 50 }).map((n) => n.eventType);
    expect(notifications).toEqual(expect.arrayContaining(['retry_block_created', 'retry_block_cleared']));

    // Second removal: idempotent, same run.
    const again = await env.request('POST', `/api/v1/blocks/${block.id}/clear`, {});
    expect(again.json).toMatchObject({ runId: null, block: { clearedRunId: runId } });

    // The item is picked up again in a new counting period – only after the lifecycle run released the lock.
    const next = await planAndFinish([...ids]);
    const nextRun = env.app.persistence.runs.require(next);
    expect(nextRun.createdAt >= final.finishedAt!).toBe(true);
    expect(env.app.persistence.blocks.counter('coder', 'repo_a:5').consecutive).toBe(1);
    expect(env.github.labels(REPO_A, 5)).toEqual(['ready']);
  });
});
