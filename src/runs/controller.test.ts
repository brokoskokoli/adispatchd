import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../config/index.js';
import { ShellExecutor, processGroupExists } from '../executors/index.js';
import { BlockedError, LockConflictError } from '../persistence/index.js';
import { RUN_EVENTS } from './controller.js';
import { RunControllerError } from './errors.js';
import {
  ISSUE,
  ITEM_KEY,
  REPO,
  createRunsEnv,
  statusTrail,
  waitForRun,
  waitForStatus,
  workflowYaml,
  type RunsTestEnv,
} from './testing/helpers.js';

const FAILURE_SCRIPT = `printf '%s' '{"schema_version":1,"result":"failure","message":"OAuth provider missing"}' > "$ORCH_RESULT_FILE"
exit 0`;

describe('RunController', () => {
  let env: RunsTestEnv;
  beforeEach(() => {
    env = createRunsEnv();
  });
  afterEach(() => env.cleanup());

  async function readyHarness(overrides: Parameters<RunsTestEnv['harness']>[0] = {}) {
    const h = env.harness(overrides);
    await h.controller.recover();
    return h;
  }

  it('runs the happy path: on_start → worker → on_success → completed, events persisted, workspace cleaned', async () => {
    const script = env.script(
      'ok.sh',
      `echo "$1 $2 $GREETING" > "${env.marks}/args.txt"
cat "$ORCH_CONTEXT_FILE" > "${env.marks}/context.json"
echo '@@ORCH_EVENT {"type":"status","message":"Tests laufen"}'
echo hello`,
    );
    const snapshot = await env.snapshot(
      workflowYaml(script).replace(
        '  cancel_grace: 300ms',
        "  cancel_grace: 300ms\n  args: ['{item.number}', '{run.id}']\n  env: { GREETING: 'hi {item.title}' }",
      ),
    );
    const h = await readyHarness();
    const run = env.reserve(snapshot);
    const final = await h.controller.startRun(run.id).done;

    expect(final.status).toBe('completed');
    expect(final.businessResult).toBe('success');
    expect(final.exitCode).toBe(0);
    expect(final.statusMessage).toBe('Tests laufen');
    expect(final.pid).toBeGreaterThan(1);
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)).toBeNull();
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-review']);
    expect(readFileSync(path.join(env.marks, 'args.txt'), 'utf8').trim()).toBe(`7 ${run.id} hi Implement OAuth`);
    const context = JSON.parse(readFileSync(path.join(env.marks, 'context.json'), 'utf8')) as Record<string, any>;
    expect(context.source).toMatchObject({ id: 'repo_a', item_id: '7', item_key: ITEM_KEY });
    expect(context.workspace.path).toBe(path.join(env.workspaces, 'wf', run.id));
    // on_success cleanup policy removed the workspace (strictly below base_dir).
    expect(final.workspacePath).toBe(path.join(env.workspaces, 'wf', run.id));
    expect(existsSync(final.workspacePath as string)).toBe(false);
    expect(statusTrail(h.events, run.id)).toEqual(['reserved', 'starting', 'running', 'finalizing', 'completed']);
    expect(h.events.some((e) => e.type === 'run.output' && e.runId === run.id && e.data.includes('hello'))).toBe(true);
    expect(env.p.events.listForRun(run.id).some((e) => e.origin === 'worker' && e.type === 'status')).toBe(true);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(0);
    // The bus saw every persisted event exactly once, in ID order.
    const busIds = h.events.flatMap((e) => (e.type === 'run.event' && e.event.runId === run.id ? [e.event.id] : []));
    expect(busIds).toEqual(env.p.events.listForRun(run.id).map((e) => e.id));
  });

  it('scenario 4: business failure → on_failure, technical counter unchanged', async () => {
    const crash = env.script('crash.sh', 'exit 1');
    const fail = env.script('fail.sh', FAILURE_SCRIPT);
    const h = await readyHarness();

    const first = await h.controller.startRun(env.reserve(await env.snapshot(workflowYaml(crash))).id).done;
    expect(first.status).toBe('crashed');
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);

    const run = env.reserve(await env.snapshot(workflowYaml(fail)));
    const final = await h.controller.startRun(run.id).done;
    expect(final.status).toBe('completed');
    expect(final.businessResult).toBe('failure');
    expect(final.result).toMatchObject({ result: 'failure', message: 'OAuth provider missing' });
    expect(final.countedTechnicalFailure).toBe(false);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
    expect(env.p.blocks.isBlocked('wf', ITEM_KEY)).toBe(false);
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'needs-maintainer']);
    const comments = env.github.comments(REPO, ISSUE).map((c) => c.body);
    expect(comments.some((b) => b.startsWith('Needs maintainer: OAuth provider missing'))).toBe(true);
    expect(env.p.actions.listForHook(run.id, 'on_failure').every((a) => a.status === 'succeeded')).toBe(true);
    // Workspace is kept for non-successful runs (cleanup: on_success).
    expect(existsSync(final.workspacePath as string)).toBe(true);
  });

  it('scenario 5: three technical failures → block; isBlocked prevents reservation; clear → new period, history kept', async () => {
    const crash = env.script('crash.sh', 'exit 3');
    const snapshot = await env.snapshot(workflowYaml(crash));
    const h = await readyHarness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = env.reserve(snapshot);
      ids.push(run.id);
      const final = await h.controller.startRun(run.id).done;
      expect(final.status).toBe('crashed');
      expect(final.finalReason).toBe('exit code 3');
      expect(h.controller.isBlocked('wf', ITEM_KEY)).toBe(i === 2);
    }
    const block = env.p.blocks.activeFor('wf', ITEM_KEY);
    expect(block).not.toBeNull();
    expect(block?.runId).toBe(ids[2]);
    expect(block?.failureCount).toBe(3);
    expect(env.p.blocks.affectedRunIds(block!.id)).toEqual(ids);
    expect(env.notifications.filter((n) => n.type === 'retry_block_created')).toEqual([
      { type: 'retry_block_created', payload: expect.objectContaining({ blockId: block!.id, workflowId: 'wf', itemKey: ITEM_KEY, runId: ids[2] }) },
    ]);
    // block.created is published after the run's `→ finalizing` status event that carries the blockId.
    const blockAt = h.events.findIndex((e) => e.type === 'block.created' && e.block.id === block!.id);
    const finalizingAt = h.events.findIndex(
      (e) => e.type === 'run.event' && e.event.runId === ids[2] && e.event.payload.to === 'finalizing',
    );
    expect(finalizingAt).toBeGreaterThanOrEqual(0);
    expect(blockAt).toBeGreaterThan(finalizingAt);
    expect(h.events[finalizingAt]).toMatchObject({ event: { payload: { blockId: block!.id } } });
    // Scheduler-style reservation is refused atomically; a manual start (no failIfBlocked) is not.
    expect(() => env.reserve(snapshot, { failIfBlocked: true })).toThrow(BlockedError);

    const cleared = h.controller.clearBlock(block!.id, 'maintainer');
    expect(cleared.clearedAt).not.toBeNull();
    expect(h.controller.isBlocked('wf', ITEM_KEY)).toBe(false);
    expect(env.p.blocks.counter('wf', ITEM_KEY)).toMatchObject({ consecutive: 0 });
    expect(h.events.some((e) => e.type === 'block.cleared' && e.block.id === block!.id)).toBe(true);
    // History stays: old runs and the cleared block remain.
    expect(env.p.runs.list({ workflowId: 'wf' }).total).toBe(3);
    expect(env.p.blocks.listForWorkflow('wf')).toHaveLength(1);
    // New counting period: the next failure counts as 1, no new block.
    const next = env.reserve(snapshot, { failIfBlocked: true });
    await h.controller.startRun(next.id).done;
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
    expect(h.controller.isBlocked('wf', ITEM_KEY)).toBe(false);
  });

  it('persists the block before on_crash runs, so a label reset by the hook cannot trigger a restart', async () => {
    const crash = env.script('crash.sh', 'kill -9 $$');
    const snapshot = await env.snapshot(workflowYaml(crash));
    const h = await readyHarness();
    const blockedWhenHookStarted: boolean[] = [];
    h.bus.subscribe((e) => {
      if (e.type === 'run.action' && e.action.hook === 'on_crash' && e.action.status === 'running') {
        blockedWhenHookStarted.push(h.controller.isBlocked('wf', ITEM_KEY));
      }
    });
    for (let i = 0; i < 3; i++) {
      const final = await h.controller.startRun(env.reserve(snapshot).id).done;
      expect(final.status).toBe('crashed');
      expect(final.finalReason).toBe('terminated by signal SIGKILL');
    }
    expect(blockedWhenHookStarted).toEqual([false, false, true]);
    // on_crash put the item back to ready-for-coding (filter matches again) …
    expect(env.github.labels(REPO, ISSUE)).toContain('ready-for-coding');
    // … but the scheduler cannot reserve it.
    expect(() => env.reserve(snapshot, { failIfBlocked: true })).toThrow(BlockedError);
  });

  it('scenario 7: cancel terminates the process group, runs on_cancel and does not count', async () => {
    const sleeper = env.script('sleep.sh', `sleep 30 &\necho started\nwait`);
    const crash = env.script('crash.sh', 'exit 1');
    const h = await readyHarness();
    await h.controller.startRun(env.reserve(await env.snapshot(workflowYaml(crash))).id).done;
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);

    const run = env.reserve(await env.snapshot(workflowYaml(sleeper)));
    const handle = h.controller.startRun(run.id);
    await waitForRun(h, env.p, run.id, (r) => r.status === 'running');
    await waitForOutput(h, run.id, 'started');
    const running = env.p.runs.require(run.id);
    const pid = running.pid as number;
    // pid + start identity were persisted with the `running` transition (recovery needs both).
    expect(running.processStartIdentity).toMatchObject({ pid, pgid: pid, token: expect.stringMatching(/^(darwin|linux):/) });
    expect(processGroupExists(pid)).toBe(true);
    expect(env.github.labels(REPO, ISSUE)).toContain('coding');

    const final = await h.controller.cancelRun(run.id, { reason: 'operator request' });
    expect(final.status).toBe('cancelled');
    expect(final.finalReason).toBe('operator request');
    expect(final.businessResult).toBeNull();
    expect(await handle.done).toMatchObject({ status: 'cancelled' });
    expect(processGroupExists(pid)).toBe(false);
    expect(statusTrail(h.events, run.id)).toEqual(['reserved', 'starting', 'running', 'cancelling', 'finalizing', 'cancelled']);
    expect(env.p.actions.listForHook(run.id, 'on_cancel').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-coding']);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
    await expect(h.controller.cancelRun(run.id)).rejects.toMatchObject({ code: 'run_not_active' });
  });

  it('does not mark a run cancelled when the process group cannot be terminated', async () => {
    const sleeper = env.script('sleep.sh', 'echo started\nexec sleep 30');
    const snapshot = await env.snapshot(workflowYaml(sleeper));
    let ignoreKills = true;
    const h = await readyHarness({
      createExecutor: ({ workspaceBaseDir }) =>
        new ShellExecutor({
          ...(workspaceBaseDir ? { workspaceBaseDir } : {}),
          killConfirmMs: 100,
          kill: (pid, signal) => {
            if (!ignoreKills) process.kill(pid, signal);
          },
        }),
    });
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'running');
    const pid = env.p.runs.require(run.id).pid as number;

    await expect(h.controller.cancelRun(run.id)).rejects.toMatchObject({ code: 'kill_failed' });
    const stuck = env.p.runs.require(run.id);
    expect(stuck.status).toBe('cancelling');
    expect(stuck.error).toMatchObject({ code: 'kill_failed' });
    expect(env.p.events.listForRun(run.id).some((e) => e.type === RUN_EVENTS.cancelFailed)).toBe(true);
    expect(processGroupExists(pid)).toBe(true);
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)?.runId).toBe(run.id);

    // A second attempt (signals work again) succeeds.
    ignoreKills = false;
    const final = await h.controller.cancelRun(run.id);
    expect(final.status).toBe('cancelled');
    expect((await handle.done).status).toBe('cancelled');
    expect(processGroupExists(pid)).toBe(false);
  });

  it('cancels a run during on_start: the rest of on_start is abandoned, on_cancel runs, no worker starts', async () => {
    const marker = path.join(env.marks, 'worker-ran');
    const worker = env.script('w.sh', `touch "${marker}"`);
    const slowAction = env.script('slow-action.sh', `echo go; sleep 30`);
    const snapshot = await env.snapshot(
      workflowYaml(worker).replace(
        'on_success:',
        `  - type: shell\n    command: ${slowAction}\n    timeout: 1m\n  - type: source.comment\n    message: never\non_success:`,
      ),
    );
    const h = await readyHarness();
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await new Promise<void>((resolve) => {
      const unsubscribe = h.bus.subscribe((e) => {
        if (e.type === 'run.action' && e.action.hook === 'on_start' && e.action.type === 'shell' && e.action.status === 'running') {
          unsubscribe();
          resolve();
        }
      });
    });
    const final = await h.controller.cancelRun(run.id);
    expect(final.status).toBe('cancelled');
    expect(await handle.done).toMatchObject({ status: 'cancelled' });
    expect(existsSync(marker)).toBe(false);
    expect(env.p.actions.listForHook(run.id, 'on_start').map((a) => a.status)).toEqual(['succeeded', 'skipped', 'skipped']);
    expect(env.p.actions.listForHook(run.id, 'on_cancel').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.github.comments(REPO, ISSUE)).toHaveLength(0);
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-coding']);
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('succeeded');
  });

  it('on_start failure: worker is not started, run ends as start_error with on_start_error and counts', async () => {
    const marker = path.join(env.marks, 'worker-ran');
    const worker = env.script('w.sh', `touch "${marker}"`);
    const snapshot = await env.snapshot(
      workflowYaml(worker).replace('on_success:', '  - type: source.comment\n    message: claimed\non_success:'),
    );
    const h = await readyHarness();
    env.github.failNext({ method: 'POST', path: `/repos/${REPO}/issues/${ISSUE}/labels` }, { status: 403, body: { message: 'nope' } });
    const run = env.reserve(snapshot);
    const final = await h.controller.startRun(run.id).done;
    expect(final.status).toBe('start_error');
    expect(final.finalReason).toBe("on_start action 'on_start.0' failed");
    expect(final.pid).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(env.p.events.listForRun(run.id).some((e) => e.type === RUN_EVENTS.spawn)).toBe(false);
    // The failed action stays visible; the rest of on_start can never run later.
    expect(env.p.actions.listForHook(run.id, 'on_start').map((a) => a.status)).toEqual(['failed', 'skipped']);
    expect(env.github.comments(REPO, ISSUE)).toHaveLength(0);
    expect(env.p.actions.listForHook(run.id, 'on_start_error').map((a) => a.status)).toEqual(['succeeded']);
    expect(final.lifecycleStatus).toBe('failed');
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
    expect(env.notifications.map((n) => n.type)).toEqual(['lifecycle_action_failed']);
  });

  it('spawn failure → start_error with on_start_error', async () => {
    const snapshot = await env.snapshot(workflowYaml(path.join(env.root, 'does-not-exist.sh')));
    const h = await readyHarness();
    const final = await h.controller.startRun(env.reserve(snapshot).id).done;
    expect(final.status).toBe('start_error');
    expect(final.finalReason).toMatch(/worker could not be started/);
    expect(env.p.actions.listForHook(final.id, 'on_start_error').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
  });

  it('idle timeout → timed_out with on_timeout, counted', async () => {
    const sleeper = env.script('sleep.sh', 'exec sleep 30');
    const snapshot = await env.snapshot(
      workflowYaml(sleeper).replace('  cancel_grace: 300ms', '  cancel_grace: 300ms\n  timeout: { idle_timeout: 200ms }'),
    );
    const h = await readyHarness();
    const final = await h.controller.startRun(env.reserve(snapshot).id).done;
    expect(final.status).toBe('timed_out');
    expect(final.finalReason).toBe('idle timeout exceeded');
    expect(env.p.actions.listForHook(final.id, 'on_timeout').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
  });

  it('re-reads the item before on_start: lost race / vanished item → cancelled without hooks, not counted', async () => {
    const marker = path.join(env.marks, 'worker-ran');
    const snapshot = await env.snapshot(workflowYaml(env.script('w.sh', `touch "${marker}"`)));
    const h = await readyHarness();
    const seen: string[][] = [];
    const lost = await h.controller.startRun(env.reserve(snapshot).id, {
      verifyItem: (item) => {
        seen.push([...(item.fields.labels as string[])]);
        return false;
      },
    }).done;
    expect(seen).toEqual([['ready-for-coding', 'manual-label']]);
    expect(lost.status).toBe('cancelled');
    expect(lost.finalReason).toBe('item no longer matches the workflow');
    expect(env.p.actions.listForRun(lost.id)).toEqual([]);

    const gone = env.reserve(snapshot, { sourceItemKey: 'repo_a:999', sourceUrl: null });
    const final = await h.controller.startRun(gone.id).done;
    expect(final.status).toBe('cancelled');
    expect(final.finalReason).toBe('item no longer available');
    expect(existsSync(marker)).toBe(false);
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-coding']);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(0);
  });

  it('hooks and execution use the run snapshot even after the configuration changed', async () => {
    const v1 = env.script('v1.sh', `echo v1 > "${env.marks}/version"`);
    const v2 = env.script('v2.sh', `echo v2 > "${env.marks}/version"`);
    const snapshot = await env.snapshot(workflowYaml(v1));
    const h = await readyHarness();
    const manager = await ConfigManager.create({ configDir: env.configDir, dataDir: env.dataDir });
    const run = env.reserve(manager.snapshotWorkflow('wf'));
    expect(snapshot.workflow.execute.command).toBe(v1);

    // Reload with another command and other labels before the run starts.
    writeFileSync(
      path.join(env.configDir, 'workflows', 'wf.yaml'),
      workflowYaml(v2).replace('labels: { add: [ready-for-review], remove: [coding] }', 'labels: { add: [v2-label], remove: [coding] }'),
    );
    const reload = await manager.reload();
    expect(reload.ok).toBe(true);
    expect(manager.getWorkflow('wf')?.config.execute.command).toBe(v2);

    const final = await h.controller.startRun(run.id).done;
    expect(final.status).toBe('completed');
    expect(readFileSync(path.join(env.marks, 'version'), 'utf8').trim()).toBe('v1');
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-review']);
  });

  it('pause only prevents automatic starts; running runs continue', async () => {
    const release = path.join(env.marks, 'release');
    const waiter = env.script('wait.sh', `while [ ! -f "${release}" ]; do sleep 0.02; done`);
    const snapshot = await env.snapshot(workflowYaml(waiter));
    const h = await readyHarness();
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'running');

    h.controller.pause();
    expect(h.controller.status).toMatchObject({ ready: true, paused: true, draining: false, activeRuns: 1 });
    expect(h.controller.canStartAutomatically()).toBe(false);
    expect(h.controller.canStartManually()).toBe(true);
    expect(h.events.some((e) => e.type === 'system.status' && e.status.paused)).toBe(true);
    expect(env.p.runs.require(run.id).status).toBe('running');

    writeFileSync(release, '');
    expect((await handle.done).status).toBe('completed');
    // Manual starts are still possible while paused.
    const manual = await h.controller.startRun(env.reserve(snapshot, { triggerType: 'manual' }).id).done;
    expect(manual.status).toBe('completed');
    h.controller.resume();
    expect(h.controller.canStartAutomatically()).toBe(true);
  });

  it('drain waits for active runs, refuses new runs, then calls the stop callback', async () => {
    const release = path.join(env.marks, 'release');
    const waiter = env.script('wait.sh', `while [ ! -f "${release}" ]; do sleep 0.02; done`);
    const snapshot = await env.snapshot(workflowYaml(waiter));
    const stops: unknown[] = [];
    const h = await readyHarness({ onStop: (r) => void stops.push(r) });
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'running');

    let drained = false;
    const draining = h.controller.drain().then((r) => {
      drained = true;
      return r;
    });
    await waitForSystemStatus(h, (s) => s.draining);
    expect(h.controller.canStartManually()).toBe(false);
    expect(h.controller.canStartAutomatically()).toBe(false);
    // A new start is refused and its reservation released (not counted, no hooks).
    const other = env.reserve(snapshot, { workflowId: 'wf', sourceItemKey: 'repo_a:8', triggerType: 'manual' });
    expect(() => h.controller.startRun(other.id)).toThrow(RunControllerError);
    expect(env.p.runs.require(other.id)).toMatchObject({ status: 'cancelled', finalReason: 'controller is draining / shutting down' });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false);
    expect(stops).toEqual([]);
    expect(env.p.runs.require(run.id).status).toBe('running');

    writeFileSync(release, '');
    expect(await draining).toEqual({ outcome: 'drained', leftActive: [] });
    expect((await handle.done).status).toBe('completed');
    expect(stops).toEqual([{ outcome: 'drained', leftActive: [] }]);
    expect(h.controller.status).toMatchObject({ draining: true, stopping: true, activeRuns: 0 });
  });

  it('cancelAllAndShutdown cancels active runs with on_cancel; drain with timeout falls back to cancel-all', async () => {
    const sleeper = env.script('sleep.sh', 'exec sleep 30');
    const snapshot = await env.snapshot(workflowYaml(sleeper));
    const h = await readyHarness();
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'running');
    const result = await h.controller.shutdown({ mode: 'drain', drainTimeoutMs: 100 });
    expect(result).toEqual({ outcome: 'cancelled', leftActive: [] });
    const final = await handle.done;
    expect(final.status).toBe('cancelled');
    expect(final.finalReason).toBe('cancelled by shutdown');
    expect(env.p.actions.listForHook(run.id, 'on_cancel').map((a) => a.status)).toEqual(['succeeded']);
    expect(processGroupExists(final.pid as number)).toBe(false);
    // After completion, further shutdown calls return the finished result.
    expect(await h.controller.cancelAllAndShutdown()).toBe(result);
  });

  it('escalates a running drain: drain() then cancelAllAndShutdown() cancels the active runs', async () => {
    const waiter = env.script('wait.sh', `while [ ! -f "${env.marks}/never" ]; do sleep 0.02; done`);
    const snapshot = await env.snapshot(workflowYaml(waiter));
    const stops: unknown[] = [];
    const h = await readyHarness({ onStop: (r) => void stops.push(r) });
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'running');

    const drain = h.controller.drain();
    await waitForSystemStatus(h, (s) => s.draining);
    const cancelAll = h.controller.cancelAllAndShutdown('second SIGTERM');
    expect(cancelAll).toBe(drain);
    const result = await drain;
    expect(result).toEqual({ outcome: 'cancelled', leftActive: [] });
    const final = await handle.done;
    expect(final).toMatchObject({ status: 'cancelled', finalReason: 'second SIGTERM' });
    expect(env.p.actions.listForHook(run.id, 'on_cancel').map((a) => a.status)).toEqual(['succeeded']);
    expect(stops).toEqual([result]);
  });

  it('escalates a running unlimited drain with a stricter drain timeout (API drain, then SIGTERM)', async () => {
    const waiter = env.script('wait.sh', `while [ ! -f "${env.marks}/never" ]; do sleep 0.02; done`);
    const snapshot = await env.snapshot(workflowYaml(waiter));
    const h = await readyHarness();
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'running');
    const drain = h.controller.drain();
    await waitForSystemStatus(h, (s) => s.draining);
    void h.controller.shutdown({ mode: 'drain', drainTimeoutMs: 50, cancelTimeoutMs: 10_000 });
    expect(await drain).toEqual({ outcome: 'cancelled', leftActive: [] });
    expect((await handle.done).status).toBe('cancelled');
  });

  it('forced stop: cancel timeout interrupts on_cancel, the run stays finalizing and recovery completes it', async () => {
    const sleeper = env.script('sleep.sh', 'exec sleep 30');
    const once = path.join(env.marks, 'hook-ran-once');
    const slowHook = env.script('slow-hook.sh', `if [ -f "${once}" ]; then exit 0; fi\ntouch "${once}"\nexec sleep 30`);
    const snapshot = await env.snapshot(
      workflowYaml(sleeper).replace('on_timeout:', `  - type: shell\n    command: ${slowHook}\n    timeout: 1m\non_timeout:`),
    );
    const h = await readyHarness({ abortSettleMs: 5_000 });
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'running');

    // Deterministic: start cancel-all without a (short) timeout, wait until the slow on_cancel hook
    // is actually running, then escalate with cancelTimeoutMs 0 (stricter timeouts replace looser ones).
    // A fixed short timeout raced with the first on_cancel action under load: the hook could be
    // interrupted before the slow action had started, so recovery ran it for the first time (sleep 30).
    const shutdown = h.controller.shutdown({ mode: 'cancel', cancelTimeoutMs: 60_000 });
    for (let i = 0; i < 1500 && !existsSync(once); i++) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(once)).toBe(true);
    void h.controller.shutdown({ mode: 'cancel', cancelTimeoutMs: 0 });
    const result = await shutdown;
    expect(result).toEqual({ outcome: 'cancelled', leftActive: [] });
    const left = await handle.done;
    expect(left.status).toBe('finalizing');
    expect(left.finalStatus).toBe('cancelled');
    expect(env.p.actions.listForHook(run.id, 'on_cancel').map((a) => a.status)).toEqual(['succeeded', 'pending']);
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)?.runId).toBe(run.id);

    // Next start: recovery resumes the interrupted hook and finishes the run.
    const next = env.harness();
    await next.controller.recover();
    const final = env.p.runs.require(run.id);
    expect(final.status).toBe('cancelled');
    expect(env.p.actions.listForHook(run.id, 'on_cancel').map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('rejects cancel while finalizing; a double cancel while running cancels once', async () => {
    const release = path.join(env.marks, 'release');
    const hookWait = env.script('hook-wait.sh', `while [ ! -f "${release}" ]; do sleep 0.02; done`);
    const ok = env.script('ok.sh', 'exit 0');
    const snapshot = await env.snapshot(
      workflowYaml(ok).replace('on_failure:', `  - type: shell\n    command: ${hookWait}\n    timeout: 1m\non_failure:`),
    );
    const h = await readyHarness();
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'finalizing');
    await expect(h.controller.cancelRun(run.id)).rejects.toMatchObject({ code: 'run_not_cancellable' });
    expect(() => h.controller.requestCancel(run.id)).toThrow(expect.objectContaining({ code: 'run_not_cancellable' }));
    writeFileSync(release, '');
    expect((await handle.done).status).toBe('completed');

    const sleeper = await env.snapshot(workflowYaml(env.script('sleep.sh', 'exec sleep 30')));
    const second = env.reserve(sleeper);
    const done = h.controller.startRun(second.id).done;
    await waitForStatus(h, env.p, second.id, 'running');
    expect(h.controller.requestCancel(second.id)).toEqual({ runId: second.id, status: 'cancelling' });
    const [a, b] = await Promise.all([h.controller.cancelRun(second.id), h.controller.cancelRun(second.id, { reason: 'again' })]);
    expect(a.status).toBe('cancelled');
    expect(b.status).toBe('cancelled');
    expect((await done).finalReason).toBe('cancelled by user');
    expect(env.p.events.listForRun(second.id).filter((e) => e.type === RUN_EVENTS.cancelRequested)).toHaveLength(1);
    expect(env.p.actions.listForHook(second.id, 'on_cancel').map((x) => x.status)).toEqual(['succeeded']);
  });

  it('internal error while running: run → recovery_pending (lock kept) until the worker ended; retryRecovery resolves it', async () => {
    const release = path.join(env.marks, 'release');
    const waiter = env.script('wait.sh', `while [ ! -f "${release}" ]; do sleep 0.02; done`);
    const snapshot = await env.snapshot(workflowYaml(waiter));
    const runs = Object.create(env.p.runs) as typeof env.p.runs;
    runs.transition = (id, to, opts) => {
      if (to === 'running') throw new Error('disk I/O error');
      return env.p.runs.transition(id, to, opts);
    };
    const h = await readyHarness({ repositories: { ...env.p, runs } });
    const run = env.reserve(snapshot);
    const handle = h.controller.startRun(run.id);
    await waitForStatus(h, env.p, run.id, 'recovery_pending');
    // The worker is still alive: the entry stays supervised (drain would wait for it).
    expect(h.controller.activeRunIds()).toEqual([run.id]);
    const pending = env.p.runs.require(run.id);
    expect(pending.error).toMatchObject({ code: 'recovery_failed', message: expect.stringContaining('disk I/O error') });
    expect(env.notifications.map((n) => n.type)).toContain('recovery_failed');
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)?.runId).toBe(run.id);

    writeFileSync(release, '');
    expect((await handle.done).status).toBe('recovery_pending');
    expect(h.controller.activeRunIds()).toEqual([]);
    const final = await h.controller.retryRecovery(run.id, { assumeGone: true });
    expect(final.status).toBe('crashed');
    expect(env.p.actions.listForHook(run.id, 'on_crash').map((a) => a.status)).toEqual(['succeeded']);
  });

  it('internal error while finishing: run stays finalizing; retryRecovery resumes and finishes it', async () => {
    const snapshot = await env.snapshot(workflowYaml(env.script('ok.sh', 'exit 0')));
    const runs = Object.create(env.p.runs) as typeof env.p.runs;
    let failures = 1;
    runs.finish = (id, opts) => {
      if (failures-- > 0) throw new Error('database is locked');
      return env.p.runs.finish(id, opts);
    };
    const h = await readyHarness({ repositories: { ...env.p, runs } });
    const run = env.reserve(snapshot);
    const left = await h.controller.startRun(run.id).done;
    expect(left.status).toBe('finalizing');
    expect(env.p.events.listForRun(run.id).some((e) => e.type === RUN_EVENTS.controllerError)).toBe(true);
    const final = await h.controller.retryRecovery(run.id);
    expect(final.status).toBe('completed');
    expect(env.p.actions.listForHook(run.id, 'on_success').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)).toBeNull();
  });

  it('rejects starts before recovery finished and protects the lock', async () => {
    const snapshot = await env.snapshot(workflowYaml(env.script('ok.sh', 'exit 0')));
    const h = env.harness();
    const run = env.reserve(snapshot);
    expect(() => h.controller.startRun(run.id)).toThrow(expect.objectContaining({ code: 'run_controller_not_ready' }));
    expect(env.p.runs.require(run.id).status).toBe('cancelled');
    await h.controller.recover();
    const again = env.reserve(snapshot);
    expect(() => env.reserve(snapshot)).toThrow(LockConflictError);
    expect((await h.controller.startRun(again.id).done).status).toBe('completed');
  });

  it('cancels a reserved run that was never started without hooks', async () => {
    const snapshot = await env.snapshot(workflowYaml(env.script('ok.sh', 'exit 0')));
    const h = await readyHarness();
    const run = env.reserve(snapshot);
    const final = await h.controller.cancelRun(run.id);
    expect(final).toMatchObject({ status: 'cancelled', finalReason: 'cancelled by user' });
    expect(env.p.actions.listForRun(run.id)).toEqual([]);
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-coding']);
  });

  it('applies workspace.cleanup = always / never', async () => {
    const ok = env.script('ok.sh', 'exit 0');
    const crash = env.script('crash.sh', 'exit 1');
    const h = await readyHarness();
    const always = await env.snapshot(workflowYaml(crash), {
      configYaml: `workspace:\n  base_dir: ${env.workspaces}\n  cleanup: always\nlifecycle:\n  action_retry: { max_attempts: 1, delay: 10ms }\n`,
    });
    const crashed = await h.controller.startRun(env.reserve(always).id).done;
    expect(crashed.status).toBe('crashed');
    expect(existsSync(crashed.workspacePath as string)).toBe(false);

    const never = await env.snapshot(workflowYaml(ok), {
      configYaml: `workspace:\n  base_dir: ${env.workspaces}\n  cleanup: never\nlifecycle:\n  action_retry: { max_attempts: 1, delay: 10ms }\n`,
    });
    const done = await h.controller.startRun(env.reserve(never).id).done;
    expect(done.status).toBe('completed');
    expect(existsSync(done.workspacePath as string)).toBe(true);
  });
});

function waitForOutput(h: ReturnType<RunsTestEnv['harness']>, runId: string, text: string): Promise<void> {
  if (h.events.some((e) => e.type === 'run.output' && e.runId === runId && e.data.includes(text))) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = h.bus.subscribe((e) => {
      if (e.type === 'run.output' && e.runId === runId && e.data.includes(text)) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function waitForSystemStatus(
  h: ReturnType<RunsTestEnv['harness']>,
  predicate: (s: { draining: boolean; stopping: boolean }) => boolean,
): Promise<void> {
  if (predicate(h.controller.status)) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = h.bus.subscribe((e) => {
      if (e.type === 'system.status' && predicate(e.status)) {
        unsubscribe();
        resolve();
      }
    });
  });
}
