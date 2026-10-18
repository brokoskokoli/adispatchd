import { afterEach, describe, expect, it } from 'vitest';
import { cheapOnly, verifyItemFor } from './planner.js';
import { ISSUE, REPO, createSchedulerEnv, sourceWorkflow, waitStatus, type SchedulerEnv } from './testing/helpers.js';
import { createItemFieldSource, evaluateFilter } from '../filters/index.js';

const READY = `filter: { field: labels, operator: contains, value: ready-for-coding }`;

describe('case-insensitive labels in planning and re-check (WI-13)', () => {
  let s: SchedulerEnv | undefined;
  afterEach(async () => s?.teardown());

  it('planOnce starts an item labelled "Ready-For-Coding" and the re-check before on_start keeps it', async () => {
    s = createSchedulerEnv();
    s.configYaml();
    s.env.github.setLabels(REPO, ISSUE, ['Ready-For-Coding']);
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
    const b = await s.build();

    const item = await s.env.adapter.getItem(String(ISSUE));
    if (!item) throw new Error('fixture issue missing');
    const fields = createItemFieldSource(item, { definitions: s.env.adapter.fieldDefinitions() });
    expect((await evaluateFilter({ field: 'labels', operator: 'contains', value: 'ready-for-coding' }, cheapOnly(fields))).value).toBe(true);
    const workflow = b.config.current.workflows.coder;
    if (!workflow) throw new Error('workflow missing');
    expect(await verifyItemFor(workflow, s.env.adapter)?.(item)).toBe(true);

    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    const run = await waitStatus(b, s.env, report.startedRunIds[0] as string, 'completed');
    expect(run.businessResult).toBe('success');
  });
});
