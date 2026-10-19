/**
 * Real measurement on the local machine (Linux or macOS): the default probe
 * with the real `ps`, `/proc/meminfo` or `vm_stat` and `statfs` gives
 * plausible values, attributes a real worker process group to its run and
 * never reports process arguments.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemProbe, PS_ARGS, readProcProcesses } from './probe.js';
import { ResourceSampler } from './sampler.js';

const SECRET_ARG = `adispatch-secret-arg-${process.pid}-${Date.now()}`;
let child: ChildProcess | undefined;
const extra: ChildProcess[] = [];

afterAll(() => {
  // Only the process groups of the children this test spawned itself (detached → group ID = their PID).
  for (const c of extra) {
    if (typeof c.pid !== 'number' || c.pid <= 1) continue;
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  if (typeof child?.pid === 'number' && child.pid > 1) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

describe('Linux /proc reader (synthetic procfs)', () => {
  const stat = (pid: number, comm: string, ticks: number, start: number): string =>
    `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${start} 1000 25 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'adispatch-proc-'));
    await writeFile(path.join(root, 'uptime'), '1000.50 3000.00\n');
    for (const [pid, comm, ticks, start] of [[10, 'node', 250, 90_000], [11, 'Web Content', 5, 99_000]] as const) {
      await mkdir(path.join(root, String(pid)));
      await writeFile(path.join(root, String(pid), 'stat'), stat(pid, comm, ticks, start));
      // cmdline is never read
      await writeFile(path.join(root, String(pid), 'cmdline'), `${comm}\0--token=SECRET9\0`);
    }
    await mkdir(path.join(root, '12')); // exited while listing: no stat
    await mkdir(path.join(root, 'self'));
    await writeFile(path.join(root, 'meminfo'), 'x');
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('reads all processes with tick precision, skips vanished ones and non-PID entries', async () => {
    const list = (await readProcProcesses(root, 100, 4096)).sort((a, b) => a.pid - b.pid);
    expect(list).toEqual([
      { pid: 10, ppid: 1, pgid: 10, cpuSeconds: 2.5, startTicks: 90_000, elapsedSeconds: expect.closeTo(100.5, 6), rssBytes: 25 * 4096, name: 'node' },
      { pid: 11, ppid: 1, pgid: 11, cpuSeconds: 0.05, startTicks: 99_000, elapsedSeconds: expect.closeTo(10.5, 6), rssBytes: 25 * 4096, name: 'Web' },
    ]);
    expect(JSON.stringify(list)).not.toContain('SECRET9');
  });

  it('the Linux probe uses /proc; without a readable procfs it falls back to ps', async () => {
    const viaProc = await createSystemProbe({ platform: 'linux', procRoot: root }).processes();
    expect(viaProc.processes?.map((p) => p.pid).sort()).toEqual([10, 11]);
    expect(viaProc.text).toBeUndefined();
    const fallback = createSystemProbe({ platform: 'linux', procRoot: path.join(root, 'missing'), psBinary: path.join(root, 'no-such-ps') });
    await expect(fallback.processes()).rejects.toThrow(/no-such-ps/);
    await expect(readProcProcesses(path.join(root, '12'), 100, 4096)).rejects.toThrow();
  });
});

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('default system probe (real OS)', () => {
  it('lists processes with ps (command name only), never with arguments', () => {
    expect(PS_ARGS.join(' ')).toBe('-A -o pid=,ppid=,pgid=,etime=,time=,rss=,ucomm=');
    expect(PS_ARGS.join(' ')).not.toMatch(/args|command|[^u]comm=/);
  });

  it('measures plausible values and attributes a worker process group to its run', async () => {
    // A busy worker in its own process group (like a run), with a "secret" argument.
    child = spawn(process.execPath, ['-e', 'const end = Date.now() + 30000; while (Date.now() < end) {}', SECRET_ARG], { detached: true, stdio: 'ignore' });
    const pid = child.pid!;
    const probe = createSystemProbe();
    const sampler = new ResourceSampler({ probe });
    const targets = { daemonPid: process.pid, runs: [{ runId: 'run-20261019T000000000Z-0badc0de', workflowId: 'demo', itemKey: null, pid, pgid: pid }] };
    const settings = { topProcesses: 5, minCpuPercent: 2, diskPaths: [os.tmpdir(), os.tmpdir()] };
    expect(await sampler.measure(targets, settings)).toBeNull();
    await new Promise((r) => setTimeout(r, 1500));
    const s = await sampler.measure(targets, settings);
    expect(s).not.toBeNull();
    const sample = s!;
    expect(sample.cpu.cores).toBeGreaterThanOrEqual(1);
    expect(sample.cpu.totalPercent).toBeGreaterThan(0);
    expect(sample.cpu.totalPercent).toBeLessThanOrEqual(100);
    expect(sample.cpu.load.every((l) => l >= 0)).toBe(true);
    expect(sample.memory.totalBytes).toBe(os.totalmem());
    expect(sample.memory.availableBytes).toBeGreaterThan(0);
    expect(sample.memory.availableBytes).toBeLessThanOrEqual(sample.memory.totalBytes);
    expect(sample.disks).toHaveLength(1); // the same file system is listed once
    expect(sample.disks[0]!.freeBytes).toBeGreaterThan(0);
    expect(sample.disks[0]!.freeBytes).toBeLessThanOrEqual(sample.disks[0]!.totalBytes);
    const daemon = sample.processes.find((g) => g.kind === 'daemon');
    expect(daemon?.count).toBe(1);
    expect(daemon!.rssBytes).toBeGreaterThan(1024 * 1024);
    const run = sample.processes.find((g) => g.kind === 'run');
    expect(run).toMatchObject({ label: 'demo · 0badc0de', count: 1 });
    // The busy loop uses about one core (Linux: /proc ticks; macOS: ps 10 ms); the machine may be loaded.
    expect(run!.cpuPercent).toBeGreaterThan(5);
    expect(run!.cpuPercent).toBeLessThanOrEqual(sample.cpu.cores * 100);
    expect(sample.processes.filter((g) => g.kind === 'rest' || g.kind === 'other').reduce((n, g) => n + g.count, 0)).toBeGreaterThan(0);
    expect(JSON.stringify(sample)).not.toContain(SECRET_ARG);
    expect(JSON.stringify(sample)).not.toContain('Date.now');
  }, 30_000);

  it('rewritten argv[0] (exec -a) and process titles never leak arguments (B1)', async () => {
    const shell = spawn('bash', ['-c', 'exec -a "/bin/sleep --token=SECRET123 x" sleep 30'], { detached: true, stdio: 'ignore' });
    const titled = spawn(process.execPath, ['-e', 'process.title = "node --password=HUNTER2"; setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
    extra.push(shell, titled);
    await new Promise((r) => setTimeout(r, 1000));
    if (process.platform === 'darwin') {
      // The attack works against `ps -o comm` (sanity check of the test itself) …
      expect(execFileSync('ps', ['-o', 'comm=', '-p', String(shell.pid)], { encoding: 'utf8' })).toContain('SECRET123');
    }
    // … but not against the listing the monitor uses.
    const probe = createSystemProbe();
    const listing = await probe.processes();
    // Linux reads /proc/<pid>/stat (comm only), macOS runs ps.
    expect(process.platform === 'linux' ? listing.processes?.length : listing.text?.length).toBeGreaterThan(0);
    expect(JSON.stringify(listing)).not.toMatch(/SECRET123|HUNTER2/);
    const sampler = new ResourceSampler({ probe });
    const settings = { topProcesses: 50, minCpuPercent: 0, diskPaths: [] };
    const targets = { daemonPid: process.pid, runs: [] };
    await sampler.measure(targets, settings);
    await new Promise((r) => setTimeout(r, 300));
    const sample = await sampler.measure(targets, settings);
    expect(JSON.stringify(sample)).not.toMatch(/SECRET123|HUNTER2/);
  }, 30_000);
});
