import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockConflictError } from '../persistence/index.js';
import { SchedulerError } from './errors.js';
import {
  ISSUE,
  ITEM_KEY,
  REPO,
  createSchedulerEnv,
  sourceWorkflow,
  waitStatus,
  type SchedulerEnv,
} from './testing/helpers.js';
import type { CandidateDiagnosis, WorkflowPlanningDiagnosis } from './types.js';

const READY = `filter: { field: labels, operator: contains, value: ready-for-coding }`;

function candidate(diag: WorkflowPlanningDiagnosis | undefined, itemKey: string): CandidateDiagnosis {
  const c = diag?.candidates.find((x) => x.itemKey === itemKey);
  if (!c) throw new Error(`no candidate ${itemKey} in ${JSON.stringify(diag?.candidates.map((x) => x.itemKey))}`);
  return c;
}

describe('Scheduler – planning step (Spec §7)', () => {
  let s: SchedulerEnv;
  beforeEach(() => {
    s = createSchedulerEnv();
    s.configYaml();
  });
  afterEach(async () => s.teardown());

  it('scenario 1: two coder runs in parallel, the third is prevented by the workflow limit', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.env.github.createIssue(REPO, { number: 9, labels: ['ready-for-coding'] });
    s.workflow('coder', sourceWorkflow('coder', s.blockingScript(), `max_concurrent: 2\n${READY}`));
    const b = await s.build();

    const report = await b.scheduler.planOnce();
    expect(report.skipped).toBeNull();
    expect(report.startedRunIds).toHaveLength(2);
    const diag = b.scheduler.lastDiagnosis('coder');
    expect(diag?.candidates.map((c) => [c.itemKey, c.decision])).toEqual([
      [ITEM_KEY, 'started'],
      ['repo_a:8', 'started'],
      ['repo_a:9', 'workflow_limit'],
    ]);
    const runs = await Promise.all(report.startedRunIds.map((id) => waitStatus(b, s.env, id, 'running')));
    // Separate workspaces, same coder identity (from the snapshot).
    expect(new Set(runs.map((r) => r.workspacePath)).size).toBe(2);
    expect(runs.map((r) => (r.configSnapshot as { workflow: { identity: string } }).workflow.identity)).toEqual(['coder', 'coder']);
    expect(s.env.p.runs.countActive('coder')).toBe(2);

    // Next poll: still full, nothing new (no persistent queue, no third run).
    const again = await b.scheduler.planOnce();
    expect(again.startedRunIds).toEqual([]);
    expect(candidate(b.scheduler.lastDiagnosis('coder'), 'repo_a:9').decision).toBe('workflow_limit');

    // Slots free up → the next poll starts the remaining candidate.
    s.release();
    await Promise.all(runs.map((r) => waitStatus(b, s.env, r.id, 'completed')));
    const third = await b.scheduler.planOnce();
    expect(third.startedRunIds).toHaveLength(1);
    expect(s.env.p.runs.get(third.startedRunIds[0] as string)?.sourceItemKey).toBe('repo_a:9');
  });

  it('a locked or blocked high-priority candidate does not block the next one', async () => {
    s.env.github.setLabels(REPO, ISSUE, ['ready-for-coding', 'priority:high']);
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    const prio = `item_priority:
  rules:
    - when: { field: labels, operator: contains, value: 'priority:high' }
      value: 100
  default: 0`;
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), `max_concurrent: 2\n${READY}\n${prio}`));
    const b = await s.build();
    const config = b.config;

    // (a) active lock on the high-priority item (a reserved run of the same workflow)
    const holder = s.env.p.runs.reserve({
      workflowId: 'coder',
      triggerType: 'source',
      sourceId: 'repo_a',
      sourceItemKey: ITEM_KEY,
      configSnapshot: config.snapshotWorkflow('coder'),
    });
    let report = await b.scheduler.planOnce();
    let diag = b.scheduler.lastDiagnosis('coder');
    expect(diag?.candidates.map((c) => [c.itemKey, c.itemPriority, c.decision])).toEqual([
      [ITEM_KEY, 100, 'locked'],
      ['repo_a:8', 0, 'started'],
    ]);
    expect(candidate(diag, ITEM_KEY).runId).toBe(holder.id);
    await waitStatus(b, s.env, report.startedRunIds[0] as string, 'completed');

    // (b) retry block on the high-priority item (lock gone)
    b.h.controller.cancelRun(holder.id);
    await waitStatus(b, s.env, holder.id, 'cancelled');
    const block = s.env.p.blocks.create({ workflowId: 'coder', itemKey: ITEM_KEY, reason: 'three crashes' });
    s.env.github.setLabels(REPO, 8, ['ready-for-coding']);
    report = await b.scheduler.planOnce();
    diag = b.scheduler.lastDiagnosis('coder');
    expect(candidate(diag, ITEM_KEY)).toMatchObject({ decision: 'blocked', blockId: block.id });
    expect(candidate(diag, 'repo_a:8').decision).toBe('started');
    expect(diag?.candidates[0]?.itemKey).toBe(ITEM_KEY);
  });

  it('an unknown filter result is not startable and does not block the next candidate', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.env.github.denyDependencies(REPO, ISSUE);
    const filter = `filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }`;
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), `max_concurrent: 2\n${filter}`));
    const b = await s.build();
    const report = await b.scheduler.planOnce();
    const diag = b.scheduler.lastDiagnosis('coder');
    expect(candidate(diag, ITEM_KEY).decision).toBe('filter_unknown');
    expect(JSON.stringify(candidate(diag, ITEM_KEY).filter)).toContain('"value":"unknown"');
    expect(candidate(diag, 'repo_a:8').decision).toBe('started');
    expect(report.startedRunIds).toHaveLength(1);
  });

  it('workflow priority wins over item priority', async () => {
    s.configYaml({ maxConcurrent: 1 });
    s.env.github.setLabels(REPO, ISSUE, ['ready-for-coding', 'urgent']);
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    const urgent = `item_priority:
  rules:
    - when: { field: labels, operator: contains, value: urgent }
      value: 1000`;
    const ok = s.env.script('ok.sh', 'exit 0');
    s.workflow('low', sourceWorkflow('low', ok, `priority: 10\nmax_concurrent: 5\n${READY}\n${urgent}`));
    s.workflow('high', sourceWorkflow('high', ok, `priority: 50\nmax_concurrent: 5\n${READY}`));
    const b = await s.build();
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    expect(s.env.p.runs.get(report.startedRunIds[0] as string)).toMatchObject({ workflowId: 'high', sourceItemKey: ITEM_KEY });
    const low = b.scheduler.lastDiagnosis('low');
    expect(candidate(low, ITEM_KEY)).toMatchObject({ itemPriority: 1000, decision: 'global_limit' });
    expect(candidate(b.scheduler.lastDiagnosis('high'), 'repo_a:8').decision).toBe('global_limit');
    await waitStatus(b, s.env, report.startedRunIds[0] as string, 'completed');
  });

  it('runs workflow conditions once per planning step; false blocks all candidates of the workflow', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.env.github.createIssue(REPO, { number: 9, labels: ['ready-for-coding'] });
    const counter = path.join(s.env.marks, 'cond-count');
    const cond = s.env.script('cond.sh', `echo x >> "${counter}"\nexit 1`);
    s.workflow(
      'coder',
      sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), `max_concurrent: 3\n${READY}\nconditions:\n  workflow:\n    - { type: shell, command: ${cond} }`),
    );
    const b = await s.build();
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toEqual([]);
    const diag = b.scheduler.lastDiagnosis('coder');
    expect(diag?.candidates.map((c) => c.decision)).toEqual(['condition_failed', 'condition_failed', 'condition_failed']);
    expect(diag?.conditions).toMatchObject([{ kind: 'workflow_condition', value: false, exitCode: 1 }]);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    // Next step evaluates again (no cache configured).
    await b.scheduler.planOnce();
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('caches workflow conditions per `cache` TTL (FakeClock) and treats exit 2 as unknown', async () => {
    const counter = path.join(s.env.marks, 'cond-count');
    const cond = s.env.script('cond.sh', `echo x >> "${counter}"\nexit 0`);
    const broken = s.env.script('broken.sh', 'exit 2');
    s.workflow(
      'coder',
      sourceWorkflow(
        'coder',
        s.blockingScript(),
        `max_concurrent: 1\n${READY}\nconditions:\n  workflow:\n    - { type: shell, command: ${cond}, cache: 60s }`,
      ),
    );
    s.workflow(
      'other',
      sourceWorkflow('other', s.env.script('ok.sh', 'exit 0'), `${READY}\nconditions:\n  workflow:\n    - { type: shell, command: ${broken} }`),
    );
    const b = await s.build();
    const first = await b.scheduler.planOnce();
    expect(first.startedRunIds).toHaveLength(1);
    expect(candidate(b.scheduler.lastDiagnosis('other'), ITEM_KEY)).toMatchObject({ decision: 'condition_unknown' });
    expect(b.scheduler.lastDiagnosis('other')?.conditions[0]).toMatchObject({ value: 'unknown', exitCode: 2 });
    await waitStatus(b, s.env, first.startedRunIds[0] as string, 'running');
    s.release();
    await waitStatus(b, s.env, first.startedRunIds[0] as string, 'completed');
    s.env.github.setLabels(REPO, ISSUE, ['ready-for-coding']);
    await b.scheduler.planOnce();
    expect(b.scheduler.lastDiagnosis('coder')?.conditions[0]).toMatchObject({ value: true, cached: true });
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    s.clock.advance(60_000);
    // The second run (started by the last step) must not block the next step from evaluating.
    const ids = b.h.controller.activeRunIds();
    await Promise.all(ids.map((id) => waitStatus(b, s.env, id, 'completed')));
    s.env.github.setLabels(REPO, ISSUE, ['ready-for-coding']);
    await b.scheduler.planOnce();
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('applies the shell filter and item conditions per candidate', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.env.github.createIssue(REPO, { number: 9, labels: ['ready-for-coding'] });
    const sf = s.env.script('sf.sh', `grep -q '"item_id":"8"' "$ORCH_CHECK_CONTEXT_FILE" && exit 1\nexit 0`);
    const ic = s.env.script('ic.sh', `[ "$1" = "9" ] && exit 1\nexit 0`);
    s.workflow(
      'coder',
      sourceWorkflow(
        'coder',
        s.env.script('ok.sh', 'exit 0'),
        `max_concurrent: 3\n${READY}\nshell_filter: { command: ${sf} }\nconditions:\n  item:\n    - { type: shell, command: ${ic}, args: ['{item.number}'] }`,
      ),
    );
    const b = await s.build();
    const report = await b.scheduler.planOnce();
    const diag = b.scheduler.lastDiagnosis('coder');
    expect(diag?.candidates.map((c) => [c.itemKey, c.decision])).toEqual([
      [ITEM_KEY, 'started'],
      ['repo_a:8', 'shell_filter_rejected'],
      ['repo_a:9', 'condition_failed'],
    ]);
    expect(candidate(diag, 'repo_a:9').itemConditions[0]).toMatchObject({ kind: 'item_condition', value: false });
    await waitStatus(b, s.env, report.startedRunIds[0] as string, 'completed');
  });

  it('respects readiness, pause and runtime overrides', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.workflow('coder', sourceWorkflow('coder', s.blockingScript(), `max_concurrent: 2\n${READY}`));
    const b = await s.build({ recover: false });
    expect((await b.scheduler.planOnce()).skipped).toBe('not_ready');
    await b.h.controller.recover();
    b.h.controller.pause();
    expect((await b.scheduler.planOnce()).skipped).toBe('paused');
    b.h.controller.resume();

    b.config.setWorkflowOverrides('coder', { enabled: false });
    expect((await b.scheduler.planOnce()).startedRunIds).toEqual([]);
    expect(b.scheduler.lastDiagnosis('coder')?.status).toBe('disabled');

    b.config.setWorkflowOverrides('coder', { enabled: true, maxConcurrent: 1 });
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    expect(candidate(b.scheduler.lastDiagnosis('coder'), 'repo_a:8').decision).toBe('workflow_limit');
    await waitStatus(b, s.env, report.startedRunIds[0] as string, 'running');

    b.config.setGlobalMaxConcurrent(1);
    b.config.setWorkflowOverrides('coder', { maxConcurrent: 5 });
    await b.scheduler.planOnce();
    expect(candidate(b.scheduler.lastDiagnosis('coder'), 'repo_a:8').decision).toBe('global_limit');
  });

  it('a failing source does not block other workflows', async () => {
    s.env.github.createIssue('example/b', { number: 1, labels: ['ready-for-coding'] });
    s.env.github.failNext({ method: 'GET', path: '/repos/example/b/issues' }, { status: 500 }, 5);
    const ok = s.env.script('ok.sh', 'exit 0');
    s.workflow('coder', sourceWorkflow('coder', ok, READY));
    s.workflow('coder_b', sourceWorkflow('coder_b', ok, READY).replace('source: repo_a', 'source: repo_b'));
    const b = await s.build();
    const report = await b.scheduler.planOnce();
    expect(b.scheduler.lastDiagnosis('coder_b')).toMatchObject({ status: 'source_error' });
    expect(b.scheduler.lastDiagnosis('coder_b')?.error).toContain('repo_b');
    expect(report.startedRunIds).toHaveLength(1);
    await waitStatus(b, s.env, report.startedRunIds[0] as string, 'completed');
  });

  it('scenario 3 (end-to-end): dependency filter prevents the start; after closing the blocker the next poll starts it', async () => {
    s.env.github.createIssue('example/b', { number: 1, title: 'Blocker' });
    s.env.github.addBlockedBy(REPO, ISSUE, 'example/b', 1);
    const filter = `filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }`;
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), filter));
    const b = await s.build();

    b.scheduler.start();
    await b.scheduler.whenIdle();
    expect(b.scheduler.lastPlanningStep()?.startedRunIds).toEqual([]);
    const blocked = candidate(b.scheduler.lastDiagnosis('coder'), ITEM_KEY);
    expect(blocked.decision).toBe('filtered');
    expect(JSON.stringify(blocked.filter)).toContain('"field":"dependencies.blocked_by_open"');
    expect(s.env.p.runs.list({ workflowId: 'coder' }).total).toBe(0);

    s.env.github.closeIssue('example/b', 1);
    await s.clock.advanceAsync(29_000);
    await b.scheduler.whenIdle();
    expect(s.env.p.runs.list({ workflowId: 'coder' }).total).toBe(0); // not yet polled again

    await s.clock.advanceAsync(1_000);
    await b.scheduler.whenIdle();
    const runs = s.env.p.runs.list({ workflowId: 'coder' }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sourceItemKey).toBe(ITEM_KEY);
    expect(candidate(b.scheduler.lastDiagnosis('coder'), ITEM_KEY).decision).toBe('started');
    await waitStatus(b, s.env, runs[0]?.id as string, 'completed');
    expect(s.env.github.labels(REPO, ISSUE)).toContain('ready-for-review');
  });

  it('polling loop: no overlapping steps, next step only after the interval', async () => {
    s.configYaml({ pollingInterval: '10s' });
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY.replace('ready-for-coding', 'nothing-matches')));
    const b = await s.build();
    const steps: string[] = [];
    b.scheduler.start();
    await b.scheduler.whenIdle();
    steps.push(b.scheduler.lastPlanningStep()?.startedAt as string);
    expect(s.clock.pendingTimers()).toBe(1);
    await s.clock.advanceAsync(9_999);
    await b.scheduler.whenIdle();
    expect(b.scheduler.lastPlanningStep()?.startedAt).toBe(steps[0]);
    await s.clock.advanceAsync(1);
    await b.scheduler.whenIdle();
    expect(b.scheduler.lastPlanningStep()?.startedAt).toBe('2026-01-01T00:00:10.000Z');
    // Concurrent explicit calls are serialized.
    const [x, y] = await Promise.all([b.scheduler.planOnce(), b.scheduler.planOnce()]);
    expect(x.finishedAt <= y.startedAt).toBe(true);
    await b.scheduler.stop();
    expect(s.clock.pendingTimers()).toBe(0);
  });
});

describe('Scheduler – manual start (Spec §5.5, §7)', () => {
  let s: SchedulerEnv;
  beforeEach(() => {
    s = createSchedulerEnv();
    s.configYaml();
  });
  afterEach(async () => s.teardown());

  it('scenario 2: manual start ignores filter/conditions/limits/block but fails on the active lock', async () => {
    s.configYaml({ maxConcurrent: 1 });
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.env.github.setLabels(REPO, ISSUE, []); // filter does not match
    const condMarker = path.join(s.env.marks, 'condition-ran');
    const cond = s.env.script('cond.sh', `touch "${condMarker}"\nexit 1`);
    s.workflow(
      'coder',
      sourceWorkflow(
        'coder',
        s.blockingScript(),
        `max_concurrent: 1\n${READY}\nconditions:\n  workflow:\n    - { type: shell, command: ${cond} }\n  item:\n    - { type: shell, command: ${cond} }`,
      ),
    );
    const b = await s.build();
    // Limits exhausted (workflow + global) by an active run on another item; block on the item.
    s.env.p.runs.reserve({
      workflowId: 'coder',
      triggerType: 'source',
      sourceId: 'repo_a',
      sourceItemKey: 'repo_a:8',
      configSnapshot: b.config.snapshotWorkflow('coder'),
    });
    s.env.p.blocks.create({ workflowId: 'coder', itemKey: ITEM_KEY, reason: 'three crashes' });

    const result = await b.scheduler.startManual('coder', { itemRef: `https://github.com/${REPO}/issues/${ISSUE}` });
    expect(result.run).toMatchObject({ triggerType: 'manual', sourceItemKey: ITEM_KEY, status: 'reserved' });
    await waitStatus(b, s.env, result.run.id, 'running');
    expect(existsSync(condMarker)).toBe(false);
    expect(s.env.p.runs.countActive('coder')).toBe(2); // manual run counts towards the utilization

    await expect(b.scheduler.startManual('coder', { itemRef: `#${ISSUE}` })).rejects.toBeInstanceOf(LockConflictError);
    await expect(b.scheduler.startManual('coder', { itemRef: String(ISSUE) })).rejects.toMatchObject({ code: 'lock_conflict' });

    // Automatic planning sees the manual run in the utilization.
    s.env.github.setLabels(REPO, 8, ['ready-for-coding']);
    await b.scheduler.planOnce();
    expect(b.scheduler.lastDiagnosis('coder')?.candidates.every((c) => c.decision.endsWith('_limit'))).toBe(true);
  });

  it('manual start is possible while paused and counts towards the limit of automatic starts', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.blockingScript(), `max_concurrent: 1\n${READY}`));
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    const b = await s.build();
    b.h.controller.pause();
    const { run } = await b.scheduler.startManual('coder', { itemRef: '8' });
    await waitStatus(b, s.env, run.id, 'running');
    b.h.controller.resume();
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toEqual([]);
    expect(candidate(b.scheduler.lastDiagnosis('coder'), ITEM_KEY).decision).toBe('workflow_limit');
  });

  it('validates item references and parameters', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
    s.workflow(
      'deploy',
      `
id: deploy
name: Deploy
trigger: { type: manual }
parameters:
  environment: { type: enum, values: [staging, production], required: true }
  dry: { type: boolean, default: false }
execute:
  type: shell
  command: ${s.env.script('deploy.sh', `echo "$ORCH_CONTEXT_FILE" > /dev/null\nexit 0`)}
`,
    );
    const b = await s.build();
    const code = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
        return 'resolved';
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        return (err as SchedulerError).code;
      }
    };
    expect(await code(b.scheduler.startManual('coder'))).toBe('manual_item_required');
    expect(await code(b.scheduler.startManual('coder', { itemRef: 'https://github.com/other/repo/issues/1' }))).toBe('manual_item_invalid_ref');
    expect(await code(b.scheduler.startManual('coder', { itemRef: '999' }))).toBe('manual_item_not_found');
    expect(await code(b.scheduler.startManual('nope'))).toBe('config_unknown_workflow');
    expect(await code(b.scheduler.startManual('deploy', { itemRef: '7' }))).toBe('manual_item_not_supported');
    expect(await code(b.scheduler.startManual('deploy', { parameters: { environment: 'moon' } }))).toBe('invalid_parameters');
    expect(s.env.p.runs.list({}).total).toBe(0);

    const ok = await b.scheduler.startManual('deploy', { parameters: { environment: 'staging' } });
    expect(ok.run).toMatchObject({ triggerType: 'manual', sourceItemKey: null, parameters: { environment: 'staging', dry: false } });
    expect((await ok.done).status).toBe('completed');
    // Item-less manual runs never conflict with each other.
    const second = await b.scheduler.startManual('deploy', { parameters: { environment: 'production' } });
    expect((await second.done).status).toBe('completed');

    await b.h.controller.drain();
    expect(await code(b.scheduler.startManual('deploy', { parameters: { environment: 'staging' } }))).toBe('scheduler_not_accepting');
  });
});
