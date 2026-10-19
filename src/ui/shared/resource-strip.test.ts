import { describe, expect, it } from 'vitest';
import { createH, createSvg, type DocLike, type ElementLike, type NodeLike, type SvgDocLike } from './dom.js';
import type { MetricsProcess, MetricsResponse, MetricsSample } from './metrics.js';
import {
  createStripFeed,
  MAX_RETRY_MS,
  MAX_TOP,
  renderResourceStrip,
  RESOURCES_HASH,
  RETRY_BASE_MS,
  SPARK_POINTS,
  SPARK_RANGE_MS,
  sparklinePaths,
  stripMetricsPath,
  stripState,
  stripSummary,
  topEntries,
  type StripState,
} from './resource-strip.js';
import { parseHash } from './route.js';
import type { LiveMessage } from './sse.js';

class FakeText implements NodeLike {
  readonly nodeType = 3;
  constructor(readonly data: string) {}
}
class FakeElement implements ElementLike {
  readonly nodeType = 1;
  attrs: Record<string, string> = {};
  children: Array<FakeElement | FakeText> = [];
  constructor(
    readonly tag: string,
    readonly ns: string | null = null,
  ) {}
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  appendChild(child: NodeLike): unknown {
    this.children.push(child as FakeElement | FakeText);
    return child;
  }
  addEventListener(): void {}
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
  }
  find(pred: (e: FakeElement) => boolean): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(pred(c) ? [c] : []), ...c.find(pred)] : []));
  }
  byClass(cls: string): FakeElement[] {
    return this.find((e) => (e.attrs.class ?? '').split(' ').includes(cls));
  }
}
const doc: DocLike<FakeElement, FakeText> & SvgDocLike<FakeElement, FakeText> = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t, ns),
  createTextNode: (d) => new FakeText(d),
};
const h = createH(doc);
const svg = createSvg(doc);

const GB = 1024 ** 3;
const T0 = Date.parse('2026-10-20T10:00:00Z');

function proc(kind: MetricsProcess['kind'], label: string, cpuPercent: number, extra: Partial<MetricsProcess> = {}): MetricsProcess {
  return { kind, label, cpuPercent, rssBytes: 1000, count: 1, ...extra };
}

function sample(minute: number, total: number, processes: MetricsProcess[] = []): MetricsSample {
  return {
    at: new Date(T0 + minute * 60_000).toISOString(),
    cpu: { totalPercent: total, cores: 4, load: [1.5, 1.25, 0.5] },
    memory: { totalBytes: 16 * GB, availableBytes: 10 * GB },
    disks: [
      { path: '/data', freeBytes: 60 * GB, totalBytes: 100 * GB },
      { path: '/work', freeBytes: 10 * GB, totalBytes: 100 * GB },
    ],
    processes,
  };
}

const PROCS = [
  proc('daemon', 'daemon', 0.2),
  proc('run', 'busy · 0000beef', 36, { runId: 'r1', workflowId: 'busy' }),
  proc('hooks', 'hooks/checks', 0),
  proc('other', 'python ×2', 48, { name: 'python' }),
  proc('other', 'WindowServer', 20, { name: 'WindowServer' }),
  proc('other', 'Finder', 8, { name: 'Finder' }),
  proc('rest', 'Others', 80),
  proc('run', 'reviewer · 0000cafe', 32, { runId: 'r2', workflowId: 'reviewer' }),
];

describe('stripSummary / topEntries (WI-29)', () => {
  it('summarises the latest sample: CPU, memory, fullest disk, load, sparkline window', () => {
    const samples = [sample(-20, 90), sample(-14, 10), sample(-5, 20), sample(0, 33.3, PROCS)];
    const s = stripSummary(samples)!;
    expect(s.cpu).toEqual({ percent: 33.3, cores: 4 });
    expect(s.spark).toEqual([10, 20, 33.3]); // the sample 20 min ago is outside the 15-min window
    expect(s.memory).toEqual({ usedBytes: 6 * GB, totalBytes: 16 * GB, fraction: 6 / 16 });
    expect(s.disk).toEqual({ path: '/work', freeBytes: 10 * GB, totalBytes: 100 * GB, fraction: 0.9 });
    expect(s.load).toEqual([1.5, 1.25, 0.5]);
    expect(stripSummary([])).toBeNull();
  });

  it('top line: own groups first (by CPU), then foreign, no "Others", no idle entries, at most MAX_TOP', () => {
    const top = topEntries(sample(0, 50, PROCS));
    expect(top.map((t) => [t.label, t.percent, t.own])).toEqual([
      ['busy · 0000beef', 9, true],
      ['reviewer · 0000cafe', 8, true],
      ['python ×2', 12, false],
      ['WindowServer', 5, false],
    ]);
    expect(top).toHaveLength(MAX_TOP);
    // daemon 0.2 % of 4 cores = 0.05 % → below the threshold; hooks at 0 left out.
    expect(top.some((t) => t.kind === 'daemon' || t.kind === 'hooks' || t.kind === 'rest')).toBe(false);
    expect(top[0]!.cls).toMatch(/^m-wf-\d$/);
    expect(top[2]!.cls).toBe('m-other-0');
    expect(top[3]!.cls).toBe('m-other-1');
    expect(topEntries(sample(0, 50, []))).toEqual([]);
  });

  it('clamps nonsense values and handles missing disks', () => {
    const s = stripSummary([{ ...sample(0, Number.NaN), disks: [], memory: { totalBytes: 0, availableBytes: 0 } }])!;
    expect(s.cpu.percent).toBe(0);
    expect(s.disk).toBeNull();
    expect(s.memory.fraction).toBe(0);
  });
});

describe('sparklinePaths', () => {
  it('maps 0–100 % to the height and spreads points over the width', () => {
    const { line, area } = sparklinePaths([0, 50, 100], 100, 22);
    expect(line).toBe('0,21 50,11 100,1');
    expect(area).toBe('M0,22L0,21L50,11L100,1L100,22Z');
  });
  it('a single value is a flat line; no values → empty', () => {
    expect(sparklinePaths([50], 100, 22).line).toBe('0,11 100,11');
    expect(sparklinePaths([])).toEqual({ line: '', area: '' });
  });
});

describe('renderResourceStrip', () => {
  const ok = (): FakeElement => renderResourceStrip(h, svg, stripState({ enabled: true, intervalMs: 5000, retentionMs: 3_600_000, samples: [sample(-1, 20), sample(0, 33.3, PROCS)] }, null)) as FakeElement;

  it('renders values, sparkline and the top line inside one link to the Resources tab', () => {
    const el = ok();
    const link = el.find((e) => e.tag === 'a');
    expect(link).toHaveLength(1);
    expect(link[0]!.attrs.href).toBe(RESOURCES_HASH);
    expect(link[0]!.attrs['aria-label']).toBe(
      'Server resources: CPU 33.3 %, memory 6.0 GiB of 16.0 GiB, disk /work 90.0 % used, load 1.50 / 1.25 / 0.50. Open the Resources tab',
    );
    expect(parseHash(RESOURCES_HASH).segments).toEqual(['resources']);
    const values = el.byClass('strip-value').map((e) => e.textContent);
    expect(values).toEqual(['33.3 %', '6.0 GiB / 16.0 GiB', '90.0 % used', '1.50 / 1.25 / 0.50']);
    const spark = el.find((e) => e.tag === 'polyline');
    expect(spark).toHaveLength(1);
    expect(spark[0]!.ns).toBe('http://www.w3.org/2000/svg');
    expect(spark[0]!.attrs.points!.split(' ')).toHaveLength(2);
    expect(el.byClass('strip-top')[0]!.textContent).toBe('Top  busy · 0000beef 9.0 % ·  reviewer · 0000cafe 8.0 % ·  python ×2 12.0 % ·  WindowServer 5.0 %');
    expect(el.find((e) => e.tag === 'meter').map((m) => m.attrs.value)).toEqual(['0.375', '0.900']);
    // The disk cell names the fullest path in its tooltip.
    expect(el.byClass('strip-cell')[2]!.attrs.title).toBe('/work: 10.0 GiB free of 100 GiB');
  });

  it('process names stay text (no markup is ever created)', () => {
    const evil = [proc('other', '<img src=x onerror=alert(1)>', 40, { name: '<img>' })];
    const el = renderResourceStrip(h, svg, stripState({ enabled: true, intervalMs: 5000, retentionMs: 1, samples: [sample(0, 10, evil)] }, null)) as FakeElement;
    expect(el.find((e) => e.tag === 'img')).toEqual([]);
    expect(el.byClass('strip-top')[0]!.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('without processes there is no top line', () => {
    const el = renderResourceStrip(h, svg, stripState({ enabled: true, intervalMs: 5000, retentionMs: 1, samples: [sample(0, 10)] }, null)) as FakeElement;
    expect(el.byClass('strip-top')).toEqual([]);
  });

  it('short notes: disabled monitoring, loading, first measurement pending, error', () => {
    const render = (s: StripState): FakeElement => renderResourceStrip(h, svg, s) as FakeElement;
    const disabled = render(stripState({ enabled: false, intervalMs: 5000, retentionMs: 1, samples: [] }, null));
    expect(disabled.textContent).toBe('Resource monitoring is disabled (monitoring.enabled: false).');
    expect(disabled.find((e) => e.tag === 'svg' || e.tag === 'a')).toEqual([]);
    expect(render(stripState(null, null)).textContent).toContain('loading');
    expect(render(stripState({ enabled: true, intervalMs: 10_000, retentionMs: 1, samples: [] }, null)).textContent).toContain('every 10 s');
    const err = render(stripState(null, new Error('HTTP 500')));
    expect(err.textContent).toContain('Server resources unavailable: HTTP 500');
    expect(err.find((e) => e.tag === 'a')[0]!.attrs.href).toBe(RESOURCES_HASH);
  });
});

describe('createStripFeed (lifecycle)', () => {
  const response = (samples: MetricsSample[], enabled = true): MetricsResponse => ({ enabled, intervalMs: 5000, retentionMs: 3_600_000, bucketMs: null, samples });
  const live = (s: MetricsSample): LiveMessage => ({ type: 'system.metrics', payload: s as unknown as Record<string, unknown> }) as LiveMessage;

  function setup(initial: MetricsResponse | Error) {
    const paths: string[] = [];
    const states: StripState[] = [];
    let next: MetricsResponse | Error = initial;
    const feed = createStripFeed({
      fetch: async (path) => {
        paths.push(path);
        if (next instanceof Error) throw next;
        return next;
      },
      onChange: (s) => states.push(s),
    });
    return { feed, paths, states, setNext: (r: MetricsResponse | Error) => (next = r) };
  }

  it('loads once with a small point count over the sparkline window', async () => {
    const { feed, paths, states } = setup(response([sample(0, 12)]));
    await feed.load();
    expect(paths).toEqual([stripMetricsPath()]);
    expect(stripMetricsPath()).toBe(`/api/v1/system/metrics?range=${SPARK_RANGE_MS}ms&points=${SPARK_POINTS}`);
    expect(SPARK_POINTS).toBeLessThanOrEqual(100);
    expect(states.at(-1)).toMatchObject({ kind: 'ok', summary: { cpu: { percent: 12 } } });
  });

  it('appends live samples without a new request and drops samples outside the window', async () => {
    const { feed, paths, states } = setup(response([sample(-20, 90), sample(0, 12)]));
    await feed.load();
    feed.onLive(live(sample(1, 40, PROCS)));
    feed.onLive(live(sample(1, 99))); // duplicate timestamp: ignored
    feed.onLive({ type: 'run.output', payload: {} } as LiveMessage); // unrelated: no change
    expect(paths).toHaveLength(1);
    const last = states.at(-1) as Extract<StripState, { kind: 'ok' }>;
    expect(last.summary.cpu.percent).toBe(40);
    expect(last.summary.spark).toEqual([12, 40]);
    expect(last.summary.top[0]!.label).toBe('busy · 0000beef');
  });

  it('config reload and resync reload (monitoring switched off → note)', async () => {
    const { feed, paths, states, setNext } = setup(response([sample(0, 12)]));
    await feed.load();
    setNext(response([], false));
    feed.onLive({ type: 'config.reloaded', payload: {} } as LiveMessage);
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)).toEqual({ kind: 'disabled' });
    // Live samples are ignored while disabled.
    feed.onLive(live(sample(1, 40)));
    expect(states.at(-1)).toEqual({ kind: 'disabled' });
    setNext(new Error('offline'));
    feed.onResync();
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)).toEqual({ kind: 'error', message: 'offline' });
    expect(paths).toHaveLength(3);
  });

  it('dispose ends the subscription: later live messages, reloads and pending responses are ignored', async () => {
    const { feed, paths, states } = setup(response([sample(0, 12)]));
    const pending = feed.load(); // response still in flight when the page is left
    feed.dispose();
    await pending;
    feed.onLive(live(sample(1, 40)));
    feed.onLive({ type: 'config.reloaded', payload: {} } as LiveMessage);
    feed.onResync();
    await feed.load();
    expect(feed.disposed).toBe(true);
    expect(states).toEqual([]);
    expect(paths).toHaveLength(1);
  });

  it('recovers from a failed first load on the next system.metrics message, with backoff', async () => {
    let clock = 1_000_000;
    const paths: string[] = [];
    const states: StripState[] = [];
    let next: MetricsResponse | Error = new Error('HTTP 503');
    const feed = createStripFeed({
      fetch: async (path) => {
        paths.push(path);
        if (next instanceof Error) throw next;
        return next;
      },
      onChange: (s) => states.push(s),
      now: () => clock,
    });
    await feed.load();
    expect(states.at(-1)).toEqual({ kind: 'error', message: 'HTTP 503' });
    // Within the first backoff (5 s): no new request.
    clock += RETRY_BASE_MS - 1;
    feed.onLive(live(sample(1, 40)));
    expect(paths).toHaveLength(1);
    // After it: one retry, still failing → backoff doubles (10 s).
    clock += 1;
    feed.onLive(live(sample(2, 40)));
    feed.onLive(live(sample(2, 41))); // while the retry is in flight: nothing else
    await new Promise((r) => setTimeout(r, 0));
    expect(paths).toHaveLength(2);
    clock += 2 * RETRY_BASE_MS - 1;
    feed.onLive(live(sample(3, 40)));
    expect(paths).toHaveLength(2);
    // Server back: the next allowed message reloads and the strip shows data again.
    next = response([sample(4, 25)]);
    clock += 1;
    feed.onLive(live(sample(4, 40)));
    await new Promise((r) => setTimeout(r, 0));
    expect(paths).toHaveLength(3);
    expect(states.at(-1)).toMatchObject({ kind: 'ok', summary: { cpu: { percent: 25 } } });
    // The delay is capped.
    expect(MAX_RETRY_MS).toBe(60_000);
  });

  it('live samples join the sparkline only at the spacing of the loaded points; current values update at once', async () => {
    const base = { enabled: true, intervalMs: 5000, retentionMs: 3_600_000, bucketMs: 60_000 };
    const { feed, states } = setup({ ...base, samples: [sample(-1, 10), sample(0, 20)] });
    await feed.load();
    const at = (ms: number, total: number): MetricsSample => ({ ...sample(0, total), at: new Date(T0 + ms).toISOString() });
    feed.onLive(live(at(5_000, 70)));
    let last = states.at(-1) as Extract<StripState, { kind: 'ok' }>;
    expect(last.summary.cpu.percent).toBe(70);
    expect(last.summary.spark).toEqual([10, 20, 70]); // provisional last point
    feed.onLive(live(at(10_000, 80)));
    last = states.at(-1) as Extract<StripState, { kind: 'ok' }>;
    expect(last.summary.spark).toEqual([10, 20, 80]); // still one provisional point, not one per sample
    feed.onLive(live(at(60_000, 30)));
    last = states.at(-1) as Extract<StripState, { kind: 'ok' }>;
    expect(last.summary.spark).toEqual([10, 20, 30]); // committed at the bucket spacing
    feed.onLive(live(at(65_000, 35)));
    last = states.at(-1) as Extract<StripState, { kind: 'ok' }>;
    expect(last.summary.spark).toEqual([10, 20, 30, 35]);
  });

  it('a slower older load does not overwrite a newer one', async () => {
    const resolvers: Array<(r: MetricsResponse) => void> = [];
    const states: StripState[] = [];
    const feed = createStripFeed({ fetch: () => new Promise((r) => resolvers.push(r)), onChange: (s) => states.push(s) });
    const first = feed.load();
    const second = feed.load();
    resolvers[1]!(response([sample(0, 50)]));
    await second;
    resolvers[0]!(response([sample(0, 1)]));
    await first;
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ kind: 'ok', summary: { cpu: { percent: 50 } } });
  });
});
