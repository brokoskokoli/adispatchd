/**
 * Access to the operating system for the resource monitor (WI-23). The
 * sampler only talks to a {@link SystemProbe}, so tests inject fixed values.
 *
 * The default probe never uses a shell: `ps` and `vm_stat` run via
 * `execFile` with a timeout, a bounded output buffer and `LC_ALL=C` (decimal
 * point in `time`); container engines are called through the engine client
 * of the container executor.
 */
import { execFile } from 'node:child_process';
import { readFile, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import type { ContainerEngine } from '../core/index.js';
import { parseMeminfo, parseVmStat } from './parse.js';

/** Aggregated CPU times of all cores. */
export interface CpuTimes {
  /** Sum of non-idle time of all cores (ms). */
  busyMs: number;
  /** Sum of all time of all cores (ms). */
  totalMs: number;
  cores: number;
}

/** Raw process listing. */
export interface ProcessListing {
  /** Output of `ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,ucomm=`. */
  text: string;
  /** PID of the `ps` process itself (excluded from the results). */
  helperPid: number | null;
}

/** File system of a path. */
export interface FileSystemUsage {
  freeBytes: number;
  totalBytes: number;
  /** Device ID (`stat().dev`): paths on the same device are reported once. */
  device: number;
}

/** Operating-system access of the monitor. */
export interface SystemProbe {
  cpuTimes(): CpuTimes;
  loadAverage(): [number, number, number];
  /** Total/available memory (never rejects; falls back to `os.freemem()`). */
  memory(): Promise<{ totalBytes: number; availableBytes: number }>;
  /** File system usage of `path`; rejects if it cannot be read (e.g. missing). */
  fileSystem(path: string): Promise<FileSystemUsage>;
  /** Process list; rejects if `ps` cannot be run, times out or fails. */
  processes(): Promise<ProcessListing>;
  /** Raw `<engine> stats --no-stream --format '{{json .}}' <names…>`; rejects on failure. */
  engineStats?(engine: ContainerEngine, names: readonly string[]): Promise<string>;
  /** Raw `<engine> inspect --format '{{.Name}} {{.State.Pid}}' <names…>`; rejects on failure. */
  engineInspect?(engine: ContainerEngine, names: readonly string[]): Promise<string>;
  /** Platform (`linux`: host-visible container processes are de-duplicated). */
  readonly platform: NodeJS.Platform;
}

/** Runs an engine CLI command (structurally {@link import('../executors/index.js').ContainerEngineClient}). */
export interface EngineRunner {
  run(engine: ContainerEngine, args: readonly string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Options of {@link createSystemProbe}. */
export interface SystemProbeOptions {
  /** Timeout of `ps` / `vm_stat` (default 10 s). */
  commandTimeoutMs?: number;
  /** Timeout of `stats` / `inspect` (default 15 s; `stats --no-stream` itself samples ~2 s). */
  engineTimeoutMs?: number;
  /** Max. output of one command (default 8 MiB). */
  maxOutputBytes?: number;
  engines?: EngineRunner;
  /** Executable of `ps` (default `ps` via PATH). */
  psBinary?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Arguments of the process listing (portable between Linux procps and macOS). */
export const PS_ARGS: readonly string[] = ['-A', '-o', 'pid=,ppid=,pgid=,etime=,time=,rss=,ucomm='];

/** `execFile` with timeout and output cap; resolves stdout and the child PID. */
function run(
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; pid: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer, env: opts.env, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          reject(new Error(e.killed ? `${file} timed out after ${opts.timeoutMs} ms` : `${file} failed: ${e.message.split('\n')[0] ?? ''}`));
          return;
        }
        resolve({ stdout, pid: child.pid ?? null });
      },
    );
    child.stdin?.end();
  });
}

/** Default probe on the local machine. */
export function createSystemProbe(options: SystemProbeOptions = {}): SystemProbe {
  const commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  const engineTimeoutMs = options.engineTimeoutMs ?? 15_000;
  const maxBuffer = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const base = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = { PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };
  const platform = options.platform ?? process.platform;
  const engines = options.engines;
  return {
    platform,
    cpuTimes(): CpuTimes {
      const cpus = os.cpus();
      let busy = 0;
      let total = 0;
      for (const c of cpus) {
        const t = c.times;
        const all = t.user + t.nice + t.sys + t.idle + t.irq;
        total += all;
        busy += all - t.idle;
      }
      return { busyMs: busy, totalMs: total, cores: Math.max(1, cpus.length) };
    },
    loadAverage(): [number, number, number] {
      const [a = 0, b = 0, c = 0] = os.loadavg();
      return [a, b, c];
    },
    async memory() {
      const totalBytes = os.totalmem();
      try {
        if (platform === 'linux') {
          const parsed = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
          if (parsed) return parsed;
        } else if (platform === 'darwin') {
          const { stdout } = await run('vm_stat', [], { timeoutMs: commandTimeoutMs, maxBuffer, env });
          const available = parseVmStat(stdout);
          if (available !== null) return { totalBytes, availableBytes: Math.min(available, totalBytes) };
        }
      } catch {
        // fall back below
      }
      return { totalBytes, availableBytes: os.freemem() };
    },
    async fileSystem(p: string): Promise<FileSystemUsage> {
      const [fs, st] = await Promise.all([statfs(p), stat(p)]);
      return { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize, device: Number(st.dev) };
    },
    async processes(): Promise<ProcessListing> {
      const { stdout, pid } = await run(options.psBinary ?? 'ps', PS_ARGS, { timeoutMs: commandTimeoutMs, maxBuffer, env });
      return { text: stdout, helperPid: pid };
    },
    ...(engines
      ? {
          async engineStats(engine: ContainerEngine, names: readonly string[]): Promise<string> {
            const r = await engines.run(engine, ['stats', '--no-stream', '--format', '{{json .}}', ...names], engineTimeoutMs);
            if (r.code !== 0) throw new Error(`${engine} stats exited with ${r.code}: ${r.stderr.trim().split('\n')[0] ?? ''}`);
            return r.stdout;
          },
          async engineInspect(engine: ContainerEngine, names: readonly string[]): Promise<string> {
            const r = await engines.run(engine, ['inspect', '--format', '{{.Name}} {{.State.Pid}}', ...names], engineTimeoutMs);
            // Exit ≠ 0 also when one of several names is gone: the output for the others is still usable.
            if (r.code !== 0 && r.stdout.trim() === '') throw new Error(`${engine} inspect exited with ${r.code}: ${r.stderr.trim().split('\n')[0] ?? ''}`);
            return r.stdout;
          },
        }
      : {}),
  };
}
