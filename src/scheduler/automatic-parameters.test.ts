import { afterEach, describe, expect, it } from 'vitest';
import { createSchedulerEnv, scheduleWorkflow, sourceWorkflow, waitStatus, type SchedulerEnv } from './testing/helpers.js';

const PARAMS = `parameters:
  target: { type: string, default: staging }
  replicas: { type: number, default: 2 }
  note: { type: string }`;

describe('automatic runs get the parameter defaults (WI-13)', () => {
  let s: SchedulerEnv | undefined;
  afterEach(async () => s?.teardown());

  it('source runs: defaults are stored and usable in working_directory', async () => {
    s = createSchedulerEnv();
    s.configYaml();
    const wf = sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), `filter: { field: labels, operator: contains, value: ready-for-coding }\n${PARAMS}`)
      .replace('  cancel_grace: 300ms', "  cancel_grace: 300ms\n  working_directory: '{workspace.base_dir}/{parameters.target}/{run.id}'");
    s.workflow('coder', wf);
    const b = await s.build();
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    const run = await waitStatus(b, s.env, report.startedRunIds[0] as string, 'completed');
    expect(run.parameters).toEqual({ target: 'staging', replicas: 2 });
    expect(run.workspacePath).toContain('/staging/');
  });

  it('cron runs: defaults are stored', async () => {
    s = createSchedulerEnv({ start: '2026-01-01T00:00:30.000Z' });
    s.configYaml();
    s.workflow('nightly', scheduleWorkflow('nightly', s.env.script('ok.sh', 'exit 0'), '* * * * *', PARAMS));
    const b = await s.build();
    b.scheduler.start();
    await b.scheduler.whenIdle();
    await s.clock.advanceAsync(30_000);
    await b.scheduler.whenIdle();
    const [run] = s.env.p.runs.list({ workflowId: 'nightly' }).runs;
    expect(run?.parameters).toEqual({ target: 'staging', replicas: 2 });
  });
});
