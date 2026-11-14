/**
 * WI-39: intake of replies (what counts, exactly once, secrets), reactions,
 * the answer in the thread, author details and the Socket Mode connections
 * per app-token variable (reload).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor } from '../core/index.js';
import type { NotificationsConfig, SlackChannelConfig, WorkflowSnapshot } from '../config/index.js';
import type { Persistence } from '../persistence/index.js';
import { openTestPersistence } from '../persistence/testing/helpers.js';
import { ChatReplyService, type ReplyTarget } from './replies.js';
import { NotificationService } from './service.js';
import { SlackWebClient } from './slack-api.js';
import { replyPlainText, MAX_REPLY_TEXT_BYTES } from './slack-text.js';
import { FAKE_SLACK_URL, FakeSlack, FakeSocketFactory, messageEnvelope } from './testing/fake-slack.js';

const BOT = 'xoxb-2222222222-test-bot-token';
const APP = 'xapp-1-A0000-test-app-token';
const CHANNEL = 'C0123456789';
const USER = 'U0123456789';

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('ChatReplyService (WI-39)', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;
  let slack: FakeSlack;
  let settings: NotificationsConfig;
  let redactor: SecretRedactor;
  let logger: MemoryLogger;
  let sockets: FakeSocketFactory;
  let target: (workflowId: string, sourceId: string | null) => ReplyTarget;
  let woken: number;
  let notifications: NotificationService;
  let svc: ChatReplyService;

  const channel = (extra: Partial<SlackChannelConfig> = {}): SlackChannelConfig => ({
    id: 'team',
    type: 'slack',
    botTokenEnv: 'SLACK_BOT_TOKEN',
    appTokenEnv: 'SLACK_APP_TOKEN',
    channel: CHANNEL,
    allowedUsers: [USER],
    on: [],
    ...extra,
  });
  const snapshot = { schemaVersion: 1, workflow: { id: 'coder' } } as unknown as WorkflowSnapshot;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
    slack = new FakeSlack({ bot: BOT, app: APP });
    slack.users[USER] = 'Alex Example';
    settings = { on: [], channels: [channel()] };
    redactor = new SecretRedactor();
    logger = new MemoryLogger(redactor.asRedactor);
    sockets = new FakeSocketFactory();
    target = () => ({ snapshot });
    woken = 0;
    const api = new SlackWebClient({ fetch: slack.fetch, timers: clock, redactor, baseUrl: FAKE_SLACK_URL });
    notifications = new NotificationService({ repositories: p, settings: () => settings, env: { SLACK_BOT_TOKEN: BOT }, clock, timers: clock, logger, redactor, slack: api });
    svc = new ChatReplyService({
      repositories: p,
      settings: () => settings,
      target: (w, s) => target(w, s),
      notifications,
      slack: api,
      onReply: () => woken++,
      env: { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, OTHER_APP_TOKEN: APP },
      webSocket: sockets.create,
      clock,
      timers: clock,
      logger,
      redactor,
    });
  });
  afterEach(async () => {
    svc.stop();
    await notifications.stop();
    cleanup();
  });

  /** A thread of (team, coder, repo_a:7) whose head is `100.1`. */
  const thread = () => {
    const t = p.threads.resolve({ channelId: 'team', workflowId: 'coder', sourceId: 'repo_a', itemKey: 'repo_a:7', chatChannel: CHANNEL, mode: 'item' });
    return p.threads.setThreadTs(t.id, '100.1');
  };
  const reply = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, ts: '100.2', thread_ts: '100.1', user: USER, text: 'Go ahead with <https://example.test/docs|the docs>', ...extra });
  const handle = (id: string, event: Record<string, unknown>) => {
    const after = svc.handleEnvelope('SLACK_APP_TOKEN', messageEnvelope(id, event));
    after?.();
  };

  it('records a reply that counts exactly once, reacts ⏳ and wakes the controller', async () => {
    const t = thread();
    handle('e1', reply());
    handle('e2', reply()); // the same message again (Slack retry / reconnect)
    const recorded = p.replies.listForItem('repo_a:7');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      status: 'pending',
      channelId: 'team',
      chatChannel: CHANNEL,
      ts: '100.2',
      threadId: t.id,
      workflowId: 'coder',
      itemKey: 'repo_a:7',
      userId: USER,
      text: 'Go ahead with the docs (https://example.test/docs)',
      configSnapshot: snapshot,
    });
    expect(woken).toBe(1);
    await flush();
    expect(slack.reactions).toEqual([{ op: 'add', channel: CHANNEL, ts: '100.2', name: 'hourglass_flowing_sand' }]);
  });

  it('ignores (debug) foreign users, other channels, unknown threads, top-level messages, edits, deletes, bots', () => {
    thread();
    handle('a', reply({ user: 'U9999999999' }));
    handle('b', reply({ channel: 'C9999999999' }));
    handle('c', reply({ thread_ts: '999.9' }));
    handle('d', reply({ thread_ts: undefined }));
    handle('e', reply({ ts: '100.1' })); // the head itself
    handle('f', reply({ subtype: 'message_changed' }));
    handle('g', reply({ subtype: 'message_deleted' }));
    handle('h', reply({ subtype: 'bot_message', bot_id: 'B1' }));
    handle('i', reply({ bot_id: 'B0123' })); // own bot posting into the thread
    svc.handleEnvelope('OTHER_APP_TOKEN', messageEnvelope('j', reply())); // event of another connection
    svc.handleEnvelope('SLACK_APP_TOKEN', { envelope_id: 'k', type: 'events_api', payload: { type: 'event_callback', event: { type: 'reaction_added' } } });
    expect(p.replies.listForItem('repo_a:7')).toEqual([]);
    expect(woken).toBe(0);
    const reasons = logger.records.filter((r) => r.msg === 'reply ignored' || r.msg.startsWith('reply ignored')).map((r) => String(r.fields?.reason ?? r.msg));
    expect(reasons).toEqual([
      'user not in allowed_users',
      'other channel',
      'unknown thread',
      'not a reply in a thread',
      'not a reply in a thread',
      'subtype message_changed',
      'subtype message_deleted',
      'subtype bot_message',
      'bot message',
      'other channel',
      'reply ignored: not a message event',
    ]);
    expect(logger.records.filter((r) => r.msg === 'reply ignored').every((r) => r.level === 'debug')).toBe(true);
  });

  it('a reply with attached files counts with its text only; files without text are ignored', () => {
    thread();
    handle('f1', reply({ subtype: 'file_share', text: 'see screenshot', files: [{ id: 'F1', name: 'screen.png' }] }));
    handle('f2', reply({ ts: '100.3', subtype: 'file_share', text: '', files: [{ id: 'F2' }] }));
    const recorded = p.replies.listForItem('repo_a:7');
    expect(recorded.map((r) => [r.ts, r.text])).toEqual([['100.2', 'see screenshot']]);
    expect(logger.records.some((r) => r.fields?.reason === 'file without text')).toBe(true);
  });

  it('a reply cancels pending reminders – also when the workflow has no on_reply (P6, no reaction)', async () => {
    const t = thread();
    const n = p.notifications.createWithDeliveries('workflow_notify', {}, [{ channelId: 'team', threadId: t.id }]);
    p.reminders.create({ notificationId: n.notification.id, threadId: t.id, channelId: 'team', workflowId: 'coder', sourceId: 'repo_a', itemKey: 'repo_a:7', dueAt: clock.now(), filter: null });
    target = () => ({ ignore: "workflow 'coder' has no on_reply" });
    handle('e1', reply());
    expect(p.reminders.forNotification(n.notification.id)).toMatchObject({ state: 'cancelled', reason: 'reply received' });
    expect(p.replies.listForItem('repo_a:7')).toEqual([]);
    await flush();
    expect(slack.reactions).toEqual([]);
  });

  it('rejects secret-looking text before storing it: ❌ and an answer in the thread, nothing else', async () => {
    const t = thread();
    notifications.start();
    handle('e1', reply({ text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for it' }));
    const [rejected] = p.replies.listForItem('repo_a:7');
    expect(rejected).toMatchObject({ status: 'rejected', text: null, configSnapshot: null, reason: 'looks like it contains a secret (GitHub token ×1)' });
    expect(woken).toBe(0);
    await flush();
    await notifications.whenIdle();
    expect(slack.reactions.map((r) => `${r.op}:${r.name}`)).toEqual(['remove:hourglass_flowing_sand', 'add:x']);
    const answer = slack.messages.find((m) => m.threadTs === '100.1');
    expect(answer?.text).toBe(':x: Reply rejected: looks like it contains a secret (GitHub token ×1); nothing was done – please never post secrets.');
    expect(JSON.stringify(p.notifications.list())).not.toContain('ghp_abc');
    expect(JSON.stringify(logger.records)).not.toContain('ghp_abc');
    // A known secret value (e.g. the bot token) is refused as well.
    redactor.add('very-secret-value-1234');
    handle('e2', reply({ ts: '100.3', text: 'value very-secret-value-1234' }));
    expect(p.replies.listForItem('repo_a:7')[0]).toMatchObject({ ts: '100.3', status: 'rejected', reason: 'looks like it contains a secret (a known secret value)' });
    void t;
  });

  it('ignores replies to threads of a removed channel (log)', () => {
    thread();
    settings = { on: [], channels: [channel({ id: 'renamed' })] };
    handle('e1', reply());
    expect(p.replies.listForItem('repo_a:7')).toEqual([]);
    expect(logger.records.some((r) => r.level === 'info' && String(r.fields?.reason).includes("channel 'team', which is no longer configured"))).toBe(true);
  });

  it('describe: display name (cached; without users:read the user ID) and permalink', async () => {
    thread();
    handle('e1', reply());
    const [r] = p.replies.listForItem('repo_a:7');
    expect(await svc.describe(r!)).toEqual({ userName: 'Alex Example', permalink: `https://acme.slack.test/archives/${CHANNEL}/p1002` });
    await svc.describe(r!);
    expect(slack.callsOf('users.info')).toHaveLength(1);
    slack.usersScope = false;
    expect((await svc.describe({ ...r!, userId: 'U1111111111' })).userName).toBeNull();
  });

  it('finished: ✅ for done; ❌ and a short answer for failed', async () => {
    thread();
    notifications.start();
    handle('e1', reply());
    const [r] = p.replies.listForItem('repo_a:7');
    svc.finished(r!, 'done', null, 'run-1');
    svc.finished(r!, 'failed', 'action labels failed', 'run-1');
    await flush();
    await notifications.whenIdle();
    expect(slack.reactions.map((x) => `${x.op}:${x.name}`)).toEqual([
      'add:hourglass_flowing_sand',
      'remove:hourglass_flowing_sand',
      'add:white_check_mark',
      'remove:hourglass_flowing_sand',
      'add:x',
    ]);
    expect(slack.messages.map((m) => m.text)).toEqual([':x: The reply could not be processed (action labels failed). Lifecycle run run-1.']);
  });

  it('one Socket Mode connection per app-token variable; a reload only reconnects when the variables change', async () => {
    settings = { on: [], channels: [channel(), channel({ id: 'second', channel: 'C0000000002' }), channel({ id: 'send-only', appTokenEnv: null })] };
    svc.start();
    await flush();
    expect(sockets.sockets).toHaveLength(1);
    sockets.last.hello();
    expect(svc.status().map((s) => [s.id, s.state, s.replies])).toEqual([
      ['team', 'connected', true],
      ['second', 'connected', true],
      ['send-only', 'disabled', false],
    ]);
    // Reload with another channel ID on the same app: same connection.
    settings = { on: [], channels: [channel({ channel: 'C0000000003' })] };
    svc.refresh();
    expect(sockets.sockets).toHaveLength(1);
    // Another variable: new connection, the old one is closed.
    settings = { on: [], channels: [channel({ appTokenEnv: 'OTHER_APP_TOKEN' })] };
    svc.refresh();
    await flush();
    expect(sockets.sockets).toHaveLength(2);
    expect(sockets.sockets[0]?.closed).not.toBeNull();
    // Events arrive through the socket and are acknowledged after recording.
    thread();
    settings = { on: [], channels: [channel({ appTokenEnv: 'OTHER_APP_TOKEN' })] };
    sockets.last.hello();
    sockets.last.push(messageEnvelope('env-9', reply()));
    expect(sockets.last.acks()).toEqual(['env-9']);
    expect(p.replies.listForItem('repo_a:7')).toHaveLength(1);
  });
});

describe('replyPlainText (WI-39)', () => {
  it('converts Slack mrkdwn to plain text', () => {
    expect(replyPlainText('Hi <@U0123456789>, see <https://x.test/a|docs> and <https://x.test/b>; <#C0123456789|team> <!here> &lt;b&gt; &amp;').text).toBe(
      'Hi @U0123456789, see docs (https://x.test/a) and https://x.test/b; #team @here <b> &',
    );
    expect(replyPlainText('<mailto:a@example.test|a@example.test> <!subteam^S0123|@devs> <@U1|alex>').text).toBe('a@example.test @devs @alex');
  });

  it('neutralizes HTML comments (no smuggled markers) and control characters', () => {
    expect(replyPlainText('ok &lt;!-- adispatchd:run=x --&gt;\u0007').text).toBe('ok &lt;!-- adispatchd:run=x -->');
  });

  it('shortens to 8 KiB without splitting a character', () => {
    const long = 'ä'.repeat(10_000);
    const { text, truncated } = replyPlainText(long);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_REPLY_TEXT_BYTES);
    expect(text.endsWith(' […]')).toBe(true);
    expect(text.replace(' […]', '')).toMatch(/^ä+$/);
  });
});
