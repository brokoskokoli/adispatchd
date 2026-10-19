import { describe, expect, it } from 'vitest';
import {
  appendSample,
  areaPath,
  buildCpuChart,
  formatPercent,
  legendEntries,
  linePaths,
  nearestIndex,
  niceMax,
  rangeOptions,
  samplesInRange,
  seriesClass,
  stackSeries,
  SYSTEM_LABEL,
  type MetricsProcess,
  type MetricsSample,
} from './metrics.js';

const T0 = Date.parse('2026-10-19T10:00:00Z');

function sample(i: number, total: number, processes: MetricsProcess[], cores = 4): MetricsSample {
  return {
    at: new Date(T0 + i * 30_000).toISOString(),
    cpu: { totalPercent: total, cores, load: [1, 1, 1] },
    memory: { totalBytes: 100, availableBytes: 40 },
    disks: [],
    processes,
  };
}
const daemon = (cpu: number): MetricsProcess => ({ kind: 'daemon', label: 'adispatchd', cpuPercent: cpu, rssBytes: 1, count: 1 });
const run = (id: string, wf: string, cpu: number, label = `${wf} · ${id}`): MetricsProcess => ({ kind: 'run', label, runId: id, workflowId: wf, cpuPercent: cpu, rssBytes: 1, count: 1 });
const other = (name: string, cpu: number, count = 1): MetricsProcess => ({ kind: 'other', label: count > 1 ? `${name} ×${count}` : name, name, cpuPercent: cpu, rssBytes: 1, count });
const rest = (cpu: number): MetricsProcess => ({ kind: 'rest', label: 'Others', cpuPercent: cpu, rssBytes: 1, count: 9 });

describe('CPU chart data', () => {
  const samples = [
    sample(0, 50, [daemon(4), run('r1', 'coder', 40), other('node', 20), rest(8)]),
    sample(1, 80, [daemon(8), run('r1', 'coder', 80), run('r2', 'reviewer', 100), other('node', 40, 3), other('java', 60), rest(12)]),
    sample(2, 30, [daemon(4), run('r2', 'reviewer', 60, 'reviewer · r2 · repo#7'), hooks(8), rest(4)]),
  ];
  function hooks(cpu: number): MetricsProcess {
    return { kind: 'hooks', label: 'adispatchd (hooks/checks)', cpuPercent: cpu, rssBytes: 1, count: 2 };
  }

  it('stacks daemon, runs (first appearance), hooks, foreign by total, Others, then the unattributed remainder', () => {
    const chart = buildCpuChart(samples);
    expect(chart.series.map((s) => s.key)).toEqual(['daemon', 'run:r1', 'run:r2', 'hooks', 'other:java', 'other:node', 'rest', 'system']);
    expect(chart.times).toEqual([T0, T0 + 30_000, T0 + 60_000]);
    expect(chart.totals).toEqual([50, 80, 30]);
    // normalised to the total capacity (4 cores): 40 % of one core = 10 % of the machine
    expect(chart.series.find((s) => s.key === 'run:r1')!.values).toEqual([10, 20, 0]);
    expect(chart.series.find((s) => s.key === 'run:r2')!.values).toEqual([0, 25, 15]);
    // remainder = total - attributed
    expect(chart.series.at(-1)).toMatchObject({ kind: 'system', label: SYSTEM_LABEL, cls: 'm-system' });
    expect(chart.series.at(-1)!.values).toEqual([50 - (1 + 10 + 5 + 2), 80 - (2 + 20 + 25 + 15 + 10 + 3), 30 - (1 + 15 + 2 + 1)]);
    // label from the latest sample
    expect(chart.series.find((s) => s.key === 'run:r2')!.label).toBe('reviewer · r2 · repo#7');
  });

  it('cumulative stacking never exceeds 100 and lower = upper of the series below', () => {
    const chart = buildCpuChart([sample(0, 100, [run('a', 'w', 300), run('b', 'w', 300)])]);
    const st = stackSeries(chart.series);
    expect(st.map((s) => [s.lower[0], s.upper[0]])).toEqual([
      [0, 75],
      [75, 100],
      [100, 100],
    ]);
  });

  it('colors are stable per workflow (runs) and per name (foreign), fixed for the rest', () => {
    const chart = buildCpuChart(samples);
    const cls = Object.fromEntries(chart.series.map((s) => [s.key, s.cls]));
    expect(cls.daemon).toBe('m-daemon');
    expect(cls.hooks).toBe('m-hooks');
    expect(cls.rest).toBe('m-rest');
    expect(cls['run:r1']).toBe(seriesClass('run', 'coder'));
    expect(cls['run:r1']).toMatch(/^m-wf-[0-7]$/);
    expect(cls['other:node']).toMatch(/^m-other-[0-3]$/);
    // the same workflow keeps its color in another data set (color follows the entity, not the rank)
    const again = buildCpuChart([sample(0, 10, [run('r9', 'coder', 4)])]);
    expect(again.series[0]!.cls).toBe(cls['run:r1']);
  });

  it('a sample without a process list shows the total as unattributed', () => {
    const chart = buildCpuChart([sample(0, 42, [])]);
    expect(chart.series.map((s) => [s.key, s.values[0]])).toEqual([['system', 42]]);
  });

  it('legend: top of the stack first, current and max value, run links', () => {
    const entries = legendEntries(buildCpuChart(samples));
    expect(entries[0]!.key).toBe('system');
    expect(entries.at(-1)!.key).toBe('daemon');
    const r1 = entries.find((e) => e.key === 'run:r1')!;
    expect(r1).toMatchObject({ runId: 'r1', current: 0, max: 20, label: 'coder · r1' });
  });
});

describe('geometry and ranges', () => {
  const x = (t: number): number => (t - T0) / 1000;
  const y = (v: number): number => 100 - v;

  it('builds area paths and splits them at gaps', () => {
    const times = [T0, T0 + 30_000, T0 + 60_000, T0 + 300_000];
    const d = areaPath(times, [0, 0, 0, 0], [10, 20, 30, 40], x, y, 75_000);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.startsWith('M0,90L30,80L60,70L60,100L30,100L0,100Z')).toBe(true);
    expect(d).toContain('M298.5,60L301.5,60L301.5,100L298.5,100Z'); // isolated sample gets a small width
    expect(areaPath(times, [5, 5, 5, 5], [5, 5, 5, 5], x, y, 75_000)).toBe('');
    expect(areaPath([], [], [], x, y, 1)).toBe('');
  });

  it('builds polylines split at gaps', () => {
    expect(linePaths([T0, T0 + 30_000, T0 + 300_000], [1, 2, 3], x, y, 75_000)).toEqual(['0,99 30,98', '300,97']);
  });

  it('finds the nearest sample', () => {
    expect(nearestIndex([10, 20, 30], 24)).toBe(1);
    expect(nearestIndex([10, 20, 30], 1000)).toBe(2);
    expect(nearestIndex([], 5)).toBe(-1);
  });

  it('offers ranges up to the retention', () => {
    expect(rangeOptions(6 * 3_600_000).map((o) => o.label)).toEqual(['15 min', '1 h', '6 h']);
    expect(rangeOptions(30 * 60_000).map((o) => o.label)).toEqual(['15 min', '30 min']);
    expect(rangeOptions(10 * 60_000).map((o) => o.label)).toEqual(['10 min']);
    expect(rangeOptions(7 * 24 * 3_600_000).map((o) => o.label)).toEqual(['15 min', '1 h', '6 h', '24 h']);
  });

  it('filters by range and appends live samples without duplicates, trimming to the retention', () => {
    const s = [0, 1, 2, 3].map((i) => ({ at: new Date(T0 + i * 60_000).toISOString() }));
    expect(samplesInRange(s, T0 + 180_000, 120_000)).toEqual(s.slice(1));
    expect(appendSample(s, s[3]!, 1e9)).toHaveLength(4);
    const next = { at: new Date(T0 + 240_000).toISOString() };
    expect(appendSample(s, next, 150_000).map((x) => x.at)).toEqual([s[2]!.at, s[3]!.at, next.at]);
  });

  it('formats percentages and nice axis maxima', () => {
    expect(formatPercent(0)).toBe('0.0 %');
    expect(formatPercent(0.04)).toBe('<0.1 %');
    expect(formatPercent(12.345)).toBe('12.3 %');
    expect(niceMax(0)).toBe(1);
    expect(niceMax(17e9)).toBe(20e9);
    expect(niceMax(2.2e9)).toBe(2.5e9);
    expect(niceMax(500)).toBe(500);
  });
});

describe('long ranges', () => {
  it('keeps at most MAX_NAMED_OTHERS named foreign series and folds the rest into "Others"', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i, 90, [{ kind: 'other', label: `p${i}`, name: `p${i}`, cpuPercent: 10 + i, rssBytes: 1, count: 1 }, rest(4)]));
    const chart = buildCpuChart(samples);
    const others = chart.series.filter((s) => s.kind === 'other');
    expect(others.map((s) => s.key)).toEqual(['other:p9', 'other:p8', 'other:p7', 'other:p6', 'other:p5', 'other:p4']);
    const restSeries = chart.series.find((s) => s.kind === 'rest')!;
    expect(restSeries.values[0]).toBe(1 + 10 / 4); // Others (4 % of a core) + folded p0 (10 %), each / 4 cores
    expect(chart.series.map((s) => s.kind).slice(-2)).toEqual(['rest', 'system']);
  });
});
