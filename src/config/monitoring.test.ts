import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

describe('monitoring (WI-23)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  const load = async (yaml: string) => {
    t = await createTempConfigDir({ ...BASE_FILES, 'config.yaml': yaml });
    return loadConfig(t.dir, { dataDir: t.dataDir });
  };

  it('defaults without a monitoring section (interval = polling interval, 5 s ≤ x ≤ 60 s)', async () => {
    const res = await load('scheduler: { polling_interval: 30s }\n');
    expect(res.ok && res.config.global.monitoring).toEqual({ enabled: true, intervalMs: 30_000, retentionMs: 6 * 3_600_000, topProcesses: 5, minCpuPercent: 2 });
    for (const [polling, interval] of [['1s', 5_000], ['10s', 10_000], ['2m', 60_000], ['1h', 60_000]] as const) {
      const r = await load(`scheduler: { polling_interval: ${polling} }\n`);
      expect(r.ok && r.config.global.monitoring.intervalMs, polling).toBe(interval);
    }
  });

  it('accepts explicit values', async () => {
    const res = await load('monitoring:\n  enabled: false\n  interval: 2m\n  retention: 1d\n  top_processes: 0\n  min_cpu_percent: 0.5\n');
    expect(res.ok && res.config.global.monitoring).toEqual({ enabled: false, intervalMs: 120_000, retentionMs: 86_400_000, topProcesses: 0, minCpuPercent: 0.5 });
  });

  it('rejects an interval below 5 s, too short/long retention, bad numbers and unknown keys', async () => {
    const errors = async (yaml: string): Promise<string[]> => {
      const r = await load(yaml);
      return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
    };
    expect(await errors('monitoring: { interval: 2s }\n')).toEqual(['monitoring.interval: Duration must be at least 5s']);
    expect(await errors('monitoring: { interval: 30s, retention: 4m }\n')).toEqual(['monitoring.retention: Must be at least 10 sampling intervals (10 × 30s)']);
    expect(await errors('monitoring: { interval: 5s, retention: 30d }\n')).toEqual(['monitoring.retention: Must be at most 20000 sampling intervals (20000 × 5s)']);
    expect((await errors('monitoring: { top_processes: -1, min_cpu_percent: -2 }\n')).sort()).toEqual([
      'monitoring.min_cpu_percent: Must be 0 or greater',
      'monitoring.top_processes: Must be 0 or greater',
    ]);
    const typo = await errors('monitoring: { intervall: 30s }\n');
    expect(typo).toHaveLength(1);
    expect(typo[0]).toContain('did you mean "interval"?');
  });
});
