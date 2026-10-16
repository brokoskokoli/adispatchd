import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceAdapter } from '../core/index.js';
import { createEnv, drive, loadSnapshot, markedComments, REPO, ISSUE, type LifecycleTestEnv } from './testing/helpers.js';

const BASE = `
id: wf
name: Coder WF
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
`;

const HOOK = `${BASE}
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
  - type: source.comment
    message: 'Completed: {result.message}'
  - type: source.update
    labels: { add: [done] }
`;

/** Adapter whose `postComment` never returns (controller "crashes" while waiting). */
function hangingAdapter(real: SourceAdapter, opts: { postFirst: boolean }): SourceAdapter {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'postComment') {
        return async (...args: Parameters<SourceAdapter['postComment']>) => {
          if (opts.postFirst) await target.postComment(...args);
          return new Promise<never>(() => undefined);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('condition not reached');
}

function labelWrites(env: LifecycleTestEnv): number {
  return env.github.requests.filter((r) => r.path.includes('/labels') && r.method !== 'GET').length;
}

describe('LifecycleEngine recovery (restart simulation)', () => {
  let env: LifecycleTestEnv;
  beforeEach(() => {
    env = createEnv();
  });
  afterEach(() => env.cleanup());

  it('does not repeat succeeded actions and does not duplicate a running comment whose marker exists', async () => {
    const snapshot = await loadSnapshot(HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const crashed = env.engine({ sources: () => hangingAdapter(env.adapter, { postFirst: true }) });
    void crashed.runHook(run, 'on_success', snapshot);
    await until(() => markedComments(env.github).length === 1);

    const before = env.p.actions.listForHook(run.id, 'on_success');
    expect(before.map((a) => a.status)).toEqual(['succeeded', 'running', 'pending']);
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('running');
    expect(env.p.actions.runIdsWithIncompleteActions()).toEqual([run.id]);
    const writesBefore = labelWrites(env);

    // controller restart: fresh engine over the same database
    const results = await drive(env.engine().resumeIncomplete(run.id), env.clock);

    expect(results.map((r) => [r.hook, r.status])).toEqual([['on_success', 'succeeded']]);
    const after = env.p.actions.listForHook(run.id, 'on_success');
    expect(after.map((a) => a.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(markedComments(env.github)).toHaveLength(1);
    expect(after[1]?.externalKey).toBe(String(env.github.comments(REPO, ISSUE)[0]?.id));
    expect(after[0]?.attempts).toBe(1); // first update not executed again
    expect(labelWrites(env) - writesBefore).toBe(1); // only the `done` label of the third action
    const posts = env.github.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'));
    expect(posts).toHaveLength(1);
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('succeeded');
    expect(env.p.actions.runIdsWithIncompleteActions()).toEqual([]);
  });

  it('posts a running comment exactly once if it was not published before the crash', async () => {
    const snapshot = await loadSnapshot(HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const crashed = env.engine({ sources: () => hangingAdapter(env.adapter, { postFirst: false }) });
    void crashed.runHook(run, 'on_success', snapshot);
    await until(() => env.p.actions.listForHook(run.id, 'on_success')[1]?.status === 'running');
    await new Promise((r) => setImmediate(r));
    expect(markedComments(env.github)).toHaveLength(0);

    const results = await drive(env.engine().resumeIncomplete(run.id), env.clock);
    expect(results[0]?.status).toBe('succeeded');
    expect(markedComments(env.github)).toHaveLength(1);
    const comment = env.p.actions.listForHook(run.id, 'on_success')[1];
    const attempts = env.p.actions.listAttempts(comment?.id ?? -1);
    expect(attempts.map((a) => [a.outcome, (a.error as { code?: string } | null)?.code ?? null])).toEqual([
      ['failed', 'lifecycle_interrupted'],
      ['succeeded', null],
    ]);
  });

  it('a running update is re-applied idempotently after re-reading the item', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const [action] = env.p.actions.createJournal(run.id, 'on_success', [
      { type: 'source.update', name: 'on_success.0', config: snapshot.workflow.hooks.on_success[0] },
    ]);
    env.p.actions.startAttempt(action?.id ?? -1); // crashed mid-attempt; the label was already added
    env.github.setLabels(REPO, ISSUE, ['ready-for-review', 'coding']);

    const results = await drive(env.engine().resumeIncomplete(run), env.clock);
    expect(results[0]?.status).toBe('succeeded');
    expect(env.github.labels(REPO, ISSUE)).toEqual(['ready-for-review']);
    const attempts = env.p.actions.listAttempts(action?.id ?? -1);
    expect(attempts.map((a) => a.outcome)).toEqual(['failed', 'succeeded']);
  });

  it('an interrupted shell action is not repeated automatically: failed + notification, chain stops', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: shell
    command: /bin/true
  - type: source.update
    labels: { add: [x] }
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const journal = env.p.actions.createJournal(
      run.id,
      'on_success',
      snapshot.workflow.hooks.on_success.map((c) => ({ type: c.type, name: c.id, config: c })),
    );
    env.p.actions.startAttempt(journal[0]?.id ?? -1);

    const results = await drive(env.engine().resumeIncomplete(run.id), env.clock);
    expect(results).toEqual([]);
    const after = env.p.actions.listForHook(run.id, 'on_success');
    expect(after.map((a) => a.status)).toEqual(['failed', 'pending']);
    expect(after[0]?.lastError).toMatchObject({ code: 'lifecycle_interrupted', outcomeUnknown: true });
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('failed');
    expect(env.notifications.map((n) => n.type)).toEqual(['lifecycle_action_failed']);
  });

  it('does not continue a chain that stopped at a failed action', async () => {
    const snapshot = await loadSnapshot(HOOK);
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    env.github.failNext({ method: 'POST', path: `/repos/${REPO}/issues/${ISSUE}/comments` }, { status: 500 }, 3);
    await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    const requests = env.github.requests.length;

    const results = await drive(env.engine().resumeIncomplete(run.id), env.clock);
    expect(results).toEqual([]);
    expect(env.github.requests.length).toBe(requests);
    expect(env.p.actions.listForHook(run.id, 'on_success').map((a) => a.status)).toEqual(['succeeded', 'failed', 'pending']);
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('failed');
  });

  it('resumes only the requested hooks; abandonHook skips the rest of a chain', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
  - type: source.comment
    message: 'started {run.id}'
on_crash:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
`);
    const run = env.reserve(snapshot);
    env.p.actions.createJournal(
      run.id,
      'on_start',
      snapshot.workflow.hooks.on_start.map((c) => ({ type: c.type, name: c.id, config: c })),
    );
    const results = await drive(env.engine().resumeIncomplete(run.id, { hooks: ['on_crash'] }), env.clock);
    expect(results).toEqual([]);
    expect(env.p.runs.require(run.id).lifecycleStatus).toBe('pending');

    const abandoned = await env.engine().abandonHook(run.id, 'on_start');
    expect(abandoned.status).toBe('succeeded');
    expect(abandoned.actions.map((a) => a.status)).toEqual(['skipped', 'skipped']);
    expect(env.github.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(env.p.actions.runIdsWithIncompleteActions()).toEqual([]);
  });
});
