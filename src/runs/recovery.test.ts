import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessStartIdentity } from '../core/index.js';
import { getStartIdentity, processGroupExists } from '../executors/index.js';
import { LockConflictError, type RunRecord } from '../persistence/index.js';
import { RUN_EVENTS } from './controller.js';
import { ISSUE, ITEM_KEY, REPO, createRunsEnv, statusTrail, workflowYaml, type RunsTestEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

describe.runIf(supported)('RunController recovery (Spec §14, variant A)', () => {
  let env: RunsTestEnv;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    env = createRunsEnv();
  });
  afterEach(() => {
    for (const c of children.splice(0)) {
      try {
        if (c.pid) process.kill(-c.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    env.cleanup();
  });

  /** A real orphaned "worker" in its own process group (as the shell executor would start it). */
  async function startOrphan(): Promise<{ child: ChildProcess & { pid: number }; identity: ProcessStartIdentity; exited: Promise<NodeJS.Signals | null> }> {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const identity = (await getStartIdentity(child.pid as number)) as ProcessStartIdentity;
    expect(identity).toBeDefined();
    return { child: child as ChildProcess & { pid: number }, identity, exited };
  }

  /** Simulate the DB state a crashed controller leaves behind for a running worker. */
  async function crashedWhileRunning(pid: number, identity: ProcessStartIdentity | null): Promise<RunRecord> {
    const snapshot = await env.snapshot(workflowYaml('/bin/true'));
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    env.github.setLabels(REPO, ISSUE, ['coding', 'manual-label']); // on_start had run
    env.p.events.append(run.id, RUN_EVENTS.spawn, { command: '/bin/true', args: [], workingDirectory: env.workspaces });
    return env.p.runs.transition(run.id, 'running', { update: { pid, processStartIdentity: identity } });
  }

  it('scenario 8: kills a live orphan with verified identity, runs on_crash, becomes ready only afterwards', async () => {
    const orphan = await startOrphan();
    const run = await crashedWhileRunning(orphan.child.pid, orphan.identity);
    const h = env.harness();
    expect(h.controller.isReady()).toBe(false);
    expect(h.controller.canStartAutomatically()).toBe(false);

    const report = await h.controller.recover();
    expect(await orphan.exited).toBe('SIGTERM');
    expect(processGroupExists(orphan.child.pid)).toBe(false);

    const final = env.p.runs.require(run.id);
    expect(final.status).toBe('crashed');
    expect(final.finalReason).toMatch(/orphaned worker .* terminated/);
    expect(final.countedTechnicalFailure).toBe(true);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
    expect(env.p.actions.listForHook(run.id, 'on_crash').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['manual-label', 'ready-for-coding']);
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)).toBeNull();
    expect(report.finalized).toEqual([{ runId: run.id, status: 'crashed', detail: final.finalReason }]);

    // Ready strictly after the run was finalized (and its hook ran).
    expect(h.controller.isReady()).toBe(true);
    const crashedAt = h.events.findIndex((e) => e.type === 'run.event' && e.event.runId === run.id && e.event.payload.to === 'crashed');
    const readyAt = h.events.findIndex((e) => e.type === 'system.status' && e.status.ready);
    expect(crashedAt).toBeGreaterThanOrEqual(0);
    expect(readyAt).toBeGreaterThan(crashedAt);
    expect(statusTrail(h.events, run.id)).toEqual(['finalizing', 'crashed']);
  });

  it('scenario 8: does NOT kill a process whose start identity differs → recovery_pending, lock kept', async () => {
    const orphan = await startOrphan();
    const wrong: ProcessStartIdentity = { ...orphan.identity, token: `${orphan.identity.token}-another-process` };
    const run = await crashedWhileRunning(orphan.child.pid, wrong);
    const h = env.harness();
    const report = await h.controller.recover();

    expect(h.controller.isReady()).toBe(true);
    expect(orphan.child.exitCode).toBeNull();
    expect(orphan.child.signalCode).toBeNull();
    expect(processGroupExists(orphan.child.pid)).toBe(true);
    const pending = env.p.runs.require(run.id);
    expect(pending.status).toBe('recovery_pending');
    expect(pending.error).toMatchObject({ code: 'recovery_failed', previousStatus: 'running' });
    expect(report.pending).toEqual([{ runId: run.id, reason: expect.stringContaining('different process') }]);
    expect(env.notifications.filter((n) => n.type === 'recovery_failed')).toEqual([
      { type: 'recovery_failed', payload: expect.objectContaining({ runId: run.id, workflowId: 'wf', pid: orphan.child.pid }) },
    ]);
    expect(env.p.events.listForRun(run.id).some((e) => e.type === RUN_EVENTS.recoveryFailed)).toBe(true);
    // No double start: the lock is still held, no hook ran, labels untouched.
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)?.runId).toBe(run.id);
    expect(() => env.reserve(pending.configSnapshot as never)).toThrow(LockConflictError);
    expect(env.p.actions.listForRun(run.id)).toEqual([]);
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['coding', 'manual-label']);
    await expect(h.controller.cancelRun(run.id)).rejects.toMatchObject({ code: 'run_not_cancellable' });

    // Retrying while still unverifiable keeps it pending (no second notification).
    expect((await h.controller.retryRecovery(run.id)).status).toBe('recovery_pending');
    expect(env.notifications.filter((n) => n.type === 'recovery_failed')).toHaveLength(1);

    // Once the operator stopped the process, retrying finalizes it as crashed with on_crash.
    process.kill(-orphan.child.pid, 'SIGKILL');
    await orphan.exited;
    const recovered = await h.controller.retryRecovery(run.id);
    expect(recovered.status).toBe('crashed');
    expect(env.p.actions.listForHook(run.id, 'on_crash').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.p.runs.activeLock('wf', `item:${ITEM_KEY}`)).toBeNull();
  });

  it('operator can resolve recovery_pending with assumeGone (nothing is signalled)', async () => {
    const orphan = await startOrphan();
    const run = await crashedWhileRunning(orphan.child.pid, { ...orphan.identity, token: 'darwin:not-it' });
    const h = env.harness();
    await h.controller.recover();
    expect(env.p.runs.require(run.id).status).toBe('recovery_pending');
    const final = await h.controller.retryRecovery(run.id, { assumeGone: true });
    expect(final.status).toBe('crashed');
    expect(final.finalReason).toMatch(/operator confirmed/);
    expect(processGroupExists(orphan.child.pid)).toBe(true);
    await expect(h.controller.retryRecovery(run.id)).rejects.toMatchObject({ code: 'run_not_recovery_pending' });
  });

  it('pid reused by another process: crashed if no group with the old pgid exists, else recovery_pending (injected probes)', async () => {
    const signals: number[] = [];
    const overrides = {
      processInspector: { platform: 'test', probe: async (pid: number) => ({ pgid: pid, token: 'test:another-process' }) },
      kill: (pid: number) => void signals.push(pid),
    };
    const gone = await crashedWhileRunning(424_242, { pid: 424_242, pgid: 424_242, token: 'test:original' });
    const h = env.harness({ ...overrides, groupExists: () => false });
    await h.controller.recover();
    expect(env.p.runs.require(gone.id)).toMatchObject({ status: 'crashed', finalReason: expect.stringContaining('pid reused') });
    expect(signals).toEqual([]);

    env.github.createIssue(REPO, { number: 9, labels: ['coding'] });
    const snapshot = await env.snapshot(workflowYaml('/bin/true'));
    const other = env.reserve(snapshot, { sourceItemKey: 'repo_a:9', sourceUrl: null });
    env.p.runs.transition(other.id, 'starting');
    env.p.runs.transition(other.id, 'running', { update: { pid: 424_243, processStartIdentity: { pid: 424_243, pgid: 424_243, token: 'test:original' } } });
    const h2 = env.harness({ ...overrides, groupExists: () => true });
    await h2.controller.recover();
    expect(env.p.runs.require(other.id).status).toBe('recovery_pending');
    expect(signals).toEqual([]);
  });

  it('shutdown during recovery waits for it; retryRecovery and cancel are refused meanwhile', async () => {
    const release = path.join(env.marks, 'release');
    const hookWait = env.script('hook-wait.sh', `while [ ! -f "${release}" ]; do sleep 0.02; done`);
    const snapshot = await env.snapshot(
      workflowYaml('/bin/true').replace('on_failure:', `  - type: shell\n    command: ${hookWait}\n    timeout: 1m\non_failure:`),
    );
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    env.p.runs.transition(run.id, 'running', { update: { pid: 999_999 } });
    env.p.runs.beginFinalization(run.id, { status: 'completed', businessResult: 'success', reason: 'exit code 0' });

    const stops: unknown[] = [];
    const h = env.harness({ onStop: (r) => void stops.push(r) });
    const hookRunning = new Promise<void>((resolve) => {
      h.bus.subscribe((e) => {
        if (e.type === 'run.action' && e.action.type === 'shell' && e.action.status === 'running') resolve();
      });
    });
    const recovering = h.controller.recover();
    await hookRunning;
    expect(h.controller.activeRunIds()).toEqual([run.id]);
    const stopping = h.controller.shutdown();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(stops).toEqual([]);
    await expect(h.controller.retryRecovery(run.id)).rejects.toMatchObject({ code: 'run_controller_not_ready' });
    await expect(h.controller.cancelRun(run.id)).rejects.toMatchObject({ code: 'run_not_cancellable' });

    writeFileSync(release, '');
    await recovering;
    expect(await stopping).toEqual({ outcome: 'drained', leftActive: [] });
    expect(stops).toHaveLength(1);
    expect(env.p.runs.require(run.id).status).toBe('completed');
  });

  it('a vanished worker (pid without identity, group gone) is treated as crashed', async () => {
    const done = spawn('true', [], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => done.once('exit', resolve));
    const run = await crashedWhileRunning(done.pid as number, null);
    const h = env.harness();
    await h.controller.recover();
    const final = env.p.runs.require(run.id);
    expect(final.status).toBe('crashed');
    expect(env.p.actions.listForHook(run.id, 'on_crash').map((a) => a.status)).toEqual(['succeeded']);
  });

  it('a run whose spawn may have happened but whose pid was not persisted becomes recovery_pending', async () => {
    const snapshot = await env.snapshot(workflowYaml('/bin/true'));
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    env.p.events.append(run.id, RUN_EVENTS.spawn, { command: '/bin/true', args: [], workingDirectory: env.workspaces });
    const h = env.harness();
    const report = await h.controller.recover();
    expect(env.p.runs.require(run.id).status).toBe('recovery_pending');
    expect(report.pending[0]?.reason).toMatch(/pid was not persisted/);
    expect(h.controller.isReady()).toBe(true);
  });

  it('crash during on_start (no worker spawned): interrupted on_start is abandoned, run → crashed with on_crash', async () => {
    const snapshot = await env.snapshot(
      workflowYaml('/bin/true').replace('on_success:', '  - type: source.comment\n    message: started\non_success:'),
    );
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    const journal = env.p.actions.createJournal(
      run.id,
      'on_start',
      (snapshot.workflow.hooks.on_start ?? []).map((config) => ({ type: config.type, name: config.id, config })),
    );
    env.p.actions.startAttempt(journal[0]!.id); // controller died inside the first action
    const h = env.harness();
    await h.controller.recover();

    const final = env.p.runs.require(run.id);
    expect(final.status).toBe('crashed');
    expect(env.p.actions.listForHook(run.id, 'on_start').map((a) => a.status)).toEqual(['skipped', 'skipped']);
    expect(env.p.actions.listForHook(run.id, 'on_crash').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.github.comments(REPO, ISSUE)).toHaveLength(0);
    expect(final.lifecycleStatus).toBe('succeeded');
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(1);
  });

  it('resumes a run left in finalizing from its persisted target (hook from the snapshot)', async () => {
    const snapshot = await env.snapshot(workflowYaml('/bin/true'));
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    env.p.runs.transition(run.id, 'running', { update: { pid: 999_999 } });
    env.p.runs.beginFinalization(
      run.id,
      { status: 'completed', businessResult: 'failure', reason: 'exit code 0, result failure' },
      { update: { result: { schema_version: 1, result: 'failure', message: 'Needs input' } } },
    );
    const h = env.harness();
    await h.controller.recover();
    const final = env.p.runs.require(run.id);
    expect(final).toMatchObject({ status: 'completed', businessResult: 'failure' });
    expect(env.p.actions.listForHook(run.id, 'on_failure').map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
    expect(env.github.comments(REPO, ISSUE).map((c) => c.body.split('\n')[0])).toEqual(['Needs maintainer: Needs input']);
    // Counted exactly once (at the original → finalizing transition): failure never counts.
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(0);
  });

  it('keeps files when resuming a finalizing run, exactly once (WI-22)', async () => {
    const snapshot = await env.snapshot(workflowYaml('/bin/true').replace('  cancel_grace: 300ms', "  cancel_grace: 300ms\n  keep: ['*.log']"));
    const run = env.reserve(snapshot);
    const ws = path.join(env.workspaces, 'wf', run.id);
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'gate.log'), 'gate');
    env.p.runs.update(run.id, { workspacePath: ws });
    env.p.runs.transition(run.id, 'starting');
    env.p.runs.transition(run.id, 'running', { update: { pid: 999_999 } });
    env.p.runs.beginFinalization(run.id, { status: 'completed', businessResult: 'success', reason: 'exit code 0' });
    const h = env.harness();
    await h.controller.recover();
    expect(env.p.runs.require(run.id).status).toBe('completed');
    expect(readFileSync(path.join(env.dataDir, 'runs', run.id, 'kept', 'gate.log'), 'utf8')).toBe('gate');
    expect(existsSync(ws)).toBe(false);
    expect(env.p.events.listForRun(run.id).filter((e) => e.type === RUN_EVENTS.keptFiles)).toHaveLength(1);
  });

  it('a reserved run is released as cancelled without hooks; cancelling runs end as cancelled', async () => {
    const snapshot = await env.snapshot(workflowYaml('/bin/true'));
    const reserved = env.reserve(snapshot);
    env.github.createIssue(REPO, { number: 8, labels: ['coding'] });
    const other = env.reserve(snapshot, { sourceItemKey: 'repo_a:8', sourceUrl: null });
    env.p.runs.transition(other.id, 'starting');
    env.p.runs.transition(other.id, 'cancelling');
    const h = env.harness();
    await h.controller.recover();
    expect(env.p.runs.require(reserved.id)).toMatchObject({ status: 'cancelled', countedTechnicalFailure: false });
    expect(env.p.actions.listForRun(reserved.id)).toEqual([]);
    const cancelled = env.p.runs.require(other.id);
    expect(cancelled.status).toBe('cancelled');
    expect(env.p.actions.listForHook(other.id, 'on_cancel').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.github.labels(REPO, 8)).toEqual(['ready-for-coding']);
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(0);
  });

  it('resumes interrupted action chains of finished runs', async () => {
    const snapshot = await env.snapshot(workflowYaml('/bin/true'));
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    env.p.runs.transition(run.id, 'running', { update: { pid: 999_999 } });
    env.p.runs.beginFinalization(run.id, { status: 'completed', businessResult: 'success', reason: 'exit code 0' });
    const journal = env.p.actions.createJournal(
      run.id,
      'on_success',
      (snapshot.workflow.hooks.on_success ?? []).map((config) => ({ type: config.type, name: config.id, config })),
    );
    env.p.runs.finish(run.id);
    env.p.actions.startAttempt(journal[0]!.id); // e.g. a manual retry interrupted by the crash
    const h = env.harness();
    const report = await h.controller.recover();
    expect(report.resumedActions).toEqual([run.id]);
    expect(env.p.actions.listForHook(run.id, 'on_success').map((a) => a.status)).toEqual(['succeeded']);
    expect(env.github.labels(REPO, ISSUE)).toContain('ready-for-review');
    expect(env.p.runs.require(run.id).status).toBe('completed');
  });
});
