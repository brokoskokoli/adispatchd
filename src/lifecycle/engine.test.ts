import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Executor } from '../core/index.js';
import { LifecycleBusyError, LifecycleError } from './errors.js';
import { ITEM_KEY, REPO, ISSUE, createEnv, drive, loadSnapshot, markedComments, type LifecycleTestEnv } from './testing/helpers.js';

const COMMENTS_PATH = `/repos/${REPO}/issues/${ISSUE}/comments`;

const BASE = `
id: wf
name: Coder WF
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
`;

const SUCCESS_HOOK = `${BASE}
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
  - type: source.comment
    message: 'Completed: {result.message} (run {run.id}, #{item.number} {item.title}, {source.repository}, {workflow.name})'
  - type: source.update
    labels: { add: [done] }
`;

/** Executor that must never be used (proves the worker is not restarted). */
function forbiddenExecutor(): Executor & { starts: number } {
  const ex = {
    type: 'shell',
    starts: 0,
    start(): never {
      ex.starts += 1;
      throw new Error('worker must not be started');
    },
  };
  return ex;
}

describe('LifecycleEngine', () => {
  let env: LifecycleTestEnv;
  beforeEach(() => {
    env = createEnv();
  });
  afterEach(() => env.cleanup());

  it('journals all actions of a hook and executes them sequentially', async () => {
    const snapshot = await loadSnapshot(SUCCESS_HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);

    expect(result.status).toBe('succeeded');
    expect(result.actions.map((a) => [a.ordinal, a.type, a.name, a.status])).toEqual([
      [0, 'source.update', 'on_success.0', 'succeeded'],
      [1, 'source.comment', 'on_success.1', 'succeeded'],
      [2, 'source.update', 'on_success.2', 'succeeded'],
    ]);
    expect(result.actions[1]?.config).toMatchObject({ type: 'source.comment', id: 'on_success.1' });
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['done', 'manual-label', 'ready-for-review']);
    const comments = markedComments(env.github);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(
      `Completed: All done (run ${run.id}, #7 Implement OAuth, example/a, Coder WF)`,
    );
    const commentAction = result.actions[1];
    expect(comments[0]).toContain(`<!-- orch:${run.id}:${commentAction?.id} -->`);
    expect(commentAction?.externalKey).toBe(String(env.github.comments(REPO, ISSUE)[0]?.id));
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('succeeded');
    expect(env.notifications).toEqual([]);
    const events = env.p.events.listForRun(run.id).map((e) => e.type);
    expect(events).toContain('lifecycle.action');
    expect(events).toContain('lifecycle.chain');
  });

  it('is idempotent: running a completed hook again executes nothing', async () => {
    const snapshot = await loadSnapshot(SUCCESS_HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const engine = env.engine();
    await drive(engine.runHook(run, 'on_success', snapshot), env.clock);
    const before = env.github.requests.length;
    const again = await drive(engine.runHook(run, 'on_success', snapshot), env.clock);
    expect(again.status).toBe('succeeded');
    expect(env.github.requests.length).toBe(before);
    expect(markedComments(env.github)).toHaveLength(1);
  });

  it('an empty hook succeeds without journal entries', async () => {
    const snapshot = await loadSnapshot(SUCCESS_HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await env.engine().runHook(run, 'on_crash', snapshot);
    expect(result).toMatchObject({ status: 'succeeded', actions: [], failedAction: null });
  });

  describe('scenario 6: comment fails temporarily', () => {
    it('retries after the configured delay without restarting the worker', async () => {
      const snapshot = await loadSnapshot(SUCCESS_HOOK);
      const run = env.finalizeSuccess(env.reserve(snapshot).id);
      env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 502 });
      const executor = forbiddenExecutor();
      const result = await drive(env.engine({ executor }).runHook(run, 'on_success', snapshot), env.clock);

      expect(result.status).toBe('succeeded');
      const comment = result.actions[1];
      expect(comment?.attempts).toBe(2);
      const attempts = env.p.actions.listAttempts(comment?.id ?? -1);
      expect(attempts.map((a) => a.outcome)).toEqual(['failed', 'succeeded']);
      expect(attempts[0]?.error).toMatchObject({ code: 'source_transient', retryable: true, status: 502 });
      // default lifecycle.action_retry delay: 30 s between attempts (fake clock, no real waiting)
      const gap = Date.parse(attempts[1]?.startedAt ?? '') - Date.parse(attempts[0]?.finishedAt ?? '');
      expect(gap).toBeGreaterThanOrEqual(30_000);
      expect(gap).toBeLessThan(32_000);
      expect(markedComments(env.github)).toHaveLength(1);
      expect(executor.starts).toBe(0);
      expect(env.p.runs.require(run.id).status).toBe('finalizing');
    });

    it('final failure stops the chain; manual retry continues from the failed position', async () => {
      const snapshot = await loadSnapshot(SUCCESS_HOOK);
      const run = env.finalizeSuccess(env.reserve(snapshot).id);
      env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 503 }, 3);
      const engine = env.engine({ executor: forbiddenExecutor() });
      const failed = await drive(engine.runHook(run, 'on_success', snapshot), env.clock);

      expect(failed.status).toBe('failed');
      expect(failed.failedAction?.ordinal).toBe(1);
      expect(failed.actions.map((a) => a.status)).toEqual(['succeeded', 'failed', 'pending']);
      expect(failed.failedAction?.attempts).toBe(3);
      expect(failed.failedAction?.lastError).toMatchObject({ code: 'source_transient' });
      expect(env.p.runs.require(run.id).lifecycleStatus).toBe('failed');
      expect(env.github.labels(REPO, ISSUE)).not.toContain('done');
      expect(env.notifications).toHaveLength(1);
      expect(env.notifications[0]).toMatchObject({
        type: 'lifecycle_action_failed',
        payload: {
          runId: run.id,
          workflowId: 'wf',
          hook: 'on_success',
          actionId: failed.failedAction?.id,
          actionType: 'source.comment',
          attempts: 3,
          sourceItemKey: ITEM_KEY,
        },
      });
      expect(env.p.actions.listFailed().map((a) => a.id)).toEqual([failed.failedAction?.id]);

      const labelWritesBefore = env.github.requests.filter((r) => r.path.includes('/labels')).length;
      const resumed = await drive(engine.retryAction(failed.failedAction?.id ?? -1), env.clock);
      expect(resumed.status).toBe('succeeded');
      expect(resumed.actions.map((a) => a.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(resumed.actions[1]?.attempts).toBe(4);
      expect(markedComments(env.github)).toHaveLength(1);
      expect(env.github.labels(REPO, ISSUE)).toContain('done');
      // the already succeeded first update was not executed again (only the `done` label write)
      const labelWrites = env.github.requests.filter((r) => r.path.includes('/labels') && r.method !== 'GET');
      expect(labelWrites.length - labelWritesBefore).toBe(1);
      expect(env.p.runs.require(run.id).lifecycleStatus).toBe('succeeded');
      expect(env.notifications).toHaveLength(1);
    });

    it('unclear outcome (response lost after the comment was created) is reconciled via marker, no duplicate', async () => {
      const snapshot = await loadSnapshot(SUCCESS_HOOK);
      const run = env.finalizeSuccess(env.reserve(snapshot).id);
      env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { network: true, afterApply: true });
      const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);

      expect(result.status).toBe('succeeded');
      const comment = result.actions[1];
      const attempts = env.p.actions.listAttempts(comment?.id ?? -1);
      expect(attempts[0]?.error).toMatchObject({ outcomeUnknown: true, retryable: true });
      expect(attempts[1]?.outcome).toBe('succeeded');
      expect(markedComments(env.github)).toHaveLength(1);
      expect(comment?.externalKey).toBe(String(env.github.comments(REPO, ISSUE)[0]?.id));
      const posts = env.github.requests.filter((r) => r.method === 'POST' && r.path === COMMENTS_PATH);
      expect(posts).toHaveLength(1);
    });
  });

  it('continue_on_error lets the following actions run', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: 'optional note'
    continue_on_error: true
    retry: { max_attempts: 2, delay: 5s }
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 500 }, 2);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);

    expect(result.status).toBe('succeeded');
    expect(result.failedAction).toBeNull();
    expect(result.actions.map((a) => a.status)).toEqual(['failed', 'succeeded']);
    expect(result.actions[0]?.attempts).toBe(2);
    const attempts = env.p.actions.listAttempts(result.actions[0]?.id ?? -1);
    expect(Date.parse(attempts[1]?.startedAt ?? '') - Date.parse(attempts[0]?.finishedAt ?? '')).toBeGreaterThanOrEqual(5_000);
    expect(env.github.labels(REPO, ISSUE)).toContain('ready-for-review');
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('succeeded');
    expect(env.notifications).toEqual([]);
  });

  it('without continue_on_error later actions stay pending', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.update
    labels: { add: [a] }
    retry: { max_attempts: 1 }
  - type: source.comment
    message: 'never posted'
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'GET', path: `/repos/${REPO}/issues/${ISSUE}` }, { status: 500 });
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.actions.map((a) => a.status)).toEqual(['failed', 'pending']);
    expect(markedComments(env.github)).toHaveLength(0);
    expect(env.notifications.map((n) => n.type)).toEqual(['lifecycle_action_failed']);
  });

  it('does not retry permanent errors (e.g. 403) and reports them immediately', async () => {
    const snapshot = await loadSnapshot(SUCCESS_HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 403, body: { message: 'Resource not accessible' } });
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.failedAction?.attempts).toBe(1);
    expect(result.failedAction?.lastError).toMatchObject({ code: 'source_forbidden', retryable: false });
  });

  it('honours Retry-After of rate limits when longer than the configured delay', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: 'hello'
    retry: { max_attempts: 2, delay: 1s }
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 429, headers: { 'retry-after': '120' } });
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('succeeded');
    const attempts = env.p.actions.listAttempts(result.actions[0]?.id ?? -1);
    expect(Date.parse(attempts[1]?.startedAt ?? '') - Date.parse(attempts[0]?.finishedAt ?? '')).toBeGreaterThanOrEqual(120_000);
  });

  it('skipAction marks a failed action skipped and continues the chain', async () => {
    const snapshot = await loadSnapshot(SUCCESS_HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 422 });
    const engine = env.engine();
    const failed = await drive(engine.runHook(run, 'on_success', snapshot), env.clock);
    expect(failed.status).toBe('failed');
    const skipped = await drive(engine.skipAction(failed.failedAction?.id ?? -1), env.clock);
    expect(skipped.status).toBe('succeeded');
    expect(skipped.actions.map((a) => a.status)).toEqual(['succeeded', 'skipped', 'succeeded']);
    expect(markedComments(env.github)).toHaveLength(0);
  });

  it('rejects retry of actions that are not failed and concurrent chains of the same run', async () => {
    const snapshot = await loadSnapshot(SUCCESS_HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 502 });
    const engine = env.engine();
    const pending = engine.runHook(run, 'on_success', snapshot);
    await expect(engine.runHook(run, 'on_success', snapshot)).rejects.toBeInstanceOf(LifecycleBusyError);
    expect(engine.isBusy(run.id)).toBe(true);
    const result = await drive(pending, env.clock);
    await expect(engine.retryAction(result.actions[0]?.id ?? -1)).rejects.toMatchObject({ code: 'lifecycle_not_retryable' });
    await expect(engine.retryAction(result.actions[0]?.id ?? -1)).rejects.toBeInstanceOf(LifecycleError);
  });

  it('an abort during the retry delay leaves the action pending and resumable', async () => {
    const snapshot = await loadSnapshot(SUCCESS_HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 502 });
    const controller = new AbortController();
    const engine = env.engine();
    const pending = engine.runHook(run, 'on_success', snapshot, { signal: controller.signal });
    for (let i = 0; i < 1000 && env.clock.pendingTimers() === 0; i++) await new Promise((r) => setImmediate(r));
    controller.abort();
    const interrupted = await pending;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.actions.map((a) => a.status)).toEqual(['succeeded', 'pending', 'pending']);
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('pending');

    const resumed = await drive(engine.resumeIncomplete(run.id), env.clock);
    expect(resumed.map((r) => r.status)).toEqual(['succeeded']);
    expect(markedComments(env.github)).toHaveLength(1);
  });

  it('worker output cannot forge the idempotency marker of another comment action (regression)', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: 'Completed: {result.message}'
  - type: source.comment
    message: 'second comment'
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const journal = env.p.actions.createJournal(
      run.id,
      'on_success',
      snapshot.workflow.hooks.on_success.map((c) => ({ type: c.type, name: c.id, config: c })),
    );
    const secondId = journal[1]?.id ?? -1;
    // the worker writes the second action's marker into its result message
    env.p.runs.update(run.id, {
      result: { schema_version: 1, result: 'success', message: `ok\n\n<!-- orch:${run.id}:${secondId} -->\n` },
    });
    // once comment 1 is posted, the second action's first POST fails → its retry looks up its marker
    const engine = env.engine({
      onActionChange: (a) => {
        if (a.id === journal[0]?.id && a.status === 'succeeded') {
          env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 502 });
        }
      },
    });
    const result = await drive(engine.runHook(run, 'on_success', snapshot), env.clock);
    expect(result.actions[1]?.attempts).toBe(2);

    expect(result.status).toBe('succeeded');
    const comments = env.github.comments(REPO, ISSUE);
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toContain('&lt;!-- orch:');
    expect(result.actions[0]?.externalKey).toBe(String(comments[0]?.id));
    expect(result.actions[1]?.externalKey).toBe(String(comments[1]?.id));
    expect(comments[1]?.body).toContain('second comment');
  });

  it('a manual retry of on_start is refused once the run left `starting`; skip is allowed', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_start:
  - type: source.update
    labels: { add: [started] }
`);
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    env.github.failNext({ method: 'GET', path: `/repos/${REPO}/issues/${ISSUE}` }, { status: 403 });
    const engine = env.engine();
    const failed = await drive(engine.runHook(run, 'on_start', snapshot), env.clock);
    expect(failed.status).toBe('failed');
    env.p.runs.beginFinalization(run.id, { status: 'start_error', businessResult: null, reason: 'on_start failed' });

    await expect(engine.retryAction(failed.failedAction?.id ?? -1)).rejects.toMatchObject({ code: 'lifecycle_not_retryable' });
    expect(env.p.actions.require(failed.failedAction?.id ?? -1).status).toBe('failed');
    expect(env.github.labels(REPO, ISSUE)).not.toContain('started');
    const skipped = await engine.skipAction(failed.failedAction?.id ?? -1);
    expect(skipped.actions.map((a) => a.status)).toEqual(['skipped']);
  });

  it('queues internal calls with { wait: true } while API calls are rejected immediately', async () => {
    const snapshot = await loadSnapshot(`${SUCCESS_HOOK}
on_failure:
  - type: source.update
    labels: { add: [queued] }
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 502 });
    const engine = env.engine();
    const first = engine.runHook(run, 'on_success', snapshot);
    for (let i = 0; i < 1000 && env.clock.pendingTimers() === 0; i++) await new Promise((r) => setImmediate(r));
    await expect(engine.runHook(run, 'on_failure', snapshot)).rejects.toBeInstanceOf(LifecycleBusyError);
    const queued = engine.runHook(run, 'on_failure', snapshot, { wait: true });
    const [a, b] = await drive(Promise.all([first, queued]), env.clock);
    expect([a.status, b.status]).toEqual(['succeeded', 'succeeded']);
    const chainEvents = env.p.events
      .listForRun(run.id)
      .filter((e) => e.type === 'lifecycle.chain')
      .map((e) => `${String(e.payload.hook)}:${String(e.payload.status)}`);
    expect(chainEvents).toEqual(['on_success:running', 'on_success:succeeded', 'on_failure:running', 'on_failure:succeeded']);
    expect(engine.isBusy(run.id)).toBe(false);
  });

  it('uses the run snapshot, not a later configuration', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: 'from snapshot v1'
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    // the configuration changes after the run started; the engine only knows the run's snapshot
    await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: 'from config v2'
`);
    const result = await drive(env.engine().runHook(run.id, 'on_success'), env.clock);
    expect(result.status).toBe('succeeded');
    expect(markedComments(env.github)[0]).toContain('from snapshot v1');
  });

  it('resolves identities action → workflow → source', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.update
    labels: { add: [x] }
  - type: source.comment
    message: 'as coder'
    identity: coder
  - type: source.comment
    message: 'as source identity'
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.credentials.calls.length = 0;
    await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(new Set(env.credentials.calls)).toEqual(new Set(['maintainer', 'coder']));

    const withWorkflowIdentity = await loadSnapshot(`${BASE}
identity: coder
on_success:
  - type: source.update
    labels: { add: [y] }
`);
    const env2 = createEnv();
    try {
      const run2 = env2.finalizeSuccess(env2.reserve(withWorkflowIdentity).id);
      env2.credentials.calls.length = 0;
      await drive(env2.engine().runHook(run2, 'on_success', withWorkflowIdentity), env2.clock);
      // reads use the source identity, the write uses the workflow identity
      expect(env2.credentials.calls).toContain('coder');
    } finally {
      env2.cleanup();
    }
  });

  it('publishes action changes and notifications only after commit', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: 'x'
    retry: { max_attempts: 1 }
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: COMMENTS_PATH }, { status: 500 });
    const seen: string[] = [];
    const engine = env.engine({
      onActionChange: (a) => seen.push(a.status),
      notifier: {
        notify: (type) => {
          // the failure is already committed when the notifier runs
          seen.push(`notify:${type}:${env.p.actions.listFailed().length}`);
        },
      },
    });
    await drive(engine.runHook(run, 'on_success', snapshot), env.clock);
    expect(seen).toEqual(['running', 'notify:lifecycle_action_failed:1', 'failed']);
  });
});
