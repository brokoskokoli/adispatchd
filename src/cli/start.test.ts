import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock } from '../persistence/index.js';
import { createStartHandler, parseStartFlags } from './start.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempConfig(port: number): { configDir: string; dataDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orch-start-'));
  dirs.push(root);
  const configDir = path.join(root, 'config');
  mkdirSync(path.join(configDir, 'workflows'), { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.yaml'),
    `server: { host: 127.0.0.1, port: ${port} }\nworkspace: { base_dir: ${path.join(root, 'ws')} }\n`,
  );
  writeFileSync(
    path.join(configDir, 'workflows', 'hello.yaml'),
    'id: hello\nname: Hello\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/echo, args: [hi] }\n',
  );
  return { configDir, dataDir: path.join(root, 'data') };
}

describe('start command', () => {
  it('starts the real binary, becomes ready and exits 0 on SIGTERM', async () => {
    const port = await freePort();
    const { configDir, dataDir } = tempConfig(port);
    // `node --import tsx` (single process): the signal reaches the orchestrator directly, as with the installed binary.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/cli/main.ts'), 'start', '--config-dir', configDir, '--data-dir', dataDir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        try {
          ready = (await fetch(`http://127.0.0.1:${port}/ready`)).status === 200;
        } catch {
          // not listening yet
        }
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      expect(ready, stderr).toBe(true);
      expect(stdout).toContain(`listening on http://127.0.0.1:${port}`);
      const run = await fetch(`http://127.0.0.1:${port}/api/v1/workflows/hello/start`, {
        method: 'POST',
        headers: { 'x-adispatch-request': '1' },
      });
      expect(run.status).toBe(202);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(stdout).toContain('adispatchd stopped');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 40_000);

  it('reports usage and configuration errors', async () => {
    const out: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t) };
    expect(await createStartHandler(io)({})).toBe(2);
    const { configDir, dataDir } = tempConfig(1);
    writeFileSync(path.join(configDir, 'workflows', 'bad.yaml'), 'id: bad\n');
    expect(await createStartHandler(io)({ configDir, dataDir })).toBe(78); // EX_CONFIG → RestartPreventExitStatus
    expect(out.join('')).toContain('is invalid');
  });

  it('exits with 78 when another instance holds the data dir lock', async () => {
    const out: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t) };
    const { configDir, dataDir } = tempConfig(1);
    mkdirSync(dataDir, { recursive: true });
    const lock = acquireInstanceLock(dataDir);
    try {
      expect(await createStartHandler(io)({ configDir, dataDir })).toBe(78);
      expect(out.join('')).toContain('Another orchestrator instance');
    } finally {
      lock.release();
    }
  });

  it('parses timeout, host and port flags', async () => {
    expect(parseStartFlags({ drainTimeout: '1h', cancelTimeout: '90s', host: '0.0.0.0', port: '0' })).toEqual({
      drainTimeoutMs: 3_600_000,
      cancelTimeoutMs: 90_000,
      host: '0.0.0.0',
      port: 0,
    });
    expect(parseStartFlags({})).toEqual({});
    expect(() => parseStartFlags({ drainTimeout: '10 minutes' })).toThrow(/--drain-timeout/);
    expect(() => parseStartFlags({ port: '70000' })).toThrow(/--port/);
    const out: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t) };
    expect(await createStartHandler(io)({ configDir: '/nonexistent', cancelTimeout: 'x' })).toBe(2);
    expect(out.join('')).toContain('invalid --cancel-timeout');
  });
});
