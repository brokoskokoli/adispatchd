/**
 * End-to-end (WI-39): complete app with Fake-GitHub and a fake Slack (Web API
 * over the injected fetch, Socket Mode over an injected WebSocket factory).
 * A worker reports `needs_maintainer` → `notify` posts into the item thread →
 * a maintainer answers in the thread → the reply runs `on_reply` as a
 * lifecycle run (comment as identity, label removed) → ✅. The channel
 * status, the run detail (reply without text), the item history and the 409
 * while a reply waits are checked over the API.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';
import { FAKE_SLACK_URL, FakeSlack, FakeSocketFactory, messageEnvelope } from './notifications/testing/fake-slack.js';

const BOT = 'xoxb-3333333333-e2e-bot-token';
const APP = 'xapp-1-A0E2E-e2e-app-token';
const CHANNEL = 'C0123456789';
const USER = 'U0123456789';

let env: AppEnv;
const slack = new FakeSlack({ bot: BOT, app: APP });
const sockets = new FakeSocketFactory();

beforeAll(async () => {
  slack.users[USER] = 'Alex Example';
  env = await startAppEnv(
    {
      configExtra: [
        'notifications:',
        '  on: [retry_block_created, lifecycle_action_failed, recovery_failed]',
        '  channels:',
        '    - id: team',
        '      type: slack',
        '      bot_token_env: SLACK_BOT_TOKEN',
        '      app_token_env: SLACK_APP_TOKEN',
        `      channel: ${CHANNEL}`,
        `      allowed_users: [${USER}]`,
        '',
      ].join('\n'),
      app: {
        // Webhooks and Slack share this fetch; only the fake Slack is used here.
        notificationFetch: slack.fetch,
        slack: { baseUrl: FAKE_SLACK_URL, webSocket: sockets.create },
      },
    },
    (e) => {
      e.env.SLACK_BOT_TOKEN = BOT;
      e.env.SLACK_APP_TOKEN = APP;
      const worker = e.script(
        'worker.sh',
        `printf '{"schema_version":1,"result":"success","outcome":"needs_maintainer","message":"Which database should I use?"}' > "$ADISPATCH_RESULT_FILE"`,
      );
      writeFileSync(
        path.join(e.configDir, 'workflows', 'coder.yaml'),
        [
          'id: coder',
          'name: Coder',
          'trigger: { type: source, source: repo_a }',
          'identity: coder',
          'filter: { field: labels, operator: contains, value: ready }',
          'execute:',
          '  type: shell',
          `  command: ${worker}`,
          'on_start:',
          '  - type: source.update',
          '    labels: { add: [coding], remove: [ready] }',
          'on_result:',
          '  needs_maintainer:',
          '    - type: source.update',
          '      labels: { add: [needs-maintainer], remove: [coding] }',
          '    - type: notify',
          '      channel: team',
          '      message: "{item.title}: {result.message}"',
          '      remind_after: 4h',
          '      remind_while: { field: labels, operator: contains, value: needs-maintainer }',
          'on_reply:',
          '  - type: source.comment',
          '    identity: maintainer',
          '    message: "{reply.text}\\n\\n(answered in Slack by {reply.user_name})"',
          '  - type: source.update',
          '    labels: { add: [ready], remove: [needs-maintainer] }',
          '',
        ].join('\n'),
      );
    },
  );
});

afterAll(async () => env?.cleanup());

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('end-to-end: Slack thread per item and replies (WI-39)', () => {
  it('needs_maintainer → message in the item thread → reply in Slack → on_reply → ✅', async () => {
    // Socket Mode connected.
    await until(() => sockets.sockets.length === 1, 'socket created');
    sockets.last.hello();
    const channels = await env.request('GET', '/api/v1/notifications/channels');
    expect(channels.json.channels).toEqual([
      expect.objectContaining({ id: 'team', type: 'slack', channel: CHANNEL, replies: true, state: 'connected', allowedUsers: 1 }),
    ]);

    env.github.createIssue(REPO_A, { number: 11, title: 'Add caching', labels: ['ready'] });
    expect((await env.request('POST', '/api/v1/scheduler/resume', {})).status).toBe(200);
    await until(() => env.app.persistence.runs.list({ workflowId: 'coder' }).runs.length === 1, 'run started');
    const [run] = env.app.persistence.runs.list({ workflowId: 'coder' }).runs;
    await env.waitTerminal(run!.id);
    expect(env.github.labels(REPO_A, 11)).toEqual(['needs-maintainer']);

    // Head + message in the thread.
    await until(() => slack.messages.length === 2, 'thread posted');
    const [head, msg] = slack.messages;
    expect(head?.text).toContain('Add caching');
    expect(msg).toMatchObject({ threadTs: head?.ts, text: 'Add caching: Which database should I use?' });
    const notifyAction = env.app.persistence.actions.listForRun(run!.id).find((a) => a.type === 'notify');
    expect(notifyAction).toMatchObject({ status: 'succeeded', effect: { notification: { channel: 'team' } } });

    // The maintainer answers in the thread (the event comes twice, e.g. after a reconnect).
    const event = { channel: CHANNEL, ts: '1700000999.000001', thread_ts: head!.ts, user: USER, text: 'Use *Postgres* please &lt;3' };
    sockets.last.push(messageEnvelope('env-1', event));
    sockets.last.push(messageEnvelope('env-2', event));
    expect(sockets.last.acks()).toEqual(['env-1', 'env-2']);
    await until(() => env.app.persistence.runs.list({ triggerType: 'reply' }).runs.some((r) => r.status === 'completed'), 'reply run finished');
    const replyRuns = env.app.persistence.runs.list({ triggerType: 'reply' }).runs;
    expect(replyRuns).toHaveLength(1);
    const replyRun = await env.waitTerminal(replyRuns[0]!.id);
    expect(replyRun).toMatchObject({ status: 'completed', businessResult: 'success', workflowId: 'coder', sourceItemKey: 'repo_a:11' });

    const comment = env.github.comments(REPO_A, 11).at(-1);
    expect(comment?.body).toContain('Use *Postgres* please <3');
    expect(comment?.body).toContain('(answered in Slack by Alex Example)');
    expect(env.github.labels(REPO_A, 11)).toEqual(['ready']);
    await until(() => slack.reactions.some((r) => r.name === 'white_check_mark'), 'reaction');
    expect(slack.reactions.filter((r) => r.op === 'add').map((r) => r.name)).toEqual(['hourglass_flowing_sand', 'white_check_mark']);
    // The reminder was cancelled by the reply.
    expect(env.app.persistence.reminders.listDue(new Date(Date.now() + 5 * 3_600_000))).toEqual([]);

    // API: run detail shows the reply without its text, filterable trigger, item history.
    const detail = await env.request('GET', `/api/v1/runs/${replyRun.id}`);
    expect(detail.json).toMatchObject({ triggerType: 'reply', reply: { userId: USER, userName: 'Alex Example', status: 'done', channelId: 'team' } });
    expect(JSON.stringify(detail.json)).not.toContain('Postgres');
    const list = await env.request('GET', '/api/v1/runs?trigger=reply');
    expect(list.json.runs.map((r: { id: string }) => r.id)).toEqual([replyRun.id]);
    const history = await env.request('GET', '/api/v1/items/repo_a/11/history');
    expect(history.status).toBe(200);
    const replyEntry = history.json.entries.find((e: { kind: string }) => e.kind === 'reply');
    expect(replyEntry).toMatchObject({ kind: 'reply', user: 'Alex Example', status: 'done', runId: replyRun.id, workflowId: 'coder' });
    expect(JSON.stringify(history.json)).not.toContain('Postgres');
    // Notifications page: Slack delivery like a webhook delivery, plus the channel status.
    const notifications = await env.request('GET', '/api/v1/notifications');
    expect(notifications.json.notifications.some((n: { eventType: string; deliveries: Array<{ channelId: string; state: string }> }) =>
      n.eventType === 'workflow_notify' && n.deliveries[0]?.channelId === 'team' && n.deliveries[0]?.state === 'delivered')).toBe(true);
    expect(notifications.json.channels[0]).toMatchObject({ id: 'team', state: 'connected' });
    // No token anywhere in the API or the log.
    expect(JSON.stringify([detail.json, notifications.json, channels.json])).not.toMatch(/xoxb-|xapp-/);
    expect(JSON.stringify(env.logger.records)).not.toContain(BOT);
    expect(JSON.stringify(env.logger.records)).not.toContain(APP);
  });

  it('while a reply waits, the planning step reports locked (reply pending) and a manual start gets 409 reply_pending', async () => {
    // Independent of the first test: own issue, own thread, a reply recorded but not yet processed.
    const persistence = env.app.persistence;
    // Whatever ran before must not occupy the workflow limit (max_concurrent 1).
    for (const r of [11]) {
      try {
        env.github.setLabels(REPO_A, r, []);
      } catch {
        /* issue of the first test not created (test run alone) */
      }
    }
    await until(() => persistence.runs.countActive('coder') === 0, 'no active run of coder');
    env.github.createIssue(REPO_A, { number: 21, title: 'Pick a queue', labels: ['ready'] });
    const thread = persistence.threads.setThreadTs(
      persistence.threads.resolve({ channelId: 'team', workflowId: 'coder', sourceId: 'repo_a', itemKey: 'repo_a:21', chatChannel: CHANNEL, mode: 'item' }).id,
      '1700000999.100000',
    );
    persistence.replies.record({
      channelId: 'team',
      chatChannel: CHANNEL,
      ts: '1700000999.100001',
      threadId: thread.id,
      workflowId: 'coder',
      sourceId: 'repo_a',
      itemKey: 'repo_a:21',
      userId: USER,
      text: 'use the existing queue',
      configSnapshot: env.app.config.snapshotWorkflow('coder', 'repo_a'),
      status: 'pending',
    });
    const res = await env.request('POST', '/api/v1/workflows/coder/start', { item: 'repo_a:21' });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('reply_pending');
    // The scheduler does not start the item (it matches the filter) but reports why.
    await env.app.scheduler.planOnce();
    const candidate = env.app.scheduler.lastDiagnosis('coder')?.candidates.find((c) => c.itemKey === 'repo_a:21');
    expect(candidate).toMatchObject({ decision: 'locked', reason: expect.stringMatching(/^reply \d+ pending \(on_reply runs first\)$/) });
    expect(persistence.runs.list({ workflowId: 'coder', sourceItemKey: 'repo_a:21' }).runs).toEqual([]);
    // Processing the waiting reply runs on_reply first.
    env.app.controller.processReplies();
    await until(() => persistence.replies.listForItem('repo_a:21').every((r) => r.status !== 'pending' && r.status !== 'running'), 'reply processed');
    const [first] = persistence.runs.list({ sourceItemKey: 'repo_a:21' }).runs.reverse();
    expect(first?.triggerType).toBe('reply');
  });
});
