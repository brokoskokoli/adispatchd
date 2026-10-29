/**
 * `service install|status|uninstall --hub` (WI-38): the unit of a hub, path checks over all
 * workspaces, dry runs and the real path against an in-memory runner. Nothing here touches systemd.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemRunner } from '../service/index.js';
import { createHubInitHandler } from './hub.js';
import { createProgram, type CliIo } from './program.js';
import { createServiceInstallHandler, createServiceStatusHandler, createServiceUninstallHandler, type ServiceDeps } from './service.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function captureIo(): CliIo & { out: string; err: string; code: number | undefined } {
  const io = {
    out: '',
    err: '',
    code: undefined as number | undefined,
    stdout: (t: string) => {
      io.out += t;
    },
    stderr: (t: string) => {
      io.err += t;
    },
    setExitCode: (c: number) => {
      io.code = c;
    },
  };
  return io;
}

/** In-memory runner: records everything, touches nothing. `existing` = files `exists()` reports. */
function memoryRunner(existing: string[] = [], failAt?: string): SystemRunner & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async exec(argv) {
      const cmd = argv.join(' ');
      log.push(`exec ${cmd}`);
      if (failAt && cmd.startsWith(failAt)) return { code: 1, stdout: '', stderr: 'simulated failure' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async writeFile(file, _content, mode) {
      log.push(`write ${file} ${mode.toString(8)}`);
    },
    async remove(file) {
      log.push(`remove ${file}`);
    },
    exists: (f) => existing.includes(f),
  };
}

const ENTRY = '/usr/lib/node_modules/adispatchd/dist/cli/main.js';
const linux = (runner: SystemRunner, euid = 0): ServiceDeps => ({ platform: 'linux', euid: () => euid, runner, execPath: '/usr/bin/node', entryPath: ENTRY });

async function service(args: string[], deps: ServiceDeps) {
  const io = captureIo();
  await createProgram(
    {
      serviceInstall: createServiceInstallHandler(io, deps),
      serviceStatus: createServiceStatusHandler(io, deps),
      serviceUninstall: createServiceUninstallHandler(io, deps),
    },
    io,
  ).parseAsync(['service', ...args], { from: 'user' });
  return io;
}

interface TestHub {
  root: string;
  configDir: string;
  /** Hub data dir (never created; the tests use a path below /var/lib that does not exist). */
  dataDir: string;
  /** Parent of the data dirs of the workspaces. */
  wsData: string;
}

/** A hub created by `hub init` in the production layout (workspace data outside the config dir). */
async function initHub(workspaces = ['a', 'b'], layout: 'production' | 'trial' = 'production'): Promise<TestHub> {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-svchub-')));
  roots.push(root);
  const configDir = path.join(root, 'etc', 'hub');
  const wsData = path.join(root, 'lib', 'workspaces');
  const dataDir = '/var/lib/orch-hub-test/hub';
  const io = captureIo();
  const code = await createHubInitHandler(io)({
    configDir,
    dataDir: path.join(root, 'lib', 'hub'),
    workspace: workspaces,
    ...(layout === 'production' ? { workspacesDataDir: wsData } : {}),
  });
  expect(code, io.err).toBe(0);
  return { root, configDir, dataDir, wsData };
}

function addWorkflow(configDir: string, id: string, grace: string): void {
  writeFileSync(path.join(configDir, 'workflows', `${id}.yaml`), `id: ${id}\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/true, cancel_grace: ${grace} }\n`);
}

describe('service install --hub --dry-run', () => {
  it('prints the unit of `hub start`, derives TimeoutStopSec from all workspaces and plans every workspace directory', async () => {
    const hub = await initHub();
    addWorkflow(path.join(hub.configDir, 'workspaces', 'b', 'config'), 'slow', '90s');
    const runner = memoryRunner();
    const io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', hub.dataDir, '--create-user'], linux(runner));
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('# /etc/systemd/system/adispatchd-hub.service');
    expect(io.out).toContain('Description=Agent Dispatch Daemon (hub)');
    expect(io.out).toContain(`ExecStart=/usr/bin/node ${ENTRY} hub start --config-dir ${hub.configDir} --data-dir ${hub.dataDir} --drain-timeout 10m --cancel-timeout 2m`);
    expect(io.out).toContain(`WorkingDirectory=${hub.dataDir}`);
    expect(io.out).toContain('EnvironmentFile=-/etc/default/adispatchd-hub');
    expect(io.out).toContain('KillMode=mixed');
    expect(io.out).toContain('RestartPreventExitStatus=78');
    // 10m drain + 2m cancel + 90s (largest cancel_grace of workspace "b") + 1m buffer
    expect(io.out).toContain('TimeoutStopSec=870');
    // The hub's own data dir and both workspace data dirs belong to the service user; one config tree (workspace configs are inside it).
    expect(io.out).toContain(`$ install -d -m 0750 -o adispatchd -g adispatchd ${hub.dataDir}`);
    for (const id of ['a', 'b']) {
      expect(io.out).toContain(`$ install -d -m 0750 -o adispatchd -g adispatchd ${path.join(hub.wsData, id)}`);
      expect(io.out).toContain(`$ chown -R adispatchd:adispatchd ${path.join(hub.wsData, id)}`);
    }
    expect(io.out).toContain(`$ chown -R root:adispatchd ${hub.configDir}`);
    expect(io.out).not.toContain(`chown -R root:adispatchd ${path.join(hub.configDir, 'workspaces')}`);
    expect(io.out).toContain('$ systemctl enable adispatchd-hub.service');
    expect(io.out).toContain('nothing was changed');
    expect(io.out).not.toMatch(/\bnpx\b/);
    expect(runner.log).toEqual(['exec id -u adispatchd']);
  });

  it('honours --name and --user and works on macOS', async () => {
    const hub = await initHub(['a']);
    const io = await service(
      ['install', '--hub', '--dry-run', '--name', 'acme-hub', '--user', 'acme', '--env-file', 'none', '--config-dir', hub.configDir, '--data-dir', hub.dataDir],
      { platform: 'darwin', runner: memoryRunner(), execPath: '/opt/homebrew/bin/node', entryPath: ENTRY },
    );
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('# /etc/systemd/system/acme-hub.service');
    expect(io.out).toContain('User=acme');
    expect(io.out).not.toContain('EnvironmentFile');
    expect(io.out).toContain('only usable on Linux');
  });

  it('warns instead of failing when hub.yaml is missing or invalid, and the plan then has no workspace directories', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-svchub-empty-')));
    roots.push(root);
    let io = await service(['install', '--hub', '--dry-run', '--config-dir', root, '--data-dir', '/var/lib/orch-hub-test/hub'], linux(memoryRunner()));
    expect(io.code, io.err).toBe(0);
    expect(io.err).toContain('hub.yaml does not exist');
    expect(io.out).toContain('hub start --config-dir');
    writeFileSync(path.join(root, 'hub.yaml'), 'bogus: 1\n');
    io = await service(['install', '--hub', '--dry-run', '--config-dir', root, '--data-dir', '/var/lib/orch-hub-test/hub'], linux(memoryRunner()));
    expect(io.code, io.err).toBe(0);
    expect(io.err).toContain('hub.yaml in');
    expect(io.err).toContain('is invalid');
  });

  it('rejects the trial layout (workspace data inside the config dir) with a pointer to --workspaces-data-dir, also in dry runs', async () => {
    const hub = await initHub(['a'], 'trial');
    const io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', hub.dataDir], linux(memoryRunner()));
    expect(io.code).toBe(2);
    expect(io.err).toContain('workspace data dir');
    expect(io.err).toContain('--workspaces-data-dir');
    expect(io.out).toBe('');
  });

  it('rejects unsafe workspace directories, nested hub directories and over-long socket paths', async () => {
    const hub = await initHub(['a']);
    const deps = linux(memoryRunner());
    const hubYaml = path.join(hub.configDir, 'hub.yaml');
    const original = readFileSync(hubYaml, 'utf8');
    const wsDataLine = `data_dir: ${path.join(hub.wsData, 'a')}`;
    expect(original).toContain(wsDataLine);

    // Workspace data dir is a system directory.
    writeFileSync(hubYaml, original.replace(wsDataLine, 'data_dir: /var/lib'));
    let io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', '/srv/orch-hub-test/hub'], deps);
    expect(io.code).toBe(2);
    expect(io.err).toContain('workspace data dir /var/lib is a system directory');

    // Workspace config dir is a system directory.
    writeFileSync(hubYaml, original.replace(/config_dir: .*?\s+#/, 'config_dir: /etc   #'));
    io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', hub.dataDir], deps);
    expect(io.code).toBe(2);
    expect(io.err).toContain('workspace config dir /etc is a system directory');

    // The hub's data dir inside the hub config dir.
    writeFileSync(hubYaml, original);
    io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', path.join(hub.configDir, 'data')], deps);
    expect(io.code).toBe(2);
    expect(io.err).toContain('must be separate, non-nested');

    // Hub data dir equal to the data dir of a workspace: hub.yaml is invalid (warning in a dry run, error otherwise).
    io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', path.join(hub.wsData, 'a')], deps);
    expect(io.err).toContain('is invalid');
    io = await service(['install', '--hub', '--config-dir', hub.configDir, '--data-dir', path.join(hub.wsData, 'a')], deps);
    expect(io.code).toBe(2);
    expect(io.err).toContain('is invalid');

    // Socket path too long for sockaddr_un.
    io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', `/var/lib/${'x'.repeat(90)}`], deps);
    expect(io.code).toBe(2);
    expect(io.err).toContain('socket path');
    expect(io.err).toContain('too long');
  });

  it('plans a migrated workspace outside the hub config dir separately and notes a single-instance unit', async () => {
    const hub = await initHub(['a']);
    // Existing single instance (init layout) added as workspace "legacy".
    const legacy = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-svchub-legacy-')));
    roots.push(legacy);
    const legacyConfig = path.join(legacy, 'etc-adispatchd');
    const legacyData = path.join(legacy, 'lib-adispatchd');
    mkdirSync(legacyConfig);
    writeFileSync(path.join(legacyConfig, 'config.yaml'), 'server: { host: 127.0.0.1, port: 8787 }\n');
    const hubYaml = path.join(hub.configDir, 'hub.yaml');
    writeFileSync(hubYaml, `${readFileSync(hubYaml, 'utf8')}  - { id: legacy, config_dir: ${legacyConfig}, data_dir: ${legacyData}, port: 8787 }\n`);
    const runner = memoryRunner(['/etc/systemd/system/adispatchd.service']);
    const io = await service(['install', '--hub', '--dry-run', '--config-dir', hub.configDir, '--data-dir', hub.dataDir], linux(runner));
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain(`$ chown -R root:adispatchd ${legacyConfig}`);
    expect(io.out).toContain(`$ chown -R adispatchd:adispatchd ${legacyData}`);
    expect(io.out).toContain('a single-instance unit adispatchd.service exists');
    expect(io.out).toContain('systemctl disable --now adispatchd');
  });
});

describe('service install --hub (Linux path, in-memory runner)', () => {
  it('runs the plan in order as root: data dirs, one config tree, env file, unit', async () => {
    const hub = await initHub();
    const runner = memoryRunner();
    const io = await service(
      ['install', '--hub', '--config-dir', hub.configDir, '--data-dir', hub.dataDir, '--unit-dir', '/u', '--name', 'orch-hub'],
      linux(runner),
    );
    expect(io.code, io.err).toBe(0);
    expect(runner.log).toEqual([
      'exec id -u adispatchd',
      'exec systemctl --version',
      `exec install -d -m 0750 -o adispatchd -g adispatchd ${hub.dataDir}`,
      `exec chown -R adispatchd:adispatchd ${hub.dataDir}`,
      `exec install -d -m 0750 -o adispatchd -g adispatchd ${path.join(hub.wsData, 'a')}`,
      `exec chown -R adispatchd:adispatchd ${path.join(hub.wsData, 'a')}`,
      `exec install -d -m 0750 -o adispatchd -g adispatchd ${path.join(hub.wsData, 'b')}`,
      `exec chown -R adispatchd:adispatchd ${path.join(hub.wsData, 'b')}`,
      `exec chown -R root:adispatchd ${hub.configDir}`,
      `exec chmod -R u=rwX,g=rX,o= ${hub.configDir}`,
      'write /etc/default/orch-hub 640',
      'exec chown root:adispatchd /etc/default/orch-hub',
      'exec chmod 0640 /etc/default/orch-hub',
      'write /u/orch-hub.service 644',
      'exec systemctl daemon-reload',
      'exec systemctl enable orch-hub.service',
    ]);
    expect(io.out).toContain('service orch-hub installed');
  });

  it('refuses without root and when hub.yaml, a workspace configuration or the user is wrong – before anything is changed', async () => {
    const hub = await initHub();
    let runner = memoryRunner();
    let io = await service(['install', '--hub', '--config-dir', hub.configDir, '--data-dir', hub.dataDir], linux(runner, 1000));
    expect(io.code).toBe(1);
    expect(io.err).toContain('must run as root');
    expect(runner.log.filter((l) => !l.startsWith('exec id -u'))).toEqual([]);

    // Typo in --config-dir: no hub.yaml.
    const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-svchub-typo-')));
    roots.push(empty);
    runner = memoryRunner();
    io = await service(['install', '--hub', '--config-dir', empty, '--data-dir', hub.dataDir], linux(runner));
    expect(io.code).toBe(2);
    expect(io.err).toContain('hub.yaml does not exist');
    expect(runner.log).toEqual([]);

    // Invalid workspace configuration.
    writeFileSync(path.join(hub.configDir, 'workspaces', 'b', 'config', 'config.yaml'), 'scheduler:\n  max_concurent: 3\n');
    runner = memoryRunner();
    io = await service(['install', '--hub', '--config-dir', hub.configDir, '--data-dir', hub.dataDir], linux(runner));
    expect(io.code).toBe(2);
    expect(io.err).toContain('workspace "b"');
    expect(io.err).toContain('hub validate');
    expect(runner.log).toEqual([]);

    // Unknown user without --create-user.
    const ok = await initHub(['a']);
    runner = memoryRunner([], 'id -u');
    io = await service(['install', '--hub', '--config-dir', ok.configDir, '--data-dir', ok.dataDir], linux(runner));
    expect(io.code).toBe(1);
    expect(io.err).toContain('--create-user');
    expect(runner.log).toEqual(['exec id -u adispatchd']);
  });

  it('explains that systemd is Linux-only on macOS', async () => {
    const io = await service(['install', '--hub', '--config-dir', '/etc/o', '--data-dir', '/var/lib/o'], { platform: 'darwin', runner: memoryRunner() });
    expect(io.code).toBe(2);
    expect(io.err).toContain('only supported on Linux');
  });
});

describe('service install --hub: guards', () => {
  it('needs at least one workspace outside dry runs (hub init --empty)', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-svchub-none-')));
    roots.push(root);
    expect(await createHubInitHandler(captureIo())({ configDir: root, dataDir: path.join(root, '..', 'x-data'), empty: true })).toBe(0);
    const dry = await service(['install', '--hub', '--dry-run', '--config-dir', root, '--data-dir', '/var/lib/orch-hub-test/hub'], linux(memoryRunner()));
    expect(dry.code, dry.err).toBe(0);
    expect(dry.err).toContain('lists no workspaces');
    const runner = memoryRunner();
    const real = await service(['install', '--hub', '--config-dir', root, '--data-dir', '/var/lib/orch-hub-test/hub'], linux(runner));
    expect(real.code).toBe(2);
    expect(real.err).toContain('lists no workspaces');
    expect(runner.log).toEqual([]);
  });

  it('does not silently overwrite a single-instance unit with --name adispatchd', async () => {
    const hub = await initHub(['a']);
    const existing = ['/etc/systemd/system/adispatchd.service'];
    const runner = memoryRunner(existing);
    const real = await service(['install', '--hub', '--name', 'adispatchd', '--config-dir', hub.configDir, '--data-dir', hub.dataDir], linux(runner));
    expect(real.code).toBe(1);
    expect(real.err).toContain('would overwrite');
    expect(runner.log.filter((l) => !l.startsWith('exec id -u'))).toEqual([]);
    const dry = await service(['install', '--hub', '--dry-run', '--name', 'adispatchd', '--config-dir', hub.configDir, '--data-dir', hub.dataDir], linux(memoryRunner(existing)));
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain('would overwrite');
  });
});

describe('service status|uninstall --hub', () => {
  it('default to the hub unit name; --name overrides', async () => {
    const runner = memoryRunner();
    let io = await service(['uninstall', '--hub', '--dry-run'], linux(runner));
    expect(io.code).toBe(0);
    expect(io.out).toContain('$ systemctl disable --now adispatchd-hub.service');
    expect(io.out).toContain('rm -f /etc/systemd/system/adispatchd-hub.service');
    expect(io.out).toContain('hub drain-all --wait');
    io = await service(['uninstall', '--hub', '--dry-run', '--name', 'acme-hub'], linux(runner));
    expect(io.out).toContain('acme-hub.service');
    io = await service(['uninstall', '--dry-run'], linux(runner));
    expect(io.out).toContain('adispatchd.service');
    expect(io.out).not.toContain('hub drain-all');

    const status = await service(['status', '--hub'], linux(runner));
    expect(runner.log).toContain('exec systemctl status --no-pager --lines 20 adispatchd-hub.service');
    expect(status.code).toBe(0);
  });

  it('uninstall --hub removes only the unit', async () => {
    const runner = memoryRunner();
    const io = await service(['uninstall', '--hub', '--unit-dir', '/u'], linux(runner));
    expect(io.code, io.err).toBe(0);
    expect(runner.log).toEqual(['exec systemctl disable --now adispatchd-hub.service', 'remove /u/adispatchd-hub.service', 'exec systemctl daemon-reload']);
  });
});
