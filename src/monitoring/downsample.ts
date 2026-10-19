/**
 * Server-side downsampling of the resource monitor's samples (WI-23 review
 * M1): the API never returns more than `maxPoints` samples. Samples are
 * grouped into equal time buckets; every bucket becomes one sample with the
 * averages of its samples (process groups: mean over all samples of the
 * bucket, absent = 0). Named foreign groups are capped (largest first, the
 * rest folded into "Others") so the result stays small as well.
 */
import { REST_LABEL } from './sampler.js';
import type { MetricsSample, ProcessGroup } from './types.js';

/** Default and maximum number of points of an API response. */
export const DEFAULT_MAX_POINTS = 600;
export const MAX_POINTS = 2_000;
/** Named foreign groups kept per downsampled sample. */
export const MAX_NAMED_OTHERS_PER_BUCKET = 6;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function groupKey(g: ProcessGroup): string {
  if (g.kind === 'run') return `run:${g.runId ?? g.label}`;
  if (g.kind === 'other') return `other:${g.name ?? g.label}`;
  return g.kind;
}

/** Merge the samples of one bucket (oldest first) into one sample stamped with the last time. */
export function mergeBucket(bucket: readonly MetricsSample[], maxNamedOthers = MAX_NAMED_OTHERS_PER_BUCKET): MetricsSample {
  const n = bucket.length;
  const last = bucket[n - 1]!;
  if (n === 1) return last;
  const avg = (f: (s: MetricsSample) => number): number => bucket.reduce((sum, s) => sum + f(s), 0) / n;
  const disks = last.disks.map((d) => {
    const values = bucket.flatMap((s) => s.disks.filter((x) => x.path === d.path).map((x) => x.freeBytes));
    return { path: d.path, totalBytes: d.totalBytes, freeBytes: Math.round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)) };
  });
  const groups = new Map<string, ProcessGroup & { cpuSum: number; rssSum: number }>();
  for (const s of bucket) {
    for (const g of s.processes) {
      const key = groupKey(g);
      const cur = groups.get(key);
      if (cur) {
        cur.cpuSum += g.cpuPercent;
        cur.rssSum += g.rssBytes;
        cur.count = Math.max(cur.count, g.count);
        cur.label = g.label; // latest label
      } else {
        groups.set(key, { ...g, cpuSum: g.cpuPercent, rssSum: g.rssBytes });
      }
    }
  }
  const all: ProcessGroup[] = [...groups.values()].map(({ cpuSum, rssSum, ...g }) => ({ ...g, cpuPercent: round2(cpuSum / n), rssBytes: Math.round(rssSum / n) }));
  const named = all.filter((g) => g.kind === 'other').sort((a, b) => b.cpuPercent - a.cpuPercent);
  const folded = named.slice(maxNamedOthers);
  const processes = all.filter((g) => g.kind !== 'other' && g.kind !== 'rest');
  processes.push(...named.slice(0, maxNamedOthers));
  const rest = all.find((g) => g.kind === 'rest');
  if (rest || folded.length > 0) {
    const r: ProcessGroup = { kind: 'rest', label: REST_LABEL, cpuPercent: rest?.cpuPercent ?? 0, rssBytes: rest?.rssBytes ?? 0, count: rest?.count ?? 0 };
    for (const f of folded) {
      r.cpuPercent = round2(r.cpuPercent + f.cpuPercent);
      r.rssBytes += f.rssBytes;
      r.count += f.count;
    }
    processes.push(r);
  }
  return {
    at: last.at,
    cpu: {
      totalPercent: round2(avg((s) => s.cpu.totalPercent)),
      cores: last.cpu.cores,
      load: [0, 1, 2].map((i) => round2(avg((s) => s.cpu.load[i] ?? 0))) as [number, number, number],
    },
    memory: { totalBytes: last.memory.totalBytes, availableBytes: Math.round(avg((s) => s.memory.availableBytes)) },
    disks,
    // An empty process list (ps failed) in all samples stays empty.
    processes: bucket.every((s) => s.processes.length === 0) ? [] : processes,
  };
}

/**
 * At most `maxPoints` samples: unchanged if there are not more, otherwise one
 * merged sample per time bucket of `bucketMs` (aligned to the first sample).
 */
export function downsample(samples: readonly MetricsSample[], maxPoints = DEFAULT_MAX_POINTS): { samples: MetricsSample[]; bucketMs: number | null } {
  const limit = Math.max(1, Math.floor(maxPoints));
  if (samples.length <= limit) return { samples: [...samples], bucketMs: null };
  const from = Date.parse(samples[0]!.at);
  const to = Date.parse(samples[samples.length - 1]!.at);
  const bucketMs = Math.max(1, Math.ceil((to - from + 1) / limit));
  const out: MetricsSample[] = [];
  let bucket: MetricsSample[] = [];
  let index = -1;
  for (const s of samples) {
    const i = Math.floor((Date.parse(s.at) - from) / bucketMs);
    if (i !== index && bucket.length > 0) {
      out.push(mergeBucket(bucket));
      bucket = [];
    }
    index = i;
    bucket.push(s);
  }
  if (bucket.length > 0) out.push(mergeBucket(bucket));
  return { samples: out, bucketMs };
}
