import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDryRun } from './format.js';
import { FakeHubSlots } from './testing/fake-hub-slots.js';
import { ITEM_KEY, REPO, createSchedulerEnv, scheduleWorkflow, sourceWorkflow, waitStatus, type SchedulerEnv } from './testing/helpers.js';

const READY = `filter: { field: labels, operator: contains, value: ready-for-coding }`;

describe('Scheduler with a hub (WI-36)', () => {
  let s: SchedulerEnv;
  let hub: FakeHubSlots;
  beforeEach(() => {
    s = createSchedulerEnv();
    s.configYaml();
    hub = new FakeHubSlots(2);
  });
  afterEach(async () => s.teardown());

  it('hub_limit: a full hub stops automatic starts before any check and is shown in the diagnosis', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), `max_concurrent: 2\n${READY}`));
    hub.others = 2;
    const b = await s.build({ hubSlots: hub });
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toEqual([]);
    expect(b.scheduler.lastDiagnosis('coder')?.candidates).toMatchObject([{ itemKey: ITEM_KEY, decision: 'hub_limit', reason: 'hub limit reached (2/2 active)' }]);
    expect(hub.acquireCalls).toBe(0);
    expect(s.env.p.runs.list({}).total).toBe(0);
  });

  it('hub_limit: hub unreachable or paused → no automatic start', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
    const b = await s.build({ hubSlots: hub });
    hub.reachable = false;
    await b.scheduler.planOnce();
    expect(b.scheduler.lastDiagnosis('coder')?.candidates[0]).toMatchObject({ decision: 'hub_limit', reason: 'hub not reachable (no new automatic runs)' });
    hub.reachable = true;
    hub.paused = true;
    await b.scheduler.planOnce();
    expect(b.scheduler.lastDiagnosis('coder')?.candidates[0]).toMatchObject({ decision: 'hub_limit', reason: 'hub paused (no new automatic runs)' });
    expect(s.env.p.runs.list({}).total).toBe(0);
  });

  it('a slot denied by the hub (stale snapshot) reserves nothing', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
    hub.denyWith = 'hub limit reached (2/2 active)';
    const b = await s.build({ hubSlots: hub });
    await b.scheduler.planOnce();
    expect(hub.acquireCalls).toBe(1);
    expect(b.scheduler.lastDiagnosis('coder')?.candidates[0]).toMatchObject({ decision: 'hub_limit', reason: 'hub limit reached (2/2 active)' });
    expect(s.env.p.runs.list({}).total).toBe(0);
    expect(hub.held).toBe(0);
  });

  it('hands the slot to the started run and releases it when the run ends', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.workflow('coder', sourceWorkflow('coder', s.blockingScript(), `max_concurrent: 5\n${READY}`));
    hub.max = 5;
    const b = await s.build({ hubSlots: hub });
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(2);
    expect(hub.attached).toEqual(report.startedRunIds);
    expect(hub.held).toBe(2);
    s.release();
    await Promise.all(report.startedRunIds.map((id) => waitStatus(b, s.env, id, 'completed')));
    await vi.waitFor(() => expect(hub.held).toBe(0));
    expect(hub.released).toBe(2);
  });

  it('gives the slot back when the local gate closes while the request is in flight', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
    const b = await s.build({ hubSlots: hub });
    hub.beforeGrant = () => b.h.controller.pause();
    const report = await b.scheduler.planOnce();
    expect(report.startedRunIds).toEqual([]);
    expect(b.scheduler.lastDiagnosis('coder')?.candidates[0]?.decision).toBe('gate_closed');
    expect(hub.held).toBe(0);
    expect(hub.released).toBe(1);
  });

  it('manual starts ignore the hub limit but occupy a slot', async () => {
    s.workflow('manual', `id: manual\nname: M\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: ${s.blockingScript()}\n  cancel_grace: 300ms\n`);
    hub.others = 2; // hub full
    const b = await s.build({ hubSlots: hub });
    const { run } = await b.scheduler.startManual('manual');
    expect(hub.adopted).toEqual([run.id]);
    expect(hub.acquireCalls).toBe(0);
    s.release();
    await waitStatus(b, s.env, run.id, 'completed');
  });

  it('cron: records skipped_limit while the hub is full and attaches the slot when it starts', async () => {
    s.workflow('nightly', scheduleWorkflow('nightly', s.env.script('ok.sh', 'exit 0'), '* * * * *', 'max_concurrent: 5'));
    hub.others = 2;
    const b = await s.build({ hubSlots: hub });
    b.scheduler.start();
    await b.scheduler.whenIdle();
    s.clock.advance(60_000);
    await b.scheduler.whenIdle();
    expect(s.env.p.cronFirings.listForWorkflow('nightly')[0]).toMatchObject({ decision: 'skipped_limit', reason: 'hub limit reached (2/2 active)' });
    hub.others = 0;
    s.clock.advance(60_000);
    await b.scheduler.whenIdle();
    const [run] = s.env.p.runs.list({ workflowId: 'nightly' }).runs;
    expect(run).toBeDefined();
    expect(hub.attached).toEqual([run?.id]);
    await waitStatus(b, s.env, run?.id as string, 'completed');
    await vi.waitFor(() => expect(hub.held).toBe(0));
  });

  it('dry-run shows the hub in the capacity, as decision and in the text output', async () => {
    s.env.github.createIssue(REPO, { number: 8, labels: ['ready-for-coding'] });
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), `max_concurrent: 5\n${READY}`));
    hub.others = 1; // one free slot for two candidates
    const b = await s.build({ hubSlots: hub });
    const result = await b.scheduler.dryRun('coder');
    expect(result.capacity.hub).toEqual({ active: 1, max: 2, reachable: true, paused: false });
    expect(result.candidates.map((c) => [c.itemKey, c.decision])).toEqual([
      [ITEM_KEY, 'would_start'],
      ['repo_a:8', 'hub_limit'],
    ]);
    expect(result.candidates[1]?.reason).toBe('hub limit reached (2/2 active) (incl. candidates above)');
    expect(formatDryRun(result)).toContain('hub: 1/2 active');
  });

  it('without a hub nothing changes: no hub in the capacity', async () => {
    s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
    const b = await s.build();
    const result = await b.scheduler.dryRun('coder');
    expect(result.capacity.hub).toBeUndefined();
    expect(result.candidates[0]?.decision).toBe('would_start');
  });

  describe('the slot is given back on every path that does not start a run', () => {
    /** A controller whose `startRun` fails (the real one finalizes a refused run itself). */
    function failingController(get: () => { status: any; canStartAutomatically(): boolean; canStartManually(): boolean }) {
      return {
        get status() {
          return get().status;
        },
        canStartAutomatically: () => get().canStartAutomatically(),
        canStartManually: () => get().canStartManually(),
        startRun: () => {
          throw new Error('boom');
        },
      };
    }

    it('source: workflow disabled meanwhile (workflow_unavailable)', async () => {
      s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
      const b = await s.build({ hubSlots: hub });
      hub.beforeGrant = () => b.config.setWorkflowOverrides('coder', { enabled: false });
      await b.scheduler.planOnce();
      expect(b.scheduler.lastDiagnosis('coder')?.candidates[0]?.decision).toBe('workflow_unavailable');
      expect([hub.held, hub.released]).toEqual([0, 1]);
    });

    it('source: item lock taken meanwhile (locked)', async () => {
      s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), `max_concurrent: 5\n${READY}`));
      const b = await s.build({ hubSlots: hub });
      hub.beforeGrant = () => {
        s.env.p.runs.reserve({ workflowId: 'coder', triggerType: 'source', sourceId: 'repo_a', sourceItemKey: ITEM_KEY, configSnapshot: b.config.snapshotWorkflow('coder') });
        hub.beforeGrant = null;
      };
      await b.scheduler.planOnce();
      expect(b.scheduler.lastDiagnosis('coder')?.candidates[0]?.decision).toBe('locked');
      expect([hub.held, hub.released]).toEqual([0, 1]);
    });

    it('source: the controller refuses the start (start_failed)', async () => {
      s.workflow('coder', sourceWorkflow('coder', s.env.script('ok.sh', 'exit 0'), READY));
      let real!: Awaited<ReturnType<typeof s.build>>['h']['controller'];
      const b = await s.build({ hubSlots: hub, controller: failingController(() => real) });
      real = b.h.controller;
      await b.scheduler.planOnce();
      expect(b.scheduler.lastDiagnosis('coder')?.candidates[0]?.decision).toBe('start_failed');
      expect([hub.held, hub.released]).toEqual([0, 1]);
    });

    async function cronTick(b: Awaited<ReturnType<typeof s.build>>): Promise<void> {
      b.scheduler.start();
      await b.scheduler.whenIdle();
      s.clock.advance(60_000);
      await b.scheduler.whenIdle();
    }

    it('cron: gate closed, block created, start refused', async () => {
      s.workflow('nightly', scheduleWorkflow('nightly', s.env.script('ok.sh', 'exit 0'), '* * * * *', 'max_concurrent: 5'));
      const b = await s.build({ hubSlots: hub });
      hub.beforeGrant = () => b.h.controller.pause();
      await cronTick(b);
      expect(s.env.p.cronFirings.listForWorkflow('nightly')[0]?.decision).toBe('skipped_paused');
      expect([hub.held, hub.released]).toEqual([0, 1]);
      b.h.controller.resume();
      hub.beforeGrant = () => {
        s.env.p.blocks.create({ workflowId: 'nightly', itemKey: null, reason: 'x' });
        hub.beforeGrant = null;
      };
      s.clock.advance(60_000);
      await b.scheduler.whenIdle();
      expect(s.env.p.cronFirings.listForWorkflow('nightly')[0]?.decision).toBe('skipped_blocked');
      expect([hub.held, hub.released]).toEqual([0, 2]);
    });

    it('cron: the controller refuses the start (start_failed)', async () => {
      s.workflow('nightly', scheduleWorkflow('nightly', s.env.script('ok.sh', 'exit 0'), '* * * * *', 'max_concurrent: 5'));
      let real!: Awaited<ReturnType<typeof s.build>>['h']['controller'];
      const b = await s.build({ hubSlots: hub, controller: failingController(() => real) });
      real = b.h.controller;
      await cronTick(b);
      expect(s.env.p.cronFirings.listForWorkflow('nightly')[0]?.decision).toBe('start_failed');
      expect([hub.held, hub.released]).toEqual([0, 1]);
    });
  });
});
