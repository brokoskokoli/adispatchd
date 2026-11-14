/**
 * WI-39: Slack channels of the notification service against a fake Slack –
 * thread per (workflow, item), order within a thread, retries with backoff
 * and `Retry-After`, orchestrator events in the item thread, reminders,
 * escaping and redaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor, type SourceAdapter, type WorkflowMessage } from '../core/index.js';
import type { NotificationsConfig, SlackChannelConfig } from '../config/index.js';
import { openTestPersistence } from '../persistence/testing/helpers.js';
import type { Persistence } from '../persistence/index.js';
import { FakeGitHub, createFakeGitHubSource } from '../sources/github/testing/index.js';
import { NotificationService } from './service.js';
import { SlackWebClient } from './slack-api.js';
import { FAKE_SLACK_URL, FakeSlack } from './testing/fake-slack.js';

const BOT = 'xoxb-1111111111-test-bot-token';
const CHANNEL = 'C0123456789';

function slackChannel(extra: Partial<SlackChannelConfig> = {}): SlackChannelConfig {
  return {
    id: 'team',
    type: 'slack',
    botTokenEnv: 'SLACK_BOT_TOKEN',
    appTokenEnv: 'SLACK_APP_TOKEN',
    channel: CHANNEL,
    allowedUsers: ['U0123456789'],
    on: ['retry_block_created', 'lifecycle_action_failed', 'recovery_failed'],
    ...extra,
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!cond()) throw new Error('condition not reached');
}

describe('NotificationService – Slack channels (WI-39)', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;
  let slack: FakeSlack;
  let settings: NotificationsConfig;
  let redactor: SecretRedactor;
  let logger: MemoryLogger;
  let github: FakeGitHub;
  let svc: NotificationService;

  const message = (extra: Partial<WorkflowMessage> = {}): WorkflowMessage => ({
    dedupeKey: `notify:run-1:${Math.random()}`,
    channelId: 'team',
    workflowId: 'coder',
    workflowName: 'Coder',
    runId: 'run-1',
    item: { sourceId: 'repo_a', key: 'repo_a:7', url: 'https://github.com/acme/app/issues/7', title: 'Fix <!channel> login & more' },
    text: 'Needs a maintainer: tests fail',
    thread: 'item',
    ...extra,
  });

  const create = (env: Record<string, string> = { SLACK_BOT_TOKEN: BOT }, sources?: (id: string) => SourceAdapter | undefined) =>
    new NotificationService({
      repositories: p,
      settings: () => settings,
      env,
      clock,
      timers: clock,
      logger,
      redactor,
      retryDelaysMs: [1_000, 5_000, 30_000],
      slack: new SlackWebClient({ fetch: slack.fetch, timers: clock, redactor, baseUrl: FAKE_SLACK_URL }),
      ...(sources ? { sources } : {}),
    });

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
    slack = new FakeSlack({ bot: BOT });
    settings = { on: ['retry_block_created', 'lifecycle_action_failed', 'recovery_failed'], channels: [slackChannel()] };
    redactor = new SecretRedactor();
    logger = new MemoryLogger(redactor.asRedactor);
    github = new FakeGitHub({ clock });
    github.createIssue('acme/app', { number: 7, title: 'Fix login', labels: ['needs-maintainer'] });
  });
  afterEach(async () => {
    await svc?.stop();
    cleanup();
  });

  it('first notify creates the thread (head + reply); later ones go into the same thread', async () => {
    svc = create();
    svc.start();
    const first = svc.enqueueMessage(message());
    expect(first.created).toBe(true);
    await svc.whenIdle();
    expect(slack.messages).toHaveLength(2);
    const [head, reply] = slack.messages;
    expect(head).toMatchObject({ channel: CHANNEL, threadTs: null });
    expect(head?.text).toContain('*<https://github.com/acme/app/issues/7|Fix &lt;!channel&gt; login &amp; more>*');
    expect(head?.text).toContain('repo_a:7 · workflow Coder (coder)');
    expect(head?.text).toContain('Reply in this thread');
    expect(reply).toMatchObject({ threadTs: head?.ts, text: 'Needs a maintainer: tests fail' });

    svc.enqueueMessage(message({ text: 'second', runId: 'run-2' }));
    svc.enqueueMessage(message({ text: 'third', runId: 'run-3' }));
    await svc.whenIdle();
    expect(slack.messages.slice(2).map((m) => [m.text, m.threadTs])).toEqual([
      ['second', head?.ts],
      ['third', head?.ts],
    ]);
    // thread: new starts another thread; another workflow has its own thread.
    svc.enqueueMessage(message({ text: 'fresh', thread: 'new' }));
    svc.enqueueMessage(message({ text: 'other workflow', workflowId: 'reviewer', workflowName: 'Reviewer' }));
    await svc.whenIdle();
    const heads = slack.messages.filter((m) => m.threadTs === null);
    expect(heads).toHaveLength(3);
    expect(slack.thread(heads[1]!.ts).map((m) => m.text)).toEqual(['fresh']);
    expect(slack.thread(heads[2]!.ts).map((m) => m.text)).toEqual(['other workflow']);
    // Exactly one delivery per message, attempts stored.
    const n = svc.get(first.notificationId)!;
    expect(n).toMatchObject({ eventType: 'workflow_notify', deliveryState: 'delivered' });
    expect(n.deliveries).toEqual([expect.objectContaining({ channelId: 'team', state: 'delivered', attempts: 1, messageTs: reply?.ts })]);
  });

  it('is idempotent per dedupe key and refuses unknown or webhook channels', () => {
    svc = create();
    const msg = message({ dedupeKey: 'notify:run-1:12' });
    const a = svc.enqueueMessage(msg);
    const b = svc.enqueueMessage(msg);
    expect(b).toEqual({ notificationId: a.notificationId, created: false });
    expect(() => svc.enqueueMessage(message({ channelId: 'nope' }))).toThrow(expect.objectContaining({ code: 'notify_channel_unknown' }));
    settings = { ...settings, channels: [...settings.channels, { id: 'ops', type: 'webhook', url: 'https://hooks.example.test/x', urlEnv: null, headersEnv: {}, on: [] }] };
    expect(() => svc.enqueueMessage(message({ channelId: 'ops' }))).toThrow(expect.objectContaining({ code: 'notify_channel_type' }));
  });

  it('two messages recorded before the first delivery get one head; a partial success does not post the head again', async () => {
    svc = create();
    svc.enqueueMessage(message({ text: 'one' }));
    svc.enqueueMessage(message({ text: 'two' }));
    // The very first call (the head) fails with 503: nothing is posted, the second message waits.
    slack.failNext('chat.postMessage', { status: 503 });
    svc.start();
    await svc.whenIdle();
    expect(slack.messages).toHaveLength(0);
    expect(slack.callsOf('chat.postMessage')).toHaveLength(1);
    clock.advance(1_000);
    svc.kick();
    await svc.whenIdle();
    expect(slack.messages.map((m) => m.text.split('\n')[0])).toEqual([expect.stringContaining(':speech_balloon:'), 'one', 'two']);

    // Now: head posted, reply fails → the retry posts only the reply.
    slack.messages.length = 0;
    svc.enqueueMessage(message({ text: 'three', thread: 'new' }));
    let calls = 0;
    const original = slack.fetch;
    const failSecond: typeof original = async (input, init) => {
      if (String(input).endsWith('chat.postMessage') && ++calls === 2) return new Response('{}', { status: 502 });
      return original(input, init);
    };
    svc = recreate(failSecond);
    svc.start();
    await svc.whenIdle();
    expect(slack.messages.map((m) => m.threadTs)).toEqual([null]);
    clock.advance(1_000);
    svc.kick();
    await svc.whenIdle();
    const head = slack.messages[0]!;
    expect(slack.messages.slice(1)).toEqual([expect.objectContaining({ text: 'three', threadTs: head.ts })]);
    expect(slack.messages.filter((m) => m.threadTs === null)).toHaveLength(1);
  });

  function recreate(fetch: typeof slack.fetch): NotificationService {
    void svc.stop();
    return new NotificationService({
      repositories: p,
      settings: () => settings,
      env: { SLACK_BOT_TOKEN: BOT },
      clock,
      timers: clock,
      logger,
      redactor,
      retryDelaysMs: [1_000, 5_000, 30_000],
      slack: new SlackWebClient({ fetch, timers: clock, redactor, baseUrl: FAKE_SLACK_URL }),
    });
  }

  it('Slack unreachable / 5xx / 429: recording is immediate, delivery retries with backoff and Retry-After; no token in errors or logs', async () => {
    svc = create();
    svc.start();
    slack.failNext('chat.postMessage', { network: `getaddrinfo ENOTFOUND slack.com (Authorization: Bearer ${BOT})` }, { status: 500 }, { status: 429, retryAfter: 20 });
    const { notificationId } = svc.enqueueMessage(message());
    // Recorded synchronously (the hook chain does not wait for Slack).
    expect(svc.get(notificationId)?.deliveries[0]).toMatchObject({ state: 'pending', attempts: 0 });
    await svc.whenIdle();
    let d = svc.get(notificationId)!.deliveries[0]!;
    expect(d).toMatchObject({ state: 'pending', attempts: 1 });
    expect(d.lastError).toContain('Slack API chat.postMessage failed: network');
    expect(d.lastError).not.toContain(BOT);
    expect(d.nextAttemptAt).toBe(new Date(clock.now().getTime() + 1_000).toISOString());
    clock.advance(1_000);
    svc.kick();
    await svc.whenIdle();
    d = svc.get(notificationId)!.deliveries[0]!;
    expect(d).toMatchObject({ attempts: 2, lastStatus: 500, lastError: 'Slack API chat.postMessage failed: http_500' });
    expect(d.nextAttemptAt).toBe(new Date(clock.now().getTime() + 5_000).toISOString());
    clock.advance(5_000);
    svc.kick();
    await svc.whenIdle();
    d = svc.get(notificationId)!.deliveries[0]!;
    // 429 with Retry-After: 20 s although the next backoff step would be 30 s → max(30 s, 20 s).
    expect(d).toMatchObject({ attempts: 3, lastStatus: 429, lastError: 'Slack API chat.postMessage failed: ratelimited' });
    expect(d.nextAttemptAt).toBe(new Date(clock.now().getTime() + 30_000).toISOString());
    clock.advance(30_000);
    svc.kick();
    await until(() => svc.get(notificationId)!.deliveries[0]!.state === 'delivered');
    expect(svc.get(notificationId)!.deliveries[0]!.attempts).toBe(4);
    expect(JSON.stringify(logger.records)).not.toContain(BOT);
    expect(JSON.stringify(svc.list())).not.toContain(BOT);
  });

  it('stop aborts a hanging Slack call: the delivery stays pending without a recorded attempt', async () => {
    let called = 0;
    const hanging: typeof slack.fetch = (_input, init) => {
      called++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    svc = new NotificationService({
      repositories: p,
      settings: () => settings,
      env: { SLACK_BOT_TOKEN: BOT },
      clock,
      timers: clock,
      logger,
      redactor,
      slack: new SlackWebClient({ fetch: hanging, timers: clock, redactor, baseUrl: FAKE_SLACK_URL, timeoutMs: 60_000 }),
    });
    svc.start();
    const { notificationId } = svc.enqueueMessage(message());
    await until(() => called === 1);
    const stopped = svc.stop(2_000);
    clock.advance(2_000);
    await stopped;
    expect(svc.get(notificationId)!.deliveries[0]).toMatchObject({ state: 'pending', attempts: 0, lastError: null });
    expect(p.threads.listForItem('repo_a:7')[0]?.threadTs).toBeNull();
  });

  it('Retry-After longer than the backoff is honoured', async () => {
    svc = create();
    svc.start();
    slack.failNext('chat.postMessage', { status: 429, retryAfter: 120 });
    const { notificationId } = svc.enqueueMessage(message());
    await svc.whenIdle();
    expect(svc.get(notificationId)!.deliveries[0]!.nextAttemptAt).toBe(new Date(clock.now().getTime() + 120_000).toISOString());
  });

  it('a missing bot token or a permanent Slack error fails the delivery at once (visible, retryable by hand)', async () => {
    svc = create({});
    svc.start();
    const { notificationId } = svc.enqueueMessage(message());
    await svc.whenIdle();
    expect(svc.get(notificationId)!.deliveries[0]).toMatchObject({
      state: 'failed',
      attempts: 1,
      lastError: 'Slack bot token is not set (environment variable SLACK_BOT_TOKEN)',
    });
    await svc.stop();
    svc = create();
    svc.start();
    slack.failNext('chat.postMessage', { error: 'not_in_channel' });
    const second = svc.enqueueMessage(message({ thread: 'new' }));
    await svc.whenIdle();
    expect(svc.get(second.notificationId)!.deliveries[0]).toMatchObject({ state: 'failed', lastError: 'Slack API chat.postMessage failed: not_in_channel' });
    expect(svc.retry(second.notificationId)?.requeued).toBe(1);
    await svc.whenIdle();
    expect(svc.get(second.notificationId)!.deliveryState).toBe('delivered');
  });

  it('orchestrator events with an item go into the thread of (workflow, item), others top-level; on filters apply', async () => {
    svc = create();
    svc.start();
    svc.enqueueMessage(message());
    await svc.whenIdle();
    const head = slack.messages[0]!;
    svc.notify('retry_block_created', { blockId: 3, workflowId: 'coder', itemKey: 'repo_a:7', reason: '3 crashes' });
    svc.notify('recovery_failed', { runId: 'r9', workflowId: 'nightly', sourceItemKey: null, reason: 'pid unknown' });
    svc.notify('retry_block_cleared', { blockId: 3, workflowId: 'coder', itemKey: 'repo_a:7' }); // not in `on`
    await svc.whenIdle();
    expect(slack.thread(head.ts).map((m) => m.text)).toEqual([
      'Needs a maintainer: tests fail',
      '[adispatchd] Retry block created for workflow coder (item repo_a:7): 3 crashes',
    ]);
    const topLevel = slack.messages.filter((m) => m.threadTs === null && m.ts !== head.ts);
    expect(topLevel.map((m) => m.text)).toEqual(['[adispatchd] Recovery of run r9 (workflow nightly) failed: pid unknown']);
    // An event for an item without a thread yet creates it (head without title, with the key).
    svc.notify('lifecycle_action_failed', { runId: 'r5', workflowId: 'coder', hook: 'on_success', actionName: 'labels', sourceItemKey: 'repo_a:8', sourceUrl: 'https://github.com/acme/app/issues/8' });
    await svc.whenIdle();
    const newHead = slack.messages.filter((m) => m.threadTs === null).at(-1)!;
    expect(newHead.text).toContain('*<https://github.com/acme/app/issues/8|repo_a:8>*');
    expect(slack.thread(newHead.ts)).toHaveLength(1);
  });

  describe('reminders', () => {
    const adapter = () => createFakeGitHubSource(github, { sourceId: 'repo_a', owner: 'acme', repository: 'app', identity: 'maintainer', clock });
    const sources = () => (id: string) => (id === 'repo_a' ? adapter() : undefined);
    const filter = { field: 'labels', operator: 'contains' as const, value: 'needs-maintainer' };

    it('comes exactly once after remind_after while remind_while holds', async () => {
      svc = create(undefined, sources());
      svc.start();
      svc.enqueueMessage(message({ reminder: { afterMs: 4 * 3_600_000, filter } }));
      await svc.whenIdle();
      const head = slack.messages[0]!;
      clock.advance(4 * 3_600_000 - 1);
      svc.kick();
      await svc.whenIdle();
      expect(slack.thread(head.ts)).toHaveLength(1);
      clock.advance(1);
      svc.kick();
      await until(() => slack.thread(head.ts).length === 2);
      expect(slack.thread(head.ts)[1]?.text).toBe(':alarm_clock: Reminder: Needs a maintainer: tests fail');
      clock.advance(24 * 3_600_000);
      svc.kick();
      await svc.whenIdle();
      expect(slack.thread(head.ts)).toHaveLength(2);
      expect(p.reminders.listDue(clock.now())).toEqual([]);
    });

    it('a source that does not answer cannot hold up the deliveries: skipped after the timeout, the next message goes out', async () => {
      let reads = 0;
      const stuck = {
        ...adapter(),
        getItem: (_id: string, options?: { signal?: AbortSignal }) => {
          reads++;
          return new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        },
      } as unknown as SourceAdapter;
      svc = create(undefined, () => stuck);
      svc.start();
      const a = svc.enqueueMessage(message({ reminder: { afterMs: 60_000, filter } }));
      await svc.whenIdle();
      const before = slack.messages.length;
      clock.advance(60_000);
      svc.kick();
      await until(() => reads === 1);
      svc.enqueueMessage(message({ text: 'meanwhile' }));
      clock.advance(15_000);
      await until(() => slack.messages.length === before + 1);
      expect(slack.messages.at(-1)?.text).toBe('meanwhile');
      expect(p.reminders.forNotification(a.notificationId)).toMatchObject({ state: 'skipped', reason: 'item could not be evaluated within 15000 ms' });
    });

    it('is skipped when the item no longer matches, when the filter is unknown, and after a reply', async () => {
      svc = create(undefined, sources());
      svc.start();
      const a = svc.enqueueMessage(message({ reminder: { afterMs: 60_000, filter } }));
      await svc.whenIdle();
      github.setLabels('acme/app', 7, []);
      clock.advance(60_000);
      svc.kick();
      await svc.whenIdle();
      expect(p.reminders.forNotification(a.notificationId)).toMatchObject({ state: 'skipped', reason: 'item no longer matches remind_while' });

      // unknown: the source is not available.
      await svc.stop();
      svc = create(undefined, () => undefined);
      svc.start();
      const b = svc.enqueueMessage(message({ reminder: { afterMs: 60_000, filter } }));
      await svc.whenIdle();
      clock.advance(60_000);
      svc.kick();
      await svc.whenIdle();
      expect(p.reminders.forNotification(b.notificationId)).toMatchObject({ state: 'skipped', reason: "source 'repo_a' is not available" });
      expect(logger.records.some((r) => r.msg === 'reminder skipped' && r.level === 'warn')).toBe(true);

      // a reply in the thread cancels it.
      const c = svc.enqueueMessage(message({ reminder: { afterMs: 60_000, filter: null } }));
      const thread = p.reminders.forNotification(c.notificationId)!.threadId;
      p.reminders.cancelForThread(thread, 'reply received');
      clock.advance(60_000);
      svc.kick();
      await svc.whenIdle();
      expect(slack.messages.filter((m) => m.text.startsWith(':alarm_clock:'))).toHaveLength(0);
      expect(p.reminders.forNotification(c.notificationId)).toMatchObject({ state: 'cancelled' });
    });
  });
});
