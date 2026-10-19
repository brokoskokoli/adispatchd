import { describe, expect, it } from 'vitest';
import { downsample, mergeBucket } from './downsample.js';
import type { MetricsSample, ProcessGroup } from './types.js';

const T0 = Date.parse('2026-10-19T10:00:00Z');
const other = (name: string, cpu: number): ProcessGroup => ({ kind: 'other', label: name, name, cpuPercent: cpu, rssBytes: 100, count: 1 });

function sample(i: number, processes: ProcessGroup[], cpu = 10 * (i % 3)): MetricsSample {
  return {
    at: new Date(T0 + i * 5_000).toISOString(),
    cpu: { totalPercent: cpu, cores: 4, load: [i, i, i] },
    memory: { totalBytes: 1000, availableBytes: 100 * (i % 4) },
    disks: [{ path: '/data', freeBytes: 1000 - i, totalBytes: 2000 }],
    processes,
  };
}

describe('downsample (API payload bound)', () => {
  it('returns the samples unchanged when they fit', () => {
    const s = [0, 1, 2].map((i) => sample(i, []));
    expect(downsample(s, 10)).toEqual({ samples: s, bucketMs: null });
  });

  it('never returns more than maxPoints; buckets carry averages and the last timestamp', () => {
    const s = Array.from({ length: 4320 }, (_, i) => sample(i, [{ kind: 'daemon', label: 'adispatchd', cpuPercent: i % 2 === 0 ? 2 : 4, rssBytes: 10, count: 1 }]));
    const { samples, bucketMs } = downsample(s, 600);
    expect(samples.length).toBeLessThanOrEqual(600);
    expect(samples.length).toBeGreaterThan(500);
    expect(bucketMs).toBe(Math.ceil((4319 * 5_000 + 1) / 600));
    expect(samples.at(-1)!.at).toBe(s.at(-1)!.at);
    const mid = samples[100]!;
    expect(mid.processes[0]).toMatchObject({ kind: 'daemon', cpuPercent: 3 });
    expect(mid.cpu.totalPercent).toBeGreaterThan(0);
    expect(JSON.stringify(samples).length).toBeLessThan(JSON.stringify(s).length / 5);
  });

  it('merges groups: absent counts as 0, named foreign groups are capped and folded into Others', () => {
    const bucket = [
      sample(0, [other('a', 10), other('b', 8), other('c', 6), { kind: 'rest', label: 'Others', cpuPercent: 2, rssBytes: 5, count: 50 }]),
      sample(1, [other('a', 20), other('d', 40)]),
    ];
    const merged = mergeBucket(bucket, 2);
    expect(merged.at).toBe(bucket[1]!.at);
    expect(merged.processes.map((g) => [g.kind, g.name ?? g.label, g.cpuPercent])).toEqual([
      ['other', 'd', 20],
      ['other', 'a', 15],
      ['rest', 'Others', 1 + 4 + 3],
    ]);
    expect(merged.memory.availableBytes).toBe(50);
    expect(merged.disks).toEqual([{ path: '/data', totalBytes: 2000, freeBytes: 1000 }]); // mean of 1000 and 999, rounded
  });
});
