/**
 * `GET /api/v1/system/metrics` and SSE `system.metrics` (WI-23) against the
 * full app with a scripted OS probe; the run controller's worker PIDs are
 * attributed to their runs.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProbe } from '../monitoring/testing/fake-probe.js';
import { connectSse, startAppEnv, type AppEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

describe.runIf(supported)('system metrics API', () => {
  let env: AppEnv;
  const probe = new FakeProbe();

  beforeAll(async () => {
    probe.processList = [{ pid: process.pid, ppid: 1, cpu: 0, comm: 'node' }];
    env = await startAppEnv({ app: { monitoring: { probe, primeDelayMs: 60 * 60_000 } } }, (e) => {
      const worker = e.script('busy.sh', 'sleep 30');
      writeFileSync(path.join(e.configDir, 'workflows', 'busy.yaml'), `id: busy\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: ${worker}\n  cancel_grace: 300ms\n`);
    });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  // polling_interval of the test config is 1h → default interval capped at 60 s.
  it('reports settings, samples (with since) and attributes a running worker to its run', async () => {
    const empty = await env.request('GET', '/api/v1/system/metrics');
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ enabled: true, intervalMs: 60_000, retentionMs: 6 * 3_600_000 });

    const start = await env.request('POST', '/api/v1/workflows/busy/start', {});
    expect(start.status).toBe(202);
    const runId: string = start.json.run.id;
    await env.waitRun(runId, (r) => r.status === 'running');
    const procs = env.app.controller.supervisedProcesses();
    expect(procs).toEqual([{ runId, workflowId: 'busy', itemKey: null, pid: expect.any(Number), pgid: expect.any(Number) }]);
    const worker = procs[0]!;

    probe.processList = [
      { pid: process.pid, ppid: 1, cpu: 0, comm: 'node' },
      { pid: worker.pid, ppid: process.pid, pgid: worker.pgid, cpu: 0, comm: 'sh' },
    ];
    await env.app.monitor.sampleNow();
    probe.processList = [
      { pid: process.pid, ppid: 1, cpu: 1, comm: 'node' },
      { pid: worker.pid, ppid: process.pid, pgid: worker.pgid, cpu: 2, comm: 'sh' },
      { pid: worker.pid + 100_000, ppid: worker.pid, pgid: worker.pgid, cpu: 0, comm: 'sleep' },
    ];
    const sse = await connectSse(`${env.app.url}/api/v1/events`);
    try {
      await new Promise((r) => setTimeout(r, 1100)); // CPU deltas need wall time > 0
      const sample = await env.app.monitor.sampleNow();
      expect(sample).not.toBeNull();
      const msg = await sse.waitFor((m) => m.event === 'system.metrics');
      expect(msg.id).toBeNull(); // live only, not persisted
      expect(msg.data.payload).toEqual(JSON.parse(JSON.stringify(sample)));
    } finally {
      sse.close();
    }

    const res = await env.request('GET', '/api/v1/system/metrics');
    const samples = res.json.samples as Array<{ at: string; processes: Array<Record<string, unknown>> }>;
    expect(samples.length).toBeGreaterThanOrEqual(1);
    const last = samples[samples.length - 1]!;
    expect(last.processes.find((g) => g.kind === 'run')).toMatchObject({ runId, workflowId: 'busy', count: 2 });
    expect(last.processes.find((g) => g.kind === 'daemon')).toMatchObject({ label: 'adispatchd', count: 1 });

    const since = await env.request('GET', `/api/v1/system/metrics?since=${encodeURIComponent(last.at)}`);
    expect(since.json.samples).toEqual([]);
    expect((await env.request('GET', '/api/v1/system/metrics?since=yesterday')).status).toBe(400);
    expect((await env.request('GET', '/api/v1/system/metrics?foo=1')).status).toBe(400);

    await env.request('POST', `/api/v1/runs/${runId}/cancel`, {});
    await env.waitTerminal(runId);
    expect(env.app.controller.supervisedProcesses()).toEqual([]);
  }, 30_000);

  it('is subject to the Host allowlist like every GET', async () => {
    const res = await env.request('GET', '/api/v1/system/metrics', undefined, { host: 'evil.example:8787' });
    expect(res.status).toBe(421);
  });

  it('shows the monitoring settings in GET /api/v1/config', async () => {
    const res = await env.request('GET', '/api/v1/config');
    expect(res.json.config.global.monitoring).toEqual({ enabled: true, intervalMs: 60_000, retentionMs: 6 * 3_600_000, topProcesses: 5, minCpuPercent: 2 });
  });
});

describe.runIf(supported)('system metrics API with monitoring disabled', () => {
  let env: AppEnv;
  const probe = new FakeProbe();
  beforeAll(async () => {
    env = await startAppEnv({ configExtra: 'monitoring:\n  enabled: false\n  interval: 10s\n', app: { monitoring: { probe, primeDelayMs: 0 } } });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it('reports enabled: false and no samples; nothing is measured', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const res = await env.request('GET', '/api/v1/system/metrics');
    expect(res.json).toEqual({ enabled: false, intervalMs: 10_000, retentionMs: 6 * 3_600_000, samples: [] });
    expect(probe.calls.processes).toBe(0);
  });
});
