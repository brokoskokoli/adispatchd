/**
 * WI-20: one workflow over several sources – planning across sources, locks
 * per global item key, `max_concurrent_per_source`, isolation of a failing
 * source, tie-break by list order, dry-run per source, manual start with an
 * item reference and `{source.vars.<name>}` at run time.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceAdapter } from '../core/index.js';
import { BASE_FILES } from '../config/testing/fixtures.js';
import { SchedulerError } from './errors.js';
import { formatDryRun } from './format.js';
import { ITEM_KEY, REPO, createSchedulerEnv, waitStatus, type SchedulerEnv } from './testing/helpers.js';
import type { CandidateDiagnosis, WorkflowPlanningDiagnosis } from './types.js';

const REPO_B = 'example/b';
const READY = `filter: { field: labels, operator: contains, value: ready-for-coding }`;

/** sources.yaml of the tests plus variables per source. */
const SOURCES_WITH_VARS = (BASE_FILES['sources.yaml'] as string)
  .replace('    repository: a\n    identity: maintainer\n', '    repository: a\n    identity: maintainer\n    vars: { base_branch: main }\n')
  .replace('    repository: b\n    identity: maintainer\n', '    repository: b\n    identity: maintainer\n    vars: { base_branch: develop }\n');

function multiWorkflow(id: string, command: string, sources: string, extra = ''): string {
  return `
id: ${id}
trigger: { type: source, sources: [${sources}] }
identity: coder
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
  env:
    BASE: '{source.vars.base_branch}'
    KEY: '{item.key}'
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
on_cancel:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
${READY}
${extra}`;
}

function decisions(diag: WorkflowPlanningDiagnosis | undefined): Array<[string, string]> {
  return (diag?.candidates ?? []).map((c: CandidateDiagnosis) => [c.itemKey, c.decision]);
}

describe('Scheduler – multi-source workflows (WI-20)', () => {
  let s: SchedulerEnv;
  beforeEach(() => {
    s = createSchedulerEnv();
    s.configYaml();
    writeFileSync(path.join(s.env.configDir, 'sources.yaml'), SOURCES_WITH_VARS);
  });
  afterEach(async () => s.teardown());

  it('starts candidates of both sources with separate locks, snapshots and source variables', async () => {
    // Same issue number in both repositories: two different global item keys.
    s.env.github.createIssue(REPO_B, { number: 7, labels: ['ready-for-coding'] });
    const worker = s.env.script('vars.sh', `echo "$BASE" > "${s.env.marks}/$KEY"\nexit 0`);
    s.workflow('coder', multiWorkflow('coder', worker, 'repo_a, repo_b', 'max_concurrent: 3'));
    const b = await s.build();

    const report = await b.scheduler.planOnce();
    expect(decisions(b.scheduler.lastDiagnosis('coder'))).toEqual([
      [ITEM_KEY, 'started'],
      ['repo_b:7', 'started'],
    ]);
    const runs = await Promise.all(report.startedRunIds.map((id) => waitStatus(b, s.env, id, 'completed')));
    expect(runs.map((r) => [r.sourceId, r.sourceItemKey])).toEqual([
      ['repo_a', ITEM_KEY],
      ['repo_b', 'repo_b:7'],
    ]);
    expect(runs.map((r) => (r.configSnapshot as { source: { id: string } }).source.id)).toEqual(['repo_a', 'repo_b']);
    // Lifecycle actions went to the repository of each item; variables per source.
    expect(s.env.github.labels(REPO, 7)).toContain('ready-for-review');
    expect(s.env.github.labels(REPO_B, 7)).toContain('ready-for-review');
    expect(readFileSync(path.join(s.env.marks, ITEM_KEY), 'utf8').trim()).toBe('main');
    expect(readFileSync(path.join(s.env.marks, 'repo_b:7'), 'utf8').trim()).toBe('develop');
    const diag = b.scheduler.lastDiagnosis('coder');
    expect(diag?.sources).toEqual([
      expect.objectContaining({ sourceId: 'repo_a', status: 'ok', polled: 1 }),
      expect.objectContaining({ sourceId: 'repo_b', status: 'ok', polled: 1 }),
    ]);
    expect(diag).toMatchObject({ sourceId: 'repo_a', polled: 2, status: 'ok', error: null });
  });

  it('max_concurrent_per_source limits each source; max_concurrent stays the overall limit', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'], createdAt: '2020-01-01T00:00:00Z' });
    s.env.github.createIssue(REPO_B, { number: 1, labels: ['ready-for-coding'] });
    s.env.github.createIssue(REPO_B, { number: 2, labels: ['ready-for-coding'] });
    s.workflow('coder', multiWorkflow('coder', s.blockingScript(), 'repo_a, repo_b', 'max_concurrent: 3\nmax_concurrent_per_source: 1'));
    const b = await s.build();

    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(2);
    const diag = b.scheduler.lastDiagnosis('coder');
    expect(decisions(diag)).toEqual([
      ['repo_a:8', 'started'],
      [ITEM_KEY, 'source_limit'],
      ['repo_b:1', 'started'],
      ['repo_b:2', 'source_limit'],
    ]);
    expect(diag?.candidates[1]?.reason).toBe("limit per source reached for 'repo_a' (1/1 active)");
    await Promise.all(report.startedRunIds.map((id) => waitStatus(b, s.env, id, 'running')));
    expect(s.env.p.runs.countActive('coder', 'repo_a')).toBe(1);
    expect(s.env.p.runs.countActive('coder', 'repo_b')).toBe(1);

    // Dry-run simulates the same limit and shows the usage per source.
    const dry = await b.scheduler.dryRun('coder');
    expect(dry.capacity.perSource).toEqual({ max: 1, active: { repo_a: 1, repo_b: 1 } });
    expect(dry.candidates.filter((c) => c.decision === 'source_limit').map((c) => c.itemKey)).toEqual([ITEM_KEY, 'repo_b:2']);
    expect(formatDryRun(dry)).toContain('capacity per source: repo_a 1/1, repo_b 1/1');
  });

  it('the per-source limit counts runs started before a reload from "source: a" to "sources: [a, b]"', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.env.github.createIssue(REPO_B, { number: 1, labels: ['ready-for-coding'] });
    const block = s.blockingScript();
    s.workflow('coder', multiWorkflow('coder', block, 'repo_a').replace('sources: [repo_a]', 'source: repo_a'));
    const b = await s.build();
    const first = await b.scheduler.planOnce();
    expect(first.startedRunIds).toHaveLength(1);
    await waitStatus(b, s.env, first.startedRunIds[0] as string, 'running');

    s.workflow('coder', multiWorkflow('coder', block, 'repo_a, repo_b', 'max_concurrent: 3\nmax_concurrent_per_source: 1'));
    expect((await b.config.reload()).ok).toBe(true);
    const second = await b.scheduler.planOnce();
    expect(decisions(b.scheduler.lastDiagnosis('coder'))).toEqual([
      ['repo_a:8', 'source_limit'],
      ['repo_b:1', 'started'],
    ]);
    expect(second.startedRunIds).toHaveLength(1);
  });

  it('a reload during a multi-source planning step makes its candidates workflow_unavailable', async () => {
    s.env.github.createIssue(REPO_B, { number: 1, labels: ['ready-for-coding'] });
    const worker = s.env.script('ok.sh', 'exit 0');
    s.workflow('coder', multiWorkflow('coder', worker, 'repo_a, repo_b', 'max_concurrent: 3'));
    let reload: (() => Promise<unknown>) | undefined;
    const reloading: SourceAdapter = Object.assign(Object.create(Object.getPrototypeOf(s.adapterB) as object) as SourceAdapter, s.adapterB, {
      listCandidates: async (...a: Parameters<SourceAdapter['listCandidates']>) => {
        const items = await s.adapterB.listCandidates(...a);
        // The workflow changes while the step polls: its hash no longer matches.
        s.workflow('coder', multiWorkflow('coder', worker, 'repo_a, repo_b', 'max_concurrent: 2'));
        await reload?.();
        return items;
      },
    });
    const b = await s.build({ sources: (id) => (id === 'repo_a' ? s.env.adapter : id === 'repo_b' ? reloading : undefined) });
    reload = () => b.config.reload();
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toEqual([]);
    expect(decisions(b.scheduler.lastDiagnosis('coder'))).toEqual([
      [ITEM_KEY, 'workflow_unavailable'],
      ['repo_b:1', 'workflow_unavailable'],
    ]);
    expect(s.env.p.runs.list({}).total).toBe(0);
  });

  it('a failing source does not stop the others; the diagnosis names it per source', async () => {
    s.env.github.createIssue(REPO_B, { number: 3, labels: ['ready-for-coding'] });
    const broken: SourceAdapter = Object.assign(Object.create(Object.getPrototypeOf(s.adapterB) as object) as SourceAdapter, s.adapterB, {
      listCandidates: () => Promise.reject(new Error('HTTP 502 from GitHub')),
    });
    s.workflow('coder', multiWorkflow('coder', s.env.script('ok.sh', 'exit 0'), 'repo_b, repo_a', 'max_concurrent: 3'));
    const b = await s.build({ sources: (id) => (id === 'repo_a' ? s.env.adapter : id === 'repo_b' ? broken : undefined) });

    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    const diag = b.scheduler.lastDiagnosis('coder');
    expect(decisions(diag)).toEqual([[ITEM_KEY, 'started']]);
    expect(diag?.status).toBe('source_error');
    expect(diag?.error).toBe("polling source 'repo_b' failed: HTTP 502 from GitHub");
    expect(diag?.sources).toEqual([
      { sourceId: 'repo_b', status: 'source_error', error: "polling source 'repo_b' failed: HTTP 502 from GitHub", polled: 0, pushdown: expect.anything() },
      expect.objectContaining({ sourceId: 'repo_a', status: 'ok', error: null, polled: 1 }),
    ]);
    await waitStatus(b, s.env, report.startedRunIds[0] as string, 'completed');

    const dry = await b.scheduler.dryRun('coder');
    expect(dry.source?.sources.map((x) => [x.sourceId, x.status])).toEqual([
      ['repo_b', 'source_error'],
      ['repo_a', 'ok'],
    ]);
    expect(dry.source?.error).toContain("polling source 'repo_b' failed");
    const textOut = formatDryRun(dry);
    expect(textOut).toContain('trigger: sources repo_b, repo_a');
    expect(textOut).toContain('source repo_b: 0 item(s) polled');
    expect(textOut).toContain("SOURCE ERROR: polling source 'repo_b' failed: HTTP 502 from GitHub");
    // The item of repo_a was taken by the run above (label removed by the hooks).
    expect(textOut).toContain('source repo_a: 0 item(s) polled');
  });

  it('equal item priorities: the list order of "sources" wins before the creation time', async () => {
    // repo_a:7 is older, but repo_b comes first in the list.
    s.env.github.setLabels(REPO, 7, ['ready-for-coding']);
    s.env.github.createIssue(REPO_B, { number: 1, labels: ['ready-for-coding'], createdAt: '2099-01-01T00:00:00Z' });
    s.workflow('coder', multiWorkflow('coder', s.blockingScript(), 'repo_b, repo_a'));
    const b = await s.build();
    await b.scheduler.planOnce();
    expect(decisions(b.scheduler.lastDiagnosis('coder'))).toEqual([
      ['repo_b:1', 'started'],
      [ITEM_KEY, 'workflow_limit'],
    ]);
  });

  it('a higher item priority still beats the list order', async () => {
    s.env.github.setLabels(REPO, 7, ['ready-for-coding', 'urgent']);
    s.env.github.createIssue(REPO_B, { number: 1, labels: ['ready-for-coding'] });
    const prio = `item_priority:
  rules:
    - when: { field: labels, operator: contains, value: urgent }
      value: 10`;
    s.workflow('coder', multiWorkflow('coder', s.blockingScript(), 'repo_b, repo_a', prio));
    const b = await s.build();
    await b.scheduler.planOnce();
    expect(decisions(b.scheduler.lastDiagnosis('coder'))).toEqual([
      [ITEM_KEY, 'started'],
      ['repo_b:1', 'workflow_limit'],
    ]);
  });

  it('item conditions see the variables of the item source', async () => {
    s.env.github.createIssue(REPO_B, { number: 1, labels: ['ready-for-coding'] });
    const log = path.join(s.env.marks, 'conditions');
    const check = s.env.script('check.sh', `echo "$1 $2" >> "${log}"\nexit 1`);
    const conditions = `conditions:
  item:
    - { type: shell, command: ${check}, args: ['{item.key}', '{source.vars.base_branch}'] }`;
    s.workflow('coder', multiWorkflow('coder', s.env.script('ok.sh', 'exit 0'), 'repo_a, repo_b', `max_concurrent: 3\n${conditions}`));
    const b = await s.build();
    await b.scheduler.planOnce();
    expect(decisions(b.scheduler.lastDiagnosis('coder'))).toEqual([
      [ITEM_KEY, 'condition_failed'],
      ['repo_b:1', 'condition_failed'],
    ]);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`${ITEM_KEY} main`, 'repo_b:1 develop']);
  });

  it('dry-run shows the polled items per source', async () => {
    s.env.github.createIssue(REPO_B, { number: 1, labels: ['ready-for-coding'] });
    s.env.github.createIssue(REPO_B, { number: 2, labels: ['other'] });
    s.workflow('coder', multiWorkflow('coder', s.env.script('ok.sh', 'exit 0'), 'repo_a, repo_b', 'max_concurrent: 5'));
    const b = await s.build();
    const dry = await b.scheduler.dryRun('coder');
    expect(dry.trigger).toEqual({ type: 'source', source: 'repo_a', sources: ['repo_a', 'repo_b'] });
    // The label filter is pushed down per source: repo_b:2 is not listed at all.
    expect(dry.source).toMatchObject({ sourceId: 'repo_a', polled: 2, error: null });
    expect(dry.source?.sources.map((x) => [x.sourceId, x.polled, x.pushdown])).toEqual([
      ['repo_a', 1, { field: 'labels', operator: 'contains', value: 'ready-for-coding' }],
      ['repo_b', 1, { field: 'labels', operator: 'contains', value: 'ready-for-coding' }],
    ]);
    expect(dry.candidates.map((c) => [c.sourceId, c.itemKey, c.decision])).toEqual([
      ['repo_a', ITEM_KEY, 'would_start'],
      ['repo_b', 'repo_b:1', 'would_start'],
    ]);
    expect(dry.capacity.perSource).toBeUndefined();
    expect(s.env.p.runs.list({}).total).toBe(0);
  });

  it('manual start derives the source from the item reference', async () => {
    s.env.github.createIssue(REPO_B, { number: 7, labels: [] });
    s.env.github.createIssue(REPO_B, { number: 9, labels: [] });
    s.workflow('coder', multiWorkflow('coder', s.env.script('ok.sh', 'exit 0'), 'repo_a, repo_b', 'max_concurrent: 5'));
    const b = await s.build();

    const byUrl = await b.scheduler.startManual('coder', { itemRef: 'https://github.com/example/b/issues/9' });
    expect(byUrl.run).toMatchObject({ sourceId: 'repo_b', sourceItemKey: 'repo_b:9', triggerType: 'manual' });
    expect((byUrl.run.configSnapshot as { source: { id: string } }).source.id).toBe('repo_b');
    const byKey = await b.scheduler.startManual('coder', { itemRef: 'repo_b:7' });
    expect(byKey.run).toMatchObject({ sourceId: 'repo_b', sourceItemKey: 'repo_b:7' });
    const shortRef = await b.scheduler.startManual('coder', { itemRef: 'example/a#7' });
    expect(shortRef.run).toMatchObject({ sourceId: 'repo_a', sourceItemKey: ITEM_KEY });
    await Promise.all([byUrl, byKey, shortRef].map((r) => r.done));

    const ambiguous = b.scheduler.startManual('coder', { itemRef: '#7' });
    await expect(ambiguous).rejects.toBeInstanceOf(SchedulerError);
    await expect(ambiguous).rejects.toMatchObject({
      code: 'manual_item_invalid_ref',
      message: expect.stringContaining(`is ambiguous for workflow 'coder' with several sources: use a URL or "<source>:<number>"`),
    });
    await expect(b.scheduler.startManual('coder', { itemRef: 'https://github.com/example/c/issues/1' })).rejects.toMatchObject({
      code: 'manual_item_invalid_ref',
      message: expect.stringContaining("is not an item reference of any source of workflow 'coder'"),
    });
    await expect(b.scheduler.startManual('coder', { itemRef: 'repo_b:abc' })).rejects.toMatchObject({
      code: 'manual_item_invalid_ref',
      message: "'repo_b:abc' is not an item reference of source 'repo_b'",
    });
  });

  it('single-source workflows also accept "<source>:<number>" and keep their old errors', async () => {
    s.workflow(
      'single',
      multiWorkflow('single', s.env.script('ok.sh', 'exit 0'), 'repo_a').replace('sources: [repo_a]', 'source: repo_a'),
    );
    const b = await s.build();
    const started = await b.scheduler.startManual('single', { itemRef: 'repo_a:7' });
    expect(started.run).toMatchObject({ sourceId: 'repo_a', sourceItemKey: ITEM_KEY });
    await started.done;
    await expect(b.scheduler.startManual('single', { itemRef: 'repo_b:7' })).rejects.toMatchObject({
      code: 'manual_item_invalid_ref',
      message: "'repo_b:7' is not an item reference of source 'repo_a'",
    });
    const diag = await b.scheduler.planOnce().then(() => b.scheduler.lastDiagnosis('single'));
    expect(diag?.sources).toEqual([expect.objectContaining({ sourceId: 'repo_a', status: 'ok' })]);
  });
});
