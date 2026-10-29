import { describe, expect, it } from 'vitest';
import { computeTimeoutStopSec, formatCliDuration, quoteSystemdArg, renderSystemdUnit, type UnitOptions } from './unit.js';

const BASE: UnitOptions = {
  unitName: 'adispatchd',
  user: 'adispatchd',
  group: 'adispatchd',
  nodePath: '/usr/bin/node',
  entryPath: '/usr/lib/node_modules/adispatchd/dist/cli/main.js',
  configDir: '/etc/adispatchd',
  dataDir: '/var/lib/adispatchd',
  envFile: '/etc/default/adispatchd',
  drainTimeoutMs: 10 * 60_000,
  cancelTimeoutMs: 2 * 60_000,
  maxCancelGraceMs: 30_000,
};

describe('systemd unit generation', () => {
  it('renders the unit (snapshot)', () => {
    expect(renderSystemdUnit(BASE)).toMatchSnapshot();
  });

  it('renders the unit of a hub (snapshot): `hub start`, KillMode=mixed, same stop contract', () => {
    const hub = renderSystemdUnit({
      ...BASE,
      unitName: 'adispatchd-hub',
      configDir: '/etc/adispatchd-hub',
      dataDir: '/var/lib/adispatchd-hub/hub',
      envFile: '/etc/default/adispatchd-hub',
      hub: { workspaceConfigDirs: ['/etc/adispatchd-hub/workspaces/a/config'], workspaceDataDirs: ['/var/lib/adispatchd-hub/workspaces/a'] },
    });
    expect(hub).toMatchSnapshot();
    const lines = hub.split('\n');
    expect(lines).toContain(
      'ExecStart=/usr/bin/node /usr/lib/node_modules/adispatchd/dist/cli/main.js hub start --config-dir /etc/adispatchd-hub --data-dir /var/lib/adispatchd-hub/hub --drain-timeout 10m --cancel-timeout 2m',
    );
    expect(lines).toContain('KillMode=mixed');
    expect(lines).toContain('RestartPreventExitStatus=78');
    expect(lines).toContain('TimeoutStopSec=810');
    expect(lines).toContain('WorkingDirectory=/var/lib/adispatchd-hub/hub');
    // The workspace directories are not part of the unit (the hub reads them from hub.yaml).
    expect(hub).not.toContain('workspaces/a');
    expect(() => renderSystemdUnit({ ...BASE, hub: { workspaceConfigDirs: ['rel'], workspaceDataDirs: [] } })).toThrow(/absolute/);
  });

  it('uses absolute paths, a dedicated user and no npx', () => {
    const unit = renderSystemdUnit(BASE);
    const lines = unit.split('\n');
    expect(lines.some((l) => /npx/.test(l))).toBe(false);
    const exec = lines.find((l) => l.startsWith('ExecStart='));
    expect(exec).toBe(
      'ExecStart=/usr/bin/node /usr/lib/node_modules/adispatchd/dist/cli/main.js start ' +
        '--config-dir /etc/adispatchd --data-dir /var/lib/adispatchd --drain-timeout 10m --cancel-timeout 2m',
    );
    expect(lines).toContain('User=adispatchd');
    expect(lines).toContain('Group=adispatchd');
    expect(lines).toContain('Restart=on-failure');
    expect(lines).toContain('RestartPreventExitStatus=78');
    expect(lines).toContain('KillMode=mixed');
    expect(lines).toContain('KillSignal=SIGTERM');
    expect(lines).toContain('WorkingDirectory=/var/lib/adispatchd');
    expect(lines).toContain('EnvironmentFile=-/etc/default/adispatchd');
    // 10m drain + 2m cancel + 30s grace + 60s buffer
    expect(lines).toContain('TimeoutStopSec=810');
  });

  it('is a pure function', () => {
    expect(renderSystemdUnit({ ...BASE })).toBe(renderSystemdUnit({ ...BASE }));
  });

  it('derives TimeoutStopSec from drain, cancel, grace and buffer', () => {
    expect(computeTimeoutStopSec({ drainTimeoutMs: 0, cancelTimeoutMs: 0, maxCancelGraceMs: 0, stopBufferMs: 0 })).toBe(0);
    expect(computeTimeoutStopSec({ drainTimeoutMs: 3_600_000, cancelTimeoutMs: 300_000, maxCancelGraceMs: 90_500 })).toBe(3600 + 300 + 91 + 60);
    const unit = renderSystemdUnit({ ...BASE, drainTimeoutMs: 3_600_000, cancelTimeoutMs: 300_000, maxCancelGraceMs: 120_000 });
    expect(unit).toContain('TimeoutStopSec=4080');
    expect(unit).toContain('--drain-timeout 1h --cancel-timeout 5m');
  });

  it('omits the environment file when disabled', () => {
    expect(renderSystemdUnit({ ...BASE, envFile: null })).not.toContain('EnvironmentFile');
  });

  it('quotes paths with spaces and escapes specifiers', () => {
    expect(quoteSystemdArg('/opt/a b/main.js')).toBe('"/opt/a b/main.js"');
    expect(quoteSystemdArg('/srv/100%/x')).toBe('/srv/100%%/x');
    expect(quoteSystemdArg('/srv/$HOME')).toBe('/srv/$$HOME');
    expect(quoteSystemdArg('a"b')).toBe('"a\\"b"');
    const unit = renderSystemdUnit({ ...BASE, configDir: '/etc/my orchestrator', dataDir: '/var/lib/o%n' });
    expect(unit).toContain('--config-dir "/etc/my orchestrator" --data-dir /var/lib/o%%n');
    expect(unit).toContain('WorkingDirectory=/var/lib/o%%n');
  });

  it('rejects npx, relative paths, root, TypeScript entry points and line breaks', () => {
    expect(() => renderSystemdUnit({ ...BASE, entryPath: '/root/.npm/_npx/123/node_modules/adispatchd/dist/cli/main.js' })).toThrow(/npx/);
    expect(() => renderSystemdUnit({ ...BASE, nodePath: '/usr/local/bin/npx' })).toThrow(/npx/);
    expect(() => renderSystemdUnit({ ...BASE, nodePath: 'node' })).toThrow(/absolute/);
    expect(() => renderSystemdUnit({ ...BASE, configDir: './config' })).toThrow(/absolute/);
    expect(() => renderSystemdUnit({ ...BASE, user: 'root' })).toThrow(/dedicated user/);
    expect(() => renderSystemdUnit({ ...BASE, entryPath: '/src/cli/main.ts' })).toThrow(/TypeScript/);
    expect(() => renderSystemdUnit({ ...BASE, dataDir: '/var/lib/x\nExecStartPre=/bin/evil' })).toThrow(/line breaks/);
    expect(() => renderSystemdUnit({ ...BASE, unitName: 'bad name' })).toThrow(/unit name/);
    expect(() => renderSystemdUnit({ ...BASE, unitName: 'orch@1' })).toThrow(/unit name/);
  });

  it('formats durations in CLI syntax', () => {
    expect(formatCliDuration(600_000)).toBe('10m');
    expect(formatCliDuration(7_200_000)).toBe('2h');
    expect(formatCliDuration(90_000)).toBe('90s');
    expect(formatCliDuration(1500)).toBe('1500ms');
    expect(formatCliDuration(0)).toBe('0s');
  });
});
