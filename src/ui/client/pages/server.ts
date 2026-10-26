/**
 * Tab "Resources" (`#/resources`, WI-29; until 0.4.0 the section "Server" at
 * the bottom of the dashboard, WI-23): stacked CPU chart by daemon / runs /
 * hooks / foreign processes, memory and disk charts on the same time axis,
 * current values as text and table. Own SVG rendering (no libraries); names
 * are text nodes only.
 *
 * Data: `GET /api/v1/system/metrics?range=…&points=…` (server-side
 * downsampling to about one point per pixel), then live via SSE
 * `system.metrics`. The chart width follows the section width
 * (ResizeObserver); hover position and the open state of the value table
 * survive re-renders.
 */
import { api, qs } from '../api.js';
import { h, replaceChildren, svg, type Child } from '../dom.js';
import { formatBytes, formatDateTime } from '../../shared/format.js';
import {
  appendSample,
  areaPath,
  buildCpuChart,
  chartDomain,
  formatPercent,
  legendEntries,
  linePaths,
  nearestIndex,
  rangeOptions,
  samplesInRange,
  stackSeries,
  timeTicks,
  type MetricsResponse,
  type MetricsSample,
} from '../../shared/metrics.js';
import type { LiveMessage } from '../../shared/sse.js';
import type { Page, PageContext } from '../page.js';
import { errorBox, loading, routeLink, table } from '../ui.js';

const RANGE_KEY = 'adispatch.server.range';
const MARGIN = { left: 52, right: 12, top: 10, bottom: 24 };

interface Axis {
  from: number;
  to: number;
  width: number;
  ticks: number[];
}

/** One chart of the shared time axis. */
interface TimeChartSpec {
  id: string;
  axis: Axis;
  times: number[];
  height: number;
  yMax: number;
  yTicks: number[];
  yFormat: (v: number) => string;
  label: string;
  layers: (x: (t: number) => number, y: (v: number) => number) => Child[];
  tooltip: (i: number) => Child;
}

/** Hover state shared by all charts (crosshair at the same time everywhere, tooltip in the hovered chart). */
interface Hover {
  t: number | null;
  chart: string | null;
}

interface MountedChart {
  apply(hover: Hover): void;
}

function timeLabel(ms: number, withDate: boolean): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate && d.getHours() === 0 && d.getMinutes() === 0 ? `${p(d.getDate())}.${p(d.getMonth() + 1)}.` : hm;
}

function timeChart(spec: TimeChartSpec, onHover: (h: Hover) => void): { el: HTMLElement; chart: MountedChart } {
  const { width, from, to, ticks } = spec.axis;
  const height = spec.height;
  const plotW = Math.max(10, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(10, height - MARGIN.top - MARGIN.bottom);
  const span = Math.max(1, to - from);
  const x = (t: number): number => MARGIN.left + ((t - from) / span) * plotW;
  const y = (v: number): number => MARGIN.top + plotH - (Math.min(spec.yMax, Math.max(0, v)) / spec.yMax) * plotH;

  const grid = [
    ...spec.yTicks.map((v) =>
      svg(
        'g',
        { class: 'tick' },
        svg('line', { class: v === 0 ? 'axis' : 'grid', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y(v), y2: y(v) }),
        svg('text', { class: 'tick-label', x: MARGIN.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, spec.yFormat(v)),
      ),
    ),
    ...ticks.map((t) => svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: MARGIN.top, y2: MARGIN.top + plotH })),
  ];
  const longRange = span > 12 * 3_600_000;
  const xLabels = ticks.map((t) => svg('text', { class: 'tick-label', x: x(t), y: height - 6, 'text-anchor': 'middle' }, timeLabel(t, longRange)));
  const cross = svg('line', { class: 'crosshair', x1: 0, x2: 0, y1: MARGIN.top, y2: MARGIN.top + plotH, visibility: 'hidden' });
  const overlay = svg('rect', { class: 'hover-target', x: MARGIN.left, y: MARGIN.top, width: plotW, height: plotH });
  const chart = svg(
    'svg',
    { class: 'chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': spec.label },
    svg('title', null, spec.label),
    grid,
    spec.layers(x, y),
    xLabels,
    cross,
    overlay,
  );
  const tip = h('div', { class: 'chart-tooltip', role: 'status', hidden: true });
  const wrap = h('div', { class: 'chart-wrap' }, chart, tip);

  const apply = (hover: Hover): void => {
    const i = hover.t === null ? -1 : nearestIndex(spec.times, hover.t);
    if (i < 0) {
      cross.setAttribute('visibility', 'hidden');
      tip.hidden = true;
      return;
    }
    const cx = x(spec.times[i] as number);
    cross.setAttribute('x1', String(cx));
    cross.setAttribute('x2', String(cx));
    cross.setAttribute('visibility', 'visible');
    if (hover.chart !== spec.id) {
      tip.hidden = true;
      return;
    }
    replaceChildren(tip, spec.tooltip(i));
    tip.hidden = false;
    // CSSOM positioning (allowed by the CSP, unlike inline style attributes).
    const rendered = (chart as unknown as Element).getBoundingClientRect().width || width;
    const left = (cx / width) * rendered;
    const right = left > rendered / 2;
    tip.style.left = right ? '' : `${left + 12}px`;
    tip.style.right = right ? `${rendered - left + 12}px` : '';
  };
  const timeAt = (clientX: number): number => {
    const rect = (chart as unknown as Element).getBoundingClientRect();
    const scale = rect.width > 0 ? width / rect.width : 1;
    return from + (((clientX - rect.left) * scale - MARGIN.left) / plotW) * span;
  };
  overlay.addEventListener('mousemove', (ev: MouseEvent) => onHover({ t: timeAt(ev.clientX), chart: spec.id }));
  overlay.addEventListener('mouseleave', () => onHover({ t: null, chart: null }));
  overlay.addEventListener('touchstart', (ev: TouchEvent) => {
    const touch = ev.touches[0];
    if (touch) onHover({ t: timeAt(touch.clientX), chart: spec.id });
  });
  return { el: wrap, chart: { apply } };
}

function swatch(cls: string): HTMLElement {
  return h('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' });
}

function meterBar(fraction: number, label: string): HTMLElement {
  const pct = Math.max(0, Math.min(1, fraction));
  return h('meter', { class: 'disk-meter', min: 0, max: 1, low: 0.8, high: 0.9, optimum: 0, value: pct.toFixed(3), title: label, 'aria-label': label });
}

/** Mounted "Server" section (content of the "Resources" tab). */
export interface ServerSection {
  el: HTMLElement;
  onLive(msg: LiveMessage): void;
  onResync(): void;
  dispose(): void;
}

/** `title`: heading of the card (dashboard widget `resources_full` with `title`, WI-32). */
export function serverSection(options: { title?: string } = {}): ServerSection {
  const heading = options.title ?? 'Server';
  const el = h('section', { class: 'card server' }, h('h2', null, heading), loading());
  let data: MetricsResponse | null = null;
  let error: unknown = null;
  let rangeMs = 60 * 60_000;
  try {
    const saved = Number(localStorage.getItem(RANGE_KEY));
    if (saved > 0) rangeMs = saved;
  } catch {
    // storage unavailable
  }
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let width = 0;
  let detailsOpen = false;
  let hover: Hover = { t: null, chart: null };
  let charts: MountedChart[] = [];
  let loadGen = 0;

  const saveRange = (): void => {
    try {
      localStorage.setItem(RANGE_KEY, String(rangeMs));
    } catch {
      // ignore
    }
  };
  /** Available chart width: section content width (card padding 14 px on each side). */
  const measure = (): number => Math.max(260, Math.floor((el.clientWidth || 900) - 28));

  const load = async (): Promise<void> => {
    const gen = ++loadGen;
    try {
      const points = Math.max(50, Math.min(2000, measure() - MARGIN.left - MARGIN.right));
      const res = await api.get<MetricsResponse>(`/api/v1/system/metrics${qs({ range: `${rangeMs}ms`, points })}`);
      if (gen !== loadGen) return;
      data = res;
      error = null;
    } catch (err) {
      if (gen !== loadGen) return;
      error = err;
    }
    render();
  };

  const scheduleRender = (): void => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      render();
    }, 150);
  };

  const onHover = (next: Hover): void => {
    hover = next;
    for (const c of charts) c.apply(hover);
  };

  // Re-render when the section width changes (window resize, sidebar, orientation).
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const w = measure();
          if (Math.abs(w - width) > 4) scheduleRender();
        })
      : null;
  observer?.observe(el);

  const render = (): void => {
    if (disposed) return;
    width = measure();
    charts = [];
    const title = h('h2', null, heading);
    if (error) {
      replaceChildren(el, title, errorBox(error));
      return;
    }
    if (!data) return;
    if (!data.enabled) {
      replaceChildren(
        el,
        title,
        h('p', { class: 'alert alert-info' }, 'Resource monitoring is disabled (', h('code', null, 'monitoring.enabled: false'), ' in config.yaml).'),
      );
      return;
    }
    const options = rangeOptions(data.retentionMs);
    if (!options.some((o) => o.ms === rangeMs)) {
      rangeMs = options[Math.min(1, options.length - 1)]!.ms;
      saveRange();
    }
    const rangeButtons = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Time range' },
      options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            class: `btn${o.ms === rangeMs ? ' btn-primary' : ''}`,
            'aria-pressed': o.ms === rangeMs ? 'true' : 'false',
            on: {
              click: () => {
                if (rangeMs === o.ms) return;
                rangeMs = o.ms;
                saveRange();
                void load();
              },
            },
          },
          o.label,
        ),
      ),
    );
    const latest = data.samples[data.samples.length - 1];
    const head = h('div', { class: 'server-head' }, title, rangeButtons);
    const spanLabel = (): HTMLElement => h('span', { class: 'muted span-label' }, ` · ${domain.label}`);
    if (!latest) {
      replaceChildren(el, head, h('p', { class: 'empty' }, `Collecting the first measurement (every ${Math.round(data.intervalMs / 1000)} s)…`));
      return;
    }
    const to = Date.parse(latest.at);
    const samples = samplesInRange(data.samples, to, rangeMs);
    // Less data than the range: the axis starts at the first sample so the data fills the width.
    const domain = chartDomain(samples, to, rangeMs);
    const from = domain.from;
    const gapMs = Math.max(data.intervalMs, data.bucketMs ?? 0) * 2.5;
    const plotW = width - MARGIN.left - MARGIN.right;
    const axis: Axis = { from, to, width, ticks: timeTicks(from, to, Math.max(2, Math.floor(plotW / 90)), -new Date(to).getTimezoneOffset()) };
    const times = samples.map((s) => Date.parse(s.at));

    // --- CPU
    const cpu = buildCpuChart(samples);
    const stacked = stackSeries(cpu.series);
    const cpuChart = timeChart(
      {
        id: 'cpu',
        axis,
        times: cpu.times,
        height: 240,
        yMax: 100,
        yTicks: [0, 25, 50, 75, 100],
        yFormat: (v) => `${v} %`,
        label: `CPU utilisation of all ${latest.cpu.cores} cores, stacked by process group; currently ${formatPercent(latest.cpu.totalPercent)}`,
        layers: (x, y) =>
          cpu.series.map((s, k) => {
            const d = areaPath(cpu.times, stacked[k]!.lower, stacked[k]!.upper, x, y, gapMs);
            if (!d) return null;
            const path = svg('path', { class: `area ${s.cls}${s.runId ? ' clickable' : ''}`, d }, svg('title', null, s.label));
            if (s.runId) path.addEventListener('click', () => (location.hash = `#/runs/${encodeURIComponent(s.runId!)}`));
            return path;
          }),
        tooltip: (i) => {
          const rows = cpu.series
            .map((s) => ({ s, v: s.values[i] ?? 0 }))
            .filter((r) => r.v >= 0.05)
            .reverse();
          return [
            h('div', { class: 'tip-title' }, `${formatDateTime(new Date(cpu.times[i] as number).toISOString())} · total ${formatPercent(cpu.totals[i] ?? 0)}`),
            h('ul', { class: 'plain' }, rows.map((r) => h('li', null, swatch(r.s.cls), ' ', r.s.label, ' ', h('b', null, formatPercent(r.v))))),
          ];
        },
      },
      onHover,
    );
    charts.push(cpuChart.chart);
    const legend = h(
      'ul',
      { class: 'legend', 'aria-label': 'Legend: current / maximum in the range' },
      legendEntries(cpu).map((e) =>
        h(
          'li',
          { class: e.dim ? 'dim' : null },
          swatch(e.cls),
          ' ',
          e.runId ? routeLink(['runs', e.runId], e.label) : h('span', null, e.label),
          ' ',
          h('span', { class: 'muted' }, `${formatPercent(e.current)} / ${formatPercent(e.max)}`),
        ),
      ),
    );

    // --- Memory (stacked used / available)
    const memMax = Math.max(...samples.map((s) => s.memory.totalBytes), 1);
    const used = samples.map((s) => Math.max(0, s.memory.totalBytes - s.memory.availableBytes));
    const total = samples.map((s) => s.memory.totalBytes);
    const zeros = samples.map(() => 0);
    const memUsedNow = latest.memory.totalBytes - latest.memory.availableBytes;
    const memChart = timeChart(
      {
        id: 'mem',
        axis,
        times,
        height: 150,
        yMax: memMax,
        yTicks: [0, memMax / 2, memMax],
        yFormat: (v) => formatBytes(v),
        label: `Memory: ${formatBytes(memUsedNow)} used, ${formatBytes(latest.memory.availableBytes)} available of ${formatBytes(latest.memory.totalBytes)}`,
        layers: (x, y) => [
          svg('path', { class: 'area m-mem-used', d: areaPath(times, zeros, used, x, y, gapMs) }, svg('title', null, 'used')),
          svg('path', { class: 'area m-mem-free', d: areaPath(times, used, total, x, y, gapMs) }, svg('title', null, 'available')),
        ],
        tooltip: (i) => {
          const s = samples[i]!;
          return [
            h('div', { class: 'tip-title' }, formatDateTime(s.at)),
            h('div', null, swatch('m-mem-used'), ` used ${formatBytes(s.memory.totalBytes - s.memory.availableBytes)}`),
            h('div', null, swatch('m-mem-free'), ` available ${formatBytes(s.memory.availableBytes)}`),
          ];
        },
      },
      onHover,
    );
    charts.push(memChart.chart);

    // --- Disks (used % per monitored path)
    const diskSeries = latest.disks.map((d, k) => ({
      path: d.path,
      cls: `m-disk-${k % 4}`,
      times: samples.filter((s) => s.disks.some((x) => x.path === d.path)).map((s) => Date.parse(s.at)),
      values: samples.flatMap((s) => s.disks.filter((x) => x.path === d.path).map((x) => (x.totalBytes > 0 ? (1 - x.freeBytes / x.totalBytes) * 100 : 0))),
    }));
    const diskChart =
      diskSeries.length > 0
        ? timeChart(
            {
              id: 'disk',
              axis,
              times,
              height: 150,
              yMax: 100,
              yTicks: [0, 50, 100],
              yFormat: (v) => `${v} %`,
              label: `Disk usage: ${latest.disks.map((d) => `${d.path} ${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`).join('; ')}`,
              layers: (x, y) =>
                diskSeries.flatMap((d) => linePaths(d.times, d.values, x, y, gapMs).map((points) => svg('polyline', { class: `line ${d.cls}`, points }, svg('title', null, d.path)))),
              tooltip: (i) => {
                const s = samples[i]!;
                return [
                  h('div', { class: 'tip-title' }, formatDateTime(s.at)),
                  s.disks.map((d) =>
                    h(
                      'div',
                      null,
                      swatch(diskSeries.find((x) => x.path === d.path)?.cls ?? 'm-disk-0'),
                      ` ${d.path}: ${formatPercent(d.totalBytes > 0 ? (1 - d.freeBytes / d.totalBytes) * 100 : 0)} used, ${formatBytes(d.freeBytes)} free`,
                    ),
                  ),
                ];
              },
            },
            onHover,
          )
        : null;
    if (diskChart) charts.push(diskChart.chart);

    // --- Current values
    const summary = h(
      'dl',
      { class: 'stats' },
      h('div', null, h('dt', null, 'CPU'), h('dd', null, formatPercent(latest.cpu.totalPercent), h('small', { class: 'muted' }, ` of ${latest.cpu.cores} cores`))),
      h('div', null, h('dt', null, 'Load 1/5/15 min'), h('dd', null, latest.cpu.load.map((l) => l.toFixed(2)).join(' / '))),
      h(
        'div',
        null,
        h('dt', null, 'Memory used'),
        h('dd', null, formatBytes(memUsedNow), h('small', { class: 'muted' }, ` of ${formatBytes(latest.memory.totalBytes)}`)),
        meterBar(memUsedNow / Math.max(1, latest.memory.totalBytes), `Memory used ${formatPercent((memUsedNow / Math.max(1, latest.memory.totalBytes)) * 100)}`),
      ),
      latest.disks.map((d) => {
        const usedPct = d.totalBytes > 0 ? (1 - d.freeBytes / d.totalBytes) * 100 : 0;
        return h(
          'div',
          null,
          h('dt', { title: d.path }, `Disk · ${d.path}`),
          h('dd', null, `${formatPercent(usedPct)} used`, h('small', { class: 'muted' }, ` · ${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`)),
          meterBar(usedPct / 100, `${d.path}: ${formatPercent(usedPct)} used`),
        );
      }),
    );
    const cores = Math.max(1, latest.cpu.cores);
    const latestChart = buildCpuChart([latest]);
    const clsOf = new Map(latestChart.series.map((s) => [s.key, s.cls]));
    const valuesTable = table(
      ['Process group', 'Kind', 'CPU (of total)', 'CPU (100 % = 1 core)', 'Memory (RSS)', 'Processes'],
      latest.processes.map((p) => {
        const key = p.kind === 'run' ? `run:${p.runId ?? p.label}` : p.kind === 'other' ? `other:${p.name ?? p.label}` : p.kind;
        return [
          h('span', null, swatch(clsOf.get(key) ?? 'm-rest'), ' ', p.runId ? routeLink(['runs', p.runId], p.label) : p.label),
          p.kind,
          formatPercent(p.cpuPercent / cores),
          formatPercent(p.cpuPercent),
          formatBytes(p.rssBytes),
          String(p.count),
        ];
      }),
      { empty: 'Process list not available.' },
    );
    const details = h(
      'details',
      { class: 'current-values', open: detailsOpen },
      h('summary', null, `Current values (${formatDateTime(latest.at)})`),
      valuesTable,
      h(
        'p',
        { class: 'hint' },
        `Measured every ${Math.round(data.intervalMs / 1000)} s`,
        data.bucketMs ? `, shown as averages of ${Math.round(data.bucketMs / 1000)} s` : '',
        '; kept in memory only (lost on restart). Foreign processes are shown by command name.',
      ),
    );
    details.addEventListener('toggle', () => {
      detailsOpen = (details as HTMLDetailsElement).open;
    });

    replaceChildren(
      el,
      head,
      summary,
      h('h3', null, 'CPU by process group', spanLabel()),
      cpuChart.el,
      legend,
      h('h3', null, 'Memory'),
      memChart.el,
      h('h3', null, 'Disk usage'),
      diskChart ? diskChart.el : h('p', { class: 'empty' }, 'No file system information.'),
      details,
    );
    // Keep the hover position across live re-renders.
    if (hover.t !== null) for (const c of charts) c.apply(hover);
  };

  void load();
  return {
    el,
    onLive: (msg) => {
      if (msg.type === 'config.reloaded') {
        void load(); // monitoring may have been enabled/disabled
        return;
      }
      if (msg.type !== 'system.metrics' || !data?.enabled) return;
      data = { ...data, samples: appendSample(data.samples, msg.payload as unknown as MetricsSample, data.retentionMs) };
      scheduleRender();
    },
    onResync: () => void load(),
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      if (pending !== null) clearTimeout(pending);
    },
  };
}

/** Tab "Resources" (WI-29): the full charts, time range and value table; live via SSE `system.metrics`. */
export const resourcesPage = (ctx: PageContext): Page => {
  ctx.setTitle('Resources');
  const server = serverSection();
  const el = h('div', { class: 'page' }, h('h1', null, 'Resources'), server.el);
  return {
    el,
    onLive: (msg) => server.onLive(msg),
    onResync: () => server.onResync(),
    dispose: () => server.dispose(),
  };
};
