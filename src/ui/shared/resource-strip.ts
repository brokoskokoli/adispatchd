/**
 * Compact resource strip at the top of the dashboard (WI-29), DOM-free so it
 * is unit-testable: summary of the latest sample (CPU total with a sparkline
 * of the last minutes, memory, the fullest disk, load, top process groups),
 * the rendering with the safe builders and a small live feed (one REST load
 * with few points, then SSE `system.metrics`). Clicking the strip opens the
 * "Resources" tab with the full charts. Process names only ever become text.
 */
import type { Child, ElementLike, HFn } from './dom.js';
import { formatBytes } from './format.js';
import { appendSample, formatPercent, seriesClass, type MetricsProcess, type MetricsResponse, type MetricsSample } from './metrics.js';
import { buildHash } from './route.js';
import type { LiveMessage } from './sse.js';

/** Route segment of the "Resources" tab: `#/resources`. */
export const RESOURCES_ROUTE = 'resources';
/** Hash of the "Resources" tab. */
export const RESOURCES_HASH = buildHash([RESOURCES_ROUTE]);
/** Span of the sparkline. */
export const SPARK_RANGE_MS = 15 * 60_000;
/** Points requested for the sparkline (server-side downsampling; small payload). */
export const SPARK_POINTS = 60;
/** Max. entries of the "Top" line. */
export const MAX_TOP = 4;
/** Entries below this share of the total capacity are left out of the "Top" line. */
export const MIN_TOP_PERCENT = 0.1;
/** Sparkline geometry (viewBox units; CSS scales it). */
export const SPARK_WIDTH = 120;
export const SPARK_HEIGHT = 28;

/** REST path of the initial load. */
export function stripMetricsPath(): string {
  return `/api/v1/system/metrics?range=${SPARK_RANGE_MS}ms&points=${SPARK_POINTS}`;
}

/** One entry of the "Top" line. */
export interface TopEntry {
  label: string;
  kind: MetricsProcess['kind'];
  /** Share of the total capacity (0–100), same scale as the CPU total. */
  percent: number;
  cls: string;
  own: boolean;
}

/** Everything the strip shows. */
export interface StripSummary {
  at: string;
  cpu: { percent: number; cores: number };
  /** CPU totals (0–100) of the sparkline window, oldest first. */
  spark: number[];
  memory: { usedBytes: number; totalBytes: number; fraction: number };
  /** The fullest monitored path (highest used fraction), `null` without disk data. */
  disk: { path: string; freeBytes: number; totalBytes: number; fraction: number } | null;
  load: [number, number, number];
  top: TopEntry[];
}

const OWN = new Set<MetricsProcess['kind']>(['daemon', 'run', 'hooks']);
const OWN_ORDER: Record<string, number> = { daemon: 0, run: 1, hooks: 2 };

/**
 * "Top" line of a sample: own process groups (daemon, runs, hooks) first,
 * then foreign processes, each by CPU descending; "Others" and entries below
 * {@link MIN_TOP_PERCENT} are left out; at most `max` entries.
 */
export function topEntries(sample: MetricsSample, max = MAX_TOP): TopEntry[] {
  const cores = Math.max(1, sample.cpu.cores);
  const entries = sample.processes
    .filter((p) => p.kind !== 'rest')
    .map((p) => ({ p, percent: Math.min(100, Math.max(0, p.cpuPercent / cores)) }))
    .filter((e) => e.percent >= MIN_TOP_PERCENT);
  const own = entries.filter((e) => OWN.has(e.p.kind)).sort((a, b) => b.percent - a.percent || OWN_ORDER[a.p.kind]! - OWN_ORDER[b.p.kind]!);
  const foreign = entries.filter((e) => !OWN.has(e.p.kind)).sort((a, b) => b.percent - a.percent);
  // Foreign colors by rank among the foreign entries (as in the chart: largest first).
  const rankOf = new Map(foreign.map((e, i) => [e, i]));
  return [...own, ...foreign].slice(0, Math.max(0, max)).map((e) => ({
    label: e.p.label,
    kind: e.p.kind,
    percent: e.percent,
    cls: seriesClass(e.p.kind, e.p.kind === 'run' ? (e.p.workflowId ?? '') : (e.p.name ?? e.p.label), rankOf.get(e) ?? 0),
    own: OWN.has(e.p.kind),
  }));
}

/**
 * Summary of the latest sample plus the sparkline window ending at it; `null`
 * without samples. `current` (a live sample newer than the last sparkline
 * point, not yet at the sparkline spacing) provides the current values and
 * the last sparkline point.
 */
export function stripSummary(samples: readonly MetricsSample[], rangeMs = SPARK_RANGE_MS, current: MetricsSample | null = null): StripSummary | null {
  const last = samples[samples.length - 1];
  const newer = current && (!last || Date.parse(current.at) > Date.parse(last.at)) ? current : null;
  const latest = newer ?? last;
  if (!latest) return null;
  const end = Date.parse(latest.at);
  const window = newer ? [...samples, newer] : samples;
  const spark = window.filter((s) => Date.parse(s.at) >= end - rangeMs).map((s) => clampPercent(s.cpu.totalPercent));
  const total = Math.max(0, latest.memory.totalBytes);
  const used = Math.max(0, total - latest.memory.availableBytes);
  let disk: StripSummary['disk'] = null;
  for (const d of latest.disks) {
    const fraction = d.totalBytes > 0 ? Math.min(1, Math.max(0, 1 - d.freeBytes / d.totalBytes)) : 0;
    if (!disk || fraction > disk.fraction) disk = { path: d.path, freeBytes: d.freeBytes, totalBytes: d.totalBytes, fraction };
  }
  return {
    at: latest.at,
    cpu: { percent: clampPercent(latest.cpu.totalPercent), cores: latest.cpu.cores },
    spark,
    memory: { usedBytes: used, totalBytes: total, fraction: total > 0 ? Math.min(1, used / total) : 0 },
    disk,
    load: latest.cpu.load,
    top: topEntries(latest),
  };
}

/**
 * Sparkline geometry (0–100 % on the y axis, evenly spaced points): the line
 * and the closed area below it. A single value becomes a flat line over the
 * full width; no values → empty strings.
 */
export function sparklinePaths(values: readonly number[], width = SPARK_WIDTH, height = SPARK_HEIGHT): { line: string; area: string } {
  if (values.length === 0) return { line: '', area: '' };
  const f = (n: number): string => (Math.round(n * 10) / 10).toString();
  const vs = values.length === 1 ? [values[0]!, values[0]!] : values;
  const step = width / (vs.length - 1);
  const pad = 1; // keep a 1-unit margin so the stroke is not clipped at 0 % / 100 %
  const pts = vs.map((v, i) => `${f(i * step)},${f(pad + (1 - clampPercent(v) / 100) * (height - 2 * pad))}`);
  return { line: pts.join(' '), area: `M0,${f(height)}L${pts.join('L')}L${f(width)},${f(height)}Z` };
}

/** State of the strip. */
export type StripState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'disabled' }
  | { kind: 'empty'; intervalMs: number }
  | { kind: 'ok'; summary: StripSummary };

/** State from the current data of the feed. */
export function stripState(data: MetricsResponse | null, error: unknown, current: MetricsSample | null = null): StripState {
  if (error) return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  if (!data) return { kind: 'loading' };
  if (!data.enabled) return { kind: 'disabled' };
  const summary = stripSummary(data.samples, SPARK_RANGE_MS, current);
  return summary ? { kind: 'ok', summary } : { kind: 'empty', intervalMs: data.intervalMs };
}

function meterEl<E extends ElementLike>(h: HFn<E>, fraction: number, label: string): E {
  return h('meter', { class: 'strip-meter', min: 0, max: 1, low: 0.8, high: 0.9, optimum: 0, value: fraction.toFixed(3), 'aria-label': label });
}

/**
 * Render the strip. `ok`: one link to the "Resources" tab containing the
 * metric cells and at most one "Top" line; other states: one short line.
 */
export function renderResourceStrip<E extends ElementLike, S extends ElementLike>(h: HFn<E>, svg: HFn<S>, state: StripState): E {
  const box = (cls: string, ...children: Child[]): E =>
    h('section', { class: `card resource-strip ${cls}`, 'aria-label': 'Server resources' }, ...children);
  const detailsLink = (): E => h('a', { class: 'strip-more', href: RESOURCES_HASH }, 'Resources →');
  switch (state.kind) {
    case 'loading':
      return box('strip-note', h('span', { class: 'muted' }, 'Server resources: loading…'));
    case 'error':
      return box('strip-note', h('span', { class: 'error-text' }, `Server resources unavailable: ${state.message}`), ' ', detailsLink());
    case 'disabled':
      return box(
        'strip-note',
        h('span', { class: 'muted' }, 'Resource monitoring is disabled (', h('code', null, 'monitoring.enabled: false'), ').'),
      );
    case 'empty':
      return box(
        'strip-note',
        h('span', { class: 'muted' }, `Server resources: collecting the first measurement (every ${Math.round(state.intervalMs / 1000)} s)…`),
      );
    case 'ok':
      break;
  }
  const s = state.summary;
  const spark = sparklinePaths(s.spark);
  const cpuLabel = `CPU ${formatPercent(s.cpu.percent)} of ${s.cpu.cores} cores`;
  const cell = (label: string, value: Child, extra: Child, title?: string): E =>
    h('div', { class: 'strip-cell', title: title ?? null }, h('span', { class: 'strip-label' }, label), h('span', { class: 'strip-value' }, value), extra);
  const memLabel = `${formatBytes(s.memory.usedBytes)} / ${formatBytes(s.memory.totalBytes)}`;
  const cells = [
    cell(
      'CPU',
      formatPercent(s.cpu.percent),
      svg(
        'svg',
        { class: 'sparkline', viewBox: `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `CPU total, last 15 min (${s.spark.length} points)` },
        svg('title', null, `CPU total, last 15 min`),
        spark.area ? svg('path', { class: 'spark-area', d: spark.area }) : null,
        spark.line ? svg('polyline', { class: 'spark-line', points: spark.line }) : null,
      ),
      `${cpuLabel}; sparkline: last 15 min`,
    ),
    cell('Memory', memLabel, meterEl(h, s.memory.fraction, `Memory used ${formatPercent(s.memory.fraction * 100)}`)),
    s.disk
      ? cell(
          'Disk',
          `${formatPercent(s.disk.fraction * 100)} used`,
          meterEl(h, s.disk.fraction, `${s.disk.path}: ${formatPercent(s.disk.fraction * 100)} used`),
          `${s.disk.path}: ${formatBytes(s.disk.freeBytes)} free of ${formatBytes(s.disk.totalBytes)}`,
        )
      : null,
    cell('Load', s.load.map((l) => l.toFixed(2)).join(' / '), null, 'Load average 1 / 5 / 15 min'),
  ];
  const top =
    s.top.length > 0
      ? h(
          'div',
          { class: 'strip-top' },
          h('span', { class: 'strip-label' }, 'Top'),
          ' ',
          s.top.map((t, i) => [
            i > 0 ? h('span', { class: 'muted' }, ' · ') : null,
            h('span', { class: `strip-proc${t.own ? ' own' : ''}` }, h('span', { class: `swatch ${t.cls}`, 'aria-hidden': 'true' }), ' ', t.label, ' ', h('b', null, formatPercent(t.percent))),
          ]),
        )
      : null;
  return box(
    'strip-ok',
    h(
      'a',
      {
        class: 'strip-link',
        href: RESOURCES_HASH,
        title: 'Open the Resources tab (charts, time range, process table)',
        'aria-label': stripAriaLabel(s),
      },
      h('div', { class: 'strip-cells' }, cells, h('span', { class: 'strip-more' }, 'Resources →')),
      top,
    ),
  );
}

/** Accessible name of the strip link: a one-line summary plus where it leads. */
export function stripAriaLabel(s: StripSummary): string {
  const parts = [
    `CPU ${formatPercent(s.cpu.percent)}`,
    `memory ${formatBytes(s.memory.usedBytes)} of ${formatBytes(s.memory.totalBytes)}`,
    ...(s.disk ? [`disk ${s.disk.path} ${formatPercent(s.disk.fraction * 100)} used`] : []),
    `load ${s.load.map((l) => l.toFixed(2)).join(' / ')}`,
  ];
  return `Server resources: ${parts.join(', ')}. Open the Resources tab`;
}

/** First retry delay after a failed load (doubles per failure, see {@link MAX_RETRY_MS}). */
export const RETRY_BASE_MS = 5_000;
/** Upper bound of the retry delay. */
export const MAX_RETRY_MS = 60_000;

/** Dependencies of {@link createStripFeed} (injected for tests). */
export interface StripFeedDeps {
  fetch(path: string): Promise<MetricsResponse>;
  /** Called after every state change (not after `dispose()`). */
  onChange(state: StripState): void;
  /** Clock for the retry backoff (default `Date.now`). */
  now?: () => number;
}

/** Live data of the strip. */
export interface StripFeed {
  load(): Promise<void>;
  onLive(msg: LiveMessage): void;
  onResync(): void;
  /** Ends the subscription: later live messages and pending loads are ignored. */
  dispose(): void;
  readonly state: StripState;
  readonly disposed: boolean;
}

/**
 * One REST load with {@link SPARK_POINTS} points over {@link SPARK_RANGE_MS},
 * then live samples from SSE `system.metrics` (kept for the sparkline window
 * only). `config.reloaded` and resyncs reload (monitoring may have been
 * switched on/off). Out-of-date loads (a newer one started) are dropped.
 *
 * - Live samples update the current values at once but join the sparkline
 *   only at the spacing of the loaded points (`bucketMs`, else the interval),
 *   so the evenly spaced line keeps its time scale.
 * - After a failed load, a `system.metrics` message (the server is reachable
 *   again) triggers a new load, with a backoff of 5 s doubling up to 60 s.
 */
export function createStripFeed(deps: StripFeedDeps): StripFeed {
  const now = deps.now ?? (() => Date.now());
  let data: MetricsResponse | null = null;
  let current: MetricsSample | null = null;
  let error: unknown = null;
  let disposed = false;
  let gen = 0;
  let inFlight = 0;
  let failures = 0;
  let retryAt = 0;
  let state: StripState = { kind: 'loading' };
  const emit = (): void => {
    state = stripState(data, error, current);
    if (!disposed) deps.onChange(state);
  };
  const load = async (): Promise<void> => {
    if (disposed) return;
    const mine = ++gen;
    inFlight++;
    try {
      const res = await deps.fetch(stripMetricsPath());
      if (disposed || mine !== gen) return;
      data = res;
      current = null;
      error = null;
      failures = 0;
    } catch (err) {
      if (disposed || mine !== gen) return;
      error = err;
      failures++;
      retryAt = now() + Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** (failures - 1));
    } finally {
      inFlight--;
    }
    emit();
  };
  return {
    load,
    onLive: (msg) => {
      if (disposed) return;
      if (msg.type === 'config.reloaded') {
        void load();
        return;
      }
      if (msg.type !== 'system.metrics') return;
      if (error) {
        if (inFlight === 0 && now() >= retryAt) void load();
        return;
      }
      if (!data?.enabled) return;
      const sample = msg.payload as unknown as MetricsSample;
      const t = Date.parse(sample.at);
      const last = data.samples[data.samples.length - 1];
      const spacing = data.bucketMs ?? data.intervalMs;
      if (!last || t - Date.parse(last.at) >= spacing) {
        data = { ...data, samples: appendSample(data.samples, sample, SPARK_RANGE_MS) };
        current = null;
      } else if (t > Date.parse(last.at) && (!current || t > Date.parse(current.at))) {
        current = sample;
      } else return;
      emit();
    },
    onResync: () => void load(),
    dispose: () => {
      disposed = true;
    },
    get state() {
      return state;
    },
    get disposed() {
      return disposed;
    },
  };
}

function clampPercent(v: number): number {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
}
