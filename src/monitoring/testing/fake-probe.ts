/**
 * Scriptable {@link SystemProbe} for tests (WI-23): every value is a plain
 * field the test changes between measurements; calls are counted.
 */
import type { ContainerEngine } from '../../core/index.js';
import type { PsProcess } from '../parse.js';
import type { CpuTimes, FileSystemUsage, ProcessListing, SystemProbe } from '../probe.js';

/** One process line of the fake `ps`. */
export interface FakeProcess {
  pid: number;
  ppid: number;
  pgid?: number;
  /** CPU time in seconds (rendered as Linux `HH:MM:SS` or macOS `MM:SS.cc`). */
  cpu: number;
  rssKiB?: number;
  comm: string;
  /** Start time (epoch ms) for `etime`; default: long before (an old process). */
  startedAt?: number;
}

/** Default start of fake processes (long before the tests run). */
const LONG_AGO = Date.parse('2026-09-01T00:00:00Z');

/** `etime` format `[[DD-]HH:]MM:SS`. */
function etime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number): string => String(n).padStart(2, '0');
  const ms = `${p(m)}:${p(s % 60)}`;
  return d > 0 ? `${d}-${p(h)}:${ms}` : h > 0 ? `${p(h)}:${ms}` : ms;
}

/** Render a fake process list in the `ps` format of `platform` (`nowMs` for `etime`). */
export function renderPs(processes: readonly FakeProcess[], platform: 'linux' | 'darwin' = 'linux', nowMs = Date.parse('2026-10-19T10:00:00Z')): string {
  const time = (sec: number): string => {
    if (platform === 'darwin') {
      const m = Math.floor(sec / 60);
      const s = sec - m * 60;
      return `${m}:${s.toFixed(2).padStart(5, '0')}`;
    }
    const whole = Math.floor(sec);
    const d = Math.floor(whole / 86_400);
    const h = Math.floor((whole % 86_400) / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return d > 0 ? `${d}-${hms}` : hms;
  };
  return processes
    .map(
      (p) =>
        `${String(p.pid).padStart(6)} ${String(p.ppid).padStart(6)} ${String(p.pgid ?? p.pid).padStart(6)} ${etime((nowMs - (p.startedAt ?? LONG_AGO)) / 1000).padStart(11)} ${time(p.cpu).padStart(11)} ${String(p.rssKiB ?? 1000).padStart(8)} ${p.comm}`,
    )
    .join('\n');
}

/** See module docs. */
export class FakeProbe implements SystemProbe {
  /** Current time for `etime` (tests pass their FakeClock). */
  constructor(private readonly now: () => number = () => Date.parse('2026-10-19T10:00:00Z')) {}

  platform: NodeJS.Platform = 'linux';
  cpu: CpuTimes = { busyMs: 0, totalMs: 0, cores: 4 };
  load: [number, number, number] = [0.5, 0.4, 0.3];
  mem = { totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 };
  fs = new Map<string, FileSystemUsage>();
  processList: FakeProcess[] = [];
  psFormat: 'linux' | 'darwin' = 'linux';
  /** Raw `ps` output overriding {@link processList}. */
  psText: string | null = null;
  /** Processes as read from Linux `/proc` (precise; overrides `ps` output). */
  procProcesses: PsProcess[] | null = null;
  psError: Error | null = null;
  helperPid: number | null = null;
  /** Resolve `processes()` only when this promise resolves (overlap tests). */
  psGate: Promise<void> | null = null;
  stats = new Map<ContainerEngine, string>();
  statsError: Error | null = null;
  inspect = new Map<ContainerEngine, string>();
  calls = { processes: 0, memory: 0, fileSystem: 0, engineStats: 0, engineInspect: 0 };
  /** Currently running `processes()` calls (max. seen in {@link maxConcurrentPs}). */
  private concurrentPs = 0;
  maxConcurrentPs = 0;

  /** Advance the system CPU counters: `busyFraction` of `ms` × cores was busy. */
  advanceCpu(ms: number, busyFraction: number): void {
    const total = ms * this.cpu.cores;
    this.cpu = { ...this.cpu, totalMs: this.cpu.totalMs + total, busyMs: this.cpu.busyMs + total * busyFraction };
  }

  cpuTimes(): CpuTimes {
    return { ...this.cpu };
  }

  loadAverage(): [number, number, number] {
    return [...this.load];
  }

  async memory(): Promise<{ totalBytes: number; availableBytes: number }> {
    this.calls.memory++;
    return { ...this.mem };
  }

  async fileSystem(p: string): Promise<FileSystemUsage> {
    this.calls.fileSystem++;
    const fs = this.fs.get(p);
    if (!fs) throw new Error(`ENOENT: no such file or directory, statfs '${p}'`);
    return fs;
  }

  async processes(): Promise<ProcessListing> {
    this.calls.processes++;
    this.concurrentPs++;
    this.maxConcurrentPs = Math.max(this.maxConcurrentPs, this.concurrentPs);
    try {
      if (this.psGate) await this.psGate;
      if (this.psError) throw this.psError;
      if (this.procProcesses) return { processes: this.procProcesses.map((p) => ({ ...p })), helperPid: null };
      return { text: this.psText ?? renderPs(this.processList, this.psFormat, this.now()), helperPid: this.helperPid };
    } finally {
      this.concurrentPs--;
    }
  }

  async engineStats(engine: ContainerEngine): Promise<string> {
    this.calls.engineStats++;
    if (this.statsError) throw this.statsError;
    const out = this.stats.get(engine);
    if (out === undefined) throw new Error(`${engine}: command not found`);
    return out;
  }

  async engineInspect(engine: ContainerEngine): Promise<string> {
    this.calls.engineInspect++;
    const out = this.inspect.get(engine);
    if (out === undefined) throw new Error(`${engine}: command not found`);
    return out;
  }
}
