/**
 * WI-39: lifecycle action `notify` – renders the message with the hook's
 * placeholders, records it via the chat notifier (item, thread, reminder),
 * succeeds without waiting for the delivery, is idempotent per (run,
 * action) and fails permanently for an unknown channel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrchestratorError, type ChatNotifier, type WorkflowMessage } from '../core/index.js';
import { createEnv, drive, loadSnapshot, type LifecycleTestEnv } from './testing/helpers.js';

const CONFIG = `notifications:
  channels:
    - { id: team, type: slack, bot_token_env: SLACK_BOT_TOKEN, app_token_env: SLACK_APP_TOKEN, channel: C0123456789, allowed_users: [U0123456789] }
`;

const WF = `
id: wf
name: Coder WF
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
on_success:
  - id: tell
    type: notify
    channel: team
    message: '{item.title}: {result.message} ({run.id})'
    remind_after: 2h
    remind_while: { field: labels, operator: contains, value: needs-maintainer }
  - type: notify
    channel: team
    thread: new
    message: 'second'
`;

class RecordingChat implements ChatNotifier {
  readonly messages: WorkflowMessage[] = [];
  fail: Error | null = null;
  private readonly keys = new Map<string, number>();
  enqueueMessage(message: WorkflowMessage): { notificationId: number; created: boolean } {
    if (this.fail) throw this.fail;
    const known = this.keys.get(message.dedupeKey);
    if (known !== undefined) return { notificationId: known, created: false };
    this.messages.push(message);
    this.keys.set(message.dedupeKey, this.messages.length);
    return { notificationId: this.messages.length, created: true };
  }
}

describe('lifecycle action notify (WI-39)', () => {
  let env: LifecycleTestEnv;
  beforeEach(() => {
    env = createEnv();
  });
  afterEach(() => env.cleanup());

  it('records the rendered message with item, thread mode and reminder; the chain does not wait for Slack', async () => {
    const snapshot = await loadSnapshot(WF, 'wf', { 'config.yaml': CONFIG });
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const chat = new RecordingChat();
    const result = await drive(env.engine({ chat }).runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('succeeded');
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]).toMatchObject({
      channelId: 'team',
      workflowId: 'wf',
      workflowName: 'Coder WF',
      runId: run.id,
      item: { sourceId: 'repo_a', key: 'repo_a:7', title: 'Implement OAuth' },
      text: `Implement OAuth: All done (${run.id})`,
      thread: 'item',
      reminder: { afterMs: 2 * 3_600_000, filter: { field: 'labels', operator: 'contains', value: 'needs-maintainer' } },
    });
    expect(chat.messages[1]).toMatchObject({ thread: 'new', text: 'second' });
    expect(chat.messages[1]?.reminder).toBeUndefined();
    const [tell] = result.actions;
    expect(tell).toMatchObject({ type: 'notify', name: 'tell', status: 'succeeded', externalKey: '1', effect: { notification: { id: 1, channel: 'team' } } });
    // Idempotent per (run, journaled action): an attempt repeated after a crash finds the recorded message.
    expect(chat.messages[0]?.dedupeKey).toBe(`notify:${run.id}:${tell!.id}`);
    const again = await drive(env.engine({ chat }).runHook(run, 'on_success', snapshot), env.clock);
    expect(again.status).toBe('succeeded');
    expect(chat.messages).toHaveLength(2);
  });

  it('fails permanently when the channel is unknown (e.g. removed by a reload) or chat is unavailable', async () => {
    const snapshot = await loadSnapshot(WF, 'wf', { 'config.yaml': CONFIG });
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const chat = new RecordingChat();
    chat.fail = new OrchestratorError('notify_channel_unknown', 'Notification channel "team" is not configured');
    const result = await drive(env.engine({ chat }).runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.failedAction).toMatchObject({ type: 'notify', attempts: 1, lastError: expect.objectContaining({ code: 'lifecycle_notify_channel_unknown', retryable: false }) });
  });

  it('fails permanently without a chat notifier', async () => {
    const snapshot = await loadSnapshot(WF, 'wf', { 'config.yaml': CONFIG });
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const without = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(without.failedAction?.lastError).toMatchObject({ code: 'lifecycle_notify_unavailable', retryable: false });
  });
});
