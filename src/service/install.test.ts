import { describe, expect, it } from 'vitest';
import { assertSafeServicePaths, executePlan, formatPlan, planInstall, planUninstall, type ExecResult, type ServicePlan, type SystemRunner } from './install.js';
import type { UnitOptions } from './unit.js';

const UNIT: UnitOptions = {
  unitName: 'adispatchd',
  user: 'orch',
  group: 'orch',
  nodePath: '/usr/bin/node',
  entryPath: '/usr/lib/node_modules/adispatchd/dist/cli/main.js',
  configDir: '/etc/adispatchd',
  dataDir: '/var/lib/adispatchd',
  envFile: '/etc/default/adispatchd',
  drainTimeoutMs: 600_000,
  cancelTimeoutMs: 120_000,
  maxCancelGraceMs: 30_000,
};

const input = (over: Partial<Parameters<typeof planInstall>[0]> = {}) => ({
  unit: UNIT,
  unitDir: '/etc/systemd/system',
  createUser: false,
  userExists: true,
  envFileExists: false,
  startNow: false,
  dryRun: false,
  ...over,
});

const argvs = (plan: ServicePlan) => plan.steps.flatMap((s) => (s.kind === 'exec' ? [s.argv.join(' ')] : []));

/** In-memory runner: records everything, touches nothing. */
function memoryRunner(fail?: (argv: string[]) => boolean): SystemRunner & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async exec(argv): Promise<ExecResult> {
      log.push(`exec ${argv.join(' ')}`);
      return fail?.(argv) ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' };
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

describe('service install plan', () => {
  it('sets permissions, writes env template and unit, reloads and enables', () => {
    const plan = planInstall(input());
    expect(argvs(plan)).toEqual([
      'install -d -m 0750 -o orch -g orch /var/lib/adispatchd',
      'chown -R orch:orch /var/lib/adispatchd',
      'chown -R root:orch /etc/adispatchd',
      'chmod -R u=rwX,g=rX,o= /etc/adispatchd',
      'chown root:orch /etc/default/adispatchd',
      'chmod 0640 /etc/default/adispatchd',
      'systemctl daemon-reload',
      'systemctl enable adispatchd.service',
    ]);
    const writes = plan.steps.filter((s) => s.kind === 'write');
    expect(writes.map((w) => [w.path, w.mode])).toEqual([
      ['/etc/default/adispatchd', 0o640],
      ['/etc/systemd/system/adispatchd.service', 0o644],
    ]);
    // The environment template contains placeholders only.
    expect(writes[0]?.kind === 'write' && writes[0].content).toMatch(/^# /m);
    expect(writes[0]?.kind === 'write' && writes[0].content.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([]);
    expect(plan.notes).toContain('start the service with: systemctl start adispatchd');
  });

  it('never overwrites an existing environment file', () => {
    const plan = planInstall(input({ envFileExists: true }));
    expect(plan.steps.some((s) => s.kind === 'write' && s.path === '/etc/default/adispatchd')).toBe(false);
    expect(argvs(plan)).toContain('chmod 0640 /etc/default/adispatchd');
  });

  it('fails without user unless --create-user; dry runs only note it', () => {
    expect(() => planInstall(input({ userExists: false }))).toThrow(/--create-user/);
    const dry = planInstall(input({ userExists: false, dryRun: true }));
    expect(dry.notes.some((n) => n.includes('does not exist'))).toBe(true);
    const create = planInstall(input({ userExists: false, createUser: true }));
    expect(argvs(create)[0]).toBe('useradd --system --user-group --home-dir /var/lib/adispatchd --no-create-home --shell /usr/sbin/nologin orch');
    const otherGroup = planInstall(input({ userExists: false, createUser: true, unit: { ...UNIT, group: 'agents' } }));
    expect(argvs(otherGroup)[0]).toContain('--gid agents');
  });

  it('--now enables and starts; no env file when disabled', () => {
    const plan = planInstall(input({ startNow: true, unit: { ...UNIT, envFile: null } }));
    expect(argvs(plan)).toContain('systemctl enable --now adispatchd.service');
    expect(argvs(plan).some((a) => a.includes('/etc/default'))).toBe(false);
  });

  it('uninstall removes only the unit file', () => {
    const plan = planUninstall({ unitName: 'adispatchd', unitDir: '/etc/systemd/system' });
    expect(plan.steps.map((s) => s.kind)).toEqual(['exec', 'remove', 'exec']);
    expect(plan.steps[1]).toMatchObject({ path: '/etc/systemd/system/adispatchd.service' });
    expect(plan.notes.join(' ')).toContain('are kept');
    expect(formatPlan(plan)).toContain('$ systemctl disable --now adispatchd.service');
  });

  it('executes plans step by step through the injected runner and stops at failures', async () => {
    const runner = memoryRunner((argv) => argv[0] === 'systemctl' && argv[1] === 'daemon-reload');
    const out: string[] = [];
    const res = await executePlan(planInstall(input()), runner, (l) => out.push(l));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
    expect(runner.log.at(-1)).toBe('exec systemctl daemon-reload');
    expect(runner.log).not.toContain('exec systemctl enable adispatchd.service');
    // Optional steps (stop on uninstall) do not abort.
    const r2 = memoryRunner((argv) => argv[1] === 'disable');
    expect((await executePlan(planUninstall({ unitName: 'x', unitDir: '/u' }), r2, () => undefined)).ok).toBe(true);
    expect(r2.log).toEqual(['exec systemctl disable --now x.service', 'remove /u/x.service', 'exec systemctl daemon-reload']);
  });

  it('rejects system directories, shallow paths, homes and nested config/data dirs', () => {
    const ok = { configDir: '/etc/adispatchd', dataDir: '/var/lib/adispatchd' };
    expect(() => assertSafeServicePaths(ok)).not.toThrow();
    expect(() => assertSafeServicePaths({ configDir: '/srv/orch/config', dataDir: '/srv/orch/data' })).not.toThrow();
    for (const bad of ['/', '/etc', '/var', '/var/lib', '/usr', '/usr/local', '/home', '/opt', '/root', '/tmp', '/etc/systemd/system']) {
      expect(() => assertSafeServicePaths({ ...ok, configDir: bad }), bad).toThrow(/system directory|too close/);
      expect(() => assertSafeServicePaths({ ...ok, dataDir: bad }), bad).toThrow(/system directory|too close/);
    }
    expect(() => assertSafeServicePaths({ ...ok, dataDir: '/data' })).toThrow(/too close/);
    expect(() => assertSafeServicePaths({ ...ok, dataDir: '/var/lib/../lib' })).toThrow(/system directory/);
    expect(() => assertSafeServicePaths({ ...ok, dataDir: '/home/alice' })).toThrow(/home directory/);
    expect(() => assertSafeServicePaths({ configDir: '/srv/orch', dataDir: '/srv/orch' })).toThrow(/non-nested/);
    expect(() => assertSafeServicePaths({ configDir: '/srv/orch', dataDir: '/srv/orch/data' })).toThrow(/non-nested/);
    expect(() => assertSafeServicePaths({ configDir: '/srv/orch/config', dataDir: '/srv/orch' })).toThrow(/non-nested/);
    // planInstall enforces it as well (also in dry runs).
    expect(() => planInstall(input({ dryRun: true, unit: { ...UNIT, dataDir: '/var/lib' } }))).toThrow(/system directory/);
  });
});
