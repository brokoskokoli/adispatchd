/**
 * Dashboard section "Server" (WI-23): stacked CPU chart by daemon / runs /
 * hooks / foreign processes, memory and disk charts, current values as a
 * table. Own SVG rendering (no libraries); names are text nodes only.
 * Data: `GET /api/v1/system/metrics`, then live via SSE `system.metrics`.
 */
import { api } from '../api.js';
import { h, replaceChildren, svg, type Child } from '../dom.js';
import { formatBytes, formatDateTime } from '../../shared/format.js';
import {
  appendSample,
  areaPath,
  buildCpuChart,
  formatPercent,
  legendEntries,
  linePaths,
  nearestIndex,
  rangeOptions,
  samplesInRange,
  seriesClass,
  stackSeries,
  type MetricsResponse,
  type MetricsSample,
} from '../../shared/metrics.js';
import type { LiveMessage } from '../../shared/sse.js';
import { errorBox, loading, routeLink, table } from '../ui.js';

const RANGE_KEY = 'adispatch.server.range';
const MARGIN = { left: 44, right: 10, top: 10, bottom: 24 };

/** One horizontally scaled time chart with hover crosshair and tooltip. */
interface TimeChartSpec {
  times: number[];
  from: number;
  to: number;
  width: number;
  height: number;
  yMax: number;
  yTicks: number[];
  yFormat: (v: number) => string;
  gapMs: number;
  label: string;
  /** Draw the layers with the given scales. */
  layers: (x: (t: number) => number, y: (v: number) => number) => Child[];
  /** Tooltip content of a sample index. */
  tooltip: (i: number) => Child;
}

function timeLabel(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}${withSeconds ? `:${p(d.getSeconds())}` : ''}`;
}

function timeChart(spec: TimeChartSpec): HTMLElement {
  const { width, height } = spec;
  const plotW = Math.max(10, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(10, height - MARGIN.top - MARGIN.bottom);
  const span = Math.max(1, spec.to - spec.from);
  const x = (t: number): number => MARGIN.left + ((t - spec.from) / span) * plotW;
  const y = (v: number): number => MARGIN.top + plotH - (Math.min(spec.yMax, Math.max(0, v)) / spec.yMax) * plotH;

  const grid = spec.yTicks.map((v) =>
    svg(
      'g',
      { class: 'tick' },
      svg('line', { class: v === 0 ? 'axis' : 'grid', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y(v), y2: y(v) }),
      svg('text', { class: 'tick-label', x: MARGIN.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, spec.yFormat(v)),
    ),
  );
  const xTicks: Child[] = [];
  const steps = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
  for (let k = 0; k <= steps; k++) {
    const t = spec.from + (span * k) / steps;
    xTicks.push(svg('text', { class: 'tick-label', x: x(t), y: height - 6, 'text-anchor': k === 0 ? 'start' : k === steps ? 'end' : 'middle' }, timeLabel(t)));
  }
  const cross = svg('line', { class: 'crosshair', x1: 0, x2: 0, y1: MARGIN.top, y2: MARGIN.top + plotH, visibility: 'hidden' });
  const overlay = svg('rect', { class: 'hover-target', x: MARGIN.left, y: MARGIN.top, width: plotW, height: plotH });
  const chart = svg(
    'svg',
    { class: 'chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': spec.label },
    svg('title', null, spec.label),
    grid,
    spec.layers(x, y),
    xTicks,
    cross,
    overlay,
  );
  const tip = h('div', { class: 'chart-tooltip', role: 'status', hidden: true });
  const wrap = h('div', { class: 'chart-wrap' }, chart, tip);

  const show = (clientX: number): void => {
    const rect = (chart as unknown as Element).getBoundingClientRect();
    const scale = rect.width > 0 ? width / rect.width : 1;
    const px = (clientX - rect.left) * scale;
    const t = spec.from + ((px - MARGIN.left) / plotW) * span;
    const i = nearestIndex(spec.times, t);
    if (i < 0) return;
    const cx = x(spec.times[i] as number);
    cross.setAttribute('x1', String(cx));
    cross.setAttribute('x2', String(cx));
    cross.setAttribute('visibility', 'visible');
    replaceChildren(tip, spec.tooltip(i));
    tip.hidden = false;
    // CSSOM positioning (allowed by the CSP, unlike inline style attributes).
    const left = (cx / width) * rect.width;
    const right = left > rect.width / 2;
    tip.style.left = right ? '' : `${left + 12}px`;
    tip.style.right = right ? `${rect.width - left + 12}px` : '';
  };
  const hide = (): void => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  overlay.addEventListener('mousemove', (ev: MouseEvent) => show(ev.clientX));
  overlay.addEventListener('mouseleave', hide);
  overlay.addEventListener('touchstart', (ev: TouchEvent) => {
    const touch = ev.touches[0];
    if (touch) show(touch.clientX);
  });
  return wrap;
}

function swatch(cls: string): HTMLElement {
  return h('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' });
}

/** Mounted "Server" section of the dashboard. */
export interface ServerSection {
  el: HTMLElement;
  onLive(msg: LiveMessage): void;
  onResync(): void;
  dispose(): void;
}

export function serverSection(): ServerSection {
  const el = h('section', { class: 'card span-all server' }, h('h2', null, 'Server'), loading());
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

  const load = async (): Promise<void> => {
    try {
      data = await api.get<MetricsResponse>('/api/v1/system/metrics');
      error = null;
    } catch (err) {
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

  const onResize = (): void => scheduleRender();
  window.addEventListener('resize', onResize);

  const render = (): void => {
    if (disposed) return;
    const title = h('h2', null, 'Server');
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
    if (!options.some((o) => o.ms === rangeMs)) rangeMs = options[Math.min(1, options.length - 1)]!.ms;
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
                rangeMs = o.ms;
                try {
                  localStorage.setItem(RANGE_KEY, String(o.ms));
                } catch {
                  // ignore
                }
                render();
              },
            },
          },
          o.label,
        ),
      ),
    );
    const latest = data.samples[data.samples.length - 1];
    const head = h('div', { class: 'server-head' }, title, rangeButtons);
    if (!latest) {
      replaceChildren(el, head, h('p', { class: 'empty' }, `Collecting the first measurement (every ${Math.round(data.intervalMs / 1000)} s)…`));
      return;
    }
    const to = Date.parse(latest.at);
    const samples = samplesInRange(data.samples, to, rangeMs);
    const from = to - rangeMs;
    const gapMs = data.intervalMs * 2.5;
    const width = Math.max(280, Math.min(1400, (el.clientWidth || 900) - 30));

    // --- CPU
    const cpu = buildCpuChart(samples);
    const stacked = stackSeries(cpu.series);
    const cpuChart = timeChart({
      times: cpu.times,
      from,
      to,
      width,
      height: 240,
      yMax: 100,
      yTicks: [0, 25, 50, 75, 100],
      yFormat: (v) => `${v} %`,
      gapMs,
      label: `CPU utilisation of all ${latest.cpu.cores} cores over the selected range, stacked by process group; currently ${formatPercent(latest.cpu.totalPercent)}`,
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
    });
    const legend = h(
      'ul',
      { class: 'legend' },
      legendEntries(cpu).map((e) =>
        h(
          'li',
          null,
          swatch(e.cls),
          ' ',
          e.runId ? routeLink(['runs', e.runId], e.label) : h('span', null, e.label),
          ' ',
          h('span', { class: 'muted' }, formatPercent(e.current)),
        ),
      ),
    );

    // --- Memory
    const memTimes = samples.map((s) => Date.parse(s.at));
    const memMax = Math.max(...samples.map((s) => s.memory.totalBytes), 1);
    const used = samples.map((s) => Math.max(0, s.memory.totalBytes - s.memory.availableBytes));
    const total = samples.map((s) => s.memory.totalBytes);
    const zeros = samples.map(() => 0);
    const memUsedNow = latest.memory.totalBytes - latest.memory.availableBytes;
    const memChart = timeChart({
      times: memTimes,
      from,
      to,
      width: width >= 760 ? Math.floor((width - 16) / 2) : width,
      height: 170,
      yMax: memMax,
      yTicks: [0, memMax / 2, memMax],
      yFormat: (v) => formatBytes(v),
      gapMs,
      label: `Memory: ${formatBytes(memUsedNow)} used, ${formatBytes(latest.memory.availableBytes)} available of ${formatBytes(latest.memory.totalBytes)}`,
      layers: (x, y) => [
        svg('path', { class: 'area m-mem-used', d: areaPath(memTimes, zeros, used, x, y, gapMs) }, svg('title', null, 'used')),
        svg('path', { class: 'area m-mem-free', d: areaPath(memTimes, used, total, x, y, gapMs) }, svg('title', null, 'available')),
      ],
      tooltip: (i) => {
        const s = samples[i]!;
        return [
          h('div', { class: 'tip-title' }, formatDateTime(s.at)),
          h('div', null, swatch('m-mem-used'), ` used ${formatBytes(s.memory.totalBytes - s.memory.availableBytes)}`),
          h('div', null, swatch('m-mem-free'), ` available ${formatBytes(s.memory.availableBytes)}`),
        ];
      },
    });

    // --- Disks (free space per monitored path)
    const diskPaths = latest.disks.map((d) => d.path);
    const diskMax = Math.max(...samples.flatMap((s) => s.disks.map((d) => d.totalBytes)), 1);
    const diskSeries = diskPaths.map((p, k) => ({
      path: p,
      cls: `m-disk-${k % 4}`,
      times: samples.filter((s) => s.disks.some((d) => d.path === p)).map((s) => Date.parse(s.at)),
      values: samples.flatMap((s) => s.disks.filter((d) => d.path === p).map((d) => d.freeBytes)),
    }));
    const diskChart =
      diskPaths.length > 0
        ? timeChart({
            times: memTimes,
            from,
            to,
            width: width >= 760 ? Math.floor((width - 16) / 2) : width,
            height: 170,
            yMax: diskMax,
            yTicks: [0, diskMax / 2, diskMax],
            yFormat: (v) => formatBytes(v),
            gapMs,
            label: `Free disk space: ${latest.disks.map((d) => `${d.path} ${formatBytes(d.freeBytes)} of ${formatBytes(d.totalBytes)}`).join('; ')}`,
            layers: (x, y) =>
              diskSeries.flatMap((d) => linePaths(d.times, d.values, x, y, gapMs).map((points) => svg('polyline', { class: `line ${d.cls}`, points }, svg('title', null, d.path)))),
            tooltip: (i) => {
              const s = samples[i]!;
              return [
                h('div', { class: 'tip-title' }, formatDateTime(s.at)),
                s.disks.map((d) => h('div', null, swatch(diskSeries.find((x) => x.path === d.path)?.cls ?? 'm-disk-0'), ` ${d.path}: ${formatBytes(d.freeBytes)} free`)),
              ];
            },
          })
        : h('p', { class: 'empty' }, 'No file system information.');

    // --- Current values
    const summary = h(
      'dl',
      { class: 'stats' },
      h('div', null, h('dt', null, 'CPU'), h('dd', null, formatPercent(latest.cpu.totalPercent), h('small', { class: 'muted' }, ` of ${latest.cpu.cores} cores`))),
      h('div', null, h('dt', null, 'Load 1/5/15 min'), h('dd', null, latest.cpu.load.map((l) => l.toFixed(2)).join(' / '))),
      h('div', null, h('dt', null, 'Memory used'), h('dd', null, formatBytes(memUsedNow), h('small', { class: 'muted' }, ` of ${formatBytes(latest.memory.totalBytes)}`))),
      latest.disks.map((d) =>
        h('div', null, h('dt', { title: d.path }, `Disk free · ${d.path}`), h('dd', null, formatBytes(d.freeBytes), h('small', { class: 'muted' }, ` of ${formatBytes(d.totalBytes)}`))),
      ),
    );
    const cores = Math.max(1, latest.cpu.cores);
    const valuesTable = table(
      ['Process group', 'Kind', 'CPU (of total)', 'CPU (100 % = 1 core)', 'Memory (RSS)', 'Processes'],
      latest.processes.map((p) => [
        h('span', null, swatch(seriesClass(p.kind, p.kind === 'run' ? (p.workflowId ?? '') : (p.name ?? p.label))), ' ', p.runId ? routeLink(['runs', p.runId], p.label) : p.label),
        p.kind,
        formatPercent(p.cpuPercent / cores),
        formatPercent(p.cpuPercent),
        formatBytes(p.rssBytes),
        String(p.count),
      ]),
      { empty: 'Process list not available.' },
    );

    replaceChildren(
      el,
      head,
      summary,
      h('h3', null, 'CPU by process group'),
      cpuChart,
      legend,
      h('div', { class: 'chart-pair' }, h('div', null, h('h3', null, 'Memory'), memChart), h('div', null, h('h3', null, 'Free disk space'), diskChart)),
      h(
        'details',
        { class: 'current-values' },
        h('summary', null, `Current values (${formatDateTime(latest.at)})`),
        valuesTable,
        h('p', { class: 'hint' }, 'Values are measured every ', `${Math.round(data.intervalMs / 1000)} s`, ' and kept in memory only (lost on restart). Foreign processes are shown by command name.'),
      ),
    );
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
      window.removeEventListener('resize', onResize);
      if (pending !== null) clearTimeout(pending);
    },
  };
}
