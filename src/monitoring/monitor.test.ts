import { describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger } from '../core/index.js';
import { DISABLED_RECHECK_MS, ResourceMonitor } from './monitor.js';
import { FakeProbe } from './testing/fake-probe.js';
import type { MetricsSample, MonitorSettings } from './types.js';

function setup(over: Partial<MonitorSettings> = {}) {
  const clock = new FakeClock('2026-10-19T10:00:00Z');
  const probe = new FakeProbe();
  probe.processList = [{ pid: 100, ppid: 1, cpu: 0, comm: 'node' }];
  const settings: MonitorSettings = { enabled: true, intervalMs: 10_000, retentionMs: 100_000, topProcesses: 5, minCpuPercent: 2, diskPaths: [], ...over };
  const published: MetricsSample[] = [];
  const monitor = new ResourceMonitor({
    probe,
    settings: () => settings,
    targets: () => ({ daemonPid: 100, runs: [] }),
    clock,
    timers: clock,
    logger: new MemoryLogger(),
    onSample: (s) => published.push(s),
  });
  return { clock, probe, settings, monitor, published };
}

describe('ResourceMonitor', () => {
  it('primes immediately, samples after min(interval, 5 s), then every interval; publishes every sample', async () => {
    const { clock, probe, monitor, published } = setup();
    monitor.start();
    await clock.advanceAsync(0);
    expect(probe.calls.processes).toBe(1);
    expect(monitor.list()).toEqual([]);
    await clock.advanceAsync(5_000);
    expect(probe.calls.processes).toBe(2);
    expect(monitor.list()).toHaveLength(1);
    await clock.advanceAsync(9_999);
    expect(probe.calls.processes).toBe(2);
    await clock.advanceAsync(1);
    expect(monitor.list()).toHaveLength(2);
    expect(published).toEqual(monitor.list());
    expect(monitor.latest()?.at).toBe('2026-10-19T10:00:15.000Z');
    await monitor.stop();
    await clock.advanceAsync(60_000);
    expect(probe.calls.processes).toBe(3);
  });

  it('keeps only `retention` worth of samples (ring buffer) and filters by `since`', async () => {
    const { clock, monitor } = setup({ retentionMs: 30_000 });
    monitor.start();
    await clock.advanceAsync(0);
    await clock.advanceAsync(5_000);
    for (let i = 0; i < 10; i++) await clock.advanceAsync(10_000);
    const list = monitor.list();
    expect(list.map((s) => s.at)).toEqual(['2026-10-19T10:01:15.000Z', '2026-10-19T10:01:25.000Z', '2026-10-19T10:01:35.000Z', '2026-10-19T10:01:45.000Z']);
    expect(monitor.list(new Date('2026-10-19T10:01:25.000Z')).map((s) => s.at)).toEqual(['2026-10-19T10:01:35.000Z', '2026-10-19T10:01:45.000Z']);
    await monitor.stop();
  });

  it('caps the buffer at maxSamples', async () => {
    const clock = new FakeClock('2026-10-19T10:00:00Z');
    const monitor = new ResourceMonitor({
      probe: new FakeProbe(),
      settings: () => ({ enabled: true, intervalMs: 5_000, retentionMs: 10 * 60_000, topProcesses: 5, minCpuPercent: 2, diskPaths: [] }),
      targets: () => ({ daemonPid: 1, runs: [] }),
      clock,
      timers: clock,
      maxSamples: 3,
    });
    await monitor.sampleNow();
    for (let i = 0; i < 5; i++) {
      clock.advance(5_000);
      await monitor.sampleNow();
    }
    expect(monitor.list()).toHaveLength(3);
  });

  it('never measures in parallel: sampleNow during a measurement returns the running one; the timer waits for it', async () => {
    const { clock, probe, monitor } = setup();
    let release!: () => void;
    probe.psGate = new Promise<void>((r) => {
      release = r;
    });
    const a = monitor.sampleNow();
    const b = monitor.sampleNow();
    expect(a).toBe(b);
    expect(monitor.busy).toBe(true);
    monitor.start(); // timer tick at 0 joins the running measurement
    await clock.advanceAsync(60_000);
    expect(probe.calls.processes).toBe(1);
    expect(probe.maxConcurrentPs).toBe(1);
    release();
    await a;
    probe.psGate = null;
    await clock.advanceAsync(10_000);
    expect(probe.maxConcurrentPs).toBe(1);
    expect(probe.calls.processes).toBeGreaterThan(1);
    await monitor.stop();
  });

  it('enabled: false stops sampling and clears the buffer; re-enabling primes again', async () => {
    const { clock, probe, settings, monitor } = setup();
    monitor.start();
    await clock.advanceAsync(0);
    await clock.advanceAsync(5_000);
    expect(monitor.list()).toHaveLength(1);
    settings.enabled = false;
    await clock.advanceAsync(10_000);
    expect(monitor.list()).toEqual([]);
    const calls = probe.calls.processes;
    await clock.advanceAsync(DISABLED_RECHECK_MS * 3);
    expect(probe.calls.processes).toBe(calls);
    settings.enabled = true;
    await clock.advanceAsync(DISABLED_RECHECK_MS);
    expect(probe.calls.processes).toBe(calls + 1); // priming
    expect(monitor.list()).toEqual([]);
    await clock.advanceAsync(5_000);
    expect(monitor.list()).toHaveLength(1);
    await monitor.stop();
  });

  it('a throwing probe does not stop the loop', async () => {
    const { clock, probe, monitor } = setup();
    probe.memory = async () => {
      throw new Error('boom');
    };
    monitor.start();
    await clock.advanceAsync(0);
    await clock.advanceAsync(5_000);
    await clock.advanceAsync(10_000);
    expect(probe.calls.processes).toBe(3);
    expect(monitor.list()).toEqual([]);
    await monitor.stop();
  });
});
