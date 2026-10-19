/**
 * One resource measurement (WI-23): system CPU/memory/disks plus a process
 * list attributed to the daemon, its runs, its hooks/checks and foreign
 * processes.
 *
 * - System CPU: delta of the `os.cpus()` times between two measurements.
 * - Process CPU: delta of the accumulated CPU time (`ps -o time`) between two
 *   listings divided by the wall time (100 % = one core). A delta is only
 *   taken for the same PID with the same command name and a CPU time that did
 *   not decrease; otherwise (new process or PID reused) the process started
 *   after the previous listing and its whole CPU time counts.
 * - Attribution: own PID → daemon; process group or ancestor chain of a run's
 *   worker → that run (container runs add `<engine> stats`); other
 *   descendants of the daemon → hooks/checks; the rest → foreign, grouped by
 *   name (top N above `minCpuPercent`, others summed up). On Linux the host-
 *   visible processes of a run's container are skipped (counted via `stats`).
 * - Only command names are reported, never arguments.
 *
 * The first call only primes the deltas and returns `null`. Errors of a part
 * (e.g. `ps` missing) leave that part empty and are logged (throttled).
 */
import { errorMessage, noopLogger, systemClock, type Clock, type ContainerEngine, type Logger } from '../core/index.js';
import { parseEngineStats, parseInspectPids, parsePsOutput, type EngineStat, type PsProcess } from './parse.js';
import type { CpuTimes, SystemProbe } from './probe.js';
import type { AttributionTargets, DiskUsage, MetricsSample, MonitoredRun, MonitorSettings, ProcessGroup } from './types.js';

/** Label of the daemon's own process. */
export const DAEMON_LABEL = 'adispatchd';
/** Label of shell actions/conditions run by the daemon. */
export const HOOKS_LABEL = 'adispatchd (hooks/checks)';
/** Label of the foreign processes not shown individually. */
export const REST_LABEL = 'Others';
/** Default minimum time between two log entries of the same failing part. */
export const DEFAULT_ERROR_LOG_INTERVAL_MS = 10 * 60_000;
/** Process names of container runtimes whose descendants are container processes (Linux de-duplication). */
const CONTAINER_SHIM = /^(containerd-shim|conmon|crun|runc)/;
/** Max. depth when walking up the parent chain. */
const MAX_ANCESTRY = 128;

/** Options of {@link ResourceSampler}. */
export interface ResourceSamplerOptions {
  probe: SystemProbe;
  clock?: Clock;
  logger?: Logger;
  /** Min. time between two warnings about the same failing part (default 10 min). */
  errorLogIntervalMs?: number;
}

interface ProcessState {
  name: string;
  cpuSeconds: number;
}

type Owner = { kind: 'daemon' } | { kind: 'hooks' } | { kind: 'run'; run: MonitoredRun } | { kind: 'skip' } | { kind: 'other' };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Short label of a run: workflow, last 8 characters of the run ID, item key. */
export function runLabel(run: Pick<MonitoredRun, 'runId' | 'workflowId' | 'itemKey'>): string {
  const short = run.runId.length > 8 ? run.runId.slice(-8) : run.runId;
  return `${run.workflowId} · ${short}${run.itemKey ? ` · ${run.itemKey}` : ''}`;
}

/** See module docs. Not reentrant: callers serialize (see `ResourceMonitor`). */
export class ResourceSampler {
  private readonly probe: SystemProbe;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly errorLogIntervalMs: number;
  private readonly lastLogged = new Map<string, number>();
  private prevCpu: CpuTimes | undefined;
  private prevProcs: Map<number, ProcessState> | undefined;
  private prevProcsAt = 0;

  constructor(options: ResourceSamplerOptions) {
    this.probe = options.probe;
    this.clock = options.clock ?? systemClock;
    this.logger = (options.logger ?? noopLogger).child({ component: 'monitoring' });
    this.errorLogIntervalMs = options.errorLogIntervalMs ?? DEFAULT_ERROR_LOG_INTERVAL_MS;
  }

  /** Forget previous values (the next call primes again). */
  reset(): void {
    this.prevCpu = undefined;
    this.prevProcs = undefined;
  }

  /** Take one measurement; `null` on the first (priming) call. */
  async measure(targets: AttributionTargets, settings: Pick<MonitorSettings, 'topProcesses' | 'minCpuPercent' | 'diskPaths'>): Promise<MetricsSample | null> {
    const containerRuns = targets.runs.filter((r) => r.container);
    const byEngine = new Map<ContainerEngine, MonitoredRun[]>();
    for (const r of containerRuns) {
      const list = byEngine.get(r.container!.engine) ?? [];
      list.push(r);
      byEngine.set(r.container!.engine, list);
    }

    const psPromise = this.probe.processes().then(
      (listing) => ({ ok: true as const, listing, at: this.clock.now().getTime(), cpu: this.probe.cpuTimes() }),
      (err: unknown) => ({ ok: false as const, error: errorMessage(err), at: this.clock.now().getTime(), cpu: this.probe.cpuTimes() }),
    );
    const [ps, memory, disks, engineData] = await Promise.all([
      psPromise,
      this.probe.memory(),
      this.disks(settings.diskPaths),
      this.engineData(byEngine),
    ]);

    // --- system CPU
    const cpuNow = ps.cpu;
    const prevCpu = this.prevCpu;
    this.prevCpu = cpuNow;
    let totalPercent = 0;
    if (prevCpu) {
      const dTotal = cpuNow.totalMs - prevCpu.totalMs;
      const dBusy = cpuNow.busyMs - prevCpu.busyMs;
      totalPercent = dTotal > 0 ? Math.min(100, Math.max(0, (dBusy / dTotal) * 100)) : 0;
    }

    // --- processes
    let processes: ProcessGroup[] = [];
    if (ps.ok) {
      this.recovered('ps');
      const list = parsePsOutput(ps.listing.text).filter((p) => p.pid !== ps.listing.helperPid);
      const prev = this.prevProcs;
      const wallMs = ps.at - this.prevProcsAt;
      this.prevProcs = new Map(list.map((p) => [p.pid, { name: p.name, cpuSeconds: p.cpuSeconds }]));
      this.prevProcsAt = ps.at;
      if (prev && wallMs > 0) {
        processes = this.attribute(list, prev, wallMs, cpuNow.cores, targets, engineData, settings);
      }
    } else {
      this.warn('ps', 'process list unavailable', { error: ps.error });
      this.prevProcs = undefined;
    }

    if (!prevCpu) return null;
    return {
      at: new Date(ps.at).toISOString(),
      cpu: { totalPercent: round2(totalPercent), cores: cpuNow.cores, load: this.probe.loadAverage().map(round2) as [number, number, number] },
      memory,
      disks,
      processes,
    };
  }

  private async disks(paths: readonly string[]): Promise<DiskUsage[]> {
    const out: DiskUsage[] = [];
    const devices = new Set<number>();
    for (const p of paths) {
      try {
        const fs = await this.probe.fileSystem(p);
        this.recovered(`disk:${p}`);
        if (devices.has(fs.device)) continue;
        devices.add(fs.device);
        out.push({ path: p, freeBytes: fs.freeBytes, totalBytes: fs.totalBytes });
      } catch (err) {
        this.warn(`disk:${p}`, 'file system usage unavailable', { path: p, error: errorMessage(err) });
      }
    }
    return out;
  }

  /** `stats` per engine (+ `inspect` on Linux for de-duplication); failures → CLI process only. */
  private async engineData(byEngine: Map<ContainerEngine, MonitoredRun[]>): Promise<{ stats: Map<string, EngineStat>; containerPids: Map<string, number> }> {
    const stats = new Map<string, EngineStat>();
    const containerPids = new Map<string, number>();
    await Promise.all(
      [...byEngine].map(async ([engine, runs]) => {
        const names = runs.map((r) => r.container!.name);
        if (this.probe.engineStats) {
          try {
            for (const s of parseEngineStats(await this.probe.engineStats(engine, names))) stats.set(s.name, s);
            this.recovered(`stats:${engine}`);
          } catch (err) {
            this.warn(`stats:${engine}`, 'container stats unavailable (only the engine CLI process is counted)', { engine, error: errorMessage(err) });
          }
        }
        if (this.probe.platform === 'linux' && this.probe.engineInspect) {
          try {
            for (const [name, pid] of parseInspectPids(await this.probe.engineInspect(engine, names))) if (pid > 0) containerPids.set(name, pid);
          } catch {
            // without PIDs host-visible container processes may show up as foreign processes
          }
        }
      }),
    );
    return { stats, containerPids };
  }

  private attribute(
    list: readonly PsProcess[],
    prev: Map<number, ProcessState>,
    wallMs: number,
    cores: number,
    targets: AttributionTargets,
    engine: { stats: Map<string, EngineStat>; containerPids: Map<string, number> },
    settings: Pick<MonitorSettings, 'topProcesses' | 'minCpuPercent'>,
  ): ProcessGroup[] {
    const byPid = new Map(list.map((p) => [p.pid, p]));
    const runByPid = new Map<number, MonitoredRun>();
    const runByPgid = new Map<number, MonitoredRun>();
    // A run's group never equals the daemon's own group (workers are detached); guard anyway.
    const daemonPgid = byPid.get(targets.daemonPid)?.pgid;
    for (const r of targets.runs) {
      runByPid.set(r.pid, r);
      if (r.pgid > 1 && r.pgid !== daemonPgid) runByPgid.set(r.pgid, r);
    }

    // Linux: host-visible processes of our containers (descendants of the container's init below a runtime shim).
    const skip = new Set<number>();
    if (engine.containerPids.size > 0) {
      const children = new Map<number, number[]>();
      for (const p of list) {
        const c = children.get(p.ppid) ?? [];
        c.push(p.pid);
        children.set(p.ppid, c);
      }
      for (const pid of engine.containerPids.values()) {
        if (!byPid.has(pid) || !this.hasShimAncestor(pid, byPid)) continue;
        const stack = [pid];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          if (skip.has(cur)) continue;
          skip.add(cur);
          stack.push(...(children.get(cur) ?? []));
        }
      }
    }

    const ownerOf = (p: PsProcess): Owner => {
      if (p.pid === targets.daemonPid) return { kind: 'daemon' };
      const direct = runByPid.get(p.pid) ?? runByPgid.get(p.pgid);
      if (direct) return { kind: 'run', run: direct };
      if (skip.has(p.pid)) return { kind: 'skip' };
      const seen = new Set<number>([p.pid]);
      let cur = byPid.get(p.ppid);
      for (let depth = 0; cur && depth < MAX_ANCESTRY && !seen.has(cur.pid); depth++) {
        seen.add(cur.pid);
        const run = runByPid.get(cur.pid) ?? runByPgid.get(cur.pgid);
        if (run) return { kind: 'run', run };
        if (cur.pid === targets.daemonPid) return { kind: 'hooks' };
        cur = byPid.get(cur.ppid);
      }
      return { kind: 'other' };
    };

    const maxPercent = cores * 100;
    const cpuOf = (p: PsProcess): number => {
      const before = prev.get(p.pid);
      const delta = before && before.name === p.name && p.cpuSeconds >= before.cpuSeconds ? p.cpuSeconds - before.cpuSeconds : p.cpuSeconds;
      return Math.min(maxPercent, Math.max(0, ((delta * 1000) / wallMs) * 100));
    };

    const daemon: ProcessGroup = { kind: 'daemon', label: DAEMON_LABEL, cpuPercent: 0, rssBytes: 0, count: 0 };
    const hooks: ProcessGroup = { kind: 'hooks', label: HOOKS_LABEL, cpuPercent: 0, rssBytes: 0, count: 0 };
    const runs = new Map<string, ProcessGroup>();
    for (const r of targets.runs) {
      runs.set(r.runId, {
        kind: 'run',
        label: runLabel(r),
        runId: r.runId,
        workflowId: r.workflowId,
        ...(r.itemKey ? { itemKey: r.itemKey } : {}),
        cpuPercent: 0,
        rssBytes: 0,
        count: 0,
      });
    }
    const others = new Map<string, { cpu: number; rss: number; count: number }>();
    const add = (g: { cpuPercent: number; rssBytes: number; count: number }, cpu: number, rss: number): void => {
      g.cpuPercent += cpu;
      g.rssBytes += rss;
      g.count += 1;
    };

    for (const p of list) {
      const owner = ownerOf(p);
      if (owner.kind === 'skip') continue;
      const cpu = cpuOf(p);
      if (owner.kind === 'daemon') add(daemon, cpu, p.rssBytes);
      else if (owner.kind === 'hooks') add(hooks, cpu, p.rssBytes);
      else if (owner.kind === 'run') add(runs.get(owner.run.runId)!, cpu, p.rssBytes);
      else {
        const o = others.get(p.name) ?? { cpu: 0, rss: 0, count: 0 };
        o.cpu += cpu;
        o.rss += p.rssBytes;
        o.count += 1;
        others.set(p.name, o);
      }
    }
    for (const r of targets.runs) {
      const s = r.container ? engine.stats.get(r.container.name) : undefined;
      if (!s) continue;
      const g = runs.get(r.runId)!;
      g.cpuPercent += Math.min(maxPercent, s.cpuPercent);
      g.rssBytes += s.memBytes;
    }

    const groups: ProcessGroup[] = [daemon, ...runs.values()];
    if (hooks.count > 0) groups.push(hooks);
    const sorted = [...others].sort((a, b) => b[1].cpu - a[1].cpu || b[1].rss - a[1].rss || a[0].localeCompare(b[0]));
    const rest: ProcessGroup = { kind: 'rest', label: REST_LABEL, cpuPercent: 0, rssBytes: 0, count: 0 };
    let shown = 0;
    for (const [name, o] of sorted) {
      if (shown < settings.topProcesses && o.cpu >= settings.minCpuPercent) {
        groups.push({ kind: 'other', label: o.count > 1 ? `${name} ×${o.count}` : name, name, cpuPercent: o.cpu, rssBytes: o.rss, count: o.count });
        shown++;
      } else {
        rest.cpuPercent += o.cpu;
        rest.rssBytes += o.rss;
        rest.count += o.count;
      }
    }
    if (rest.count > 0) groups.push(rest);
    for (const g of groups) g.cpuPercent = round2(g.cpuPercent);
    return groups;
  }

  private hasShimAncestor(pid: number, byPid: Map<number, PsProcess>): boolean {
    let cur = byPid.get(byPid.get(pid)?.ppid ?? -1);
    for (let depth = 0; cur && depth < MAX_ANCESTRY; depth++) {
      if (CONTAINER_SHIM.test(cur.name)) return true;
      if (cur.ppid === cur.pid) break;
      cur = byPid.get(cur.ppid);
    }
    return false;
  }

  private warn(key: string, message: string, context: Record<string, unknown>): void {
    const now = this.clock.now().getTime();
    const last = this.lastLogged.get(key);
    if (last !== undefined && now - last < this.errorLogIntervalMs) return;
    this.lastLogged.set(key, now);
    this.logger.warn(`resource monitor: ${message}`, context);
  }

  private recovered(key: string): void {
    if (this.lastLogged.delete(key)) this.logger.info('resource monitor: measurement works again', { part: key });
  }
}
