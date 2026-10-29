import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '../core/index.js';
import type { HubConfig } from '../config/index.js';
import { HubControlClient, HubResponseError, HubUnreachableError } from './control-client.js';
import { createHub, type Hub, type HubOptions } from './hub.js';
import { HubSlotClient } from './slot-client.js';
import { FakeSpawner } from './testing/fakes.js';

let dir: string;
let spawner: FakeSpawner;
const hubs: Hub[] = [];
const clients: HubSlotClient[] = [];

const config = (max = 2): HubConfig => ({
  configDir: '/etc/hub',
  maxConcurrent: max,
  server: { host: '127.0.0.1', port: 8090, allowedHosts: [] },
  workspaces: [
    { id: 'coder', configDir: '/cfg/coder', dataDir: '/data/coder', port: 8091, enabled: true },
    { id: 'docs', configDir: '/cfg/docs', dataDir: '/data/docs', port: 8092, enabled: true },
    { id: 'off', configDir: '/cfg/off', dataDir: '/data/off', port: 8093, enabled: false },
  ],
});

function make(extra: Partial<HubOptions> = {}, max = 2): Hub {
  const hub = createHub({
    config: config(max),
    dataDir: path.join(dir, 'hub'),
    version: 'test',
    logger: noopLogger,
    spawner,
    probe: async () => true,
    control: async () => true,
    output: () => undefined,
    baseEnv: {},
    probeIntervalMs: 10,
    drainTimeoutMs: 60_000,
    cancelTimeoutMs: 10_000,
    ...extra,
  });
  hubs.push(hub);
  return hub;
}

async function until(what: string, fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function slotClient(hub: Hub, id: string): HubSlotClient {
  const c = new HubSlotClient({ socketPath: hub.slotSocketPath, workspaceId: id, activeRunIds: () => [], heartbeatMs: 50, reconnectInitialMs: 20, reconnectMaxMs: 100 });
  clients.push(c);
  c.start();
  return c;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'orch-hub-'));
  spawner = new FakeSpawner();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const h of hubs.splice(0)) {
    for (const child of spawner.children) child.exit(0);
    await h.shutdown();
  }
  await rm(dir, { recursive: true, force: true });
});

describe('createHub', () => {
  it('starts the enabled workspaces, listens on two 0600 sockets and refuses a second hub on the same data dir', async () => {
    const hub = make();
    await hub.start();
    expect(spawner.children.map((c) => c.spec.workspaceId)).toEqual(['coder', 'docs']);
    expect(spawner.children[0]?.spec.env).toMatchObject({ ADISPATCH_HUB_SOCKET: hub.slotSocketPath, ADISPATCH_HUB_WORKSPACE: 'coder' });
    for (const p of [hub.slotSocketPath, hub.controlSocketPath]) expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect(() => make()).toThrow(expect.objectContaining({ code: 'instance_locked' }));
  });

  it('reports status over the control socket, incl. connections and slots per workspace', async () => {
    const hub = make();
    await hub.start();
    const ctl = new HubControlClient(hub.controlSocketPath);
    const slot = slotClient(hub, 'coder');
    await until('connected', () => slot.snapshot().reachable);
    await slot.acquire();
    await until('slot visible', () => hub.status().slots.active === 1);
    const status = await ctl.status();
    expect(status).toMatchObject({
      version: 'test',
      state: 'running',
      paused: false,
      slots: { max: 2, active: 1, byWorkspace: { coder: 1 } },
      server: { host: '127.0.0.1', port: 8090 },
    });
    expect(status.workspaces.map((w) => [w.id, w.slots, w.connected, w.url])).toEqual([
      ['coder', 1, true, 'http://127.0.0.1:8091'],
      ['docs', 0, false, 'http://127.0.0.1:8092'],
      ['off', 0, false, 'http://127.0.0.1:8093'],
    ]);
    await until('probe → running', () => hub.status().workspaces[0]?.state === 'running');
  });

  it('pause denies new automatic runs hub-wide, resume allows them again; running slots stay', async () => {
    const hub = make();
    await hub.start();
    const ctl = new HubControlClient(hub.controlSocketPath);
    const a = slotClient(hub, 'coder');
    await until('connected', () => a.snapshot().reachable);
    expect((await a.acquire()).ok).toBe(true);
    expect((await ctl.pause()).state).toBe('paused');
    await until('pushed', () => a.snapshot().paused);
    expect(await a.acquire()).toEqual({ ok: false, reason: 'hub paused (no new automatic runs)' });
    expect(hub.status().slots.active).toBe(1);
    expect((await ctl.resume()).state).toBe('running');
    await until('resumed', () => !a.snapshot().paused);
    expect((await a.acquire()).ok).toBe(true);
  });

  it('frees the slots of a workspace whose process died', async () => {
    const hub = make();
    await hub.start();
    const a = slotClient(hub, 'coder');
    await until('connected', () => a.snapshot().reachable);
    await a.acquire();
    await a.acquire();
    expect((await a.acquire()).ok).toBe(false);
    spawner.last('coder').exit(null, 'SIGKILL'); // kill -9
    await until('slots freed', () => hub.status().slots.active === 0);
    expect(hub.status().workspaces[0]).toMatchObject({ state: 'backoff', crashes: 1 });
  });

  it('workspace commands over the socket; errors map to 404/409', async () => {
    const hub = make();
    await hub.start();
    const ctl = new HubControlClient(hub.controlSocketPath);
    expect((await ctl.workspace('off', 'start')).workspaces[2]?.state).toBe('starting');
    await expect(ctl.workspace('off', 'start')).rejects.toMatchObject({ status: 409, code: 'invalid_state' });
    await expect(ctl.workspace('nope', 'start')).rejects.toMatchObject({ status: 404, code: 'unknown_workspace' });
    expect((await ctl.workspace('coder', 'restart')).workspaces[0]?.transition).toBe('restarting');
    const stopped = await ctl.drainAll();
    expect(stopped.workspaces.every((w) => w.transition === 'draining')).toBe(true);
    await expect(ctl.workspace('coder', 'bogus' as 'start')).rejects.toBeInstanceOf(HubResponseError);
  });

  it('shutdown: SIGTERM to every child, escalation on repeat, then sockets removed and lock released', async () => {
    const hub = make();
    await hub.start();
    const p = hub.shutdown({ mode: 'drain' });
    expect(spawner.children.map((c) => c.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
    void hub.shutdown({ mode: 'cancel' });
    expect(spawner.children.map((c) => c.signals)).toEqual([['SIGTERM', 'SIGTERM'], ['SIGTERM', 'SIGTERM']]);
    expect(hub.status().state).toBe('stopping');
    let stopped = false;
    void hub.stopped.then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false); // children still alive
    for (const c of spawner.children) c.exit(0);
    expect(await p).toEqual({ exitCode: 0 });
    await expect(stat(hub.slotSocketPath)).rejects.toThrow();
    await expect(stat(hub.controlSocketPath)).rejects.toThrow();
    await expect(new HubControlClient(hub.controlSocketPath).status()).rejects.toBeInstanceOf(HubUnreachableError);
    // The lock is free again.
    const again = make();
    await again.start();
  });
});
