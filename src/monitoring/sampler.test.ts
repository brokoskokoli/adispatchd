import { describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger } from '../core/index.js';
import { HOOKS_LABEL, REST_LABEL, ResourceSampler, runLabel } from './sampler.js';
import { FakeProbe, type FakeProcess } from './testing/fake-probe.js';
import type { AttributionTargets, MetricsSample, MonitoredRun, ProcessGroup } from './types.js';

const DAEMON = 100;
const settings = { topProcesses: 5, minCpuPercent: 2, diskPaths: [] as string[] };

function setup(platform: NodeJS.Platform = 'linux') {
  const clock = new FakeClock('2026-10-19T10:00:00Z');
  const probe = new FakeProbe();
  probe.platform = platform;
  const logger = new MemoryLogger();
  const sampler = new ResourceSampler({ probe, clock, logger });
  /** Prime with `before`, advance 10 s (CPU 25 % busy), measure `after`. */
  const twice = async (before: FakeProcess[], after: FakeProcess[], targets: AttributionTargets = { daemonPid: DAEMON, runs: [] }, s = settings): Promise<MetricsSample> => {
    probe.processList = before;
    expect(await sampler.measure(targets, s)).toBeNull();
    clock.advance(10_000);
    probe.advanceCpu(10_000, 0.25);
    probe.processList = after;
    const sample = await sampler.measure(targets, s);
    expect(sample).not.toBeNull();
    return sample!;
  };
  return { clock, probe, logger, sampler, twice };
}

const group = (s: MetricsSample, pred: (g: ProcessGroup) => boolean): ProcessGroup | undefined => s.processes.find(pred);

describe('ResourceSampler', () => {
  it('primes on the first call, then reports system and per-process CPU from the deltas', async () => {
    const { twice } = setup();
    const s = await twice(
      [
        { pid: DAEMON, ppid: 1, cpu: 10, comm: 'node' },
        { pid: 500, ppid: 1, cpu: 100, comm: 'postgres' },
      ],
      [
        { pid: DAEMON, ppid: 1, cpu: 11, rssKiB: 2048, comm: 'node' },
        { pid: 500, ppid: 1, cpu: 105, comm: 'postgres' },
      ],
    );
    expect(s.at).toBe('2026-10-19T10:00:10.000Z');
    expect(s.cpu).toEqual({ totalPercent: 25, cores: 4, load: [0.5, 0.4, 0.3] });
    expect(s.memory).toEqual({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 });
    expect(group(s, (g) => g.kind === 'daemon')).toEqual({ kind: 'daemon', label: 'adispatchd', cpuPercent: 10, rssBytes: 2048 * 1024, count: 1 });
    expect(group(s, (g) => g.kind === 'other')).toMatchObject({ label: 'postgres', name: 'postgres', cpuPercent: 50, count: 1 });
  });

  it('macOS ps format with fractional CPU times gives the same deltas', async () => {
    const { probe, twice } = setup('darwin');
    probe.psFormat = 'darwin';
    const s = await twice([{ pid: 500, ppid: 1, cpu: 61.25, comm: '/usr/libexec/thing' }], [{ pid: 500, ppid: 1, cpu: 63.75, comm: '/usr/libexec/thing' }]);
    expect(group(s, (g) => g.kind === 'other')).toMatchObject({ label: 'thing', cpuPercent: 25 });
  });

  it('handles PID reuse: other name or smaller CPU time → new process, whole CPU time counts', async () => {
    const { twice } = setup();
    const s = await twice(
      [
        { pid: 600, ppid: 1, cpu: 500, comm: 'old' },
        { pid: 601, ppid: 1, cpu: 500, comm: 'same' },
      ],
      [
        { pid: 600, ppid: 1, cpu: 3, comm: 'new' },
        { pid: 601, ppid: 1, cpu: 2, comm: 'same' },
        { pid: 602, ppid: 1, cpu: 1, comm: 'fresh' },
      ],
      undefined,
      { ...settings, minCpuPercent: 0 },
    );
    const byName = Object.fromEntries(s.processes.filter((g) => g.kind === 'other').map((g) => [g.name, g.cpuPercent]));
    expect(byName).toEqual({ new: 30, same: 20, fresh: 10 });
  });

  it('caps a process at the capacity of all cores and never reports negative values', async () => {
    const { twice } = setup();
    const s = await twice([], [{ pid: 700, ppid: 1, cpu: 3600, comm: 'burner' }]);
    expect(group(s, (g) => g.name === 'burner')?.cpuPercent).toBe(400);
  });

  it('attributes processes to runs via process group and ancestry, other daemon children to hooks/checks', async () => {
    const { twice } = setup();
    const run: MonitoredRun = { runId: 'run-20261019T100000000Z-1a2b3c4d', workflowId: 'coder', itemKey: 'project_a:12', pid: 200, pgid: 200 };
    const run2: MonitoredRun = { runId: 'run-20261019T100000000Z-99999999', workflowId: 'reviewer', itemKey: null, pid: 250, pgid: 250 };
    const procs = (cpu: number): FakeProcess[] => [
      { pid: DAEMON, ppid: 1, pgid: 90, cpu, comm: 'node' },
      { pid: 90, ppid: 1, pgid: 90, cpu, comm: 'npm' }, // daemon's own group is not attributed to anything
      { pid: 200, ppid: DAEMON, cpu, comm: 'bash' }, // worker leader
      { pid: 201, ppid: 200, pgid: 200, cpu, comm: 'claude' }, // child in the group
      { pid: 202, ppid: 201, pgid: 202, cpu, comm: 'git' }, // own group, ancestor is the worker
      { pid: 203, ppid: 1, pgid: 200, cpu, comm: 'daemonized' }, // reparented, same group
      { pid: 250, ppid: DAEMON, cpu, comm: 'sh' },
      { pid: 300, ppid: DAEMON, pgid: 300, cpu, comm: 'sh' }, // shell action
      { pid: 301, ppid: 300, pgid: 300, cpu, comm: 'gh' },
    ];
    const s = await twice(procs(0), procs(1), { daemonPid: DAEMON, runs: [run, run2] }, { ...settings, minCpuPercent: 0 });
    expect(group(s, (g) => g.kind === 'daemon')).toMatchObject({ cpuPercent: 10, count: 1 });
    expect(group(s, (g) => g.runId === run.runId)).toMatchObject({
      kind: 'run',
      label: 'coder · 1a2b3c4d · project_a:12',
      workflowId: 'coder',
      itemKey: 'project_a:12',
      cpuPercent: 40,
      count: 4,
    });
    expect(group(s, (g) => g.runId === run2.runId)).toMatchObject({ label: 'reviewer · 99999999', cpuPercent: 10, count: 1 });
    expect(group(s, (g) => g.kind === 'hooks')).toMatchObject({ label: HOOKS_LABEL, cpuPercent: 20, count: 2 });
    expect(group(s, (g) => g.kind === 'other')).toMatchObject({ label: 'npm', count: 1 });
    expect(runLabel({ runId: 'abc', workflowId: 'w', itemKey: null })).toBe('w · abc');
  });

  it('runs without a visible process are still listed (count 0); no hooks group without hook processes', async () => {
    const { twice } = setup();
    const run: MonitoredRun = { runId: 'run-x-00000001', workflowId: 'w', itemKey: null, pid: 999, pgid: 999 };
    const s = await twice([], [{ pid: DAEMON, ppid: 1, cpu: 0, comm: 'node' }], { daemonPid: DAEMON, runs: [run] });
    expect(s.processes.map((g) => g.kind)).toEqual(['daemon', 'run']);
    expect(group(s, (g) => g.kind === 'run')).toMatchObject({ cpuPercent: 0, count: 0 });
  });

  it('container run: engine CLI process + `stats`; host-visible container processes are not counted twice (Linux)', async () => {
    const { probe, twice } = setup('linux');
    const run: MonitoredRun = { runId: 'run-c-0000000c', workflowId: 'boxed', itemKey: null, pid: 400, pgid: 400, container: { engine: 'docker', name: 'adispatch-run-c-0000000c' } };
    probe.stats.set('docker', '{"Name":"adispatch-run-c-0000000c","CPUPerc":"150.00%","MemUsage":"100MiB / 7GiB"}\n');
    probe.inspect.set('docker', '/adispatch-run-c-0000000c 900\n');
    const procs = (cpu: number): FakeProcess[] => [
      { pid: 400, ppid: DAEMON, cpu, rssKiB: 1000, comm: 'docker' },
      { pid: 850, ppid: 1, cpu, comm: 'containerd-shim-runc-v2' },
      { pid: 900, ppid: 850, cpu: cpu * 10, comm: 'docker-init' },
      { pid: 901, ppid: 900, pgid: 900, cpu: cpu * 10, comm: 'claude' },
    ];
    const s = await twice(procs(0), procs(1), { daemonPid: DAEMON, runs: [run] }, { ...settings, minCpuPercent: 0 });
    expect(group(s, (g) => g.kind === 'run')).toMatchObject({ cpuPercent: 160, rssBytes: 1000 * 1024 + 100 * 1024 ** 2, count: 1 });
    const others = s.processes.filter((g) => g.kind === 'other' || g.kind === 'rest').map((g) => g.name ?? g.label);
    expect(others).toEqual(['containerd-shim-runc-v2']);
    expect(probe.calls.engineStats).toBe(2);
    expect(probe.calls.engineInspect).toBe(2);
  });

  it('container run on macOS: no inspect (processes live in the VM); stats failure → only the CLI process, no error', async () => {
    const { probe, logger, twice, sampler, clock } = setup('darwin');
    const run: MonitoredRun = { runId: 'run-c-0000000d', workflowId: 'boxed', itemKey: null, pid: 400, pgid: 400, container: { engine: 'podman', name: 'adispatch-run-c-0000000d' } };
    probe.statsError = new Error('Cannot connect to the Podman socket');
    const s = await twice([{ pid: 400, ppid: DAEMON, cpu: 0, comm: 'podman' }], [{ pid: 400, ppid: DAEMON, cpu: 1, comm: 'podman' }], { daemonPid: DAEMON, runs: [run] });
    expect(group(s, (g) => g.kind === 'run')).toMatchObject({ cpuPercent: 10, count: 1 });
    expect(probe.calls.engineInspect).toBe(0);
    // warned once, throttled afterwards
    clock.advance(10_000);
    await sampler.measure({ daemonPid: DAEMON, runs: [run] }, settings);
    expect(logger.records.filter((r) => r.msg.includes('container stats unavailable'))).toHaveLength(1);
  });

  it('groups foreign processes by name: top N above min_cpu_percent individually, the rest as "Others"', async () => {
    const { twice } = setup();
    const before: FakeProcess[] = [];
    const after: FakeProcess[] = [];
    const add = (pid: number, comm: string, cpu: number, rssKiB = 100): void => {
      before.push({ pid, ppid: 1, cpu: 0, comm });
      after.push({ pid, ppid: 1, cpu, rssKiB, comm });
    };
    add(10, 'node', 2);
    add(11, 'node', 3);
    add(12, 'node', 1);
    add(20, 'java', 5);
    add(30, 'chrome', 4);
    add(40, 'idle-a', 0.1);
    add(41, 'idle-b', 0, 5000);
    const s = await twice(before, after, undefined, { ...settings, topProcesses: 2 });
    const foreign = s.processes.filter((g) => g.kind === 'other' || g.kind === 'rest');
    expect(foreign).toEqual([
      { kind: 'other', label: 'node ×3', name: 'node', cpuPercent: 60, rssBytes: 300 * 1024, count: 3 },
      { kind: 'other', label: 'java', name: 'java', cpuPercent: 50, rssBytes: 100 * 1024, count: 1 },
      { kind: 'rest', label: REST_LABEL, cpuPercent: 40, // 0.1 s is below the 1-s resolution of Linux ps
      rssBytes: (100 + 100 + 5000) * 1024, count: 3 },
    ]);
    const none = await setup().twice(before, after, undefined, { ...settings, topProcesses: 0 });
    expect(none.processes.filter((g) => g.kind === 'other')).toEqual([]);
    const high = await setup().twice(before, after, undefined, { ...settings, minCpuPercent: 55 });
    expect(high.processes.filter((g) => g.kind === 'other').map((g) => g.label)).toEqual(['node ×3']);
  });

  it('reports command names only, never arguments, and excludes the ps process itself', async () => {
    const { probe, sampler, clock } = setup();
    probe.helperPid = 77;
    probe.psText = '   77   100   77 00:00:00  10 ps\n  500     1  500 00:00:01 100 /opt/tools/bin/tool\n';
    await sampler.measure({ daemonPid: DAEMON, runs: [] }, settings);
    clock.advance(10_000);
    probe.psText = '   77   100   77 00:00:00  10 ps\n  500     1  500 00:00:09 100 /opt/tools/bin/tool\n';
    const s = (await sampler.measure({ daemonPid: DAEMON, runs: [] }, settings))!;
    const json = JSON.stringify(s);
    expect(json).toContain('"tool"');
    expect(json).not.toContain('/opt/tools');
    expect(s.processes.some((g) => g.kind === 'hooks')).toBe(false); // ps was a daemon child but is excluded
  });

  it('a failing ps leaves the processes empty (logged, throttled) while CPU/memory/disks are still reported', async () => {
    const { probe, sampler, clock, logger } = setup();
    probe.fs.set('/data', { freeBytes: 10, totalBytes: 100, device: 1 });
    probe.fs.set('/data/workspaces', { freeBytes: 10, totalBytes: 100, device: 1 });
    probe.fs.set('/mnt/ws', { freeBytes: 50, totalBytes: 500, device: 2 });
    const s = { ...settings, diskPaths: ['/data', '/data/workspaces', '/mnt/ws', '/missing'] };
    probe.psError = new Error('spawn ps ENOENT');
    await sampler.measure({ daemonPid: DAEMON, runs: [] }, s);
    for (let i = 0; i < 3; i++) {
      clock.advance(10_000);
      probe.advanceCpu(10_000, 0.5);
      const sample = await sampler.measure({ daemonPid: DAEMON, runs: [] }, s);
      expect(sample).toMatchObject({ cpu: { totalPercent: 50 }, processes: [] });
      expect(sample!.disks).toEqual([
        { path: '/data', freeBytes: 10, totalBytes: 100 },
        { path: '/mnt/ws', freeBytes: 50, totalBytes: 500 },
      ]);
    }
    expect(logger.records.filter((r) => r.msg.includes('process list unavailable'))).toHaveLength(1);
    expect(logger.records.filter((r) => r.msg.includes('file system usage unavailable'))).toHaveLength(1);
    // ps works again: one priming listing, then values; recovery is logged
    probe.psError = null;
    probe.processList = [{ pid: 500, ppid: 1, cpu: 0, comm: 'x' }];
    clock.advance(10_000);
    expect((await sampler.measure({ daemonPid: DAEMON, runs: [] }, s))!.processes).toEqual([]);
    clock.advance(10_000);
    expect((await sampler.measure({ daemonPid: DAEMON, runs: [] }, s))!.processes.length).toBeGreaterThan(0);
    expect(logger.records.some((r) => r.msg.includes('measurement works again'))).toBe(true);
  });
});
