import { mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlotLedger } from './ledger.js';
import { HubSlotClient, type HubSlotClientOptions } from './slot-client.js';
import { SlotServer } from './slot-server.js';

let dir: string;
let socketPath: string;
const closers: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'orch-slots-'));
  socketPath = path.join(dir, 's.sock');
});
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  await rm(dir, { recursive: true, force: true });
});

async function server(max: number, extra: { leaseTtlMs?: number; workspaces?: string[] } = {}): Promise<{ server: SlotServer; ledger: SlotLedger }> {
  const ledger = new SlotLedger(max);
  const s = new SlotServer({
    socketPath,
    ledger,
    workspaceIds: () => new Set(extra.workspaces ?? ['a', 'b']),
    ...(extra.leaseTtlMs ? { leaseTtlMs: extra.leaseTtlMs } : {}),
  });
  await s.listen();
  closers.push(() => s.close());
  return { server: s, ledger };
}

function client(workspaceId: string, runs: () => string[] = () => [], extra: Partial<HubSlotClientOptions> = {}): HubSlotClient {
  const c = new HubSlotClient({ socketPath, workspaceId, activeRunIds: runs, heartbeatMs: 50, reconnectInitialMs: 20, reconnectMaxMs: 100, requestTimeoutMs: 1000, ...extra });
  closers.push(() => c.stop());
  c.start();
  return c;
}

async function until(what: string, fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('slot server and client', () => {
  it('creates the socket with mode 0600', async () => {
    await server(1);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('never grants more than max across two workspaces, even for parallel requests', async () => {
    const { ledger } = await server(3);
    const a = client('a');
    const b = client('b');
    await until('connected', () => a.snapshot().reachable && b.snapshot().reachable);
    const results = await Promise.all([...Array.from({ length: 6 }, () => a.acquire()), ...Array.from({ length: 6 }, () => b.acquire())]);
    const granted = results.filter((r) => r.ok);
    expect(granted).toHaveLength(3);
    expect(ledger.active).toBe(3);
    const denied = results.find((r) => !r.ok);
    expect(denied && !denied.ok ? denied.reason : '').toBe('hub limit reached (3/3 active)');
    // Releasing frees exactly that slot.
    const first = granted[0];
    if (first?.ok) first.lease.release();
    await until('freed', () => ledger.active === 2);
    expect((await a.acquire()).ok).toBe(true);
  });

  it('releases a slot when the run it was attached to ends', async () => {
    const { ledger } = await server(1);
    const a = client('a');
    await until('connected', () => a.snapshot().reachable);
    const r = await a.acquire();
    expect(r.ok).toBe(true);
    let end!: () => void;
    const done = new Promise<void>((resolve) => (end = resolve));
    if (r.ok) r.lease.attach('run-1', done);
    expect(ledger.active).toBe(1);
    end();
    await until('released', () => ledger.active === 0);
  });

  it('adopts runs of the database (recovery, manual) without refusing them, and releases ended runs', async () => {
    const { ledger } = await server(1);
    let runs = ['r1', 'r2'];
    const a = client('a', () => runs);
    await until('adopted', () => ledger.activeOf('a') === 2);
    expect(ledger.active).toBe(2); // above max: real runs cannot be refused
    expect((await a.acquire()).ok).toBe(false);
    runs = ['r2'];
    await until('r1 released', () => ledger.activeOf('a') === 1);
    a.adopt('m1', new Promise(() => undefined));
    await until('manual adopted', () => ledger.activeOf('a') === 2);
  });

  it('frees the slots of a workspace whose process died (dropWorkspace)', async () => {
    const { server: s, ledger } = await server(2);
    const a = client('a');
    await until('connected', () => a.snapshot().reachable);
    await a.acquire();
    await a.acquire();
    expect(ledger.active).toBe(2);
    s.dropWorkspace('a');
    expect(ledger.active).toBe(0);
    // The client notices the closed connection and reconnects with an empty claim … then its own leases are re-announced.
    await until('reconnected', () => a.snapshot().reachable);
  });

  it('expires the slots of a silent workspace after the lease TTL (kill -9 without a clean close)', async () => {
    const { ledger } = await server(2, { leaseTtlMs: 150 });
    // A raw peer that says hello, takes a slot and then never speaks again.
    const raw = net.createConnection(socketPath);
    closers.push(() => void raw.destroy());
    raw.write('{"t":"hello","v":1,"workspace":"a","pid":1,"leases":[]}\n{"t":"acquire","id":1,"lease":"k1"}\n');
    await until('granted', () => ledger.active === 1);
    await until('expired', () => ledger.active === 0, 3000);
  });

  it('keeps the leases through a short connection loss and counts them again after a hub restart', async () => {
    const first = await server(2);
    const a = client('a', () => ['run-1']);
    await until('connected', () => a.snapshot().reachable);
    const r = await a.acquire();
    if (r.ok) r.lease.attach('run-1', new Promise(() => undefined));
    // Hub dies (kill -9 equivalent: close without dropping on the client side).
    await first.server.close();
    await until('unreachable', () => !a.snapshot().reachable);
    expect((await a.acquire()).ok).toBe(false);
    // A new hub starts on the same socket: the client re-announces its lease.
    const second = await server(2);
    await until('reconnected', () => a.snapshot().reachable);
    expect(second.ledger.activeOf('a')).toBe(1);
  });

  it('denies while paused and tells the client', async () => {
    const { server: s } = await server(5);
    const a = client('a');
    await until('connected', () => a.snapshot().reachable);
    s.setPaused(true);
    await until('paused pushed', () => a.snapshot().paused);
    const r = await a.acquire();
    expect(r).toEqual({ ok: false, reason: 'hub paused (no new automatic runs)' });
    s.setPaused(false);
    await until('resumed', () => !a.snapshot().paused);
    expect((await a.acquire()).ok).toBe(true);
  });

  it('pushes the hub-wide usage to every workspace', async () => {
    await server(4);
    const a = client('a');
    const b = client('b');
    await until('connected', () => a.snapshot().reachable && b.snapshot().reachable);
    await a.acquire();
    await until('b sees it', () => b.snapshot().active === 1 && b.snapshot().max === 4);
  });

  it('rejects unknown workspaces', async () => {
    await server(1, { workspaces: ['a'] });
    const x = client('x');
    await new Promise((r) => setTimeout(r, 200));
    expect(x.snapshot().reachable).toBe(false);
  });

  it('without a hub: acquire is denied (safe side) and the snapshot says unreachable', async () => {
    const a = client('a');
    expect(a.snapshot()).toEqual({ reachable: false, paused: false, active: 0, max: 0 });
    const r = await a.acquire();
    expect(r.ok).toBe(false);
  });
});
