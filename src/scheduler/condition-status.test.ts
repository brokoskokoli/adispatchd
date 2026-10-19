import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShellCheckResult } from '../filters/index.js';
import { checkDisplayName, MAX_CHECK_LABEL_LENGTH } from './checks.js';
import { ConditionStatusStore, summarizeItemChecks } from './condition-status.js';
import { formatDryRun } from './format.js';
import { ISSUE, ITEM_KEY, REPO, createSchedulerEnv, sourceWorkflow, waitStatus, type SchedulerEnv } from './testing/helpers.js';
import type { CandidateDiagnosis, CheckDiagnosis } from './types.js';

const READY = `filter: { field: labels, operator: contains, value: ready-for-coding }`;

function diag(index: number, value: CheckDiagnosis['value'], error: string | null = null): CheckDiagnosis {
  return { kind: 'workflow_condition', index, command: '/x', value, cached: false, exitCode: null, error, durationMs: null };
}

function result(partial: Partial<ShellCheckResult>): ShellCheckResult {
  return {
    value: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 12,
    cached: false,
    ...partial,
  };
}

describe('checkDisplayName (WI-24)', () => {
  it('prefers the name, otherwise command (relative to the config dir) + args, shortened', () => {
    expect(checkDisplayName({ name: 'Credits available', command: '/etc/x/check.sh' })).toBe('Credits available');
    expect(checkDisplayName({ command: '/etc/adispatchd/scripts/check.sh', args: ['--min', '5'] }, '/etc/adispatchd')).toBe('scripts/check.sh --min 5');
    expect(checkDisplayName({ command: '/opt/check.sh' }, '/etc/adispatchd')).toBe('/opt/check.sh');
    expect(checkDisplayName({ command: `/${'d'.repeat(90)}/check.sh`, args: ['a'] })).toBe('…/check.sh a');
    const long = checkDisplayName({ command: 'check', args: ['x'.repeat(200)] });
    expect(long).toHaveLength(MAX_CHECK_LABEL_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('ConditionStatusStore (WI-24)', () => {
  it('keeps the last result per workflow condition and reports status changes only', () => {
    const changes: string[] = [];
    let now = new Date('2026-01-01T00:00:05.000Z');
    const store = new ConditionStatusStore(() => now, (id) => changes.push(id));
    expect(store.get('wf', 2)).toEqual({ workflow: [null, null], items: null });

    store.recordWorkflowCondition('wf', 2, diag(0, true), result({}));
    store.recordWorkflowCondition('wf', 2, diag(1, false), result({ value: false, exitCode: 1, stderr: '\n  no credits left  \nsecond line' }));
    expect(store.get('wf', 2).workflow).toEqual([
      { status: 'ok', checkedAt: '2026-01-01T00:00:05.000Z', ranAt: '2026-01-01T00:00:00.000Z', durationMs: 12, cached: false, exitCode: 0, error: null, stderr: null },
      expect.objectContaining({ status: 'not_now', exitCode: 1, stderr: 'no credits left', error: null }),
    ]);
    expect(changes).toEqual(['wf', 'wf']);

    // Same status again (cache hit): updated, but no change notification.
    now = new Date('2026-01-01T00:00:35.000Z');
    store.recordWorkflowCondition('wf', 2, diag(0, true), result({ cached: true }));
    expect(store.get('wf', 2).workflow[0]).toMatchObject({ status: 'ok', cached: true, checkedAt: '2026-01-01T00:00:35.000Z' });
    expect(changes).toHaveLength(2);

    store.recordWorkflowCondition('wf', 2, diag(0, 'unknown', 'timed out after 15000ms'), result({ value: 'unknown', exitCode: null, timedOut: true }));
    store.recordWorkflowCondition('wf', 2, diag(1, 'not_evaluated'), null);
    expect(store.get('wf', 2).workflow).toEqual([
      expect.objectContaining({ status: 'error', error: 'timed out after 15000ms' }),
      expect.objectContaining({ status: 'skipped', ranAt: null, durationMs: null, exitCode: null }),
    ]);
    expect(changes).toHaveLength(4);

    store.forget(['wf', 'unknown-wf']);
    expect(store.get('wf', 2).workflow).toEqual([null, null]);
    expect(changes).toEqual(['wf', 'wf', 'wf', 'wf', 'wf']);
  });

  it('cuts long stderr lines', () => {
    const store = new ConditionStatusStore(() => new Date(0));
    store.recordWorkflowCondition('wf', 1, diag(0, 'unknown', 'check error: exit code 2'), result({ value: 'unknown', exitCode: 2, stderr: 'e'.repeat(500) }));
    expect(store.get('wf', 1).workflow[0]?.stderr).toHaveLength(200);
  });

  it('summarizes item conditions and the shell filter over the candidates of a step', () => {
    const cand = (itemConditions: CheckDiagnosis[], shellFilter: CheckDiagnosis | null): CandidateDiagnosis =>
      ({ itemConditions, shellFilter }) as unknown as CandidateDiagnosis;
    const ic = (index: number, value: CheckDiagnosis['value']): CheckDiagnosis => ({ ...diag(index, value), kind: 'item_condition' });
    const sf = (value: CheckDiagnosis['value']): CheckDiagnosis => ({ ...diag(0, value), kind: 'shell_filter' });
    const summary = summarizeItemChecks('2026-01-01T00:00:00.000Z', 2, true, [
      cand([ic(0, true), ic(1, true)], sf(true)),
      cand([ic(0, false), ic(1, 'not_evaluated')], sf(true)),
      cand([ic(0, 'unknown'), ic(1, 'not_evaluated')], sf(true)),
      cand([], sf(false)),
      cand([], null),
    ]);
    expect(summary).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      items: 3,
      itemConditions: [
        { ok: 1, notNow: 1, error: 1, notEvaluated: 0 },
        { ok: 1, notNow: 0, error: 0, notEvaluated: 2 },
      ],
      shellFilter: { ok: 3, notNow: 1, error: 0, notEvaluated: 0, items: 4 },
    });
    const store = new ConditionStatusStore(() => new Date(0));
    let n = 0;
    const counting = new ConditionStatusStore(() => new Date(0), () => n++);
    counting.recordItemSummary('wf', summary);
    counting.recordItemSummary('wf', { ...summary, at: '2026-01-01T00:01:00.000Z' });
    expect(n).toBe(1);
    expect(counting.get('wf', 0).items?.at).toBe('2026-01-01T00:01:00.000Z');
    expect(store.get('wf', 0).items).toBeNull();
  });
});

describe('Scheduler – condition status (WI-24)', () => {
  let s: SchedulerEnv;
  beforeEach(() => {
    s = createSchedulerEnv();
    s.configYaml();
  });
  afterEach(async () => s.teardown());

  it('records workflow conditions (ok / not now / cache) and item-condition summaries', async () => {
    s.env.github.createIssue(REPO, { number: 9, labels: ['ready-for-coding'] });
    const ok = s.env.script('ok-cond.sh', 'exit 0');
    const later = s.env.script('later.sh', 'echo "quota exhausted" >&2\nexit 1');
    const ic = s.env.script('ic.sh', `[ "$1" = "9" ] && exit 1\nexit 0`);
    s.workflow(
      'gated',
      sourceWorkflow(
        'gated',
        s.env.script('run.sh', 'exit 0'),
        `${READY}\nconditions:\n  workflow:\n    - { name: Credits available, type: shell, command: ${ok}, cache: 60s }\n    - { type: shell, command: ${later}, args: [--quota] }\n    - { type: shell, command: ${ok} }`,
      ),
    );
    s.workflow(
      'coder',
      sourceWorkflow(
        'coder',
        s.env.script('ok.sh', 'exit 0'),
        `max_concurrent: 3\n${READY}\nconditions:\n  item:\n    - { name: Not item 9, type: shell, command: ${ic}, args: ['{item.number}'] }`,
      ),
    );
    const changes: string[] = [];
    const b = await s.build({ onConditionStatusChange: (id) => changes.push(id) });
    const report = await b.scheduler.planOnce();

    const gated = b.scheduler.conditionStatus('gated');
    expect(gated?.workflow).toEqual([
      expect.objectContaining({ status: 'ok', cached: false, exitCode: 0 }),
      expect.objectContaining({ status: 'not_now', exitCode: 1, stderr: 'quota exhausted' }),
      expect.objectContaining({ status: 'skipped' }),
    ]);
    expect(gated?.items).toBeNull();
    expect(candidate(b, 'gated', ITEM_KEY).reason).toBe(`workflow condition 1 (${later}) is false`);
    expect(b.scheduler.lastDiagnosis('gated')?.conditions[0]).toMatchObject({ name: 'Credits available', value: true });

    const coder = b.scheduler.conditionStatus('coder');
    expect(coder?.workflow).toEqual([]);
    expect(coder?.items).toMatchObject({ items: 2, itemConditions: [{ ok: 1, notNow: 1, error: 0, notEvaluated: 0 }], shellFilter: null });
    expect(candidate(b, 'coder', 'repo_a:9').reason).toBe(`item condition 0 "Not item 9" (${ic}) is false`);
    expect(changes).toContain('gated');
    expect(changes).toContain('coder');
    expect(b.scheduler.conditionStatus('nope')).toBeUndefined();
    await Promise.all(report.startedRunIds.map((id) => waitStatus(b, s.env, id, 'completed')));

    // Second step: the first condition comes from the cache, statuses unchanged → no further notification for "gated".
    s.env.github.setLabels(REPO, ISSUE, ['ready-for-coding']);
    const before = changes.filter((id) => id === 'gated').length;
    s.clock.advance(1000);
    await b.scheduler.planOnce();
    expect(b.scheduler.conditionStatus('gated')?.workflow[0]).toMatchObject({ status: 'ok', cached: true });
    expect(changes.filter((id) => id === 'gated').length).toBe(before);

    // Dry-run output shows the display name.
    const dry = await b.scheduler.dryRun('gated');
    expect(formatDryRun(dry)).toContain(`workflow condition 0 "Credits available" (${ok}): unknown / not evaluated`);
  });

  it('drops the status of changed workflows on reload and keeps the others', async () => {
    const no = s.env.script('no.sh', 'exit 1');
    const wf = (id: string, name: string): string =>
      sourceWorkflow(id, s.env.script('run.sh', 'exit 0'), `${READY}\nconditions:\n  workflow:\n    - { name: ${name}, type: shell, command: ${no} }`);
    s.workflow('a', wf('a', 'Gate A'));
    s.workflow('b', wf('b', 'Gate B'));
    const b = await s.build();
    b.scheduler.start();
    await b.scheduler.whenIdle();
    await b.scheduler.planOnce();
    expect(b.scheduler.conditionStatus('a')?.workflow[0]).toMatchObject({ status: 'not_now' });
    expect(b.scheduler.conditionStatus('b')?.workflow[0]).toMatchObject({ status: 'not_now' });

    s.workflow('a', wf('a', 'Gate A renamed'));
    const res = await b.config.reload();
    expect(res.ok && res.diff.changedWorkflows).toEqual(['a']);
    expect(b.scheduler.conditionStatus('a')?.workflow).toEqual([null]);
    expect(b.scheduler.conditionStatus('b')?.workflow[0]).toMatchObject({ status: 'not_now' });
  });
});

function candidate(b: { scheduler: { lastDiagnosis(id: string): { candidates: CandidateDiagnosis[] } | undefined } }, wf: string, key: string): CandidateDiagnosis {
  const c = b.scheduler.lastDiagnosis(wf)?.candidates.find((x) => x.itemKey === key);
  if (!c) throw new Error(`no candidate ${key}`);
  return c;
}
