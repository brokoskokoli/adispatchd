/**
 * WI-24 over HTTP: dashboard info tiles (GET, throttled refresh POST with the
 * usual CSRF/Host/Origin rules, SSE `dashboard.info`) and the condition
 * status in the workflow views (SSE `workflow.conditions`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from './server.js';
import { connectSse, REPO_A, startAppEnv, type AppEnv } from './testing/helpers.js';

const SECRET = 'sekret-value-0123456789';

let env: AppEnv;
let counterFile: string;

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}

beforeAll(async () => {
  // Short manual-refresh throttle so the test does not wait 10 s of real time.
  env = await startAppEnv({ start: false, app: { dashboardInfo: { manualMinIntervalMs: 3_000 } } }, (e) => {
    counterFile = path.join(e.marks, 'info-count');
    const disk = e.script('disk.sh', `echo x >> "${counterFile}"\necho "87%"`);
    const broken = e.script('broken.sh', `echo "failed with ${SECRET}" >&2\nexit 2`);
    const cond = e.script('cond.sh', `echo "no credits for ${SECRET}" >&2\nexit 1`);
    writeFileSync(
      path.join(e.configDir, 'dashboard.yaml'),
      [
        'info:',
        '  - id: disk',
        '    title: Disk',
        '    type: percent',
        `    command: ${disk}`,
        '    cache: 1h',
        '    warn_above: 80',
        '    critical_above: 95',
        '  - id: broken',
        '    type: number',
        `    command: ${broken}`,
        '',
      ].join('\n'),
    );
    mkdirSync(path.join(e.configDir, 'scripts'), { recursive: true });
    writeFileSync(path.join(e.configDir, 'scripts', 'inside.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      path.join(e.configDir, 'workflows', 'gated.yaml'),
      [
        'id: gated',
        'trigger: { type: source, source: repo_a }',
        'filter: { field: labels, operator: contains, value: ready }',
        'conditions:',
        '  workflow:',
        `    - { name: Credits available, type: shell, command: ${cond}, timeout: 5s, cache: 30s }`,
        `    - { type: shell, command: ${cond}, args: [second] }`,
        '    - { type: shell, command: scripts/inside.sh }',
        '  item:',
        `    - { type: shell, command: ${cond}, args: ['{item.number}'] }`,
        'execute:',
        '  type: shell',
        '  command: /bin/true',
        '',
      ].join('\n'),
    );
    e.github.createIssue(REPO_A, { number: 7, title: 'Seven', labels: ['ready'] });
  });
  // Registered before the start: the first fetch happens right at readiness.
  env.app.redactor.add(SECRET);
  await env.app.start();
  await env.app.ready;
  await env.app.scheduler.whenIdle();
});

afterAll(async () => {
  await env.cleanup();
});

describe('dashboard info API (WI-24)', () => {
  it('lists the tiles with values fetched in the background at start', async () => {
    const tiles = await waitFor(async () => {
      const res = await env.request('GET', '/api/v1/dashboard/info');
      const list = res.json.info as Array<{ id: string; status: string }>;
      return list.every((t) => t.status !== 'pending') ? res.json : undefined;
    });
    expect(tiles.configured).toBe(true);
    expect(tiles.file).toBe('dashboard.yaml');
    expect(tiles.info).toEqual([
      expect.objectContaining({ id: 'disk', title: 'Disk', type: 'percent', value: 87, unit: '%', status: 'warn', stale: false }),
      expect.objectContaining({ id: 'broken', status: 'error', value: null, error: 'exit code 2: failed with [REDACTED]' }),
    ]);
    // Page views never run a script.
    const { readFileSync } = await import('node:fs');
    const runs = readFileSync(counterFile, 'utf8').trim().split('\n').length;
    for (let i = 0; i < 3; i++) await env.request('GET', '/api/v1/dashboard/info');
    expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(runs);
  });

  it('refresh POST: CSRF/Host/Origin protected, 404 for unknown tiles, throttled', async () => {
    const url = '/api/v1/dashboard/info/disk/refresh';
    const raw = (headers: Record<string, string>) => env.app.http.inject({ method: 'POST', url, headers });
    expect((await raw({})).statusCode).toBe(403);
    expect((await raw({ [CSRF_HEADER]: '1', host: 'evil.example.com' })).statusCode).toBe(421);
    expect((await raw({ [CSRF_HEADER]: '1', origin: 'http://evil.example.com' })).statusCode).toBe(403);
    expect((await raw({ [CSRF_HEADER]: '1', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await env.request('POST', '/api/v1/dashboard/info/nope/refresh', {})).status).toBe(404);
    expect((await env.request('POST', url, { extra: 1 })).status).toBe(400);
  });

  it('refresh POST starts a fetch and publishes dashboard.info over SSE', async () => {
    const sse = await connectSse(`${env.app.url}/api/v1/events`);
    try {
      // Wait out the (shortened) throttle after the start-up fetch.
      const res = await waitFor(async () => {
        const r = await env.request('POST', '/api/v1/dashboard/info/disk/refresh', {});
        return r.status === 202 ? r : undefined;
      }, 10_000);
      expect(res.json).toMatchObject({ accepted: true, tile: { id: 'disk' } });
      const msg = await sse.waitFor((m) => m.event === 'dashboard.info' && m.data.payload.id === 'disk' && m.data.payload.refreshing === false);
      expect(msg.data.payload).toMatchObject({ id: 'disk', value: 87, status: 'warn' });
      expect(Date.parse(msg.data.payload.nextAttemptAt)).toBeGreaterThan(Date.now());
      // Right after that fetch: throttled.
      const limited = await env.request('POST', '/api/v1/dashboard/info/disk/refresh', {});
      expect(limited.status).toBe(429);
      expect(limited.json.error.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    } finally {
      sse.close();
    }
  }, 20_000);

  it('lists dashboard.yaml among the configuration files', async () => {
    const res = await env.request('GET', '/api/v1/config/files');
    expect(res.json.files.map((f: { file: string }) => f.file)).toContain('dashboard.yaml');
  });
});

describe('workflow conditions in the API (WI-24)', () => {
  it('shows definitions with display names and the last status (redacted)', async () => {
    const view = await waitFor(async () => {
      const res = await env.request('GET', '/api/v1/workflows/gated');
      return res.json.conditions.workflow[0].last ? res.json : undefined;
    });
    expect(view.conditions.workflow).toEqual([
      expect.objectContaining({
        index: 0,
        name: 'Credits available',
        label: 'Credits available',
        timeoutMs: 5000,
        cacheMs: 30_000,
        last: expect.objectContaining({ status: 'not_now', exitCode: 1, cached: false, stderr: 'no credits for [REDACTED]' }),
      }),
      expect.objectContaining({ index: 1, name: null, label: expect.stringMatching(/cond\.sh second$/), last: expect.objectContaining({ status: 'skipped' }) }),
      // Inside the config dir: shown relative to it; outside: absolute.
      expect.objectContaining({ index: 2, label: 'scripts/inside.sh', displayCommand: 'scripts/inside.sh', command: path.join(env.configDir, 'scripts/inside.sh') }),
    ]);
    // Item conditions were not reached (the workflow conditions said "not now").
    expect(view.conditions.item).toEqual([expect.objectContaining({ index: 0, name: null, last: { at: expect.any(String), items: 0, ok: 0, notNow: 0, error: 0, notEvaluated: 0 } })]);
    expect(view.conditions.shellFilter).toBeNull();
    const list = await env.request('GET', '/api/v1/workflows');
    const gated = list.json.workflows.find((w: { id: string }) => w.id === 'gated');
    expect(gated.conditions.workflow[0].last.status).toBe('not_now');
  });
});
