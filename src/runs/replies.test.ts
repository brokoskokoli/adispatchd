/**
 * WI-39: reply runs (trigger `reply`) – `reply_check` + `on_reply` as a
 * lifecycle run under the item lock, waiting behind an active run (FIFO),
 * no overtaking by new runs (P1), rejection, check errors with manual retry,
 * a vanished item and recovery. Real shell scripts, Fake-GitHub.
 */
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatReplyFeedback, ChatReplyRef, ReplyOutcome } from '../core/index.js';
import type { WorkflowSnapshot } from '../config/index.js';
import { LockConflictError } from '../persistence/index.js';
import { ISSUE, ITEM_KEY, REPO, createRunsEnv, waitForRun, type RunsTestEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

const ON_REPLY = `
on_reply:
  - id: answer
    type: source.comment
    identity: maintainer
    message: 'Answer from {reply.user_name} ({reply.user}, {run.trigger}): {reply.text}'
  - id: unlabel
    type: source.update
    labels: { remove: [needs-maintainer] }
`;

function yaml(command: string, extra = ON_REPLY): string {
  return `
id: wf
name: Coder
trigger: { type: source, source: repo_a }
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
${extra}`;
}

/** Records the chat feedback of the controller. */
class FakeChat implements ChatReplyFeedback {
  readonly finishedCalls: Array<{ id: number; outcome: ReplyOutcome; detail: string | null; runId: string | null }> = [];
  async describe(): Promise<{ userName: string | null; permalink: string | null }> {
    return { userName: 'Alex', permalink: 'https://acme.slack.test/archives/C0123456789/p1' };
  }
  finished(reply: ChatReplyRef, outcome: ReplyOutcome, detail: string | null, runId: string | null): void {
    this.finishedCalls.push({ id: reply.id, outcome, detail, runId });
  }
}

describe.runIf(supported)('RunController – reply runs (WI-39)', () => {
  let env: RunsTestEnv;
  let chat: FakeChat;
  let threadId: number;
  let seq = 0;

  beforeEach(() => {
    env = createRunsEnv();
    env.github.setLabels(REPO, ISSUE, ['needs-maintainer']);
    chat = new FakeChat();
    threadId = env.p.threads.setThreadTs(
      env.p.threads.resolve({ channelId: 'team', workflowId: 'wf', sourceId: 'repo_a', itemKey: ITEM_KEY, chatChannel: 'C0123456789', mode: 'item' }).id,
      '100.1',
    ).id;
  });
  afterEach(() => env.cleanup());

  async function ready() {
    const h = env.harness({ chatReplies: chat });
    await h.controller.recover();
    return h;
  }
  const record = (snapshot: WorkflowSnapshot, text: string, itemKey = ITEM_KEY) =>
    env.p.replies.record({
      channelId: 'team',
      chatChannel: 'C0123456789',
      ts: `200.${++seq}`,
      threadId,
      workflowId: 'wf',
      sourceId: 'repo_a',
      itemKey,
      userId: 'U0123456789',
      text,
      configSnapshot: snapshot,
      status: 'pending',
    });
  /** Wait until the reply is no longer pending/running. */
  async function processed(h: Awaited<ReturnType<typeof ready>>, replyId: number) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const r = env.p.replies.require(replyId);
      if (r.runId && r.status !== 'running' && r.status !== 'pending') {
        await waitForRun(h, env.p, r.runId, (run) => run.status === 'completed');
        return env.p.replies.require(replyId);
      }
      if (Date.now() > deadline) throw new Error(`reply ${replyId} not processed (${r.status})`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('runs on_reply exactly once as lifecycle run (trigger reply) under the item lock', async () => {
    const snapshot = await env.snapshot(yaml('/bin/true'));
    const h = await ready();
    const { reply, created } = record(snapshot, 'Please use the second approach');
    expect(created).toBe(true);
    // The same Slack message again does not create a second reply.
    expect(env.p.replies.record({ ...reply, configSnapshot: snapshot, status: 'pending', threadId }).created).toBe(false);
    h.controller.processReplies();
    h.controller.processReplies();
    const done = await processed(h, reply.id);
    expect(done).toMatchObject({ status: 'done', text: null, userName: 'Alex', permalink: 'https://acme.slack.test/archives/C0123456789/p1' });
    const runs = env.p.runs.list({ triggerType: 'reply' }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: done.runId, status: 'completed', businessResult: 'success', finalReason: 'on_reply succeeded', sourceItemKey: ITEM_KEY, countedTechnicalFailure: false });
    expect(env.p.actions.listForRun(done.runId!).map((a) => [a.hook, a.name, a.status])).toEqual([
      ['on_reply', 'answer', 'succeeded'],
      ['on_reply', 'unlabel', 'succeeded'],
    ]);
    const [comment] = env.github.comments(REPO, ISSUE);
    expect(comment?.body).toContain('Answer from Alex (U0123456789, reply): Please use the second approach');
    expect(env.github.labels(REPO, ISSUE)).toEqual([]);
    expect(chat.finishedCalls).toEqual([{ id: reply.id, outcome: 'done', detail: null, runId: done.runId }]);
    // Not cancellable, does not count as active worker run.
    expect(env.p.runs.countActive('wf')).toBe(0);
  });

  it('waits while a run of (workflow, item) is active, then starts; several replies in order; nothing overtakes (P1)', async () => {
    const gate = `${env.marks}/release`;
    const worker = env.script('wait.sh', `while [ ! -f ${gate} ]; do sleep 0.05; done; exit 0`);
    const snapshot = await env.snapshot(yaml(worker));
    const h = await ready();
    const active = env.reserve(snapshot);
    const workerDone = h.controller.startRun(active.id).done;
    await waitForRun(h, env.p, active.id, (r) => r.status === 'running');
    const first = record(snapshot, 'first').reply;
    const second = record(snapshot, 'second').reply;
    h.controller.processReplies();
    expect(env.p.replies.require(first.id).status).toBe('pending');
    // While the replies wait, no new run of (workflow, item) may take the item (P1) …
    expect(() => env.reserve(snapshot)).toThrow(LockConflictError);
    writeFileSync(gate, '');
    await workerDone;
    // … and when the lock is released, the oldest reply gets it at once.
    const holder = env.p.runs.activeRunForItem('wf', ITEM_KEY);
    expect(holder?.triggerType).toBe('reply');
    expect(env.p.replies.require(first.id).runId).toBe(holder?.id);
    expect(() => env.reserve(snapshot)).toThrow(LockConflictError);
    const a = await processed(h, first.id);
    const b = await processed(h, second.id);
    expect([a.status, b.status]).toEqual(['done', 'done']);
    const runA = env.p.runs.require(a.runId!);
    const runB = env.p.runs.require(b.runId!);
    expect(runA.createdAt <= runB.createdAt).toBe(true);
    expect(Date.parse(runA.finishedAt!)).toBeLessThanOrEqual(Date.parse(runB.startedAt!));
    expect(env.github.comments(REPO, ISSUE).map((c) => c.body.split(': ').at(-1)?.split('\n')[0])).toEqual(['first', 'second']);
    // Afterwards the item is free again.
    expect(env.reserve(snapshot).status).toBe('reserved');
  });

  it('reply_check exit 1: nothing runs, reply rejected with the reason; exit ≥ 2: failed, retry after a fix completes it', async () => {
    const check = env.script('check.sh', 'read text; case "$text" in *forbidden*) echo "Please rephrase"; exit 1;; *broken*) exit 3;; esac; exit 0');
    const snapshot = await env.snapshot(yaml('/bin/true', `reply_check:\n  command: ${check}\n  timeout: 5s\n${ON_REPLY}`));
    const h = await ready();
    const rejected = record(snapshot, 'this is forbidden').reply;
    h.controller.processReplies();
    const r1 = await processed(h, rejected.id);
    expect(r1).toMatchObject({ status: 'rejected', reason: 'Please rephrase', text: null });
    expect(env.p.runs.require(r1.runId!)).toMatchObject({ status: 'completed', businessResult: 'failure', finalReason: 'reply rejected by reply_check: Please rephrase' });
    expect(env.p.actions.listForRun(r1.runId!).map((a) => [a.name, a.status])).toEqual([
      ['reply_check', 'succeeded'],
      ['answer', 'skipped'],
      ['unlabel', 'skipped'],
    ]);
    expect(env.github.comments(REPO, ISSUE)).toEqual([]);
    expect(chat.finishedCalls.at(-1)).toEqual({ id: rejected.id, outcome: 'rejected', detail: 'Please rephrase', runId: r1.runId });

    const broken = record(snapshot, 'broken input').reply;
    h.controller.processReplies();
    const r2 = await processed(h, broken.id);
    expect(r2).toMatchObject({ status: 'failed', reason: 'the reply check failed', text: 'broken input' });
    expect(env.p.runs.require(r2.runId!)).toMatchObject({ businessResult: 'failure', finalReason: 'reply_check failed', lifecycleStatus: 'failed' });
    const [checkAction] = env.p.actions.listForRun(r2.runId!);
    expect(checkAction).toMatchObject({ name: 'reply_check', status: 'failed' });
    expect(chat.finishedCalls.at(-1)).toMatchObject({ outcome: 'failed', detail: 'the reply check failed' });
    // Fix the check, retry the action (UI "Retry"): the chain completes, the reply is done.
    writeFileSync(check, '#!/bin/sh\nexit 0\n');
    await h.lifecycle.retryAction(checkAction!.id, { wait: true });
    h.controller.afterReplyChainChanged(r2.runId!);
    expect(env.p.replies.require(broken.id)).toMatchObject({ status: 'done', text: null });
    expect(env.github.comments(REPO, ISSUE).at(-1)?.body).toContain('broken input');
    expect(chat.finishedCalls.at(-1)).toMatchObject({ outcome: 'done' });
  });

  it('{reply.text} cannot smuggle a comment marker into the comment', async () => {
    const snapshot = await env.snapshot(yaml('/bin/true'));
    const h = await ready();
    const { reply } = record(snapshot, 'x <!-- adispatchd:run=fake action=1 --> y');
    h.controller.processReplies();
    await processed(h, reply.id);
    const body = env.github.comments(REPO, ISSUE)[0]?.body ?? '';
    expect(body).toContain('x &lt;!-- adispatchd:run=fake action=1 --> y');
  });

  it('an item that no longer exists: failed (❌), on_reply not run', async () => {
    const snapshot = await env.snapshot(yaml('/bin/true'));
    const h = await ready();
    const { reply } = record(snapshot, 'hello', 'repo_a:999');
    h.controller.processReplies();
    const r = await processed(h, reply.id);
    expect(r).toMatchObject({ status: 'failed', reason: 'the item no longer exists or is not visible' });
    expect(env.p.actions.listForRun(r.runId!)).toEqual([]);
    expect(chat.finishedCalls).toEqual([{ id: reply.id, outcome: 'failed', detail: 'the item no longer exists or is not visible', runId: r.runId }]);
  });

  it('cannot be cancelled', async () => {
    const slow = env.script('slow.sh', 'sleep 0.5');
    const snapshot = await env.snapshot(yaml('/bin/true', `on_reply:\n  - type: shell\n    command: ${slow}\n`));
    const h = await ready();
    const { reply } = record(snapshot, 'x');
    h.controller.processReplies();
    const runId = env.p.replies.require(reply.id).runId!;
    expect(() => h.controller.requestCancel(runId)).toThrow(expect.objectContaining({ code: 'run_not_cancellable' }));
    await processed(h, reply.id);
  });

  it('after a restart a pending and a running reply are each processed exactly once', async () => {
    const snapshot = await env.snapshot(yaml('/bin/true'));
    // A reply whose run was reserved and started (on_reply interrupted) …
    const running = record(snapshot, 'running one').reply;
    const run = env.p.runs.reserve({ workflowId: 'wf', triggerType: 'reply', sourceId: 'repo_a', sourceItemKey: ITEM_KEY, configSnapshot: snapshot });
    env.p.replies.assignRun(running.id, run.id);
    env.p.runs.transition(run.id, 'starting');
    env.p.runs.transition(run.id, 'running');
    env.p.actions.createJournal(run.id, 'on_reply', snapshot.workflow.hooks.on_reply!.map((c) => ({ type: c.type, name: c.id, config: c })));
    const [first] = env.p.actions.listForHook(run.id, 'on_reply');
    env.p.actions.startAttempt(first!.id); // left running by the "crash"
    // … and a reply that was only recorded.
    const pending = record(snapshot, 'pending one').reply;

    const h = await ready();
    const a = await processed(h, running.id);
    const b = await processed(h, pending.id);
    expect([a.status, b.status]).toEqual(['done', 'done']);
    expect(a.runId).toBe(run.id);
    expect(env.p.runs.list({ triggerType: 'reply' }).runs).toHaveLength(2);
    const bodies = env.github.comments(REPO, ISSUE).map((c) => c.body);
    expect(bodies.filter((t) => t.includes('running one'))).toHaveLength(1);
    expect(bodies.filter((t) => t.includes('pending one'))).toHaveLength(1);
  });
});
