/**
 * `service` CLI: `--dry-run`, refusals and the real install path against an
 * in-memory runner – the tests never run systemctl/useradd/chown or write
 * unit files.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemRunner } from '../service/index.js';
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

/** Runner that fails the test on any side effect except the read-only user probe. */
function guardRunner(): SystemRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(argv) {
      calls.push(argv.join(' '));
      if (argv[0] === 'id') return { code: 1, stdout: '', stderr: 'no such user' };
      throw new Error(`unexpected command in test: ${argv.join(' ')}`);
    },
    async writeFile(file) {
      throw new Error(`unexpected write in test: ${file}`);
    },
    async remove(file) {
      throw new Error(`unexpected remove in test: ${file}`);
    },
    exists: () => false,
  };
}

const ENTRY = '/usr/lib/node_modules/adispatchd/dist/cli/main.js';

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

function configWithGrace(grace: string): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-svc-')));
  roots.push(root);
  mkdirSync(path.join(root, 'workflows'));
  writeFileSync(path.join(root, 'config.yaml'), 'server: { host: 127.0.0.1, port: 8787 }\n');
  writeFileSync(
    path.join(root, 'workflows', 'w.yaml'),
    `id: w\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/true, cancel_grace: ${grace} }\n`,
  );
  return root;
}

describe('cli service (dry-run only)', () => {
  it('install --dry-run prints the unit with absolute paths and the planned steps', async () => {
    const configDir = configWithGrace('2m');
    const runner = guardRunner();
    const io = await service(
      ['install', '--dry-run', '--config-dir', configDir, '--data-dir', '/var/lib/adispatchd', '--drain-timeout', '30m', '--create-user'],
      { platform: 'linux', runner, execPath: '/usr/bin/node', entryPath: ENTRY },
    );
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('# /etc/systemd/system/adispatchd.service');
    expect(io.out).toContain(`ExecStart=/usr/bin/node ${ENTRY} start --config-dir ${configDir} --data-dir /var/lib/adispatchd --drain-timeout 30m --cancel-timeout 2m`);
    // 30m + 2m + 2m (largest cancel_grace of the config) + 1m buffer
    expect(io.out).toContain('TimeoutStopSec=2100');
    expect(io.out).toContain('$ useradd --system --user-group');
    expect(io.out).toContain('$ systemctl enable adispatchd.service');
    expect(io.out).toContain('nothing was changed');
    expect(io.out).not.toMatch(/\bnpx\b/);
    // Only the read-only user probe ran.
    expect(runner.calls).toEqual(['id -u adispatchd']);
  });

  it('install --dry-run works on macOS and notes a missing user instead of failing', async () => {
    const io = await service(['install', '--dry-run', '--config-dir', '/etc/o', '--data-dir', '/var/lib/o', '--user', 'orch', '--env-file', 'none'], {
      platform: 'darwin',
      runner: guardRunner(),
      execPath: '/opt/homebrew/bin/node',
      entryPath: ENTRY,
    });
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('User=orch');
    expect(io.out).not.toContain('EnvironmentFile');
    expect(io.out).toContain('only usable on Linux');
    expect(io.err).toContain('TimeoutStopSec assumes a cancel grace of 30s');
    expect(io.err).toContain('/etc/o/config.yaml does not exist');
  });

  it('refuses npx / TypeScript entry points and missing directories', async () => {
    const deps = { platform: 'linux' as const, runner: guardRunner(), execPath: '/usr/bin/node' };
    let io = await service(['install', '--dry-run', '--config-dir', '/etc/o', '--data-dir', '/var/lib/o'], {
      ...deps,
      entryPath: '/home/u/.npm/_npx/abc/node_modules/adispatchd/dist/cli/main.js',
    });
    expect(io.code).toBe(2);
    expect(io.err).toContain('npx cache');
    io = await service(['install', '--dry-run', '--config-dir', '/etc/o', '--data-dir', '/var/lib/o'], { ...deps, entryPath: '/x/src/cli/main.ts' });
    expect(io.code).toBe(2);
    io = await service(['install', '--dry-run', '--config-dir', '/etc/o'], { ...deps, entryPath: ENTRY });
    expect(io.code).toBe(2);
    expect(io.err).toContain('--data-dir are required');
  });

  it('uninstall --dry-run lists the steps and keeps config/data', async () => {
    const io = await service(['uninstall', '--dry-run', '--name', 'orch-test'], { platform: 'linux', runner: guardRunner() });
    expect(io.code).toBe(0);
    expect(io.out).toContain('$ systemctl disable --now orch-test.service');
    expect(io.out).toContain('rm -f /etc/systemd/system/orch-test.service');
    expect(io.out).toContain('are kept');
  });

  it('explains that systemd is Linux-only on macOS', async () => {
    for (const cmd of [['install', '--config-dir', '/etc/o', '--data-dir', '/var/lib/o'], ['status'], ['uninstall']]) {
      const io = await service(cmd, { platform: 'darwin', runner: guardRunner() });
      expect(io.code).toBe(2);
      expect(io.err).toContain('only supported on Linux');
    }
  });

  it('rejects unsafe directories (also in dry runs) and warns about an ineffective cancel grace', async () => {
    const deps = { platform: 'linux' as const, runner: guardRunner(), execPath: '/usr/bin/node', entryPath: ENTRY };
    for (const [configDir, dataDir] of [
      ['/etc', '/var/lib/o'],
      ['/etc/o', '/var/lib'],
      ['/etc/o', '/etc/o/data'],
      ['/srv', '/var/lib/o'],
    ]) {
      const io = await service(['install', '--dry-run', '--config-dir', configDir ?? '', '--data-dir', dataDir ?? ''], deps);
      expect(io.code, `${configDir} ${dataDir}`).toBe(2);
      expect(io.out).toBe('');
    }
    const configDir = configWithGrace('5m');
    const io = await service(['install', '--dry-run', '--config-dir', configDir, '--data-dir', '/var/lib/o'], deps);
    expect(io.code).toBe(0);
    expect(io.out).toContain('is not smaller than the cancel timeout');
  });
});

/** In-memory runner for the real (non-dry-run) Linux path. */
function memoryRunner(failAt?: string): SystemRunner & { log: string[] } {
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
    exists: () => false,
  };
}

describe('cli service install (Linux path, in-memory runner)', () => {
  const linux = (runner: SystemRunner, euid = 0): ServiceDeps => ({ platform: 'linux', euid: () => euid, runner, execPath: '/usr/bin/node', entryPath: ENTRY });

  it('runs the plan in order as root', async () => {
    const configDir = configWithGrace('30s');
    const runner = memoryRunner();
    const io = await service(['install', '--config-dir', configDir, '--data-dir', '/var/lib/orch-test', '--name', 'orch-test', '--unit-dir', '/u'], linux(runner));
    expect(io.code, io.err).toBe(0);
    expect(runner.log).toEqual([
      'exec id -u adispatchd',
      'exec systemctl --version',
      'exec install -d -m 0750 -o adispatchd -g adispatchd /var/lib/orch-test',
      'exec chown -R adispatchd:adispatchd /var/lib/orch-test',
      `exec chown -R root:adispatchd ${configDir}`,
      `exec chmod -R u=rwX,g=rX,o= ${configDir}`,
      'write /etc/default/orch-test 640',
      'exec chown root:adispatchd /etc/default/orch-test',
      'exec chmod 0640 /etc/default/orch-test',
      'write /u/orch-test.service 644',
      'exec systemctl daemon-reload',
      'exec systemctl enable orch-test.service',
    ]);
    expect(io.out).toContain('service orch-test installed');
  });

  it('stops at the first failing step and reports it', async () => {
    const configDir = configWithGrace('30s');
    const runner = memoryRunner('systemctl daemon-reload');
    const io = await service(['install', '--config-dir', configDir, '--data-dir', '/var/lib/orch-test', '--unit-dir', '/u'], linux(runner));
    expect(io.code).toBe(1);
    expect(io.err).toContain('failed at "reload systemd units"');
    expect(io.err).toContain('simulated failure');
    expect(runner.log.at(-1)).toBe('exec systemctl daemon-reload');
    expect(runner.log.some((l) => l.includes('enable'))).toBe(false);
  });

  it('refuses without root, without a valid configuration and without the user', async () => {
    const configDir = configWithGrace('30s');
    let runner = memoryRunner();
    let io = await service(['install', '--config-dir', configDir, '--data-dir', '/var/lib/orch-test'], linux(runner, 1000));
    expect(io.code).toBe(1);
    expect(io.err).toContain('must run as root');
    expect(runner.log.filter((l) => !l.startsWith('exec id -u'))).toEqual([]);

    // Missing config.yaml (e.g. a typo in --config-dir) → nothing is chowned.
    const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orch-svc-empty-')));
    roots.push(empty);
    runner = memoryRunner();
    io = await service(['install', '--config-dir', empty, '--data-dir', '/var/lib/orch-test'], linux(runner));
    expect(io.code).toBe(2);
    expect(io.err).toContain('config.yaml does not exist');
    expect(runner.log).toEqual([]);

    // Unknown user without --create-user.
    runner = memoryRunner('id -u');
    io = await service(['install', '--config-dir', configDir, '--data-dir', '/var/lib/orch-test'], linux(runner));
    expect(io.code).toBe(1);
    expect(io.err).toContain('--create-user');
    expect(runner.log).toEqual(['exec id -u adispatchd']);
  });
});
