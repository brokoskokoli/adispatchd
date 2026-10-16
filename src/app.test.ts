import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isOrchestratorError, type FetchLike } from './core/index.js';
import { installSignalHandlers, type App } from './app.js';
import { REPO_A, createAppEnv, type AppEnv } from './api/testing/helpers.js';

const envs: AppEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()!.cleanup();
});

function sourceWorkflow(env: AppEnv, id: string, command: string, extra = ''): void {
  writeFileSync(
    path.join(env.configDir, 'workflows', `${id}.yaml`),
    `id: ${id}\nname: ${id}\nenabled: false\ntrigger: { type: source, source: repo_a }\nexecute:\n  type: shell\n  command: ${command}\n  cancel_grace: 200ms\n${extra}`,
  );
}

describe('createApp', () => {
  it('/ready becomes true only after recovery finished (/health works before)', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let gated = 0;
    const env = await createAppEnv();
    envs.push(env);
    const fetchGated: FetchLike = async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/labels')) {
        gated++;
        await gate;
      }
      return env.github.fetch(input, init);
    };
    sourceWorkflow(env, 'coder', env.script('ok.sh', 'exit 0'), 'on_success:\n  - type: source.update\n    labels: { add: [done] }\n');
    env.github.createIssue(REPO_A, { number: 1, title: 'x' });
    env.app = await env.createApp({ fetch: fetchGated });
    // A run left in `finalizing` by a "crashed" previous controller: recovery resumes its on_success hook.
    const p = env.app.persistence;
    const run = p.runs.reserve({
      workflowId: 'coder',
      triggerType: 'source',
      sourceId: 'repo_a',
      sourceItemKey: 'repo_a:1',
      configSnapshot: env.app.config.snapshotWorkflow('coder'),
    });
    p.runs.transition(run.id, 'starting');
    p.runs.transition(run.id, 'running');
    p.runs.beginFinalization(run.id, { status: 'completed', businessResult: 'success', reason: 'exit code 0' });

    await env.app.start();
    expect((await env.request('GET', '/health')).status).toBe(200);
    for (let i = 0; i < 200 && gated === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(gated).toBe(1);
    const notReady = await env.request('GET', '/ready');
    expect(notReady.status).toBe(503);
    expect(notReady.json).toMatchObject({ ready: false, checks: { database: true, recovery: false, scheduler: false } });
    expect((await env.request('GET', '/api/v1/status')).json.scheduler.state).toBe('recovering');

    releaseGate();
    await env.app.ready;
    expect((await env.request('GET', '/ready')).status).toBe(200);
    expect(p.runs.get(run.id)!.status).toBe('completed');
    expect(env.github.labels(REPO_A, 1)).toContain('done');
  });

  it('refuses a second instance on the same data dir; API drain stops with exit code 0 and releases the lock', async () => {
    const env = await createAppEnv();
    envs.push(env);
    env.app = await env.createApp();
    await env.app.start();
    await env.app.ready;
    await expect(env.createApp()).rejects.toSatisfy((err: unknown) => isOrchestratorError(err, 'instance_locked'));

    const res = await env.request('POST', '/api/v1/shutdown/drain');
    expect(res.status).toBe(202);
    const result = await env.app.stopped;
    expect(result).toMatchObject({ exitCode: 0, shutdown: { outcome: 'drained', leftActive: [] } });

    const second = await env.createApp();
    await second.start();
    await second.ready;
    await second.shutdown();
  });

  it('API cancel-all cancels active runs (on_cancel runs) and stops with exit code 0', async () => {
    const env = await createAppEnv();
    envs.push(env);
    const release = path.join(env.marks, 'release');
    sourceWorkflow(env, 'slow', env.script('slow.sh', `while [ ! -f "${release}" ]; do sleep 0.05; done`), 'on_cancel:\n  - type: source.update\n    labels: { add: [cancelled] }\n');
    env.github.createIssue(REPO_A, { number: 6, title: 'slow' });
    env.app = await env.createApp();
    await env.app.start();
    await env.app.ready;
    const start = await env.request('POST', '/api/v1/workflows/slow/start', { item: '6' });
    const runId = start.json.run.id as string;
    await env.waitRun(runId, (r) => r.status === 'running');
    const res = await env.request('POST', '/api/v1/shutdown/cancel-all', { reason: 'maintenance' });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ accepted: true, mode: 'cancel', activeRuns: [runId] });
    const result = await env.app.stopped;
    expect(result).toMatchObject({ exitCode: 0, shutdown: { outcome: 'cancelled', leftActive: [] } });
    const again = await env.createApp();
    expect(again.persistence.runs.get(runId)).toMatchObject({ status: 'cancelled', finalReason: 'maintenance' });
    expect(env.github.labels(REPO_A, 6)).toContain('cancelled');
    await again.shutdown();
  });

  it('SIGTERM drains with timeout, then cancels; a second signal escalates; a third forces exit', async () => {
    const env = await createAppEnv();
    envs.push(env);
    const release = path.join(env.marks, 'release');
    sourceWorkflow(env, 'slow', env.script('slow.sh', `while [ ! -f "${release}" ]; do sleep 0.05; done`), 'on_cancel:\n  - type: source.update\n    labels: { add: [cancelled] }\n');
    env.github.createIssue(REPO_A, { number: 5, title: 'slow' });
    env.app = await env.createApp();
    await env.app.start();
    await env.app.ready;
    const start = await env.request('POST', '/api/v1/workflows/slow/start', { item: '5' });
    const runId = start.json.run.id as string;
    await env.waitRun(runId, (r) => r.status === 'running');

    const target = new EventEmitter();
    const exits: number[] = [];
    const uninstall = installSignalHandlers(env.app, {
      target: target as never,
      drainTimeoutMs: 300,
      cancelTimeoutMs: 5_000,
      forceExit: (c) => exits.push(c),
    });
    target.emit('SIGTERM');
    // Draining: new manual starts are refused, the run keeps running for now.
    await new Promise((r) => setTimeout(r, 50));
    expect(env.app.controller.status.draining).toBe(true);
    expect((await env.request('GET', '/ready')).status).toBe(503);
    const result: Awaited<App['stopped']> = await env.app.stopped;
    expect(result.exitCode).toBe(0);
    expect(result.shutdown?.outcome).toBe('cancelled');
    uninstall();
    // DB is closed now; check the outcome through a fresh instance.
    const again = await env.createApp();
    expect(again.persistence.runs.get(runId)!.status).toBe('cancelled');
    expect(env.github.labels(REPO_A, 5)).toContain('cancelled');
    await again.shutdown();

    // Escalation + force exit on a fake app.
    const calls: unknown[] = [];
    const fake = { shutdown: async (o: unknown) => (calls.push(o), { exitCode: 0, shutdown: null }), logger: env.logger };
    const t2 = new EventEmitter();
    installSignalHandlers(fake as never, { target: t2 as never, forceExit: (c) => exits.push(c) });
    t2.emit('SIGINT');
    t2.emit('SIGTERM');
    t2.emit('SIGTERM');
    expect(calls).toMatchObject([{ mode: 'drain' }, { mode: 'cancel' }]);
    expect(exits).toEqual([1]);
  });
});
