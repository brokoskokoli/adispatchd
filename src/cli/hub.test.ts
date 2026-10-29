import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '../core/index.js';
import { type Hub } from '../hub/index.js';
import { FakeSpawner } from '../hub/testing/fakes.js';
import { createInitHandler } from './init.js';
import {
  allWorkspacesStopped,
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

describe('hub init layouts (WI-38)', () => {
  it('--workspaces-data-dir keeps the data of the workspaces outside the config dir (production layout), idempotent, hub validate green', async () => {
    const root = tmp();
    const configDir = path.join(root, 'etc', 'hub');
    const dataDir = path.join(root, 'lib', 'hub');
    const wsData = path.join(root, 'lib', 'workspaces');
    const c = captured();
    expect(await createHubInitHandler(c.io)({ configDir, dataDir, workspacesDataDir: wsData, workspace: ['coder', 'docs'] })).toBe(0);
    const yaml = readFileSync(path.join(configDir, 'hub.yaml'), 'utf8');
    expect(yaml).toContain(`data_dir: ${path.join(wsData, 'coder')}`);
    expect(yaml).toContain('config_dir: workspaces/coder/config');
    expect(existsSync(path.join(wsData, 'docs', 'logs'))).toBe(true);
    expect(existsSync(path.join(configDir, 'workspaces', 'coder', 'data'))).toBe(false);
    expect(c.text()).toContain('Hub configuration in');
    expect(c.text()).toContain('service install --hub');

    // Second run changes nothing (no "created" line), hub validate stays green.
    const again = captured();
    expect(await createHubInitHandler(again.io)({ configDir, dataDir, workspacesDataDir: wsData, workspace: ['coder', 'docs'] })).toBe(0);
    expect(again.text()).not.toContain('created  ');
    expect(readFileSync(path.join(configDir, 'hub.yaml'), 'utf8')).toBe(yaml);
    expect(await createHubValidateHandler(captured().io)({ configDir, dataDir })).toBe(0);
  });

  it('quotes data dirs with special characters in hub.yaml', async () => {
    const root = tmp();
    const configDir = path.join(root, 'hub');
    const wsData = path.join(root, 'data with space');
    expect(await createHubInitHandler(captured().io)({ configDir, dataDir: path.join(root, 'hd'), workspacesDataDir: wsData })).toBe(0);
    expect(readFileSync(path.join(configDir, 'hub.yaml'), 'utf8')).toContain(`data_dir: ${JSON.stringify(path.join(wsData, 'main'))}`);
  });

  it('--empty creates a valid hub without workspaces (warning only) and excludes --workspace', async () => {
    const root = tmp();
    const configDir = path.join(root, 'hub');
    const c = captured();
    expect(await createHubInitHandler(c.io)({ configDir, dataDir: path.join(root, 'hd'), empty: true })).toBe(0);
    expect(c.text()).toContain('0 workspace(s)');
    expect(c.errText()).toContain('warning');
    expect(existsSync(path.join(configDir, 'workspaces'))).toBe(false);
    expect(readFileSync(path.join(configDir, 'hub.yaml'), 'utf8')).toContain('workspaces: []');
    const bad = captured();
    expect(await createHubInitHandler(bad.io)({ configDir: path.join(root, 'x'), empty: true, workspace: ['a'] })).toBe(2);
  });
});

describe('migrating a single instance into a hub (WI-38)', () => {
  it('keeps config-dir and data-dir unchanged, starts the instance with the new port and leaves its data alone', async () => {
    const root = tmp();
    // 1. An existing single instance with data (database marker, logs) on port 8787.
    const instConfig = path.join(root, 'etc-adispatchd');
    const instData = path.join(root, 'lib-adispatchd');
    expect(await createInitHandler(captured().io)({ configDir: instConfig, dataDir: instData, port: '8787' })).toBe(0);
    writeFileSync(path.join(instData, 'adispatchd.sqlite'), 'existing history');
    mkdirSync(path.join(instData, 'logs', 'run-1'), { recursive: true });
    writeFileSync(path.join(instData, 'logs', 'run-1', 'stdout.log'), 'old log');
    const before = readFileSync(path.join(instConfig, 'config.yaml'), 'utf8');

    // 2. Hub without workspaces, then the instance is added unchanged (new port).
    const hubConfig = path.join(root, 'hub');
    const hubData = path.join(root, 'hub-data');
    expect(await createHubInitHandler(captured().io)({ configDir: hubConfig, dataDir: hubData, empty: true })).toBe(0);
    const hubYaml = path.join(hubConfig, 'hub.yaml');
    writeFileSync(
      hubYaml,
      readFileSync(hubYaml, 'utf8').replace(
        'workspaces: []',
        `workspaces:\n  - { id: main, config_dir: ${instConfig}, data_dir: ${instData}, port: 8091 }`,
      ),
    );
    const v = captured();
    expect(await createHubValidateHandler(v.io)({ configDir: hubConfig, dataDir: hubData })).toBe(0);
    expect(v.text()).toContain('main: port 8091');

    // 3. The hub starts exactly this config-dir/data-dir with --port 8091 (config.yaml still says 8787 and stays untouched).
    const spawner = new FakeSpawner();
    const startIo = captured();
    const signals = new EventEmitter() as never as { on: (s: 'SIGTERM' | 'SIGINT', l: () => void) => unknown; off: (s: 'SIGTERM' | 'SIGINT', l: () => void) => unknown; emit: (s: string) => boolean };
    let hub!: Hub;
    const started = new Promise<void>((resolve) => {
      void createHubStartHandler(startIo.io, {
        hubOptions: { http: undefined, spawner, logger: noopLogger, probe: async () => true, control: async () => true, output: () => undefined, probeIntervalMs: 10, baseEnv: {} },
        signals,
        exit: () => undefined,
        onStarted: (h) => {
          hub = h;
          resolve();
        },
      })({ configDir: hubConfig, dataDir: hubData }).then((code) => {
        if (code !== 0) console.error(startIo.errText());
      });
    });
    await started;
    const args = spawner.last('main').spec.args;
    expect(args.slice(0, 5)).toEqual(['start', '--config-dir', instConfig, '--data-dir', instData]);
    expect(args[args.indexOf('--port') + 1]).toBe('8091');
    expect(readFileSync(path.join(instConfig, 'config.yaml'), 'utf8')).toBe(before);
    expect(readFileSync(path.join(instData, 'adispatchd.sqlite'), 'utf8')).toBe('existing history');
    expect(readFileSync(path.join(instData, 'logs', 'run-1', 'stdout.log'), 'utf8')).toBe('old log');
    // Hub data (sockets, lock, audit) live in the hub's own data dir, not in the instance's.
    expect(existsSync(path.join(instData, 'hub.sock'))).toBe(false);
    expect(existsSync(path.join(hubData, 'hub.sock'))).toBe(true);
    signals.emit('SIGTERM');
    for (const child of spawner.children) child.exit(0);
    await hub.stopped;
  });

  it('refuses the old data dir as hub data dir and a workspace port equal to the hub port', async () => {
    const root = tmp();
    const instConfig = path.join(root, 'etc-adispatchd');
    const instData = path.join(root, 'lib-adispatchd');
    await createInitHandler(captured().io)({ configDir: instConfig, dataDir: instData, port: '8787' });
    const hubConfig = path.join(root, 'hub');
    mkdirSync(hubConfig);
    writeFileSync(hubYamlOf(hubConfig), `hub: { server: { port: 8787 } }\nworkspaces:\n  - { id: main, config_dir: ${instConfig}, data_dir: ${instData}, port: 8787 }\n`);
    const c = captured();
    expect(await createHubValidateHandler(c.io)({ configDir: hubConfig, dataDir: path.join(root, 'hd') })).toBe(1);
    expect(c.errText()).toContain('8787');
    // Same data dir for hub and workspace: the hub would lock the instance's data dir.
    writeFileSync(hubYamlOf(hubConfig), `workspaces:\n  - { id: main, config_dir: ${instConfig}, data_dir: ${instData}, port: 8091 }\n`);
    const d = captured();
    expect(await createHubValidateHandler(d.io)({ configDir: hubConfig, dataDir: instData })).toBe(1);
    expect(d.errText()).toContain('overlaps with the hub');
  });
});

function hubYamlOf(dir: string): string {
  return path.join(dir, 'hub.yaml');
}

describe('hub drain-all --wait', () => {
  const ws = (over: Record<string, unknown>) => ({ id: 'a', enabled: true, state: 'stopped', transition: null, pid: null, ...over });
  const statusOf = (...workspaces: Array<ReturnType<typeof ws>>) => ({ workspaces }) as never;

  it('recognises ended workspaces', () => {
    expect(allWorkspacesStopped(statusOf(ws({}), ws({ id: 'b', state: 'failed' })))).toBe(true);
    expect(allWorkspacesStopped(statusOf(ws({ state: 'running', pid: 5, transition: 'draining' })))).toBe(false);
    expect(allWorkspacesStopped(statusOf(ws({ state: 'starting' })))).toBe(false);
  });

  function fakeClient(statuses: unknown[]) {
    let i = 0;
    return {
      calls: 0,
      client: () => ({
        status: async () => {
          const s = statuses[Math.min(i++, statuses.length - 1)];
          if (s instanceof Error) throw s;
          return s as never;
        },
        drainAll: async () => statuses[0] as never,
        stopAll: async () => statuses[0] as never,
        pause: async () => statuses[0] as never,
        resume: async () => statuses[0] as never,
        workspace: async () => statuses[0] as never,
      }),
    };
  }

  it('polls until all workspaces ended (exit 0)', async () => {
    const busy = statusOf(ws({ state: 'running', pid: 5, transition: 'draining' }));
    const done = statusOf(ws({}));
    const f = fakeClient([busy, busy, busy, done]);
    const c = captured();
    const sleeps: number[] = [];
    const code = await createHubGlobalHandler('drain-all', c.io, { client: f.client, sleep: async (ms) => void sleeps.push(ms), pollIntervalMs: 7 })({ dataDir: '/x', wait: true });
    expect(code).toBe(0);
    expect(sleeps).toEqual([7, 7, 7]);
    expect(c.text()).toContain('waiting for all workspaces to end');
    expect(c.text()).toContain('all workspaces ended');
  });

  it('times out with exit code 4, reports an unreachable hub with 3 and rejects --wait elsewhere', async () => {
    const busy = statusOf(ws({ state: 'running', pid: 5, transition: 'draining' }));
    let t = 0;
    const c = captured();
    const code = await createHubGlobalHandler('stop-all', c.io, {
      client: fakeClient([busy]).client,
      sleep: async () => void (t += 1000),
      now: () => t,
    })({ dataDir: '/x', wait: true, timeout: '3s' });
    expect(code).toBe(4);
    expect(c.errText()).toContain('still running after 3s');

    const { HubUnreachableError } = await import('../hub/index.js');
    const g = captured();
    expect(
      await createHubGlobalHandler('drain-all', g.io, { client: fakeClient([busy, new HubUnreachableError('/x/hub.sock', 'gone')]).client, sleep: async () => undefined })({ dataDir: '/x', wait: true }),
    ).toBe(3);

    const e = captured();
    expect(await createHubGlobalHandler('pause', e.io, { client: fakeClient([busy]).client })({ dataDir: '/x', wait: true })).toBe(2);
    expect(await createHubGlobalHandler('drain-all', e.io, { client: fakeClient([busy]).client })({ dataDir: '/x', timeout: '1s' })).toBe(2);
    expect(await createHubGlobalHandler('drain-all', e.io, { client: fakeClient([busy]).client })({ dataDir: '/x', wait: true, timeout: 'soon' })).toBe(2);
  });

  it('validates --timeout before executing anything and keeps --json output parseable while waiting', async () => {
    const done = statusOf(ws({}));
    let calls = 0;
    const counting = { client: () => ({ ...fakeClient([done]).client(), drainAll: async () => ((calls += 1), done) }) };
    const bad = captured();
    expect(await createHubGlobalHandler('drain-all', bad.io, counting)({ dataDir: '/x', wait: true, timeout: 'soon' })).toBe(2);
    expect(calls).toBe(0);

    const c = captured();
    expect(await createHubGlobalHandler('drain-all', c.io, { client: fakeClient([done]).client })({ dataDir: '/x', wait: true, json: true })).toBe(0);
    expect(() => JSON.parse(c.text())).not.toThrow();
    expect(c.errText()).toContain('all workspaces ended');
  });
});
