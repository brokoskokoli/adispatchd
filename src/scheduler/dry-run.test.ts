import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../config/index.js';
import { dryRunWorkflow } from './dry-run.js';
import { formatDryRun } from './format.js';
import { emptyState, repositoryState } from './state.js';
import { ISSUE, ITEM_KEY, REPO, createSchedulerEnv, scheduleWorkflow, sourceWorkflow, type SchedulerEnv } from './testing/helpers.js';

describe('dry-run (Spec §19)', () => {
  let s: SchedulerEnv;
  beforeEach(() => {
    s = createSchedulerEnv();
    s.configYaml();
  });
  afterEach(async () => s.teardown());

  it('never executes shell filters/conditions, reserves nothing and writes nothing', async () => {
    const marker = path.join(s.env.marks, 'executed');
    const touch = s.env.script('touch.sh', `touch "${marker}"\nexit 0`);
    const worker = s.env.script('worker.sh', `touch "${marker}"\nexit 0`);
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.env.github.createIssue('example/b', { number: 1, title: 'Blocker' });
    s.env.github.addBlockedBy(REPO, 8, 'example/b', 1);
    s.workflow(
      'coder',
      sourceWorkflow(
        'coder',
        worker,
        `max_concurrent: 3
filter:
  all:
    - { field: labels, operator: contains, value: ready-for-coding }
    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }
shell_filter: { command: ${touch} }
conditions:
  workflow:
    - { type: shell, command: ${touch} }
  item:
    - { type: shell, command: ${touch} }`,
      ),
    );
    const b = await s.build();
    const result = await b.scheduler.dryRun('coder');

    expect(existsSync(marker)).toBe(false);
    expect(s.env.p.runs.list({}).total).toBe(0);
    expect(s.env.github.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(s.env.github.labels(REPO, ISSUE)).toEqual(['ready-for-coding', 'manual-label']);

    expect(result.conditions).toEqual([expect.objectContaining({ kind: 'workflow_condition', value: 'not_evaluated' })]);
    const [first, second] = result.candidates;
    expect(first).toMatchObject({ itemKey: ITEM_KEY, decision: 'pending_checks' });
    expect(first?.shellFilter).toMatchObject({ value: 'not_evaluated' });
    expect(first?.itemConditions).toEqual([expect.objectContaining({ value: 'not_evaluated' })]);
    // Declarative dependency check is evaluated (open cross-repo blocker).
    expect(second).toMatchObject({ itemKey: 'repo_a:8', decision: 'filtered' });
    expect(JSON.stringify(second?.filter)).toContain('"actual":1');
    expect(result.summary).toEqual({ candidates: 2, wouldStart: 0, pendingChecks: 1, notStartable: 1 });
    expect(result.gate).toEqual({ canStartAutomatically: true, reason: null });

    const text = formatDryRun(result);
    expect(text).toContain('unknown / not evaluated');
    expect(text).toContain('dependencies.blocked_by_open equals 0: false (actual 1)');
  });

  it('shows locks, blocks, priorities and simulated capacity', async () => {
    for (const n of [8, 9, 10]) s.env.github.createIssue(REPO, { number: n, labels: ['ready-for-coding'] });
    s.env.github.setLabels(REPO, 10, ['ready-for-coding', 'urgent']);
    s.workflow(
      'coder',
      sourceWorkflow(
        'coder',
        s.env.script('ok.sh', 'exit 0'),
        `max_concurrent: 2
filter: { field: labels, operator: contains, value: ready-for-coding }
item_priority:
  rules:
    - when: { field: labels, operator: contains, value: urgent }
      value: 10`,
      ),
    );
    const b = await s.build();
    const lockRun = s.env.p.runs.reserve({
      workflowId: 'coder',
      triggerType: 'source',
      sourceId: 'repo_a',
      sourceItemKey: 'repo_a:8',
      configSnapshot: b.config.snapshotWorkflow('coder'),
    });
    s.env.p.blocks.create({ workflowId: 'coder', itemKey: 'repo_a:9', reason: 'crashes' });
    const result = await b.scheduler.dryRun('coder');
    expect(result.capacity).toEqual({ global: { active: 1, max: 4 }, workflow: { active: 1, max: 2 } });
    expect(result.gate).toEqual({ canStartAutomatically: true, reason: null });
    expect(result.candidates.map((c) => [c.itemKey, c.itemPriority, c.decision])).toEqual([
      ['repo_a:10', 10, 'would_start'],
      [ITEM_KEY, 0, 'workflow_limit'],
      ['repo_a:8', 0, 'locked'],
      ['repo_a:9', 0, 'blocked'],
    ]);
    expect(result.candidates[2]?.runId).toBe(lockRun.id);
    expect(s.env.p.runs.countActive()).toBe(1);

    // Closed gate / disabled workflow: eligible candidates are never counted as would_start.
    b.h.controller.pause();
    const paused = await b.scheduler.dryRun('coder');
    expect(paused.gate).toEqual({ canStartAutomatically: false, reason: 'paused' });
    expect(paused.candidates.map((c) => c.decision)).toEqual(['gate_closed', 'gate_closed', 'locked', 'blocked']);
    expect(paused.summary.wouldStart).toBe(0);
    b.h.controller.resume();
    b.config.setWorkflowOverrides('coder', { enabled: false });
    const disabled = await b.scheduler.dryRun('coder');
    expect(disabled.candidates.map((c) => c.decision)).toEqual(['workflow_unavailable', 'workflow_unavailable', 'locked', 'blocked']);
    expect(disabled.summary).toMatchObject({ wouldStart: 0, pendingChecks: 0, notStartable: 4 });
  });

  it('dry-runs schedule and manual workflows; works without database/controller', async () => {
    s.workflow('nightly', scheduleWorkflow('nightly', s.env.script('ok.sh', 'exit 0'), '0 3 * * *', 'max_concurrent: 1'));
    s.workflow(
      'deploy',
      `id: deploy\nname: Deploy\ntrigger: { type: manual }\nexecute: { type: shell, command: ${s.env.script('d.sh', 'exit 0')}, keep: ['.agent/*.log'], keep_max_size: 50MB }\n`,
    );
    const config = await ConfigManager.create({ configDir: s.env.configDir, dataDir: s.env.dataDir });
    const deps = { config, sources: () => undefined, state: emptyState(), clock: s.clock };
    const nightly = await dryRunWorkflow(deps, 'nightly');
    expect(nightly.gate).toBeNull();
    expect(nightly.cron).toMatchObject({
      nextSlots: ['2026-01-01T03:00:00.000Z', '2026-01-02T03:00:00.000Z', '2026-01-03T03:00:00.000Z', '2026-01-04T03:00:00.000Z', '2026-01-05T03:00:00.000Z'],
      nextSlotForecast: 'would_start',
    });
    expect(nightly.notes.some((n) => n.includes('controller state unknown'))).toBe(true);
    expect(nightly.notes.some((n) => n.includes('execute.keep'))).toBe(false);
    expect((await dryRunWorkflow(deps, 'deploy')).notes).toContain('files kept after each run (execute.keep, max 50 MB per run): .agent/*.log');

    s.env.p.blocks.create({ workflowId: 'nightly', itemKey: null, reason: 'crashes' });
    const blocked = await dryRunWorkflow({ ...deps, state: repositoryState(s.env.p) }, 'nightly');
    expect(blocked.cron).toMatchObject({ nextSlotForecast: 'skipped_blocked' });

    const deploy = await dryRunWorkflow(deps, 'deploy');
    expect(deploy.cron).toBeNull();
    expect(deploy.source).toBeNull();
    expect(formatDryRun(deploy)).toContain('manual workflow');
    await expect(dryRunWorkflow(deps, 'nope')).rejects.toMatchObject({ code: 'config_unknown_workflow' });
  });

  it('lists the on_result keys and the hook per technical outcome (WI-17)', async () => {
    s.workflow(
      'coder',
      sourceWorkflow(
        'coder',
        s.env.script('ok.sh', 'exit 0'),
        'on_error:\n  - type: source.update\n    labels: { add: [ready-for-coding] }\non_result:\n  approved: []\n  needs_maintainer: []',
      ),
    );
    const config = await ConfigManager.create({ configDir: s.env.configDir, dataDir: s.env.dataDir });
    const result = await dryRunWorkflow({ config, sources: () => undefined, state: emptyState() }, 'coder');
    expect(result.hooks).toEqual({
      onResult: ['approved', 'needs_maintainer'],
      technical: { crashed: 'on_crash', start_error: 'on_error', timed_out: 'on_error', cancelled: 'on_cancel' },
    });
    const text = formatDryRun(result);
    expect(text).toContain('  on_result: approved, needs_maintainer');
    expect(text).toContain('  technical outcomes: crashed → on_crash, start_error → on_error, timed_out → on_error, cancelled → on_cancel');
  });

  it('reports a source error instead of throwing', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), ''));
    const config = await ConfigManager.create({ configDir: s.env.configDir, dataDir: s.env.dataDir });
    const result = await dryRunWorkflow({ config, sources: () => undefined, state: emptyState() }, 'coder');
    expect(result.source).toMatchObject({ sourceId: 'repo_a', error: "source 'repo_a' is not available" });
    expect(formatDryRun(result)).toContain('SOURCE ERROR');
  });
});
