/**
 * WI-17: named outcomes (`on_result.<outcome>`) and the collective hook
 * `on_error` – hook selection, persistence of outcome/hook, warnings and
 * recovery of interrupted chains. Real shell scripts, Fake-GitHub.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_EVENTS } from './controller.js';
import { ISSUE, ITEM_KEY, REPO, createRunsEnv, waitForRun, type RunsTestEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

/** Script writing a result file with the given fields. */
function resultScript(fields: Record<string, unknown>): string {
  const json = JSON.stringify({ schema_version: 1, ...fields }).replace(/'/g, `'"'"'`);
  return `printf '%s' '${json}' > "$ADISPATCH_RESULT_FILE"\nexit 0`;
}

/** Reviewer-style workflow with three named outcomes and a collective error hook. */
function reviewerYaml(command: string, extra = ''): string {
  return `
id: wf
name: Reviewer
trigger: { type: source, source: repo_a }
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
on_start:
  - type: source.update
    labels: { add: [reviewing], remove: [ready-for-review] }
on_success:
  - type: source.update
    labels: { add: [done], remove: [reviewing] }
on_failure:
  - type: source.update
    labels: { add: [failed], remove: [reviewing] }
on_result:
  approved:
    - type: source.update
      labels: { add: [approved], remove: [reviewing] }
    - type: source.comment
      message: 'Outcome {result.outcome} ({result.result}): {result.message}'
  changes_requested:
    - type: source.update
      labels: { add: [ready-for-coding], remove: [reviewing] }
  quiet: []
on_error:
  - type: source.update
    labels: { add: [ready-for-review], remove: [reviewing] }
${extra}`;
}

describe.runIf(supported)('RunController – named outcomes and on_error (WI-17)', () => {
  let env: RunsTestEnv;
  beforeEach(() => {
    env = createRunsEnv();
    env.github.setLabels(REPO, ISSUE, ['ready-for-review']);
  });
  afterEach(() => env.cleanup());

  async function run(yaml: string) {
    const snapshot = await env.snapshot(yaml);
    const h = env.harness();
    await h.controller.recover();
    const reserved = env.reserve(snapshot);
    return { h, final: await h.controller.startRun(reserved.id).done };
  }

  const hooksOf = (runId: string) => [...new Set(env.p.actions.listForRun(runId).map((a) => a.hook))];
  const warnings = (runId: string) => env.p.events.listForRun(runId).filter((e) => e.type === RUN_EVENTS.outcomeWarning).map((e) => e.payload);

  it('outcome with an on_result entry runs exactly that chain instead of on_success/on_failure', async () => {
    const script = env.script('approve.sh', resultScript({ result: 'success', outcome: 'approved', message: 'LGTM' }));
    const { final } = await run(reviewerYaml(script));
    expect(final).toMatchObject({ status: 'completed', businessResult: 'success', outcome: 'approved', completionHook: 'on_result.approved' });
    expect(hooksOf(final.id)).toEqual(['on_start', 'on_result.approved']);
    expect(env.p.actions.listForHook(final.id, 'on_result.approved').map((a) => [a.name, a.status])).toEqual([
      ['on_result.approved.0', 'succeeded'],
      ['on_result.approved.1', 'succeeded'],
    ]);
    expect(env.github.labels(REPO, ISSUE)).toEqual(['approved']);
    expect(env.github.comments(REPO, ISSUE).map((c) => c.body.split('\n')[0])).toEqual(['Outcome approved (success): LGTM']);
    expect(final.lifecycleStatus).toBe('succeeded');
    expect(warnings(final.id)).toEqual([]);
    const finalizing = env.p.events.listForRun(final.id).find((e) => e.type === 'run.status' && e.payload.to === 'finalizing');
    expect(finalizing?.payload).toMatchObject({ outcome: 'approved', hook: 'on_result.approved' });
    // Business statistics are still driven by `result`: success resets the counter.
    expect(env.p.blocks.counter('wf', ITEM_KEY).consecutive).toBe(0);
  });

  it('on_result also replaces on_failure; result stays the business result', async () => {
    const script = env.script('changes.sh', resultScript({ result: 'failure', outcome: 'changes_requested' }));
    const { final } = await run(reviewerYaml(script));
    expect(final).toMatchObject({ status: 'completed', businessResult: 'failure', outcome: 'changes_requested' });
    expect(hooksOf(final.id)).toEqual(['on_start', 'on_result.changes_requested']);
    expect(env.github.labels(REPO, ISSUE)).toEqual(['ready-for-coding']);
    expect(final.countedTechnicalFailure).toBe(false);
  });

  it('an empty on_result entry is defined: nothing runs, no fallback', async () => {
    const script = env.script('quiet.sh', resultScript({ result: 'success', outcome: 'quiet' }));
    const { final } = await run(reviewerYaml(script));
    expect(final).toMatchObject({ outcome: 'quiet', completionHook: 'on_result.quiet' });
    expect(hooksOf(final.id)).toEqual(['on_start']);
    expect(env.github.labels(REPO, ISSUE)).toEqual(['reviewing']);
  });

  it('outcome without an on_result entry falls back to on_success/on_failure with a warning', async () => {
    const script = env.script('other.sh', resultScript({ result: 'failure', outcome: 'needs_maintainer' }));
    const { final } = await run(reviewerYaml(script));
    expect(final).toMatchObject({ businessResult: 'failure', outcome: 'needs_maintainer', completionHook: 'on_failure' });
    expect(hooksOf(final.id)).toEqual(['on_start', 'on_failure']);
    expect(env.github.labels(REPO, ISSUE)).toEqual(['failed']);
    expect(warnings(final.id)).toEqual([
      expect.objectContaining({ code: 'unmatched_outcome', outcome: 'needs_maintainer', hook: 'on_failure' }),
    ]);
  });

  it('without outcome the old behaviour applies', async () => {
    const script = env.script('plain.sh', resultScript({ result: 'success' }));
    const { final } = await run(reviewerYaml(script));
    expect(final).toMatchObject({ outcome: null, completionHook: 'on_success' });
    expect(hooksOf(final.id)).toEqual(['on_start', 'on_success']);
    expect(warnings(final.id)).toEqual([]);
  });

  it('an outcome in invalid format is ignored with a warning; the result is evaluated normally', async () => {
    const script = env.script('bad.sh', resultScript({ result: 'success', outcome: 'not valid!' }));
    const { final } = await run(reviewerYaml(script));
    expect(final).toMatchObject({ status: 'completed', businessResult: 'success', outcome: null, completionHook: 'on_success' });
    expect(final.result).not.toHaveProperty('outcome');
    expect(warnings(final.id)).toEqual([expect.objectContaining({ code: 'invalid_outcome', message: expect.stringContaining('"not valid!"') })]);
    expect(env.github.labels(REPO, ISSUE)).toEqual(['done']);
  });

  it('an outcome of a crashed run is ignored (exit code ≠ 0 ignores the result file)', async () => {
    const script = env.script('crash-outcome.sh', resultScript({ result: 'success', outcome: 'approved' }).replace('exit 0', 'exit 2'));
    const { final } = await run(reviewerYaml(script));
    expect(final).toMatchObject({ status: 'crashed', outcome: null, completionHook: 'on_error' });
    expect(hooksOf(final.id)).toEqual(['on_start', 'on_error']);
  });

  describe('on_error', () => {
    it('crashed, start_error, timed_out and cancelled without own hook run on_error', async () => {
      const crash = env.script('crash.sh', 'exit 1');
      const crashed = (await run(reviewerYaml(crash))).final;
      expect(crashed).toMatchObject({ status: 'crashed', completionHook: 'on_error' });
      expect(hooksOf(crashed.id)).toEqual(['on_start', 'on_error']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['ready-for-review']);

      const startError = (await run(reviewerYaml(path.join(env.root, 'missing.sh')))).final;
      expect(startError).toMatchObject({ status: 'start_error', completionHook: 'on_error' });
      expect(hooksOf(startError.id)).toEqual(['on_start', 'on_error']);

      const sleeper = env.script('sleep.sh', 'exec sleep 30');
      const timedOut = (await run(reviewerYaml(sleeper).replace('  cancel_grace: 300ms', '  cancel_grace: 300ms\n  timeout: { max_duration: 200ms }'))).final;
      expect(timedOut).toMatchObject({ status: 'timed_out', completionHook: 'on_error' });
      expect(hooksOf(timedOut.id)).toEqual(['on_start', 'on_error']);

      const snapshot = await env.snapshot(reviewerYaml(sleeper));
      const h = env.harness();
      await h.controller.recover();
      const reserved = env.reserve(snapshot);
      const handle = h.controller.startRun(reserved.id);
      await waitForRun(h, env.p, reserved.id, (r) => r.status === 'running');
      const cancelled = await h.controller.cancelRun(reserved.id);
      await handle.done;
      expect(cancelled).toMatchObject({ status: 'cancelled', completionHook: 'on_error' });
      expect(hooksOf(cancelled.id)).toEqual(['on_start', 'on_error']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['ready-for-review']);
    });

    it('a specific hook – even an empty list – takes precedence; never both', async () => {
      const crash = env.script('crash.sh', 'exit 1');
      const withEmpty = (await run(reviewerYaml(crash, 'on_crash: []\n'))).final;
      expect(withEmpty).toMatchObject({ status: 'crashed', completionHook: 'on_crash' });
      expect(hooksOf(withEmpty.id)).toEqual(['on_start']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['reviewing']);

      env.github.setLabels(REPO, ISSUE, ['ready-for-review']);
      const specific = (await run(
        reviewerYaml(crash, 'on_crash:\n  - type: source.update\n    labels: { add: [crashed], remove: [reviewing] }\n'),
      )).final;
      expect(specific.completionHook).toBe('on_crash');
      expect(hooksOf(specific.id)).toEqual(['on_start', 'on_crash']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['crashed']);
    });
  });

  describe('recovery after a restart', () => {
    /** Run left in `finalizing` with the hook chain interrupted in its first action. */
    async function interruptedIn(hook: 'on_result.approved' | 'on_error', status: 'completed' | 'crashed') {
      const snapshot = await env.snapshot(reviewerYaml('/bin/true'));
      const reserved = env.reserve(snapshot);
      env.p.runs.transition(reserved.id, 'starting');
      env.p.runs.transition(reserved.id, 'running', { update: { pid: 999_999 } });
      env.github.setLabels(REPO, ISSUE, ['reviewing']);
      env.p.runs.beginFinalization(
        reserved.id,
        status === 'completed'
          ? { status: 'completed', businessResult: 'success', reason: 'exit code 0, result success' }
          : { status: 'crashed', businessResult: null, reason: 'exit code 1' },
        {
          update: {
            completionHook: hook,
            ...(status === 'completed'
              ? { outcome: 'approved', result: { schema_version: 1, result: 'success', outcome: 'approved', message: 'ok' } }
              : {}),
          },
        },
      );
      const journal = env.p.actions.createJournal(
        reserved.id,
        hook,
        (snapshot.workflow.hooks[hook] ?? []).map((config) => ({ type: config.type, name: config.id, config })),
      );
      env.p.actions.startAttempt(journal[0]!.id); // the controller died inside the first action
      return reserved.id;
    }

    it('resumes an interrupted on_result.<outcome> chain from the persisted hook', async () => {
      const runId = await interruptedIn('on_result.approved', 'completed');
      const h = env.harness();
      await h.controller.recover();
      const final = env.p.runs.require(runId);
      expect(final).toMatchObject({ status: 'completed', outcome: 'approved', completionHook: 'on_result.approved' });
      expect(hooksOf(runId)).toEqual(['on_result.approved']);
      expect(env.p.actions.listForHook(runId, 'on_result.approved').map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['approved']);
      expect(env.github.comments(REPO, ISSUE)).toHaveLength(1);
    });

    it('resumes an interrupted on_error chain from the persisted hook', async () => {
      const runId = await interruptedIn('on_error', 'crashed');
      const h = env.harness();
      await h.controller.recover();
      const final = env.p.runs.require(runId);
      expect(final).toMatchObject({ status: 'crashed', completionHook: 'on_error' });
      expect(hooksOf(runId)).toEqual(['on_error']);
      expect(env.p.actions.listForHook(runId, 'on_error').map((a) => a.status)).toEqual(['succeeded']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['ready-for-review']);
    });

    it('the persisted hook wins over a re-selection (deterministic)', async () => {
      // Persisted on_error although the snapshot would now select on_crash: recovery keeps the persisted hook.
      const snapshot = await env.snapshot(reviewerYaml('/bin/true', 'on_crash:\n  - type: source.update\n    labels: { add: [crashed] }\n'));
      const reserved = env.reserve(snapshot);
      env.p.runs.transition(reserved.id, 'starting');
      env.p.runs.transition(reserved.id, 'running', { update: { pid: 999_999 } });
      env.p.runs.beginFinalization(reserved.id, { status: 'crashed', businessResult: null, reason: 'exit code 1' }, { update: { completionHook: 'on_error' } });
      await env.harness().controller.recover();
      expect(hooksOf(reserved.id)).toEqual(['on_error']);
    });

    it('a run finalized before 0.3.0 (no persisted hook, old snapshot) resumes with the specific hook', async () => {
      const current = await env.snapshot(reviewerYaml('/bin/true'));
      // Pre-0.3.0 snapshot shape: every list hook present (empty if unused), no on_error, no on_result.
      const crashAction = { ...current.workflow.hooks.on_success[0]!, id: 'on_crash.0', labels: { add: ['ready-for-review'], remove: ['reviewing'] } };
      const legacy = {
        ...current,
        workflow: {
          ...current.workflow,
          hooks: {
            on_start: current.workflow.hooks.on_start,
            on_success: current.workflow.hooks.on_success,
            on_failure: current.workflow.hooks.on_failure,
            on_crash: [crashAction],
            on_start_error: [],
            on_cancel: [],
            on_timeout: [],
          },
        },
      };
      const reserved = env.reserve(legacy as typeof current);
      env.p.runs.transition(reserved.id, 'starting');
      env.p.runs.transition(reserved.id, 'running', { update: { pid: 999_999 } });
      env.github.setLabels(REPO, ISSUE, ['reviewing']);
      env.p.runs.beginFinalization(reserved.id, { status: 'crashed', businessResult: null, reason: 'exit code 1' });
      expect(env.p.runs.require(reserved.id)).toMatchObject({ status: 'finalizing', completionHook: null, outcome: null });
      await env.harness().controller.recover();
      expect(env.p.runs.require(reserved.id).status).toBe('crashed');
      expect(hooksOf(reserved.id)).toEqual(['on_crash']);
      expect(env.github.labels(REPO, ISSUE)).toEqual(['ready-for-review']);
    });

    it('continues interrupted on_result chains of finished runs', async () => {
      const runId = await interruptedIn('on_result.approved', 'completed');
      env.p.actions.finishAttempt(env.p.actions.listAttempts(env.p.actions.listForHook(runId, 'on_result.approved')[0]!.id)[0]!.id, 'failed');
      env.p.actions.setStatus(env.p.actions.listForHook(runId, 'on_result.approved')[0]!.id, 'pending');
      env.p.runs.finish(runId);
      const report = await env.harness().controller.recover();
      expect(report.resumedActions).toEqual([runId]);
      expect(env.p.actions.listForHook(runId, 'on_result.approved').map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
    });
  });
});
