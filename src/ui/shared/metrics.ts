/**
 * DOM-free chart data of the dashboard section "Server" (WI-23): stacking of
 * the CPU series, stable colors, legend, time ranges, SVG path geometry.
 *
 * CPU values of process groups come in "100 % = one core"; the chart shows
 * them as share of the total capacity (÷ cores). The remainder up to the
 * measured total utilisation is "System / unattributed".
 */

/** Process group of a sample (`GET /api/v1/system/metrics`). */
export interface MetricsProcess {
  kind: 'daemon' | 'run' | 'hooks' | 'other' | 'rest';
  label: string;
  name?: string;
  runId?: string;
  workflowId?: string;
  itemKey?: string;
  cpuPercent: number;
  rssBytes: number;
  count: number;
}

/** One sample. */
export interface MetricsSample {
  at: string;
  cpu: { totalPercent: number; cores: number; load: [number, number, number] };
  memory: { totalBytes: number; availableBytes: number };
  disks: Array<{ path: string; freeBytes: number; totalBytes: number }>;
  processes: MetricsProcess[];
}

/** Response of `GET /api/v1/system/metrics`. */
export interface MetricsResponse {
  enabled: boolean;
  intervalMs: number;
  retentionMs: number;
  /** Bucket size when the server downsampled the samples (averages), else `null`. */
  bucketMs?: number | null;
  samples: MetricsSample[];
}

/** Kind of a chart series (process kinds plus the unattributed remainder). */
export type SeriesKind = MetricsProcess['kind'] | 'system';

/** One stacked series. */
export interface CpuSeries {
  key: string;
  kind: SeriesKind;
  label: string;
  /** CSS class carrying the color (`m-…`). */
  cls: string;
  runId?: string;
  workflowId?: string;
  /** Share of the total capacity (0–100) per sample; 0 where the series is absent. */
  values: number[];
}

/** Stacked CPU chart data. */
export interface CpuChart {
  /** Sample times (epoch ms). */
  times: number[];
  /** Measured total utilisation per sample (0–100). */
  totals: number[];
  /** Bottom to top; the last one is the unattributed remainder. */
  series: CpuSeries[];
}

/** Number of colors for runs (fixed categorical order, assigned by workflow). */
export const RUN_COLORS = 8;
/** Number of muted hues for named foreign processes (assigned by rank in the visible set). */
export const OTHER_COLORS = 6;
/** Max. named foreign series in one chart (the rest is folded into "Others"). */
export const MAX_NAMED_OTHERS = 6;

/** Stable small hash (FNV-1a) of a string. */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Color class of a process group: runs by workflow (stable hash, saturated
 * categorical colors), named foreign processes by their rank in the visible
 * set (muted hues, no collisions), fixed classes for the rest.
 */
export function seriesClass(kind: SeriesKind, id = '', rank = 0): string {
  switch (kind) {
    case 'run':
      return `m-wf-${stableHash(id) % RUN_COLORS}`;
    case 'other':
      return `m-other-${rank % OTHER_COLORS}`;
    default:
      return `m-${kind}`;
  }
}

/** Series key of a process group. */
export function seriesKey(p: MetricsProcess): string {
  if (p.kind === 'run') return `run:${p.runId ?? p.label}`;
  if (p.kind === 'other') return `other:${p.name ?? p.label}`;
  return p.kind;
}

const KIND_ORDER: Record<SeriesKind, number> = { daemon: 0, run: 1, hooks: 2, other: 3, rest: 4, system: 5 };

/** Label of the unattributed remainder. */
export const SYSTEM_LABEL = 'System / unattributed';

/**
 * Build the stacked CPU series of `samples` (oldest first). Order bottom to
 * top: daemon, runs (by first appearance), hooks/checks, named foreign
 * processes (largest total first), "Others", then the remainder up to the
 * measured total. Labels are taken from the latest sample of a series.
 */
export function buildCpuChart(samples: readonly MetricsSample[]): CpuChart {
  const times = samples.map((s) => Date.parse(s.at));
  const totals = samples.map((s) => clamp(s.cpu.totalPercent));
  const byKey = new Map<string, CpuSeries & { first: number; sum: number }>();
  samples.forEach((s, i) => {
    const cores = Math.max(1, s.cpu.cores);
    for (const p of s.processes) {
      const key = seriesKey(p);
      let series = byKey.get(key);
      if (!series) {
        series = {
          key,
          kind: p.kind,
          label: p.label,
          cls: seriesClass(p.kind, p.kind === 'run' ? (p.workflowId ?? '') : (p.name ?? p.label)),
          ...(p.runId ? { runId: p.runId } : {}),
          ...(p.workflowId ? { workflowId: p.workflowId } : {}),
          values: new Array<number>(samples.length).fill(0),
          first: i,
          sum: 0,
        };
        byKey.set(key, series);
      }
      const v = clamp(p.cpuPercent / cores);
      series.values[i] = (series.values[i] ?? 0) + v;
      series.sum += v;
      series.label = p.label;
    }
  });
  const ordered = [...byKey.values()].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.kind === 'run' ? a.first - b.first : 0) ||
      (a.kind === 'other' ? b.sum - a.sum : 0) ||
      a.key.localeCompare(b.key),
  );
  // Each sample names its own top processes; over a long range the union could grow large.
  // Keep the largest named foreign series and fold the others into "Others".
  const named = ordered.filter((s) => s.kind === 'other');
  const folded = new Set(named.slice(MAX_NAMED_OTHERS).map((s) => s.key));
  if (folded.size > 0) {
    let restSeries = ordered.find((s) => s.kind === 'rest');
    if (!restSeries) {
      restSeries = { key: 'rest', kind: 'rest', label: 'Others', cls: 'm-rest', values: new Array<number>(samples.length).fill(0), first: 0, sum: 0 };
      ordered.push(restSeries);
    }
    for (const s of ordered) {
      if (!folded.has(s.key)) continue;
      s.values.forEach((v, i) => {
        restSeries!.values[i] = (restSeries!.values[i] ?? 0) + v;
      });
    }
  }
  const series: CpuSeries[] = ordered.filter((s) => !folded.has(s.key)).map(({ first: _f, sum: _s, ...rest }) => rest);
  // Foreign colors by rank (largest first) – distinct within the chart.
  series.filter((x) => x.kind === 'other').forEach((x, rank) => {
    x.cls = seriesClass('other', x.key, rank);
  });
  const system: CpuSeries = { key: 'system', kind: 'system', label: SYSTEM_LABEL, cls: 'm-system', values: [] };
  system.values = samples.map((s, i) => {
    // Only where processes were measured: an empty process list (ps failed) shows no breakdown.
    const attributed = series.reduce((n, x) => n + (x.values[i] ?? 0), 0);
    return s.processes.length === 0 ? (totals[i] ?? 0) : Math.max(0, (totals[i] ?? 0) - attributed);
  });
  series.push(system);
  return { times, totals, series };
}

/** Cumulative lower/upper bounds per series and sample (capped at 100). */
export function stackSeries(series: readonly CpuSeries[]): Array<{ lower: number[]; upper: number[] }> {
  const n = series[0]?.values.length ?? 0;
  const base = new Array<number>(n).fill(0);
  return series.map((s) => {
    const lower = [...base];
    const upper = s.values.map((v, i) => Math.min(100, (base[i] ?? 0) + v));
    for (let i = 0; i < n; i++) base[i] = upper[i] ?? 0;
    return { lower, upper };
  });
}

/** Legend entry of a CPU series. */
export interface LegendEntry {
  key: string;
  kind: SeriesKind;
  label: string;
  cls: string;
  runId?: string;
  /** Value of the latest sample (share of the total capacity). */
  current: number;
  /** Maximum within the shown range. */
  max: number;
  /** Foreign series that never reached 0.1 % (shown dimmed). */
  dim: boolean;
}

const LEGEND_ORDER: Record<SeriesKind, number> = { daemon: 0, run: 1, hooks: 2, other: 3, rest: 4, system: 5 };

/**
 * Legend: own groups first (daemon, runs, hooks), then foreign processes by
 * current value (descending), then "Others" and the unattributed remainder.
 * Foreign series with a maximum below 0.1 % are dimmed.
 */
export function legendEntries(chart: CpuChart): LegendEntry[] {
  const last = chart.times.length - 1;
  const entries = chart.series.map((s, index) => {
    const current = last >= 0 ? (s.values[last] ?? 0) : 0;
    const max = s.values.reduce((m, v) => Math.max(m, v), 0);
    return {
      entry: {
        key: s.key,
        kind: s.kind,
        label: s.label,
        cls: s.cls,
        ...(s.runId ? { runId: s.runId } : {}),
        current,
        max,
        dim: (s.kind === 'other' || s.kind === 'rest') && max < 0.1,
      },
      index,
    };
  });
  return entries
    .sort((a, b) => LEGEND_ORDER[a.entry.kind] - LEGEND_ORDER[b.entry.kind] || (a.entry.kind === 'other' ? b.entry.current - a.entry.current : 0) || a.index - b.index)
    .map((e) => e.entry);
}

/**
 * Time-axis ticks at round local clock boundaries (1, 2, 5, 10, 15, 30 min,
 * 1, 2, 3, 6, 12, 24 h): the smallest step giving at most `maxTicks` ticks in
 * `[from, to]`. `offsetMinutes` = local UTC offset (east positive).
 */
export function timeTicks(from: number, to: number, maxTicks: number, offsetMinutes = 0): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * 60_000);
  const span = Math.max(1, to - from);
  const step = steps.find((st) => span / st <= Math.max(1, maxTicks)) ?? steps[steps.length - 1]!;
  const offset = offsetMinutes * 60_000;
  const first = Math.ceil((from + offset) / step) * step - offset;
  const out: number[] = [];
  for (let t = first; t <= to && out.length < 1000; t += step) out.push(t);
  return out;
}

/**
 * SVG path of a stacked area: `x(i)`/`y(v)` map sample index and value to
 * pixels. Gaps (time between two samples > `gapMs`) split the area into
 * separate sub-paths. A single isolated sample is drawn `halfWidth` wide.
 */
export function areaPath(
  times: readonly number[],
  lower: readonly number[],
  upper: readonly number[],
  x: (t: number) => number,
  y: (v: number) => number,
  gapMs: number,
  halfWidth = 1.5,
): string {
  const segments: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i === times.length || (times[i] as number) - (times[i - 1] as number) > gapMs) {
      segments.push([start, i - 1]);
      start = i;
    }
  }
  const f = (n: number): string => (Math.round(n * 10) / 10).toString();
  const parts: string[] = [];
  for (const [a, b] of segments) {
    if (times.length === 0) break;
    const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    if (idx.every((i) => (upper[i] ?? 0) - (lower[i] ?? 0) <= 0)) continue;
    const pts = (i: number, v: number): [number, number] => [x(times[i] as number), y(v)];
    let top = idx.map((i) => pts(i, upper[i] ?? 0));
    let bottom = idx.map((i) => pts(i, lower[i] ?? 0)).reverse();
    if (idx.length === 1) {
      const [[tx, ty]] = top as [[number, number]];
      const [[, by]] = bottom as [[number, number]];
      top = [
        [tx - halfWidth, ty],
        [tx + halfWidth, ty],
      ];
      bottom = [
        [tx + halfWidth, by],
        [tx - halfWidth, by],
      ];
    }
    const all = [...top, ...bottom];
    parts.push(`M${all.map(([px, py]) => `${f(px)},${f(py)}`).join('L')}Z`);
  }
  return parts.join('');
}

/** SVG polyline points of one line (gaps split into separate strings). */
export function linePaths(times: readonly number[], values: readonly number[], x: (t: number) => number, y: (v: number) => number, gapMs: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const f = (n: number): string => (Math.round(n * 10) / 10).toString();
  times.forEach((t, i) => {
    if (i > 0 && t - (times[i - 1] as number) > gapMs && cur.length > 0) {
      out.push(cur.join(' '));
      cur = [];
    }
    cur.push(`${f(x(t))},${f(y(values[i] ?? 0))}`);
  });
  if (cur.length > 0) out.push(cur.join(' '));
  return out;
}

/** Index of the sample closest to `t` (`-1` if none). */
export function nearestIndex(times: readonly number[], t: number): number {
  let best = -1;
  let dist = Infinity;
  times.forEach((x, i) => {
    const d = Math.abs(x - t);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}

/** Selectable time ranges, limited by the retention (always at least the shortest). */
export function rangeOptions(retentionMs: number): Array<{ label: string; ms: number }> {
  const all = [
    { label: '15 min', ms: 15 * 60_000 },
    { label: '1 h', ms: 60 * 60_000 },
    { label: '6 h', ms: 6 * 60 * 60_000 },
    { label: '24 h', ms: 24 * 60 * 60_000 },
  ];
  const fitting = all.filter((o) => o.ms <= retentionMs);
  if (fitting.length === 0) return [{ label: formatSpan(retentionMs), ms: retentionMs }];
  if (retentionMs > fitting[fitting.length - 1]!.ms && retentionMs < 7 * 24 * 60 * 60_000 && !all.some((o) => o.ms === retentionMs)) {
    fitting.push({ label: formatSpan(retentionMs), ms: retentionMs });
  }
  return fitting;
}

/** Minimum visible span of the time axis (a single sample still gets some width). */
export const MIN_DOMAIN_MS = 60_000;

/**
 * Time-axis domain: `[max(end − range, first sample), end]`, so the available
 * data fills the width when there is less data than the selected range. At
 * least {@link MIN_DOMAIN_MS} wide (never wider than the range). `partial`
 * and `label` describe the visible span, e.g. "last 4 min of 1 h".
 */
export function chartDomain(
  samples: readonly { at: string }[],
  endMs: number,
  rangeMs: number,
): { from: number; to: number; partial: boolean; label: string } {
  const rangeStart = endMs - rangeMs;
  const first = samples.length > 0 ? Date.parse(samples[0]!.at) : endMs;
  let from = Math.max(rangeStart, first);
  if (endMs - from < MIN_DOMAIN_MS) from = Math.max(rangeStart, endMs - MIN_DOMAIN_MS);
  const partial = from > rangeStart;
  const rangeLabel = formatSpan(rangeMs);
  return { from, to: endMs, partial, label: partial ? `last ${formatVisibleSpan(endMs - from)} of ${rangeLabel}` : `last ${rangeLabel}` };
}

/** Rounded span for labels: `45 s`, `4 min`, `1 h 20 min`. */
export function formatVisibleSpan(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

function formatSpan(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** Samples within `[endMs - rangeMs, endMs]`. */
export function samplesInRange<T extends { at: string }>(samples: readonly T[], endMs: number, rangeMs: number): T[] {
  const from = endMs - rangeMs;
  return samples.filter((s) => {
    const t = Date.parse(s.at);
    return t >= from && t <= endMs;
  });
}

/** Append a live sample (ignoring duplicates/out-of-order ones) and drop samples older than `retentionMs`. */
export function appendSample<T extends { at: string }>(samples: readonly T[], sample: T, retentionMs: number): T[] {
  const t = Date.parse(sample.at);
  const last = samples[samples.length - 1];
  if (last && Date.parse(last.at) >= t) return [...samples];
  return [...samples, sample].filter((s) => Date.parse(s.at) >= t - retentionMs);
}

/** Percent with one decimal (`12.3 %`), `<0.1 %` for small non-zero values. */
export function formatPercent(v: number): string {
  if (v > 0 && v < 0.1) return '<0.1 %';
  return `${(Math.round(v * 10) / 10).toFixed(1)} %`;
}

/** Nice upper bound for an axis (1, 2, 2.5, 5 × 10^n). */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * base) return m * base;
  return 10 * base;
}

function clamp(v: number): number {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
}
