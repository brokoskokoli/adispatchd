/**
 * Packaging smoke test (WI-12): `npm pack` → install the tarball into a temp
 * prefix → `adispatch init` → `start` → run the example workflow →
 * `status` → `drain --wait` (exit 0) → "update" (install the tarball into a
 * second prefix) → start again on the same config/data dirs → history and
 * logs are still there → SIGTERM (exit 0).
 *
 * Runs only with `ADISPATCH_PACK_TEST=1` (`npm run test:pack`): it builds the
 * package, needs npm with the dependencies in its cache or registry access
 * and takes ~10–60 s, so it is not part of the per-commit gate.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

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
const root = ENABLED ? mkdtempSync(path.join(os.tmpdir(), 'orch-pack-')) : '';
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
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

describe.skipIf(!ENABLED)('npm pack: installable package (WI-12)', () => {
  it('packs, installs, inits, starts, drains and survives an update', async () => {
    // 1. Pack (prepack: clean build).
    const pack = await run('npm', ['pack', '--pack-destination', root, '--json']);
    expect(pack.code, pack.stderr).toBe(0);
    const info = JSON.parse(pack.stdout.slice(pack.stdout.indexOf('['))) as Array<{ filename: string; files: Array<{ path: string; mode: number }> }>;
    const tarball = path.join(root, info[0]?.filename ?? '');
    const files = (info[0]?.files ?? []).map((f) => f.path);
    for (const f of ['dist/cli/main.js', 'dist/app.js', 'dist/persistence/schema.js', 'dist/service/unit.js', 'dist/ui/public/index.html', 'dist/ui/public/app.css', 'examples/config/config.yaml', 'README.md', 'README.de.md', 'docs/operations.md', 'docs/worker-protocol.md', 'package.json']) {
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
    expect(version.stdout.trim()).toBe('0.4.0');

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
  }, 600_000);
});
