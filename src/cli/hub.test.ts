import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '../core/index.js';
import { type Hub } from '../hub/index.js';
import { FakeSpawner } from '../hub/testing/fakes.js';
import {
  createHubGlobalHandler,
  createHubInitHandler,
  createHubStartHandler,
  createHubStatusHandler,
  createHubValidateHandler,
  createHubWorkspaceHandler,
  formatHubStatus,
} from './hub.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'orch-hubcli-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function captured() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err, text: () => out.join(''), errText: () => err.join('') };
}

describe('hub init', () => {
  it('creates hub.yaml and complete workspace directories, validates them and never overwrites', async () => {
    const root = tmp();
    const configDir = path.join(root, 'hub');
    const dataDir = path.join(root, 'hub-data');
    const c = captured();
    const code = await createHubInitHandler(c.io)({ configDir, dataDir, workspace: ['coder', 'docs'], basePort: '9100' });
    expect(code).toBe(0);
    const yaml = readFileSync(path.join(configDir, 'hub.yaml'), 'utf8');
    expect(yaml).toContain('- id: coder');
    expect(yaml).toContain('port: 9101');
    expect(c.text()).toContain('Hub configuration in');
    expect(c.text()).toContain('adispatch hub start --config-dir');

    // Second run: everything kept, hub.yaml unchanged even if other workspaces are requested.
    writeFileSync(path.join(configDir, 'hub.yaml'), `${yaml}# edited\n`);
    const again = captured();
    expect(await createHubInitHandler(again.io)({ configDir, dataDir, workspace: ['other'] })).toBe(0);
    expect(again.text()).toContain('kept');
    expect(readFileSync(path.join(configDir, 'hub.yaml'), 'utf8')).toBe(`${yaml}# edited\n`);
  });

  it('rejects invalid arguments', async () => {
    const c = captured();
    expect(await createHubInitHandler(c.io)({})).toBe(2);
    expect(await createHubInitHandler(c.io)({ configDir: tmp(), workspace: ['Bad_ID'] })).toBe(2);
    expect(await createHubInitHandler(c.io)({ configDir: tmp(), workspace: ['a', 'a'] })).toBe(2);
    expect(await createHubInitHandler(c.io)({ configDir: tmp(), basePort: '0' })).toBe(2);
  });
});

describe('hub validate', () => {
  async function initHub(): Promise<{ configDir: string; dataDir: string }> {
    const root = tmp();
    const configDir = path.join(root, 'hub');
    const dataDir = path.join(root, 'hub-data');
    await createHubInitHandler(captured().io)({ configDir, dataDir, workspace: ['a', 'b'] });
    return { configDir, dataDir };
  }

  it('accepts a valid hub and lists the workspaces', async () => {
    const { configDir, dataDir } = await initHub();
    const c = captured();
    expect(await createHubValidateHandler(c.io)({ configDir, dataDir })).toBe(0);
    expect(c.text()).toContain('2 workspace(s) (2 enabled)');
    expect(c.text()).toContain('a: port 8091');
  });

  it('reports hub.yaml errors', async () => {
    const { configDir, dataDir } = await initHub();
    writeFileSync(path.join(configDir, 'hub.yaml'), 'workspaces:\n  - { id: a, config_dir: x, data_dir: y, port: 1 }\n  - { id: a, config_dir: x, data_dir: y, port: 1 }\n');
    const c = captured();
    expect(await createHubValidateHandler(c.io)({ configDir, dataDir })).toBe(1);
    expect(c.errText()).toContain('Duplicate workspace ID');
    writeFileSync(path.join(configDir, 'hub.yaml'), 'bogus: 1\n');
    const d = captured();
    expect(await createHubValidateHandler(d.io)({ configDir, dataDir })).toBe(1);
    expect(d.errText()).toContain('"bogus"');
  });

  it('also validates the configuration of every workspace, with the workspace ID in the message', async () => {
    const { configDir, dataDir } = await initHub();
    writeFileSync(path.join(configDir, 'workspaces', 'b', 'config', 'config.yaml'), 'scheduler:\n  max_concurent: 3\n');
    const c = captured();
    expect(await createHubValidateHandler(c.io)({ configDir, dataDir })).toBe(1);
    expect(c.errText()).toContain('Workspace "b"');
    expect(c.errText()).toContain('[b] config.yaml');
    expect(c.errText()).toContain('max_concurent');
  });

  it('requires --config-dir', async () => {
    const c = captured();
    expect(await createHubValidateHandler(c.io)({})).toBe(1);
  });
});

describe('hub start and the control commands', () => {
  class FakeSignals extends EventEmitter {
    override on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): this {
      return super.on(signal, listener);
    }
    override off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): this {
      return super.off(signal, listener);
    }
  }

  it('runs the hub, serves the control commands, drains on SIGTERM and escalates on the second signal', async () => {
    const root = tmp();
    const configDir = path.join(root, 'hub');
    const dataDir = path.join(root, 'hd');
    await createHubInitHandler(captured().io)({ configDir, dataDir, workspace: ['a', 'b'] });
    const spawner = new FakeSpawner();
    const signals = new FakeSignals();
    const c = captured();
    let hub!: Hub;
    const started = new Promise<void>((resolve) => {
      void createHubStartHandler(c.io, {
        hubOptions: { http: undefined, spawner, logger: noopLogger, probe: async () => true, control: async () => true, output: () => undefined, probeIntervalMs: 10, baseEnv: {} },
        signals,
        exit: () => undefined,
        onStarted: (h) => {
          hub = h;
          resolve();
        },
      })({ configDir, dataDir }).then((code) => {
        exitCode = code;
      });
    });
    let exitCode: number | undefined;
    await started;
    expect(c.text()).toContain('2 workspace(s) started');

    // status
    const s = captured();
    expect(await createHubStatusHandler(s.io)({ dataDir })).toBe(0);
    expect(s.text()).toContain('slots:      0/5 in use');
    expect(s.text()).toMatch(/a\s+\w+\s+1000\s+8091/);
    const json = captured();
    expect(await createHubStatusHandler(json.io)({ dataDir, json: true })).toBe(0);
    expect(JSON.parse(json.text())).toMatchObject({ state: 'running', slots: { max: 5 } });

    // pause / resume / workspace commands
    const p = captured();
    expect(await createHubGlobalHandler('pause', p.io)({ dataDir })).toBe(0);
    expect(p.text()).toContain('hub paused');
    expect(hub.status().paused).toBe(true);
    expect(await createHubGlobalHandler('resume', captured().io)({ dataDir })).toBe(0);
    const w = captured();
    expect(await createHubWorkspaceHandler('drain', w.io)('a', { dataDir })).toBe(0);
    expect(w.text()).toContain('workspace a: running (draining…)');
    const bad = captured();
    expect(await createHubWorkspaceHandler('start', bad.io)('nope', { dataDir })).toBe(1);
    expect(bad.errText()).toContain('Unknown workspace "nope"');
    expect(bad.errText()).toContain('404');

    // SIGTERM → drain (one SIGTERM per child), second signal → cancel (one more)
    signals.emit('SIGTERM');
    expect(spawner.of('b').at(0)?.signals).toEqual(['SIGTERM']);
    signals.emit('SIGTERM');
    expect(spawner.of('b').at(0)?.signals).toEqual(['SIGTERM', 'SIGTERM']);
    for (const child of spawner.children) child.exit(0);
    await hub.stopped;
    await new Promise((r) => setTimeout(r, 20));
    expect(exitCode).toBe(0);
    expect(c.text()).toContain('hub stopped');

    // Hub gone: the control commands say so (exit code 3).
    const gone = captured();
    expect(await createHubStatusHandler(gone.io)({ dataDir })).toBe(3);
    expect(gone.errText()).toContain('cannot reach the hub');
  });

  it('refuses an invalid hub.yaml with exit code 78 and a second hub on the same data dir', async () => {
    const root = tmp();
    const configDir = path.join(root, 'hub');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'hub.yaml'), 'hub: { max_concurrent: 0 }\n');
    const c = captured();
    expect(await createHubStartHandler(c.io)({ configDir, dataDir: path.join(root, 'hd') })).toBe(78);
    expect(c.errText()).toContain('max_concurrent');
    expect(await createHubStartHandler(c.io)({ dataDir: path.join(root, 'hd') })).toBe(2);
    expect(await createHubStartHandler(c.io)({ configDir, dataDir: path.join(root, 'hd'), drainTimeout: 'soon' })).toBe(2);
  });

  it('formats the status table', () => {
    const text = formatHubStatus({
      version: '1.0.0',
      pid: 5,
      startedAt: 'T',
      time: 'T',
      state: 'paused',
      paused: true,
      slots: { max: 6, active: 2, byWorkspace: { coder: 2 } },
      server: { host: '127.0.0.1', port: 8090 },
      workspaces: [
        { id: 'coder', enabled: true, state: 'running', transition: null, pid: 11, port: 8091, configDir: '/c', dataDir: '/d', startedAt: 'T', restarts: 0, crashes: 0, lastExit: null, nextRestartAt: null, message: null, url: 'u', slots: 2, connected: true },
        { id: 'docs', enabled: true, state: 'backoff', transition: null, pid: null, port: 8092, configDir: '/c', dataDir: '/d', startedAt: null, restarts: 2, crashes: 3, lastExit: null, nextRestartAt: 'T', message: 'exited unexpectedly (exit code 1); restarting in 4s', url: 'u', slots: 0, connected: false },
      ],
    });
    expect(text).toContain('PAUSED');
    expect(text).toContain('2/6 in use');
    expect(text).toMatch(/docs\s+backoff\s+-\s+8092\s+0\s+2 \(3 crashes\)\s+exited unexpectedly/);
  });
});
