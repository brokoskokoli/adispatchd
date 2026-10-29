/**
 * Packaging smoke test (WI-12): `npm pack` → install the tarball into a temp
 * prefix → `adispatch init` → `start` → run the example workflow →
 * `status` → `drain --wait` (exit 0) → "update" (install the tarball into a
 * second prefix) → start again on the same config/data dirs → history and
 * logs are still there → SIGTERM (exit 0).
 *
 * Hub (WI-37), with the same installation: `hub init` (production layout with
 * `--workspaces-data-dir`) → `hub validate` → `service install --hub --dry-run`
 * → `hub start` → one run in each of two workspaces through the hub's
 * `/w/<id>/` pass-through → `hub drain-all --wait` → SIGTERM (exit 0); then the
 * single instance of the first test is migrated into a second hub (unchanged
 * config/data dirs, new port) and its history is served through the hub.
 *
 * Runs only with `ADISPATCH_PACK_TEST=1` (`npm run test:pack`): it builds the
 * package, needs npm with the dependencies in its cache or registry access
 * and takes ~10–60 s, so it is not part of the per-commit gate.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_VERSION } from '../app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENABLED = process.env.ADISPATCH_PACK_TEST === '1';

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd ?? ROOT, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

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

/** Two consecutive free loopback ports (`hub init --base-port` gives the workspaces consecutive ports). */
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const first = await freePort();
    const second = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(first + 1, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (second) return first;
  }
  throw new Error('no two consecutive free ports');
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const children: ChildProcess[] = [];

/** PIDs of all descendants of a process we started (via `ps`, our own process tree only). */
function descendants(root: number): number[] {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((r) => r.length === 2 && !r.some(Number.isNaN)) as Array<[number, number]>;
    const out: number[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const parent = queue.shift() as number;
      for (const [pid, ppid] of rows) if (ppid === parent) (out.push(pid), queue.push(pid));
    }
    return out;
  } catch {
    return [];
  }
}
const root = ENABLED ? mkdtempSync(path.join(os.tmpdir(), 'orch-pack-')) : '';
afterAll(() => {
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    // Hub children and their workers run in their own process groups: terminate the hub's descendants via their own PIDs first.
    if (c.pid) {
      for (const pid of descendants(c.pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }
    c.kill('SIGKILL');
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

function startInstance(bin: string, configDir: string, dataDir: string) {
  const child = spawn(bin, ['start', '--config-dir', configDir, '--data-dir', dataDir, '--drain-timeout', '30s', '--cancel-timeout', '10s'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out = { stdout: '', stderr: '' };
  child.stdout?.on('data', (c: Buffer) => (out.stdout += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out.stderr += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out, exited };
}

/** State handed from the single-instance test to the hub test (same installation, same directories). */
const shared: { bin?: string; configDir?: string; dataDir?: string; runId?: string } = {};

function startHub(bin: string, configDir: string, dataDir: string) {
  const child = spawn(bin, ['hub', 'start', '--config-dir', configDir, '--data-dir', dataDir, '--drain-timeout', '30s', '--cancel-timeout', '10s'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out = { stdout: '', stderr: '' };
  child.stdout?.on('data', (c: Buffer) => (out.stdout += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out.stderr += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out, exited };
}

interface HubStatusJson {
  slots: { max: number; active: number };
  workspaces: Array<{ id: string; state: string; pid: number | null; connected: boolean; transition: string | null }>;
}

const postJson = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'x-adispatch-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Start the hello workflow of a workspace through the hub and wait for the run to succeed. */
async function helloThroughHub(hubBase: string, workspace: string, name: string): Promise<string> {
  const started = await postJson(`${hubBase}/w/${workspace}/api/v1/workflows/hello/start`, { parameters: { name } });
  expect(started.status, `start in ${workspace}`).toBe(202);
  const runId = ((await started.json()) as { run: { id: string } }).run.id;
  const done = await waitFor(`run in ${workspace}`, async () => {
    const r = (await (await fetch(`${hubBase}/w/${workspace}/api/v1/runs/${runId}`)).json()) as { status: string; businessResult: string; lifecycleStatus: string };
    return r.status === 'completed' && r.lifecycleStatus !== 'running' ? r : undefined;
  });
  expect(done).toMatchObject({ businessResult: 'success', lifecycleStatus: 'succeeded' });
  const logs = (await (await fetch(`${hubBase}/w/${workspace}/api/v1/runs/${runId}/logs?stream=stdout`)).json()) as { data: string };
  expect(logs.data).toContain(`Hello, ${name}!`);
  return runId;
}

describe.skipIf(!ENABLED)('npm pack: installable package (WI-12)', () => {
  it('packs, installs, inits, starts, drains and survives an update', async () => {
    // 1. Pack (prepack: clean build).
    const pack = await run('npm', ['pack', '--pack-destination', root, '--json']);
    expect(pack.code, pack.stderr).toBe(0);
    const info = JSON.parse(pack.stdout.slice(pack.stdout.indexOf('['))) as Array<{ filename: string; files: Array<{ path: string; mode: number }> }>;
    const tarball = path.join(root, info[0]?.filename ?? '');
    const files = (info[0]?.files ?? []).map((f) => f.path);
    for (const f of ['dist/cli/main.js', 'dist/app.js', 'dist/persistence/schema.js', 'dist/service/unit.js', 'dist/ui/public/index.html', 'dist/ui/public/app.css', 'examples/config/config.yaml', 'examples/hub/hub.yaml', 'docs/manual-tests/hub-systemd.md', 'README.md', 'README.de.md', 'docs/operations.md', 'docs/worker-protocol.md', 'package.json']) {
      expect(files, f).toContain(f);
    }
    expect(files.filter((f) => /\.test\.|\/testing\/|^src\//.test(f))).toEqual([]);
    expect(files.some((f) => /^dist\/ui\/public\/js\/.+\.js$/.test(f))).toBe(true); // compiled browser code
    expect(info[0]?.files.find((f) => f.path === 'dist/cli/main.js')?.mode ?? 0).toBeGreaterThan(0);

    // 2. Install into a temp prefix (production dependencies only).
    const prefix1 = path.join(root, 'install-1');
    const install = await run('npm', ['install', '--prefix', prefix1, tarball, '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: root });
    expect(install.code, install.stderr).toBe(0);
    const bin1 = path.join(prefix1, 'node_modules', '.bin', 'adispatch');
    expect(existsSync(bin1)).toBe(true);
    expect(readFileSync(path.join(prefix1, 'node_modules', 'adispatchd', 'dist', 'cli', 'main.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
    const version = await run(bin1, ['--version'], { cwd: root });
    expect(version.stdout.trim()).toBe(APP_VERSION);

    // 3. init (twice: nothing is overwritten).
    const configDir = path.join(root, 'config');
    const dataDir = path.join(root, 'data');
    const port = await freePort();
    const init = await run(bin1, ['init', '--config-dir', configDir, '--data-dir', dataDir, '--port', String(port)], { cwd: root });
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain('Next steps:');
    writeFileSync(path.join(configDir, 'workflows', 'hello.yaml'), readFileSync(path.join(configDir, 'workflows', 'hello.yaml'), 'utf8') + '# local edit\n');
    const init2 = await run(bin1, ['init', '--config-dir', configDir, '--data-dir', dataDir], { cwd: root });
    expect(init2.code, init2.stderr).toBe(0);
    expect(init2.stdout).not.toContain('created  ');
    expect(readFileSync(path.join(configDir, 'workflows', 'hello.yaml'), 'utf8')).toContain('# local edit');
    const validate = await run(bin1, ['config', 'validate', '--config-dir', configDir, '--data-dir', dataDir], { cwd: root });
    expect(validate.code, validate.stderr).toBe(0);

    // 4. start, run the example workflow, status, drain --wait.
    const base = `http://127.0.0.1:${port}`;
    const first = startInstance(bin1, configDir, dataDir);
    await waitFor('ready', async () => ((await fetch(`${base}/ready`)).status === 200 ? true : undefined));
    expect(first.out.stdout).toContain(`listening on ${base}`);
    expect(first.out.stderr).not.toContain('web UI assets not found');
    // Web UI (WI-11) is served from the installed package.
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type') ?? '').toContain('text/html');
    expect(await index.text()).toMatch(/<html/i);
    expect((await fetch(`${base}/js/client/app.js`)).status).toBe(200);
    const started = await fetch(`${base}/api/v1/workflows/hello/start`, {
      method: 'POST',
      headers: { 'x-adispatch-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ parameters: { name: 'pack' } }),
    });
    expect(started.status).toBe(202);
    const runId = ((await started.json()) as { run: { id: string } }).run.id;
    const done = await waitFor('run completed', async () => {
      const r = (await (await fetch(`${base}/api/v1/runs/${runId}`)).json()) as { status: string; businessResult: string; lifecycleStatus: string };
      return r.status === 'completed' && r.lifecycleStatus !== 'running' ? r : undefined;
    });
    expect(done).toMatchObject({ businessResult: 'success', lifecycleStatus: 'succeeded' });
    const status = await run(bin1, ['status', '--config-dir', configDir], { cwd: root });
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain('ready:      yes');
    const drain = await run(bin1, ['drain', '--config-dir', configDir, '--wait', '--timeout', '60s'], { cwd: root });
    expect(drain.code, drain.stderr).toBe(0);
    expect(await first.exited).toBe(0);

    // 5. "Update": a fresh installation of the package on the same config/data dirs.
    const prefix2 = path.join(root, 'install-2');
    const install2 = await run('npm', ['install', '--prefix', prefix2, tarball, '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: root });
    expect(install2.code, install2.stderr).toBe(0);
    rmSync(prefix1, { recursive: true, force: true }); // old code is gone
    const bin2 = path.join(prefix2, 'node_modules', '.bin', 'adispatch');
    const second = startInstance(bin2, configDir, dataDir);
    await waitFor('ready after update', async () => ((await fetch(`${base}/ready`)).status === 200 ? true : undefined));
    const kept = (await (await fetch(`${base}/api/v1/runs/${runId}`)).json()) as { status: string; resultMessage: string };
    expect(kept).toMatchObject({ status: 'completed', resultMessage: 'Said hello' });
    const logs = (await (await fetch(`${base}/api/v1/runs/${runId}/logs?stream=stdout`)).json()) as { data: string };
    expect(logs.data).toContain('Hello, pack!');
    expect(readFileSync(path.join(configDir, 'workflows', 'hello.yaml'), 'utf8')).toContain('# local edit');
    second.child.kill('SIGTERM');
    expect(await second.exited).toBe(0);
    expect(second.out.stdout).toContain('adispatchd stopped');
    Object.assign(shared, { bin: bin2, configDir, dataDir, runId });
  }, 600_000);

  it('runs a hub with two workspaces from the installed package and migrates a single instance into a hub (WI-37)', async () => {
    const { bin, configDir: instConfig, dataDir: instData, runId: oldRun } = shared;
    if (!bin || !instConfig || !instData || !oldRun) throw new Error('the single-instance test must run (and pass) first');

    // 1. hub init in the production layout (config tree, hub data dir and workspace data dirs separate); idempotent.
    const hubConfig = path.join(root, 'hub-config');
    const hubData = path.join(root, 'hub-data');
    const wsData = path.join(root, 'ws-data');
    const hubPort = await freePort();
    const basePort = await freePortPair();
    const initArgs = ['hub', 'init', '--config-dir', hubConfig, '--data-dir', hubData, '--workspaces-data-dir', wsData, '--workspace', 'alpha', '--workspace', 'beta', '--hub-port', String(hubPort), '--base-port', String(basePort)];
    const init = await run(bin, initArgs, { cwd: root });
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain('Hub configuration in');
    expect(init.stdout).toContain('2 workspace(s) (2 enabled)');
    const init2 = await run(bin, initArgs, { cwd: root });
    expect(init2.code, init2.stderr).toBe(0);
    expect(init2.stdout).not.toContain('created  ');
    const validate = await run(bin, ['hub', 'validate', '--config-dir', hubConfig, '--data-dir', hubData], { cwd: root });
    expect(validate.code, validate.stderr).toBe(0);

    // 2. The systemd unit of this installation (dry run: nothing is changed).
    const unit = await run(bin, ['service', 'install', '--hub', '--dry-run', '--config-dir', hubConfig, '--data-dir', hubData, '--create-user'], { cwd: root });
    expect(unit.code, unit.stderr).toBe(0);
    expect(unit.stdout).toContain('# /etc/systemd/system/adispatchd-hub.service');
    expect(unit.stdout).toMatch(/ExecStart=\S*node\S* \S*dist\/cli\/main\.js hub start --config-dir /);
    expect(unit.stdout).toContain('KillMode=mixed');
    expect(unit.stdout).toContain(`install -d -m 0750 -o adispatchd -g adispatchd ${path.join(wsData, 'beta')}`);
    expect(unit.stdout).toContain('nothing was changed');

    // 3. hub start: overview, pass-through, one run in each workspace.
    const hubBase = `http://127.0.0.1:${hubPort}`;
    const hub = startHub(bin, hubConfig, hubData);
    const ready = async (): Promise<HubStatusJson> =>
      waitFor('workspaces running', async () => {
        const r = await run(bin, ['hub', 'status', '--data-dir', hubData, '--json'], { cwd: root });
        if (r.code !== 0) return undefined;
        const s = JSON.parse(r.stdout) as HubStatusJson;
        return s.workspaces.length > 0 && s.workspaces.every((w) => w.state === 'running' && w.connected) ? s : undefined;
      }, 60_000);
    const status = await ready();
    expect(status.workspaces.map((w) => w.id)).toEqual(['alpha', 'beta']);
    expect(hub.out.stdout).toContain(`web UI and API on ${hubBase}`);
    const overview = await fetch(`${hubBase}/`);
    expect(overview.status).toBe(200);
    expect(await overview.text()).toMatch(/<html/i);
    expect((await fetch(`${hubBase}/w/alpha/`)).status).toBe(200);
    expect((await fetch(`${hubBase}/api/v1/hub/status`)).status).toBe(200);
    const runAlpha = await helloThroughHub(hubBase, 'alpha', 'alpha');
    const runBeta = await helloThroughHub(hubBase, 'beta', 'beta');
    expect(runAlpha).not.toBe('');
    expect(runBeta).not.toBe('');
    // Separate databases: a run of one workspace is unknown in the other (run IDs are only unique per workspace database).
    expect(existsSync(path.join(wsData, 'alpha', 'adispatchd.sqlite'))).toBe(true);
    expect(existsSync(path.join(wsData, 'beta', 'adispatchd.sqlite'))).toBe(true);

    // 4. drain-all --wait: every workspace ends, the hub keeps running; SIGTERM ends it with exit 0.
    const drain = await run(bin, ['hub', 'drain-all', '--data-dir', hubData, '--wait', '--timeout', '60s'], { cwd: root });
    expect(drain.code, drain.stderr).toBe(0);
    expect(drain.stdout).toContain('all workspaces ended');
    const after = JSON.parse((await run(bin, ['hub', 'status', '--data-dir', hubData, '--json'], { cwd: root })).stdout) as HubStatusJson;
    expect(after.workspaces.map((w) => w.state)).toEqual(['stopped', 'stopped']);
    hub.child.kill('SIGTERM');
    expect(await hub.exited).toBe(0);
    expect(hub.out.stdout).toContain('hub stopped');
    expect(existsSync(path.join(hubData, 'hub.sock'))).toBe(false);

    // 5. Migration: the single instance of the first test (unchanged config/data dirs, history included) becomes a workspace.
    const hub2Config = path.join(root, 'hub2-config');
    const hub2Data = path.join(root, 'hub2-data');
    const hub2Port = await freePort();
    const legacyPort = await freePort();
    const initEmpty = await run(bin, ['hub', 'init', '--empty', '--config-dir', hub2Config, '--data-dir', hub2Data, '--hub-port', String(hub2Port)], { cwd: root });
    expect(initEmpty.code, initEmpty.stderr).toBe(0);
    const yamlFile = path.join(hub2Config, 'hub.yaml');
    writeFileSync(
      yamlFile,
      readFileSync(yamlFile, 'utf8').replace('workspaces: []', `workspaces:\n  - { id: legacy, config_dir: ${JSON.stringify(instConfig)}, data_dir: ${JSON.stringify(instData)}, port: ${legacyPort} }`),
    );
    const validate2 = await run(bin, ['hub', 'validate', '--config-dir', hub2Config, '--data-dir', hub2Data], { cwd: root });
    expect(validate2.code, validate2.stderr).toBe(0);
    const hub2Base = `http://127.0.0.1:${hub2Port}`;
    const hub2 = startHub(bin, hub2Config, hub2Data);
    await waitFor('legacy workspace', async () => {
      const r = await fetch(`${hub2Base}/w/legacy/ready`).catch(() => undefined);
      return r?.status === 200 ? true : undefined;
    }, 60_000);
    const kept = (await (await fetch(`${hub2Base}/w/legacy/api/v1/runs/${oldRun}`)).json()) as { status: string; resultMessage: string };
    expect(kept).toMatchObject({ status: 'completed', resultMessage: 'Said hello' });
    await helloThroughHub(hub2Base, 'legacy', 'migrated');
    expect(readFileSync(path.join(instConfig, 'workflows', 'hello.yaml'), 'utf8')).toContain('# local edit');
    hub2.child.kill('SIGTERM');
    expect(await hub2.exited).toBe(0);
  }, 600_000);
});
