/**
 * Parsers of the resource monitor (WI-23): `ps` output (Linux procps and
 * macOS/BSD formats), `/proc/meminfo`, `vm_stat` and the container engine's
 * `stats` / `inspect` output. All pure, never throwing.
 */

/** One process of a `ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,ucomm=` listing. */
export interface PsProcess {
  pid: number;
  ppid: number;
  pgid: number;
  /** Elapsed time since the process started, in seconds (1-s resolution). */
  elapsedSeconds: number;
  /** Accumulated CPU time in seconds. */
  cpuSeconds: number;
  rssBytes: number;
  /** Command name only (accounting name, shortened) – never arguments. */
  name: string;
}

/** Max. length of a process name in results. */
export const MAX_PROCESS_NAME_LENGTH = 48;

/**
 * Parse a `ps` duration: CPU time (`time`: macOS `MM:SS.cc` – minutes may
 * exceed 59 – or `H:MM:SS.cc`, Linux `HH:MM:SS` or `D-HH:MM:SS`) and elapsed
 * time (`etime`: `[[DD-]HH:]MM:SS`). Returns seconds or `null` if malformed.
 */
export function parseCpuTime(value: string): number | null {
  const m = /^(?:(\d+)-)?(\d+(?::\d+){0,2})(?:[.,](\d+))?$/.exec(value.trim());
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const parts = (m[2] as string).split(':').map(Number);
  if (parts.length === 1 && !m[3] && !m[1]) return null; // a bare number is not a time
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  const fraction = m[3] ? Number(`0.${m[3]}`) : 0;
  const total = days * 86_400 + seconds + fraction;
  return Number.isFinite(total) ? total : null;
}

/**
 * Display name of a process from `ucomm` (the kernel's accounting name, not
 * the rewritable `argv[0]`). Defence in depth against names that still carry
 * arguments: an absolute path is reduced to its basename, any other value is
 * cut at the first whitespace. Control characters are removed; the result is
 * shortened. Residual on Linux: a process can set its task name itself
 * (`prctl(PR_SET_NAME)`, max. 15 bytes) – that text is shown up to the first blank.
 */
export function processName(comm: string): string {
  // eslint-disable-next-line no-control-regex
  let name = comm.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (name.startsWith('/')) {
    // An executable path: its basename (paths may contain spaces, arguments never come after a path in ucomm).
    name = name.slice(name.lastIndexOf('/') + 1).split(/\s/)[0] ?? '';
  } else {
    name = name.split(/\s/)[0] ?? '';
  }
  if (name === '') return '?';
  return name.length > MAX_PROCESS_NAME_LENGTH ? `${name.slice(0, MAX_PROCESS_NAME_LENGTH - 1)}…` : name;
}

/**
 * Parse `ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,ucomm=` (no header).
 * The name is the last column. Malformed lines are skipped. `rss` is in KiB on
 * Linux and macOS.
 */
export function parsePsOutput(text: string): PsProcess[] {
  const out: PsProcess[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const elapsedSeconds = parseCpuTime(m[4] as string);
    const cpuSeconds = parseCpuTime(m[5] as string);
    if (cpuSeconds === null || elapsedSeconds === null) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      elapsedSeconds,
      cpuSeconds,
      rssBytes: Number(m[6]) * 1024,
      name: processName(m[7] as string),
    });
  }
  return out;
}

/** Total and available memory from Linux `/proc/meminfo` (`MemAvailable`); `null` if missing. */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const value = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = value('MemTotal');
  const available = value('MemAvailable');
  if (total === null || available === null) return null;
  return { totalBytes: total, availableBytes: Math.min(available, total) };
}

/**
 * Available memory from macOS `vm_stat`: (free + inactive + speculative)
 * pages × page size (from the header line). `null` if the output is not recognised.
 */
export function parseVmStat(text: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(text);
  if (!pageSize) return null;
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const free = pages('Pages free');
  const inactive = pages('Pages inactive');
  if (free === null || inactive === null) return null;
  const speculative = pages('Pages speculative') ?? 0;
  return (free + inactive + speculative) * Number(pageSize[1]);
}

/** Byte size like `12.5MiB`, `1.2GB`, `512kB`, `0B` (docker/podman stats); `null` if malformed. */
export function parseEngineSize(value: string): number | null {
  const m = /^\s*([\d.]+)\s*([kKmMgGtT]?)(i?)[bB]?\s*$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const base = m[3] ? 1024 : 1000;
  const exp = { '': 0, k: 1, m: 2, g: 3, t: 4 }[unit] ?? 0;
  return Math.round(n * base ** exp);
}

/** Usage of one container from `<engine> stats --no-stream --format '{{json .}}'`. */
export interface EngineStat {
  name: string;
  /** 100 = one core (as reported by docker/podman). */
  cpuPercent: number;
  memBytes: number;
}

/**
 * Parse `stats --no-stream --format '{{json .}}'` of docker (one JSON object
 * per line, `Name`, `CPUPerc: "12.34%"`, `MemUsage: "100MiB / 2GiB"`) or podman
 * (same keys; older versions print a JSON array). Unknown lines are skipped.
 */
export function parseEngineStats(text: string): EngineStat[] {
  const out: EngineStat[] = [];
  const handle = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const x of o) handle(x);
      return;
    }
    if (typeof o !== 'object' || o === null) return;
    const r = o as Record<string, unknown>;
    const name = typeof r.Name === 'string' ? r.Name : typeof r.name === 'string' ? r.name : null;
    if (!name) return;
    const cpuRaw = r.CPUPerc ?? r.CPU ?? r.cpu_percent;
    const cpu = typeof cpuRaw === 'number' ? cpuRaw : typeof cpuRaw === 'string' ? Number.parseFloat(cpuRaw.replace('%', '')) : NaN;
    const memRaw = r.MemUsage ?? r.mem_usage;
    const mem = typeof memRaw === 'number' ? memRaw : typeof memRaw === 'string' ? parseEngineSize(memRaw.split('/')[0] ?? '') : null;
    out.push({ name: name.replace(/^\//, ''), cpuPercent: Number.isFinite(cpu) ? Math.max(0, cpu) : 0, memBytes: mem ?? 0 });
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      handle(JSON.parse(trimmed));
      return out;
    } catch {
      // fall through: line by line
    }
  }
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{') && !l.startsWith('[')) continue;
    try {
      handle(JSON.parse(l));
    } catch {
      // skip
    }
  }
  return out;
}

/** Parse `inspect --format '{{.Name}} {{.State.Pid}}'` lines → container name → host PID (0 = not running). */
export function parseInspectPids(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^\s*\/?(\S+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(m[1] as string, Number(m[2]));
  }
  return out;
}
