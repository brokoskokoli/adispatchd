/**
 * WI-30: `on_retry_block` (appended to the finalization of the run that
 * creates a retry block) and `on_retry_unblock` (lifecycle run with trigger
 * `unblock` when the block is removed). Real shell scripts, Fake-GitHub.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockedError, LockConflictError } from '../persistence/index.js';
import { ISSUE, ITEM_KEY, REPO, createRunsEnv, waitForRun, type RunsTestEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

/** Coder-style workflow; `extra` appends YAML (e.g. the retry-block hooks). */
function yaml(command: string, extra: string, options: { maxFailures?: number; onCrash?: string } = {}): string {
  return `
id: wf
name: Coder
trigger: { type: source, source: repo_a }
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
retry: { max_technical_failures: ${options.maxFailures ?? 3} }
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready] }
on_crash:
${
  options.onCrash ??
  `  - type: source.update
    labels: { add: [ready], remove: [coding] }`
}
${extra}`;
}

const BLOCK_HOOKS = `
on_retry_block:
  - type: source.update
    labels: { add: [agent-blocked], remove: [ready] }
  - type: source.comment
    message: 'Blocked after {block.failures} technical failures (last {block.last_status}, run {run.id}, result {result.status}).'
on_retry_unblock:
  - type: source.update
    labels: { add: [ready], remove: [agent-blocked] }
  - type: source.comment
    message: 'Unblocked by {block.cleared_by} (block {block.id}, trigger {run.trigger}).'
`;

describe.runIf(supported)('RunController – retry-block hooks (WI-30)', () => {
  let env: RunsTestEnv;
  beforeEach(() => {
    env = createRunsEnv();
    env.github.setLabels(REPO, ISSUE, ['ready']);
  });
  afterEach(() => env.cleanup());

  async function ready(overrides: Parameters<RunsTestEnv['harness']>[0] = {}) {
    const h = env.harness(overrides);
    await h.controller.recover();
    return h;
  }
  const hooksOf = (runId: string) => [...new Set(env.p.actions.listForRun(runId).map((a) => a.hook))];

  /** Crash `n` times; returns the run IDs. */
  async function crashTimes(h: Awaited<ReturnType<typeof ready>>, snapshot: Awaited<ReturnType<RunsTestEnv['snapshot']>>, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const reserved = env.reserve(snapshot);
      ids.push(reserved.id);
      await h.controller.startRun(reserved.id).done;
    }
    return ids;
  }

  describe('on_retry_block', () => {
    it('runs after the completion hook in the run that creates the block, never before', async () => {
      const crash = env.script('crash.sh', 'exit 3');
      const snapshot = await env.snapshot(yaml(crash, BLOCK_HOOKS));
      const h = await ready();
      const ids = await crashTimes(h, snapshot, 3);
      expect(hooksOf(ids[0]!)).toEqual(['on_start', 'on_crash']);
      expect(hooksOf(ids[1]!)).toEqual(['on_start', 'on_crash']);
      expect(hooksOf(ids[2]!)).toEqual(['on_start', 'on_crash', 'on_retry_block']);
      const last = env.p.runs.require(ids[2]!);
      expect(last).toMatchObject({ status: 'crashed', completionHook: 'on_crash', retryBlockHook: true });
      expect(env.p.actions.listForHook(last.id, 'on_retry_block').map((a) => [a.name, a.status])).toEqual([
        ['on_retry_block.0', 'succeeded'],
        ['on_retry_block.1', 'succeeded'],
      ]);
      // on_crash put `ready` back, on_retry_block removed it again and marked the item.
      expect(env.github.labels(REPO, ISSUE)).toEqual(['agent-blocked']);
      const [comment] = env.github.comments(REPO, ISSUE);
      expect(comment?.body).toContain(`Blocked after 3 technical failures (last crashed, run ${last.id}, result crashed).`);
      const block = env.p.blocks.activeFor('wf', ITEM_KEY);
      expect(block).toMatchObject({ runId: last.id, lastStatus: 'crashed', failureCount: 3 });
    });

    it('runs although the completion hook stopped at a failed action', async () => {
      const crash = env.script('crash.sh', 'exit 3');
      const fail = env.script('fail.sh', 'exit 1');
      const snapshot = await env.snapshot(
        yaml(crash, BLOCK_HOOKS, { maxFailures: 1, onCrash: `  - type: shell\n    command: ${fail}\n  - type: source.update\n    labels: { add: [never] }` }),
      );
      const h = await ready();
      const [id] = await crashTimes(h, snapshot, 1);
      expect(env.p.actions.listForHook(id!, 'on_crash').map((a) => a.status)).toEqual(['failed', 'pending']);
      expect(env.p.actions.listForHook(id!, 'on_retry_block').map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
      expect(env.p.runs.require(id!)).toMatchObject({ status: 'crashed', lifecycleStatus: 'failed' });
      expect([...env.github.labels(REPO, ISSUE)].sort()).toEqual(['agent-blocked', 'coding']);
    });

    it('runs for a start_error without hooks that creates the block (block.* in shell args)', async () => {
      const out = path.join(env.marks, 'blocked.txt');
      const record = env.script('record.sh', `printf '%s ' "$@" > ${out}`);
      const snapshot = await env.snapshot(
        yaml('/bin/true', `on_retry_block:\n  - type: shell\n    command: ${record}\n    args: ['{block.failures}', '{block.last_status}', '{block.id}']\n`, { maxFailures: 1 }),
      );
      const h = await ready();
      // The run's source is not available → start_error without hooks (Spec §6.5).
      const reserved = env.reserve(snapshot, { sourceId: 'gone' });
      const final = await h.controller.startRun(reserved.id).done;
      expect(final).toMatchObject({ status: 'start_error', completionHook: null, retryBlockHook: true });
      expect(hooksOf(final.id)).toEqual(['on_retry_block']);
      const block = env.p.blocks.activeFor('wf', ITEM_KEY);
      expect(readFileSync(out, 'utf8')).toBe(`1 start_error ${block!.id} `);
    });

    it('does not run when no block is created (limit not reached, or block already active)', async () => {
      const crash = env.script('crash.sh', 'exit 3');
      const snapshot = await env.snapshot(yaml(crash, BLOCK_HOOKS, { maxFailures: 2 }));
      const h = await ready();
      const ids = await crashTimes(h, snapshot, 3); // the 3rd run is a manual-style start despite the block
      expect(hooksOf(ids[0]!)).not.toContain('on_retry_block');
      expect(hooksOf(ids[1]!)).toContain('on_retry_block');
      expect(hooksOf(ids[2]!)).not.toContain('on_retry_block');
      expect(env.p.runs.require(ids[2]!).retryBlockHook).toBe(false);
    });

    it('recovery continues an interrupted on_retry_block chain after a restart', async () => {
      const snapshot = await env.snapshot(yaml('/bin/true', BLOCK_HOOKS, { maxFailures: 1 }));
      const reserved = env.reserve(snapshot);
      env.p.runs.transition(reserved.id, 'starting');
      env.p.runs.transition(reserved.id, 'running', { update: { pid: 999_999 } });
      env.p.runs.beginFinalization(
        reserved.id,
        { status: 'crashed', businessResult: null, reason: 'exit code 1' },
        { update: { completionHook: 'on_crash' }, blockPolicy: { maxTechnicalFailures: 1, retryBlockHook: true } },
      );
      const crashJournal = env.p.actions.createJournal(
        reserved.id,
        'on_crash',
        (snapshot.workflow.hooks.on_crash ?? []).map((config) => ({ type: config.type, name: config.id, config })),
      );
      env.p.actions.setStatus(crashJournal[0]!.id, 'succeeded');
      const journal = env.p.actions.createJournal(
        reserved.id,
        'on_retry_block',
        (snapshot.workflow.hooks.on_retry_block ?? []).map((config) => ({ type: config.type, name: config.id, config })),
      );
      env.p.actions.startAttempt(journal[0]!.id); // the controller died inside the first action
      env.github.setLabels(REPO, ISSUE, ['ready']);

      await env.harness().controller.recover();
      const final = env.p.runs.require(reserved.id);
      expect(final).toMatchObject({ status: 'crashed', retryBlockHook: true });
      expect(env.p.actions.listForHook(reserved.id, 'on_crash').map((a) => a.status)).toEqual(['succeeded']);
      expect(env.p.actions.listForHook(reserved.id, 'on_retry_block').map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['agent-blocked']);
      expect(env.github.comments(REPO, ISSUE)).toHaveLength(1);
    });
  });

  describe('on_retry_unblock', () => {
    async function blocked(extra = BLOCK_HOOKS) {
      const crash = env.script('crash.sh', 'exit 3');
      const snapshot = await env.snapshot(yaml(crash, extra, { maxFailures: 1 }));
      const h = await ready();
      await crashTimes(h, snapshot, 1);
      const block = env.p.blocks.activeFor('wf', ITEM_KEY)!;
      return { h, snapshot, block };
    }

    it('removing the block starts a lifecycle run (trigger unblock) that runs only on_retry_unblock', async () => {
      const { h, snapshot, block } = await blocked();
      const counter = env.p.blocks.counter('wf', ITEM_KEY);
      const cleared = h.controller.clearBlock(block.id, 'olga', { snapshot });
      expect(cleared.clearedRunId).not.toBeNull();
      expect(h.controller.isBlocked('wf', ITEM_KEY)).toBe(false);
      const runId = cleared.clearedRunId!;
      expect(env.p.runs.require(runId)).toMatchObject({ triggerType: 'unblock', sourceItemKey: ITEM_KEY, lockKey: `item:${ITEM_KEY}` });
      const final = await h.controller.whenSupervisionEnds(runId)!;
      expect(final).toMatchObject({ status: 'completed', businessResult: 'success', countedTechnicalFailure: false, workspacePath: null, pid: null });
      expect(hooksOf(runId)).toEqual(['on_retry_unblock']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['ready']);
      const comments = env.github.comments(REPO, ISSUE);
      expect(comments.at(-1)?.body).toContain(`Unblocked by olga (block ${block.id}, trigger unblock).`);
      // Clearing still started a new counting period; the lifecycle run itself neither counted nor reset.
      expect(env.p.blocks.counter('wf', ITEM_KEY)).toEqual({ consecutive: 0, generation: counter.generation + 1 });
      expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)).toBeNull();
      expect(env.notifications.filter((n) => n.type === 'retry_block_cleared')).toEqual([
        { type: 'retry_block_cleared', payload: expect.objectContaining({ blockId: block.id, clearedBy: 'olga', runId }) },
      ]);
      // Idempotent: a second removal starts nothing.
      expect(h.controller.clearBlock(block.id, 'olga', { snapshot }).clearedRunId).toBe(runId);
      expect(env.p.runs.list({ triggerType: 'unblock' }).total).toBe(1);
    });

    it('holds the item lock while the chain runs: no automatic start in between', async () => {
      const gate = path.join(env.marks, 'go');
      const started = path.join(env.marks, 'started');
      const wait = env.script('wait.sh', `touch ${started}\ni=0\nwhile [ ! -f ${gate} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done`);
      const { h, snapshot, block } = await blocked(`
on_retry_unblock:
  - type: shell
    command: ${wait}
  - type: source.update
    labels: { add: [ready] }
`);
      const runId = h.controller.clearBlock(block.id, null, { snapshot }).clearedRunId!;
      await waitForRun(h, env.p, runId, () => existsSync(started));
      expect(env.p.runs.require(runId).status).toBe('running');
      expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)?.runId).toBe(runId);
      expect(() => env.reserve(snapshot, { failIfBlocked: true })).toThrow(LockConflictError);
      expect(h.controller.status.activeRuns).toBe(1);
      // A lifecycle run cannot be cancelled.
      expect(() => h.controller.requestCancel(runId)).toThrow(/cannot be cancelled/);
      writeFileSync(gate, '');
      const final = await h.controller.whenSupervisionEnds(runId)!;
      expect(final.status).toBe('completed');
      expect(env.reserve(snapshot, { failIfBlocked: true }).status).toBe('reserved');
    });

    it('a failed chain ends as completed + failure with lifecycle_action_failed; the block stays removed', async () => {
      const fail = env.script('fail.sh', 'exit 1');
      const { h, snapshot, block } = await blocked(`
on_retry_unblock:
  - type: shell
    command: ${fail}
  - type: source.update
    labels: { add: [ready] }
`);
      const runId = h.controller.clearBlock(block.id, null, { snapshot }).clearedRunId!;
      const final = await h.controller.whenSupervisionEnds(runId)!;
      expect(final).toMatchObject({ status: 'completed', businessResult: 'failure', lifecycleStatus: 'failed' });
      expect(final.finalReason).toContain("on_retry_unblock action 'on_retry_unblock.0' failed");
      expect(env.p.actions.listForHook(runId, 'on_retry_unblock').map((a) => a.status)).toEqual(['failed', 'pending']);
      expect(env.notifications.some((n) => n.type === 'lifecycle_action_failed' && n.payload.runId === runId)).toBe(true);
      expect(h.controller.isBlocked('wf', ITEM_KEY)).toBe(false);
      expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(0);
    });

    it('without on_retry_unblock no run is created; with an active run the removal is refused (409)', async () => {
      const { h, snapshot, block } = await blocked();
      // Empty hook → plain removal as before, also while a run is active.
      const noHook = { ...snapshot, workflow: { ...snapshot.workflow, hooks: { ...snapshot.workflow.hooks, on_retry_unblock: [] } } };
      const active = env.reserve(snapshot);
      expect(() => h.controller.clearBlock(block.id, null, { snapshot })).toThrow(expect.objectContaining({ code: 'block_run_active' }));
      expect(h.controller.isBlocked('wf', ITEM_KEY)).toBe(true);
      expect(env.p.runs.list({ triggerType: 'unblock' }).total).toBe(0);
      const cleared = h.controller.clearBlock(block.id, null, { snapshot: noHook });
      expect(cleared).toMatchObject({ clearedRunId: null });
      expect(cleared.clearedAt).not.toBeNull();
      expect(env.p.runs.list({ triggerType: 'unblock' }).total).toBe(0);
      await h.controller.startRun(active.id).done;
    });

    it('recovery continues an interrupted on_retry_unblock chain after a restart', async () => {
      const { snapshot, block } = await blocked();
      // Simulate the state at a crash: block cleared with its lifecycle run, first action interrupted.
      const run = env.p.transaction(() => {
        const reserved = env.p.runs.reserve({
          workflowId: 'wf',
          triggerType: 'unblock',
          sourceId: 'repo_a',
          sourceItemKey: ITEM_KEY,
          configSnapshot: snapshot,
        });
        env.p.blocks.clear(block.id, 'olga', reserved.id);
        return reserved;
      });
      env.p.runs.transition(run.id, 'starting');
      env.p.runs.transition(run.id, 'running');
      const journal = env.p.actions.createJournal(
        run.id,
        'on_retry_unblock',
        (snapshot.workflow.hooks.on_retry_unblock ?? []).map((config) => ({ type: config.type, name: config.id, config })),
      );
      env.p.actions.startAttempt(journal[0]!.id);

      const h = env.harness();
      const report = await h.controller.recover();
      expect(report.finalized.map((f) => f.runId)).toContain(run.id);
      const final = env.p.runs.require(run.id);
      expect(final).toMatchObject({ status: 'completed', businessResult: 'success' });
      expect(env.p.actions.listForHook(run.id, 'on_retry_unblock').map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['ready']);
      expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)).toBeNull();
    });

    it('workflow-scoped blocks (no item): only shell actions, no automatic cron start while the chain runs', async () => {
      const gate = path.join(env.marks, 'go');
      const out = path.join(env.marks, 'unblocked.txt');
      const wait = env.script('wait.sh', `printf '%s ' "$@" > ${out}\ni=0\nwhile [ ! -f ${gate} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done`);
      const snapshot = await env.snapshot(`
id: nightly
trigger: { type: schedule, cron: '0 3 * * *' }
execute: { type: shell, command: /bin/false }
retry: { max_technical_failures: 1 }
on_retry_unblock:
  - type: shell
    command: ${wait}
    args: ['{block.cleared_by}', '{block.failures}', '{run.trigger}']
`, { id: 'nightly' });
      const h = await ready();
      const slot = { workflowId: 'nightly', triggerType: 'schedule' as const, configSnapshot: snapshot };
      const first = env.p.runs.reserve({ ...slot, scheduledFor: '2026-10-22T03:00:00.000Z' });
      await h.controller.startRun(first.id).done;
      const block = env.p.blocks.activeFor('nightly', null)!;
      const runId = h.controller.clearBlock(block.id, null, { snapshot }).clearedRunId!;
      await waitForRun(h, env.p, runId, () => existsSync(out));
      expect(() => env.p.runs.reserve({ ...slot, scheduledFor: '2026-10-23T03:00:00.000Z', failIfBlocked: true })).toThrow(BlockedError);
      writeFileSync(gate, '');
      await h.controller.whenSupervisionEnds(runId);
      expect(readFileSync(out, 'utf8')).toBe('anonymous 1 unblock ');
      expect(env.p.runs.reserve({ ...slot, scheduledFor: '2026-10-23T03:00:00.000Z', failIfBlocked: true }).status).toBe('reserved');
    });
  });
});
