import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUB_SOCKET_ENV, HUB_WORKSPACE_ENV } from '../core/index.js';
import { hubFromEnv } from '../app.js';
import { REPO_A, createAppEnv, startAppEnv, type AppEnv } from '../api/testing/helpers.js';
import { SlotLedger } from './ledger.js';
import { SlotServer } from './slot-server.js';

let env: AppEnv;
let sockDir: string;
let socketPath: string;
let ledger: SlotLedger;
let hubServer: SlotServer;

async function startHub(max: number): Promise<void> {
  ledger = new SlotLedger(max);
  hubServer = new SlotServer({ socketPath, ledger, workspaceIds: () => new Set(['w1']) });
  await hubServer.listen();
}

beforeEach(async () => {
  sockDir = await mkdtemp(path.join(os.tmpdir(), 'orch-ah-'));
  socketPath = path.join(sockDir, 's.sock');
});
afterEach(async () => {
  await env?.cleanup();
  await hubServer?.close();
  await rm(sockDir, { recursive: true, force: true });
});

describe('hub membership of an instance (WI-35)', () => {
  it('reads the hub from the environment variables and ignores an empty value', () => {
    expect(hubFromEnv({})).toBeUndefined();
    expect(hubFromEnv({ [HUB_SOCKET_ENV]: '  ' })).toBeUndefined();
    expect(hubFromEnv({ [HUB_SOCKET_ENV]: '/x/s.sock', [HUB_WORKSPACE_ENV]: 'w1' })).toEqual({ socketPath: '/x/s.sock', workspaceId: 'w1' });
    expect(() => hubFromEnv({ [HUB_SOCKET_ENV]: '/x/s.sock' })).toThrow(/ADISPATCH_HUB_WORKSPACE/);
  });

  it('shares the limit, reports the hub in /status, and survives a hub outage without touching running runs', async () => {
    await startHub(1);
    env = await createAppEnv({ start: false });
    const gate = path.join(env.marks, 'gate');
    const worker = env.script('block.sh', `while [ ! -f "${gate}" ]; do sleep 0.05; done`);
    writeFileSync(
      path.join(env.configDir, 'workflows', 'coder.yaml'),
      `id: coder\nname: coder\ntrigger: { type: source, source: repo_a }\nidentity: coder\nmax_concurrent: 5\nfilter: { field: labels, operator: contains, value: ready }\nexecute:\n  type: shell\n  command: ${worker}\n  cancel_grace: 200ms\n`,
    );
    env.github.createIssue(REPO_A, { number: 1, labels: ['ready'] });
    env.github.createIssue(REPO_A, { number: 2, labels: ['ready'] });
    env.app = await env.createApp({ hub: { socketPath, workspaceId: 'w1', heartbeatMs: 50, reconnectInitialMs: 20, reconnectMaxMs: 100 } });
    await env.app.start();
    await env.app.ready;
    await vi.waitFor(async () => expect(((await env.request('GET', '/api/v1/status')).json as any).hub?.reachable).toBe(true));
    // The first planning step (right after start) took the only slot; the second candidate got hub_limit.
    await vi.waitFor(() => expect(ledger.active).toBe(1));
    await env.app.scheduler.planOnce();
    const decisions = env.app.scheduler.lastDiagnosis('coder')?.candidates.map((c) => c.decision);
    expect(decisions).toContain('hub_limit');
    expect(env.app.persistence.runs.countActive()).toBe(1);
    const status = (await env.request('GET', '/api/v1/status')).json as any;
    expect(status.hub).toEqual({ workspace: 'w1', reachable: true, paused: false, active: 1, max: 1 });

    // Hub outage: the running run is untouched, nothing new starts.
    const [running] = env.app.persistence.runs.listActive();
    await hubServer.close();
    await vi.waitFor(async () => expect(((await env.request('GET', '/api/v1/status')).json as any).hub.reachable).toBe(false));
    await env.app.scheduler.planOnce();
    expect(env.app.scheduler.lastDiagnosis('coder')?.candidates.every((c) => c.decision !== 'started')).toBe(true);
    expect(env.app.scheduler.lastDiagnosis('coder')?.candidates.map((c) => c.reason)).toContain('hub not reachable (no new automatic runs)');
    expect(env.app.persistence.runs.get(running!.id)?.status).toBe('running');

    // The hub comes back: the surviving run is counted again.
    await startHub(1);
    await vi.waitFor(() => expect(ledger.active).toBe(1));
    expect(ledger.byWorkspace()).toEqual({ w1: 1 });

    // Run ends → slot freed → the next planning step starts the other item.
    writeFileSync(gate, '');
    await env.waitTerminal(running!.id);
    await vi.waitFor(() => expect(ledger.active).toBe(0));
    await vi.waitFor(async () => expect(((await env.request('GET', '/api/v1/status')).json as any).hub.active).toBe(0));
    const report = await env.app.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
  });

  it('a manual run is never refused by the hub but counts', async () => {
    await startHub(1);
    ledger.adopt('other', 'x'); // hub already full
    env = await createAppEnv({ start: false });
    const worker = env.script('quick.sh', 'sleep 0.3');
    writeFileSync(
      path.join(env.configDir, 'workflows', 'manual.yaml'),
      `id: manual\nname: manual\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: ${worker}\n  cancel_grace: 200ms\n`,
    );
    env.app = await env.createApp({ hub: { socketPath, workspaceId: 'w1', heartbeatMs: 50 } });
    await env.app.start();
    await env.app.ready;
    await vi.waitFor(async () => expect(((await env.request('GET', '/api/v1/status')).json as any).hub?.reachable).toBe(true));
    const res = await env.request('POST', '/api/v1/workflows/manual/start', {});
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(ledger.activeOf('w1')).toBe(1));
    expect(ledger.active).toBe(2);
    await vi.waitFor(() => expect(ledger.activeOf('w1')).toBe(0));
  });

  it('without a hub /status has no hub entry', async () => {
    env = await startAppEnv();
    expect(((await env.request('GET', '/api/v1/status')).json as any).hub).toBeUndefined();
  });
});
