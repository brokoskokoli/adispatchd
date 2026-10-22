import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, NOTIFICATION_EVENT_TYPES, SecretRedactor } from '../core/index.js';
import type { NotificationsConfig, WebhookChannelConfig } from '../config/index.js';
import { openTestPersistence } from '../persistence/testing/helpers.js';
import type { Persistence } from '../persistence/index.js';
import { NotificationService, summarize, type NotificationView } from './service.js';

const SECRET_URL = 'https://hooks.example.test/services/T000/SECRET-TOKEN-123';
const AUTH = 'Bearer super-secret-header-value';

function channel(extra: Partial<WebhookChannelConfig> = {}): WebhookChannelConfig {
  return { id: 'ops', type: 'webhook', url: SECRET_URL, urlEnv: null, headersEnv: { Authorization: 'HOOK_AUTH' }, on: [...NOTIFICATION_EVENT_TYPES], ...extra };
}

/** Yield to the event loop until `cond` holds (bounded). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!cond()) throw new Error('condition not reached');
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

describe('NotificationService', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;
  let calls: Call[];
  let responses: Array<number | 'network' | 'hang'>;
  let byRun: Map<string, Array<number | 'network' | 'hang'>>;
  let settings: NotificationsConfig;
  let logger: MemoryLogger;
  let redactor: SecretRedactor;
  let changes: NotificationView[];

  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const body = JSON.parse(String(init?.body)) as { payload?: { runId?: string } };
    const perRun = body.payload?.runId ? byRun.get(body.payload.runId) : undefined;
    const next = (perRun && perRun.length > 0 ? perRun.shift() : responses.shift()) ?? 200;
    if (next === 'network') throw new TypeError(`fetch failed for ${String(input)}`);
    if (next === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return new Response('ok', { status: next });
  };

  const create = (overrides: Partial<ConstructorParameters<typeof NotificationService>[0]> = {}) => {
    const svc = new NotificationService({
      repositories: p,
      settings: () => settings,
      env: { HOOK_AUTH: AUTH },
      fetch: fetchStub,
      clock,
      timers: clock,
      logger,
      redactor,
      retryDelaysMs: [1000, 5000],
      timeoutMs: 2000,
      onChange: (n) => changes.push(n),
      ...overrides,
    });
    return svc;
  };

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
    calls = [];
    responses = [];
    byRun = new Map();
    changes = [];
    settings = { on: [...NOTIFICATION_EVENT_TYPES], channels: [channel()] };
    redactor = new SecretRedactor();
    logger = new MemoryLogger(redactor.asRedactor);
  });
  afterEach(() => cleanup());

  it('persists synchronously and delivers asynchronously as JSON POST with headers', async () => {
    const svc = create();
    svc.start();
    svc.notify('retry_block_created', { workflowId: 'coder', itemKey: 'a:1', reason: '3 failures' });
    // Persisted before any network I/O happened.
    const [n] = p.notifications.list();
    expect(n?.eventType).toBe('retry_block_created');
    await svc.whenIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SECRET_URL);
    expect(calls[0]!.headers.Authorization).toBe(AUTH);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toMatchObject({ event: 'retry_block_created', payload: { workflowId: 'coder' } });
    expect(String(calls[0]!.body.text)).toContain('coder');
    const view = svc.get(n!.id)!;
    expect(view.deliveryState).toBe('delivered');
    expect(view.deliveries).toMatchObject([{ channelId: 'ops', state: 'delivered', attempts: 1, lastStatus: 200 }]);
    expect(changes.at(-1)?.deliveryState).toBe('delivered');
    await svc.stop();
  });

  it('a failing webhook never blocks notify; attempts are retried with backoff and stored', async () => {
    const svc = create();
    svc.start();
    byRun.set('r0', ['hang', 500, 503]);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) svc.notify('lifecycle_action_failed', { runId: `r${i}`, hook: 'on_success' });
    expect(Date.now() - t0).toBeLessThan(1000); // synchronous persistence only
    expect(p.notifications.list({ limit: 500 })).toHaveLength(20);
    const first = p.notifications.list({ limit: 500 }).at(-1)!;
    expect(first.payload.runId).toBe('r0');

    // First attempt hangs → timeout after 2 s (fake time); the others are delivered afterwards.
    await until(() => calls.length === 1);
    await clock.advanceAsync(2000);
    await svc.whenIdle();
    let d = p.notifications.listDeliveries(first.id)[0]!;
    expect(d).toMatchObject({ state: 'pending', attempts: 1 });
    expect(d.lastError).toMatch(/timed out/);
    expect(p.notifications.list({ limit: 500 }).filter((n) => n.deliveryState === 'delivered')).toHaveLength(19);

    // Retry after 1 s → HTTP 500, retry after further 5 s → HTTP 503 → final failure after 3 attempts.
    await clock.advanceAsync(1000);
    await svc.whenIdle();
    d = p.notifications.listDeliveries(first.id)[0]!;
    expect(d).toMatchObject({ state: 'pending', attempts: 2, lastStatus: 500 });
    await clock.advanceAsync(5000);
    await svc.whenIdle();
    d = p.notifications.listDeliveries(first.id)[0]!;
    expect(d).toMatchObject({ state: 'failed', attempts: 3, lastStatus: 503, nextAttemptAt: null });
    expect(p.notifications.get(first.id)!.deliveryState).toBe('failed');
    await svc.stop();
  });

  it('does not retry client errors and never stores or logs the webhook URL or header values', async () => {
    const svc = create();
    svc.start();
    responses = [404, 'network'];
    svc.notify('recovery_failed', { runId: 'r1', workflowId: 'wf', reason: 'pid unknown' });
    await svc.whenIdle();
    settings = { on: [...NOTIFICATION_EVENT_TYPES], channels: [channel({ id: 'second' })] };
    svc.notify('recovery_failed', { runId: 'r2' });
    await svc.whenIdle();
    const [second, first] = p.notifications.list();
    expect(p.notifications.listDeliveries(first!.id)[0]).toMatchObject({ state: 'failed', attempts: 1, lastStatus: 404 });
    const networkDelivery = p.notifications.listDeliveries(second!.id)[0]!;
    expect(networkDelivery.state).toBe('pending'); // network errors are retried
    expect(networkDelivery.lastError).toMatch(/webhook request failed/);
    const dump = JSON.stringify([p.notifications.list(), p.notifications.listDeliveries(first!.id), networkDelivery, logger.records]);
    expect(dump).not.toContain('SECRET-TOKEN-123');
    expect(dump).not.toContain('super-secret-header-value');
    await svc.stop();
  });

  it('marks deliveries with missing env configuration as failed without calling the network', async () => {
    settings = { on: [...NOTIFICATION_EVENT_TYPES], channels: [channel({ url: null, urlEnv: 'MISSING_URL' })] };
    const svc = create();
    svc.start();
    svc.notify('recovery_failed', {});
    await svc.whenIdle();
    expect(calls).toHaveLength(0);
    const [n] = p.notifications.list();
    expect(n!.deliveryState).toBe('failed');
    expect(n!.lastError).toMatch(/MISSING_URL/);
    await svc.stop();
  });

  it('respects enabled events and per-channel subscriptions', async () => {
    settings = { on: ['recovery_failed'], channels: [channel({ on: ['recovery_failed'] }), channel({ id: 'blocks', on: ['retry_block_created'] })] };
    const svc = create();
    svc.notify('retry_block_created', {}); // disabled globally → not stored
    expect(p.notifications.list()).toHaveLength(0);
    svc.notify('recovery_failed', {});
    const [n] = p.notifications.list();
    expect(p.notifications.listDeliveries(n!.id).map((d) => d.channelId)).toEqual(['ops']);
    // Not started: nothing delivered yet; start() picks up pending deliveries (e.g. after a restart).
    expect(calls).toHaveLength(0);
    svc.start();
    await svc.whenIdle();
    expect(calls).toHaveLength(1);
    await svc.stop();
  });

  it('manual retry re-queues failed deliveries', async () => {
    const svc = create({ retryDelaysMs: [] });
    svc.start();
    responses = [500];
    svc.notify('recovery_failed', {});
    await svc.whenIdle();
    const [n] = p.notifications.list();
    expect(n!.deliveryState).toBe('failed');
    expect(svc.retry(n!.id)?.requeued).toBe(1);
    await svc.whenIdle();
    expect(svc.get(n!.id)!.deliveryState).toBe('delivered');
    expect(svc.retry(9999)).toBeNull();
    await svc.stop();
  });

  it('never throws from notify, even if persistence fails', () => {
    const svc = create({ repositories: { notifications: { createWithDeliveries: () => { throw new Error('disk full'); } } as never } });
    expect(() => svc.notify('recovery_failed', {})).not.toThrow();
    expect(logger.records.some((r) => r.msg === 'failed to record notification')).toBe(true);
  });

  it('summarizes events', () => {
    expect(summarize('recovery_failed', { runId: 'r1', workflowId: 'wf', reason: 'x' })).toContain('r1');
    expect(summarize('lifecycle_action_failed', { runId: 'r1', hook: 'on_success', actionName: 'a' })).toContain('on_success');
    expect(summarize('retry_block_cleared', { blockId: 4, workflowId: 'wf', itemKey: 'repo_a:7', clearedBy: 'olga', runId: 'r2' })).toBe(
      '[adispatchd] Retry block 4 removed for workflow wf (item repo_a:7) by olga, lifecycle run r2',
    );
  });
});
