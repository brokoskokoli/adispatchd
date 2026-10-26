import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import type { DashboardConfig, DashboardInfoConfig } from '../config/index.js';
import type { ShellCheckResult, ShellCheckSpec } from '../filters/index.js';
import { DashboardInfoService, INFO_ENV, type InfoScriptContext, type InfoTileView } from './service.js';

function tile(id: string, extra: Partial<DashboardInfoConfig> = {}): DashboardInfoConfig {
  return {
    id,
    title: id,
    type: 'number',
    command: `/scripts/${id}.sh`,
    args: [],
    env: {},
    timeoutMs: 15_000,
    cacheMs: 60_000,
    unit: null,
    thresholds: { warnAbove: null, criticalAbove: null, warnBelow: null, criticalBelow: null },
    ...extra,
  };
}

function ok(stdout: string, partial: Partial<ShellCheckResult> = {}): ShellCheckResult {
  return {
    value: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: '',
    outputTruncated: false,
    startedAt: new Date(0).toISOString(),
    durationMs: 5,
    cached: false,
    ...partial,
  };
}

interface Call {
  spec: ShellCheckSpec;
  context: InfoScriptContext;
  signal: AbortSignal;
  resolve(r: ShellCheckResult): void;
}

/** Executor whose executions are resolved by the test. */
function controlledExecutor(): { calls: Call[]; executor: (s: ShellCheckSpec, c: InfoScriptContext, sig: AbortSignal) => Promise<ShellCheckResult> } {
  const calls: Call[] = [];
  return {
    calls,
    executor: (spec, context, signal) =>
      new Promise<ShellCheckResult>((resolve) => {
        calls.push({ spec, context, signal, resolve });
        signal.addEventListener('abort', () => resolve(ok('', { value: 'unknown', exitCode: null, error: 'aborted' })), { once: true });
      }),
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

describe('DashboardInfoService (WI-24)', () => {
  const services: DashboardInfoService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.stop();
  });

  function create(dashboard: { current: DashboardConfig | null }, extra: Partial<ConstructorParameters<typeof DashboardInfoService>[0]> = {}) {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const ctl = controlledExecutor();
    const changes: InfoTileView[] = [];
    const service = new DashboardInfoService({
      dashboard: () => dashboard.current,
      configDir: () => '/cfg',
      dataDir: '/data',
      executor: ctl.executor,
      clock,
      timers: clock,
      onChange: (t) => changes.push(t),
      ...extra,
    });
    services.push(service);
    return { service, clock, calls: ctl.calls, changes };
  }

  it('never runs anything before start; at start fetches all tiles with at most 2 in parallel', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a'), tile('b'), tile('c')] } };
    const { service, calls } = create(cfg);
    expect(service.list().map((t) => t.status)).toEqual(['pending', 'pending', 'pending']);
    expect(calls).toHaveLength(0);
    service.start();
    expect(calls.map((c) => c.context.info.id)).toEqual(['a', 'b']);
    expect(service.list().map((t) => t.refreshing)).toEqual([true, true, true]);
    calls[0]?.resolve(ok('1'));
    await flush();
    expect(calls.map((c) => c.context.info.id)).toEqual(['a', 'b', 'c']);
    expect(service.get('a')).toMatchObject({ value: 1, status: 'ok', updatedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:01:00.000Z', refreshing: false });
    // Execution settings: config dir as cwd, context, env.
    expect(calls[0]?.spec).toMatchObject({ command: '/scripts/a.sh', cwd: '/cfg', timeoutMs: 15_000 });
    expect(calls[0]?.spec.env).toMatchObject({ [INFO_ENV.id]: 'a', [INFO_ENV.configDir]: '/cfg', [INFO_ENV.dataDir]: '/data' });
    expect(calls[0]?.context).toEqual({ schema_version: 1, kind: 'dashboard_info', info: { id: 'a', type: 'number' }, config_dir: '/cfg', data_dir: '/data' });
  });

  it('refetches in the background when the cache expires, never twice at the same time', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a', { cacheMs: 30_000 })] } };
    const { service, clock, calls } = create(cfg);
    service.start();
    calls[0]?.resolve(ok('5'));
    await flush();
    clock.advance(29_999);
    expect(calls).toHaveLength(1);
    clock.advance(1);
    expect(calls).toHaveLength(2);
    // Still running: further expiry or manual refresh does not start a second execution.
    clock.advance(120_000);
    expect(calls).toHaveLength(2);
    expect(service.refresh('a')).toMatchObject({ ok: true, alreadyRunning: true });
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(ok('6'));
    await flush();
    expect(service.get('a')?.value).toBe(6);
  });

  it('keeps the last valid value on errors (stale), with a short redacted message, and retries after min(cache, 60s)', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a', { cacheMs: 600_000, thresholds: { warnAbove: 80, criticalAbove: 95, warnBelow: null, criticalBelow: null } })] } };
    const { service, clock, calls } = create(cfg, { redact: (s) => s.replaceAll('hunter2', '[REDACTED]') });
    service.start();
    calls[0]?.resolve(ok('85'));
    await flush();
    expect(service.get('a')).toMatchObject({ value: 85, status: 'warn' });
    clock.advance(600_000);
    calls[1]?.resolve(ok('', { value: 'unknown', exitCode: 3, error: 'check error: exit code 3', stderr: 'token hunter2 rejected\nmore' }));
    await flush();
    expect(service.get('a')).toMatchObject({
      value: 85,
      status: 'error',
      stale: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      error: 'exit code 3: token [REDACTED] rejected',
      nextAttemptAt: '2026-01-01T00:11:00.000Z',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
    clock.advance(59_999);
    expect(calls).toHaveLength(2);
    clock.advance(1);
    expect(calls).toHaveLength(3);
    calls[2]?.resolve(ok('99'));
    await flush();
    expect(service.get('a')).toMatchObject({ value: 99, status: 'critical', stale: false });
    expect(service.get('a')?.error).toBeUndefined();
  });

  it('treats exit 1, timeouts and unparsable output as errors', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a'), tile('b'), tile('c', { type: 'percent' })] } };
    const { service, calls } = create(cfg, { maxParallel: 3 });
    service.start();
    calls[0]?.resolve(ok('', { value: false, exitCode: 1 }));
    calls[1]?.resolve(ok('', { value: 'unknown', exitCode: null, timedOut: true, error: 'timed out after 15000ms' }));
    calls[2]?.resolve(ok('120'));
    await flush();
    expect(service.list().map((t) => [t.status, t.error, t.value])).toEqual([
      ['error', 'exit code 1', null],
      ['error', 'timed out after 15000ms', null],
      ['error', 'percent value 120 is outside 0–100', null],
    ]);
    expect(service.get('c')?.unit).toBe('%');
  });

  it('redacts text values', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('t', { type: 'text' })] } };
    const { service, calls } = create(cfg, { redact: (s) => s.replaceAll('hunter2', '[REDACTED]') });
    service.start();
    calls[0]?.resolve(ok('deployed with hunter2'));
    await flush();
    expect(service.get('t')?.value).toBe('deployed with [REDACTED]');
  });

  it('throttles manual refreshes per tile and globally', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a'), tile('b')] } };
    const { service, clock, calls } = create(cfg, { manualMinIntervalMs: 10_000, manualPerMinute: 2 });
    service.start();
    calls[0]?.resolve(ok('1'));
    calls[1]?.resolve(ok('2'));
    await flush();
    expect(service.refresh('a')).toEqual({ ok: false, reason: 'rate_limited', retryAfterMs: 10_000 });
    expect(service.refresh('nope')).toEqual({ ok: false, reason: 'not_found' });
    clock.advance(10_000);
    expect(service.refresh('a')).toMatchObject({ ok: true, alreadyRunning: false });
    expect(calls).toHaveLength(3);
    calls[2]?.resolve(ok('3'));
    await flush();
    expect(service.refresh('b')).toMatchObject({ ok: true });
    calls[3]?.resolve(ok('4'));
    await flush();
    clock.advance(10_000);
    // Global limit: 2 manual refreshes per minute.
    expect(service.refresh('a')).toMatchObject({ ok: false, reason: 'rate_limited' });
    clock.advance(50_000);
    expect(service.refresh('a')).toMatchObject({ ok: true });
  });

  it('on reload keeps unchanged tiles, refetches changed and new ones, drops removed ones', async () => {
    const cfg: { current: DashboardConfig | null } = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a'), tile('b'), tile('c')] } };
    const { service, calls } = create(cfg, { maxParallel: 3 });
    service.start();
    for (const [i, c] of calls.entries()) c.resolve(ok(String(i + 1)));
    await flush();
    cfg.current = { file: 'dashboard.yaml', layout: null, info: [tile('a'), tile('b', { cacheMs: 120_000 }), tile('d')] };
    service.sync();
    expect(service.list().map((t) => [t.id, t.value, t.refreshing])).toEqual([
      ['a', 1, false],
      ['b', null, true],
      ['d', null, true],
    ]);
    expect(calls.slice(3).map((c) => c.context.info.id)).toEqual(['b', 'd']);
    // A result of a replaced tile's old execution is discarded.
    cfg.current = { file: 'dashboard.yaml', layout: null, info: [tile('a')] };
    service.sync();
    calls[3]?.resolve(ok('42'));
    await flush();
    expect(service.list().map((t) => t.id)).toEqual(['a']);
    expect(calls[4]?.signal.aborted).toBe(true);
    cfg.current = null;
    service.sync();
    expect(service.configured).toBe(false);
    expect(service.list()).toEqual([]);
  });

  it('a changed tile waits until the old (killed) execution settled – no overlapping processes', async () => {
    const cfg: { current: DashboardConfig | null } = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a')] } };
    // Executor that ignores the abort for a while (like a process in its kill grace period).
    const calls: Array<{ id: string; resolve(r: ShellCheckResult): void; signal: AbortSignal }> = [];
    const { service } = create(cfg, {
      executor: (_spec, context, signal) => new Promise<ShellCheckResult>((resolve) => calls.push({ id: context.info.id, resolve, signal })),
    });
    service.start();
    expect(calls).toHaveLength(1);
    cfg.current = { file: 'dashboard.yaml', layout: null, info: [tile('a', { cacheMs: 120_000 })] };
    service.sync();
    expect(calls[0]?.signal.aborted).toBe(true);
    // Old process still finishing: the new definition is not started yet, but shown as refreshing.
    expect(calls).toHaveLength(1);
    expect(service.get('a')).toMatchObject({ refreshing: true, value: null });
    expect(service.refresh('a')).toMatchObject({ ok: true, alreadyRunning: true });
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(ok('', { value: 'unknown', exitCode: null, signal: 'SIGKILL', error: 'aborted' }));
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(ok('5'));
    await flush();
    expect(service.get('a')).toMatchObject({ value: 5, status: 'ok' });
    expect(service.get('a')).not.toHaveProperty('error');
  });

  it('refuses manual refreshes after stop', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a')] } };
    const { service, calls } = create(cfg);
    service.start();
    calls[0]?.resolve(ok('1'));
    await flush();
    await service.stop();
    expect(service.refresh('a')).toEqual({ ok: false, reason: 'stopped' });
  });

  it('reports changes (SSE) and stops cleanly', async () => {
    const cfg = { current: { file: 'dashboard.yaml', layout: null, info: [tile('a')] } };
    const { service, calls, changes } = create(cfg);
    service.start();
    expect(changes.map((c) => [c.id, c.refreshing])).toEqual([['a', true]]);
    calls[0]?.resolve(ok('7'));
    await flush();
    expect(changes.at(-1)).toMatchObject({ id: 'a', value: 7, refreshing: false });
    await service.stop();
    expect(service.refresh('a')).toMatchObject({ ok: false, reason: 'stopped' });
  });
});

describe('DashboardInfoService – real scripts (WI-24)', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('runs scripts without a shell, with minimal env, in the config dir, and kills them on timeout', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'orch-info-'));
    const script = (name: string, body: string): string => {
      const file = path.join(root as string, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const env = script('env.sh', 'echo "$(pwd)|${HOST_SECRET:-unset}|$EXTRA|$1|$ADISPATCH_DATA_DIR"');
    const slow = script('slow.sh', 'sleep 30');
    const config: DashboardConfig = {
      file: 'dashboard.yaml',
      layout: null,
      info: [
        tile('env', { type: 'text', command: env, args: ['$(not expanded)'], env: { EXTRA: 'x1' } }),
        tile('slow', { command: slow, timeoutMs: 300 }),
      ],
    };
    const service = new DashboardInfoService({
      dashboard: () => config,
      configDir: () => root as string,
      dataDir: path.join(root, 'data'),
      hostEnv: { PATH: process.env.PATH, HOST_SECRET: 'leak' },
    });
    service.start();
    await service.whenIdle();
    const real = (await import('node:fs')).realpathSync(root);
    expect(service.get('env')?.value).toBe(`${real}|unset|x1|$(not expanded)|${path.join(root, 'data')}`);
    expect(service.get('slow')).toMatchObject({ status: 'error', error: expect.stringMatching(/^timed out after 300ms/) });
    await service.stop();
  }, 20_000);
});
