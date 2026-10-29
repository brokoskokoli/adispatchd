/**
 * End-to-end test of the hub (WI-35) with real processes: `adispatch hub start`
 * runs two real workspace instances (child processes) against Fake-GitHub
 * (served on a local port; the children reach it through a fetch preload).
 *
 * Covers: shared limit across two workspaces (never more than `max_concurrent`
 * runs at once), slots freed by `kill -9` of a child and restart with backoff
 * without touching the sibling, pause/resume, shutdown by SIGTERM (drain) and
 * a second signal (cancel-all) without orphan processes, and a crash of the
 * hub itself (running runs untouched, nothing new starts, slots counted again
 * after the hub is back).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGitHub } from '../sources/github/testing/index.js';
import { HubControlClient } from './control-client.js';
import type { HubStatus } from './hub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testing/fetch-redirect.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 40_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let root: string;
let github: FakeGitHub;
let githubServer: http.Server;
let githubPort: number;
let hubProc: ChildProcess | undefined;
let hubOut = '';
const knownPids = new Set<number>();
let ports: { w1: number; w2: number; hub: number };
let hubCfg: string;
let hubData: string;
let marks: string;
let ctl: HubControlClient;
const env: Record<string, string> = {};

function writeWorkspace(id: 'w1' | 'w2', repo: string, port: number): void {
  const cfg = path.join(root, 'hub', 'workspaces', id, 'config');
  mkdirSync(path.join(cfg, 'workflows'), { recursive: true });
  const common = {
    maintainer: github.createApp({ login: 'maintainer[bot]' }),
    coder: github.createApp({ login: 'coder[bot]' }),
  };
  env[`${id.toUpperCase()}_MAINTAINER_KEY`] = common.maintainer.privateKeyPem;
  env[`${id.toUpperCase()}_CODER_KEY`] = common.coder.privateKeyPem;
  writeFileSync(
    path.join(cfg, 'identities.yaml'),
    [
      'identities:',
      ...(['maintainer', 'coder'] as const).flatMap((name) => [
        `  ${name}:`,
        '    type: github_app',
        `    app_id: ${common[name].appId}`,
        `    installation_id: ${common[name].installationId}`,
        `    private_key_env: ${id.toUpperCase()}_${name.toUpperCase()}_KEY`,
      ]),
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(cfg, 'sources.yaml'), `sources:\n  repo_a: { type: github, owner: example, repository: ${repo}, identity: maintainer }\n`);
  writeFileSync(
    path.join(cfg, 'config.yaml'),
    [
      `server: { host: 127.0.0.1, port: ${port} }`,
      'scheduler: { polling_interval: 1s, max_concurrent: 5 }',
      `workspace: { base_dir: ${path.join(root, 'hub', 'workspaces', id, 'ws')}, cleanup: always }`,
      'lifecycle: { action_retry: { max_attempts: 1, delay: 10ms } }',
      'monitoring: { enabled: false }',
      '',
    ].join('\n'),
  );
  const script = path.join(root, 'work.sh');
  writeFileSync(
    path.join(cfg, 'workflows', 'coder.yaml'),
    [
      'id: coder',
      'name: Coder',
      'trigger: { type: source, source: repo_a }',
      'identity: coder',
      'max_concurrent: 5',
      'filter: { field: labels, operator: contains, value: ready-for-coding }',
      `execute: { type: shell, command: ${script}, cancel_grace: 300ms }`,
      'on_start: [ { type: source.update, labels: { add: [coding], remove: [ready-for-coding] } } ]',
      'on_success: [ { type: source.update, labels: { add: [done], remove: [coding] } } ]',
      'on_cancel: [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]',
      'on_crash: [ { type: source.update, labels: { add: [ready-for-coding], remove: [coding] } } ]',
      '',
    ].join('\n'),
  );
}

/** Pids of the worker scripts that started (they record themselves). */
const workerPids = (): number[] => (existsSync(path.join(marks, 'running')) ? readdirSync(path.join(marks, 'running')).map(Number) : []);
const runningWorkers = (): number[] => workerPids().filter(alive);
const maxConcurrentSeen = (): number => {
  const file = path.join(marks, 'counts');
  return existsSync(file) ? Math.max(0, ...readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number)) : 0;
};
const openGate = (): void => writeFileSync(path.join(marks, 'gate'), '');

function startHub(): { exited: Promise<number | null> } {
  hubOut = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/cli/main.ts'), 'hub', 'start', '--config-dir', hubCfg, '--data-dir', hubData, '--drain-timeout', '30s', '--cancel-timeout', '10s'], {
    cwd: ROOT,
    env: { ...process.env, ...env, ADISPATCH_TEST_GITHUB_URL: `http://127.0.0.1:${githubPort}`, NODE_OPTIONS: `--import=${PRELOAD}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hubProc = proc;
  proc.stdout?.on('data', (c: Buffer) => (hubOut += c.toString()));
  proc.stderr?.on('data', (c: Buffer) => (hubOut += c.toString()));
  return { exited: new Promise((resolve) => proc.on('exit', (code) => resolve(code))) };
}

const status = async (): Promise<HubStatus> => {
  const s = await ctl.status();
  for (const w of s.workspaces) if (w.pid) knownPids.add(w.pid);
  return s;
};

let nextIssue = 1;
/** Fresh state for a test: gate closed, no markers, 2 new ready issues per repository, hub started and both workspaces connected. */
async function boot(): Promise<HubStatus> {
  rmSync(path.join(marks, 'gate'), { force: true });
  rmSync(path.join(marks, 'counts'), { force: true });
  for (const f of readdirSync(path.join(marks, 'running'))) rmSync(path.join(marks, 'running', f), { force: true });
  for (const repo of ['example/a', 'example/b']) {
    for (let i = 0; i < 3; i++) github.createIssue(repo, { number: nextIssue + i, labels: ['ready-for-coding'] });
  }
  nextIssue += 3;
  startHub();
  return until('both workspaces running and connected', async () => {
    const s = await status();
    return s.workspaces.every((w) => w.state === 'running' && w.connected) ? s : undefined;
  });
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'orch-hub-e2e-'));
  marks = path.join(root, 'marks');
  mkdirSync(path.join(marks, 'running'), { recursive: true });
  github = new FakeGitHub();
  githubServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    try {
      const r = await github.fetch(`https://api.github.com${req.url}`, {
        method: req.method ?? 'GET',
        headers: req.headers as Record<string, string>,
        ...(body.length > 0 ? { body: body.toString('utf8') } : {}),
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => githubServer.listen(0, '127.0.0.1', resolve));
  githubPort = (githubServer.address() as net.AddressInfo).port;
  ports = { w1: await freePort(), w2: await freePort(), hub: await freePort() };
  const script = path.join(root, 'work.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `touch "${marks}/running/$$"`,
      // Count the workers that are alive right now (own marker included); stale markers of killed workers are skipped.
      'n=0',
      `for f in "${marks}"/running/*; do if kill -0 "$(basename "$f")" 2>/dev/null; then n=$((n+1)); fi; done`,
      `echo "$n" >> "${marks}/counts"`,
      `while [ ! -f "${marks}/gate" ]; do sleep 0.05; done`,
      'sleep 0.3',
      `rm -f "${marks}/running/$$"`,
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  hubCfg = path.join(root, 'hub');
  hubData = path.join(root, 'hub-data');
  mkdirSync(hubCfg, { recursive: true });
  writeWorkspace('w1', 'a', ports.w1);
  writeWorkspace('w2', 'b', ports.w2);
  writeFileSync(
    path.join(hubCfg, 'hub.yaml'),
    [
      'hub:',
      '  max_concurrent: 2',
      `  server: { host: 127.0.0.1, port: ${ports.hub} }`,
      'workspaces:',
      ...(['w1', 'w2'] as const).flatMap((id) => [
        `  - id: ${id}`,
        `    config_dir: workspaces/${id}/config`,
        `    data_dir: workspaces/${id}/data`,
        `    port: ${ports[id]}`,
      ]),
      '',
    ].join('\n'),
  );
  ctl = new HubControlClient(path.join(hubData, 'hub.sock'));
});

afterAll(async () => {
  // Own processes only: the hub, its children and the worker scripts that were seen.
  openGate();
  if (hubProc && hubProc.exitCode === null) hubProc.kill('SIGKILL');
  for (const pid of [...knownPids, ...workerPids()]) if (alive(pid)) process.kill(pid, 'SIGKILL');
  await new Promise<void>((resolve) => githubServer.close(() => resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('hub with real workspace processes (WI-35)', () => {
  it('shares the limit of 2 across two workspaces, frees the slots of a killed child and restarts it with backoff', { timeout: 120_000 }, async () => {
    const s0 = await boot();
    expect(s0.workspaces.map((w) => w.id)).toEqual(['w1', 'w2']);

    // 6 ready issues, polling every second in both workspaces, gate closed: exactly 2 runs at the same time.
    await until('2 slots in use', async () => (await status()).slots.active === 2 || undefined);
    await new Promise((r) => setTimeout(r, 3_000)); // several more polling cycles
    const held = await status();
    expect(held.slots.active).toBe(2);
    expect(runningWorkers()).toHaveLength(2);
    expect(Object.values(held.slots.byWorkspace).reduce((a, b) => a + b, 0)).toBe(2);
    // The workspaces report the hub limit in their own status.
    const w1Status = await (await fetch(`http://127.0.0.1:${ports.w1}/api/v1/status`)).json() as any;
    expect(w1Status.hub).toMatchObject({ workspace: 'w1', reachable: true, max: 2 });
    expect(maxConcurrentSeen()).toBe(2);

    // kill -9 of one child: its slots are freed at once, the sibling is untouched, the child is restarted after the backoff.
    const victim = held.workspaces.find((w) => w.slots > 0)!;
    const sibling = held.workspaces.find((w) => w.id !== victim.id)!;
    const victimPid = victim.pid!;
    process.kill(victimPid, 'SIGKILL');
    const after = await until('victim in backoff or restarted', async () => {
      const s = await status();
      const v = s.workspaces.find((w) => w.id === victim.id)!;
      return v.crashes >= 1 ? s : undefined;
    });
    expect(after.workspaces.find((w) => w.id === victim.id)).toMatchObject({ crashes: 1, lastExit: { signal: 'SIGKILL' }, slots: 0 });
    expect(after.slots.active).toBeLessThanOrEqual(2);
    expect(after.workspaces.find((w) => w.id === sibling.id)).toMatchObject({ pid: sibling.pid, state: 'running', crashes: 0 });
    const restarted = await until('victim running again', async () => {
      const s = await status();
      const v = s.workspaces.find((w) => w.id === victim.id)!;
      return v.state === 'running' && v.pid !== victimPid && v.connected ? v : undefined;
    });
    expect(restarted.restarts).toBe(1);

    // pause: nothing new once the gate opens and the running runs end; resume: the rest is processed.
    await ctl.pause();
    openGate();
    await until('all running runs ended', async () => ((await status()).slots.active === 0 && runningWorkers().length === 0) || undefined);
    await new Promise((r) => setTimeout(r, 2_500));
    expect((await status()).slots.active).toBe(0); // paused: still nothing started
    const doneWhilePaused = ['example/a', 'example/b'].flatMap((repo) => [1, 2, 3].filter((n) => github.labels(repo, n).includes('done'))).length;
    await ctl.resume();
    await until('all 6 issues done', () => ['example/a', 'example/b'].every((repo) => [1, 2, 3].every((n) => github.labels(repo, n).includes('done'))) || undefined, 60_000);
    expect(doneWhilePaused).toBeLessThan(6);
    // (After the kill -9 the orphaned worker of the victim lives on until the restarted workspace recovers it,
    // so the count of live workers is only asserted for the phase before the kill, see above.)
    hubProc!.kill('SIGTERM');
    await until('hub stopped', () => hubProc!.exitCode !== null || undefined, 30_000);
  });

  it('SIGTERM drains and a second signal cancels; no processes are left behind', { timeout: 120_000 }, async () => {
    await boot();
    await until('2 slots in use', async () => (await status()).slots.active === 2 || undefined);
    const before = await status();
    const childPids = before.workspaces.map((w) => w.pid!).filter(Boolean);
    const busy = before.workspaces.filter((w) => w.slots > 0).map((w) => w.pid!);
    const workers = runningWorkers();
    expect(workers).toHaveLength(2);
    expect(busy.length).toBeGreaterThan(0);

    const proc = hubProc!;
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
    proc.kill('SIGTERM'); // drain: runs are active, so the hub keeps waiting (an idle workspace stops at once)
    await new Promise((r) => setTimeout(r, 1_500));
    expect(proc.exitCode).toBeNull();
    expect(busy.every(alive)).toBe(true);
    expect(runningWorkers()).toHaveLength(2); // drain does not cancel
    expect((await status()).state).toBe('stopping');

    proc.kill('SIGTERM'); // second signal: cancel-all in the workspaces
    expect(await exited).toBe(0);
    expect(hubOut).toContain('hub stopped');
    await until('no children, no workers', () => (childPids.every((p) => !alive(p)) && workers.every((p) => !alive(p))) || undefined, 20_000);
    expect(existsSync(path.join(hubData, 'hub.sock'))).toBe(false);
    expect(existsSync(path.join(hubData, 'slots.sock'))).toBe(false);
  });

  it('a crashed hub leaves the workspaces and their runs alone, nothing new starts, and the slots are counted again after the hub is back', { timeout: 120_000 }, async () => {
    await boot();
    await until('2 slots in use', async () => (await status()).slots.active === 2 || undefined);
    const before = await status();
    const childPids = before.workspaces.map((w) => w.pid!);
    const workers = runningWorkers();
    expect(workers).toHaveLength(2);

    hubProc!.kill('SIGKILL'); // hub crash: no clean shutdown
    await new Promise((r) => setTimeout(r, 500));
    expect(childPids.every(alive)).toBe(true);
    expect(workers.every(alive)).toBe(true);

    // The workspaces notice the outage: no new automatic runs although the limit would not matter any more.
    const outage = await until('workspaces report the hub as unreachable', async () => {
      const s = (await (await fetch(`http://127.0.0.1:${ports.w1}/api/v1/status`)).json()) as any;
      return s.hub?.reachable === false ? s : undefined;
    });
    expect(outage.hub.reachable).toBe(false);
    github.createIssue('example/a', { number: 91, labels: ['ready-for-coding'] });
    github.createIssue('example/b', { number: 91, labels: ['ready-for-coding'] });
    await new Promise((r) => setTimeout(r, 3_500)); // several polling cycles
    expect(github.labels('example/a', 91)).toEqual(['ready-for-coding']);
    expect(github.labels('example/b', 91)).toEqual(['ready-for-coding']);
    expect(runningWorkers()).toHaveLength(2); // the running runs are untouched

    // The hub comes back: the orphaned workspaces still hold the instance locks (the hub marks them failed, they are not managed),
    // but they reconnect to the slot socket and their running runs count against the limit again.
    startHub();
    const back = await until('slots counted again', async () => {
      const s = await status();
      return s.slots.active === 2 ? s : undefined;
    });
    expect(back.workspaces.every((w) => w.state === 'failed')).toBe(true);
    expect(back.workspaces.every((w) => w.connected)).toBe(true);
    // Still nothing new while the limit is used up.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(github.labels('example/a', 91)).toEqual(['ready-for-coding']);

    // Clean up our own processes: stop the orphans (SIGTERM = drain; the gate is closed, so cancel with a second signal).
    for (const pid of childPids) process.kill(pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of childPids) process.kill(pid, 'SIGTERM');
    await until('orphans gone', () => (childPids.every((p) => !alive(p)) && workers.every((p) => !alive(p))) || undefined, 30_000);
    hubProc!.kill('SIGTERM');
  });
});
