import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSchedulerEnv, scheduleWorkflow, waitStatus, type Built, type SchedulerEnv } from './testing/helpers.js';

const WF = 'nightly';

function firings(s: SchedulerEnv): Array<[string, string]> {
  return s.env.p.cronFirings
    .listForWorkflow(WF)
    .reverse()
    .map((f) => [f.scheduledFor.slice(11, 16), f.decision]);
}

/** Advance the fake clock and wait for all cron handlers / planning steps. */
async function advance(s: SchedulerEnv, b: Built, ms: number): Promise<void> {
  await s.clock.advanceAsync(ms);
  await b.scheduler.whenIdle();
}

describe('Scheduler – cron trigger (Spec §5.5, §7)', () => {
  let s: SchedulerEnv;
  beforeEach(() => {
    s = createSchedulerEnv({ start: '2026-01-01T00:00:30.000Z' });
    s.configYaml();
  });
  afterEach(async () => s.teardown());

  it('scenario 9: a slot at the limit is skipped, no backlog is built up', async () => {
    s.workflow(WF, scheduleWorkflow(WF, s.blockingScript(), '* * * * *', 'max_concurrent: 1'));
    const b = await s.build();
    b.scheduler.start();
    await b.scheduler.whenIdle();
    expect(b.scheduler.cronStatus()).toMatchObject([{ workflowId: WF, nextSlot: '2026-01-01T00:01:00.000Z', lastFiring: null }]);

    await advance(s, b, 30_000); // 00:01
    const first = s.env.p.runs.list({ workflowId: WF }).runs;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ triggerType: 'schedule', scheduledFor: '2026-01-01T00:01:00.000Z' });
    await waitStatus(b, s.env, first[0]?.id as string, 'running');

    await advance(s, b, 60_000); // 00:02 – limit reached
    await advance(s, b, 60_000); // 00:03 – limit reached
    expect(firings(s)).toEqual([
      ['00:01', 'started'],
      ['00:02', 'skipped_limit'],
      ['00:03', 'skipped_limit'],
    ]);
    expect(s.env.p.runs.list({ workflowId: WF }).total).toBe(1);

    s.release();
    await waitStatus(b, s.env, first[0]?.id as string, 'completed');
    await advance(s, b, 60_000); // 00:04 – exactly one new run, skipped slots are not caught up
    expect(firings(s).at(-1)).toEqual(['00:04', 'started']);
    const runs = s.env.p.runs.list({ workflowId: WF }).runs;
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.scheduledFor).sort()).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:04:00.000Z']);
    expect(b.scheduler.cronStatus()[0]).toMatchObject({ nextSlot: '2026-01-01T00:05:00.000Z', lastFiring: { decision: 'started' } });
  });

  it('skips slots on false/unknown conditions, block, pause and disabled workflows', async () => {
    const mode = path.join(s.env.marks, 'mode');
    writeFileSync(mode, '1');
    const cond = s.env.script('cond.sh', `exit "$(cat "${mode}")"`);
    s.workflow(
      WF,
      scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '* * * * *', `max_concurrent: 1\nconditions:\n  workflow:\n    - { type: shell, command: ${cond} }`),
    );
    const b = await s.build();
    b.scheduler.start();
    await b.scheduler.whenIdle();
    await advance(s, b, 30_000); // 00:01 condition false
    writeFileSync(mode, '2');
    await advance(s, b, 60_000); // 00:02 condition unknown
    expect(b.scheduler.cronStatus()[0]?.lastConditions).toMatchObject([{ value: 'unknown', exitCode: 2 }]);
    writeFileSync(mode, '0');
    const block = s.env.p.blocks.create({ workflowId: WF, itemKey: null, reason: 'three crashes' });
    await advance(s, b, 60_000); // 00:03 blocked (workflow scope)
    b.h.controller.clearBlock(block.id);
    b.h.controller.pause();
    await advance(s, b, 60_000); // 00:04 paused
    b.h.controller.resume();
    b.config.setWorkflowOverrides(WF, { enabled: false });
    await advance(s, b, 60_000); // 00:05 disabled
    b.config.setWorkflowOverrides(WF, { enabled: true });
    await advance(s, b, 60_000); // 00:06 started
    expect(firings(s)).toEqual([
      ['00:01', 'skipped_condition'],
      ['00:02', 'skipped_condition_unknown'],
      ['00:03', 'skipped_blocked'],
      ['00:04', 'skipped_paused'],
      ['00:05', 'skipped_disabled'],
      ['00:06', 'started'],
    ]);
    const runs = s.env.p.runs.list({ workflowId: WF }).runs;
    expect(runs).toHaveLength(1);
    expect((await waitStatus(b, s.env, runs[0]?.id as string, 'completed')).scheduledFor).toBe('2026-01-01T00:06:00.000Z');
  });

  it('keeps the schedule alive when handling a slot throws (e.g. a database error)', async () => {
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '* * * * *', 'max_concurrent: 5'));
    const b = await s.build();
    const repo = s.env.p.cronFirings;
    const original = repo.get.bind(repo);
    let failures = 0;
    repo.get = (...args: Parameters<typeof repo.get>) => {
      if (failures === 0) {
        failures++;
        throw new Error('database is locked');
      }
      return original(...args);
    };
    b.scheduler.start();
    await b.scheduler.whenIdle();
    await advance(s, b, 30_000); // 00:01 – handling throws
    expect(failures).toBe(1);
    expect(firings(s)).toEqual([]);
    expect(b.scheduler.cronStatus()[0]?.nextSlot).toBe('2026-01-01T00:02:00.000Z');
    await advance(s, b, 60_000); // 00:02 – decided normally again
    expect(firings(s)).toEqual([['00:02', 'started']]);
    expect(s.env.p.runs.list({ workflowId: WF }).total).toBe(1);
  });

  it('records disabled/paused series only once per state change (no row flood)', async () => {
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '* * * * *', 'max_concurrent: 5'));
    const b = await s.build();
    b.scheduler.start();
    await b.scheduler.whenIdle();
    b.config.setWorkflowOverrides(WF, { enabled: false });
    for (let i = 0; i < 3; i++) await advance(s, b, i === 0 ? 30_000 : 60_000); // 00:01–00:03 disabled
    b.config.setWorkflowOverrides(WF, { enabled: true });
    b.h.controller.pause();
    await advance(s, b, 60_000); // 00:04 paused
    await advance(s, b, 60_000); // 00:05 paused
    b.h.controller.resume();
    await advance(s, b, 60_000); // 00:06 started
    b.config.setWorkflowOverrides(WF, { enabled: false });
    await advance(s, b, 60_000); // 00:07 disabled – new series after a start
    await advance(s, b, 60_000); // 00:08 (not recorded)
    expect(firings(s)).toEqual([
      ['00:01', 'skipped_disabled'],
      ['00:04', 'skipped_paused'],
      ['00:06', 'started'],
      ['00:07', 'skipped_disabled'],
    ]);
    expect(s.env.p.cronFirings.get(WF, '2026-01-01T00:01:00.000Z')?.reason).toContain('further slots are not recorded');
    expect(b.scheduler.cronStatus()[0]?.nextSlot).toBe('2026-01-01T00:09:00.000Z');
  });

  it('records slots missed during downtime as skipped_missed and never catches them up', async () => {
    s.clock.set('2026-01-01T00:05:30.000Z');
    s.env.p.cronFirings.record({ workflowId: WF, scheduledFor: '2026-01-01T00:01:00.000Z', decision: 'started' });
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '* * * * *'));
    const b = await s.build({ cronMisfireToleranceMs: 20_000 });
    b.scheduler.start();
    await b.scheduler.whenIdle();
    // 00:05 is 30 s late (> 20 s tolerance) → missed as well.
    expect(firings(s)).toEqual([
      ['00:01', 'started'],
      ['00:02', 'skipped_missed'],
      ['00:03', 'skipped_missed'],
      ['00:04', 'skipped_missed'],
      ['00:05', 'skipped_missed'],
    ]);
    expect(s.env.p.cronFirings.get(WF, '2026-01-01T00:02:00.000Z')?.reason).toContain('not running');
    expect(s.env.p.runs.list({ workflowId: WF }).total).toBe(0);
    await advance(s, b, 30_000); // 00:06 regular slot
    expect(firings(s).at(-1)).toEqual(['00:06', 'started']);
    expect(s.env.p.runs.list({ workflowId: WF }).total).toBe(1);
  });

  it('starts a slot that is only slightly late after a restart (within tolerance) and caps missed records', async () => {
    s.clock.set('2026-01-01T03:00:10.000Z');
    s.env.p.cronFirings.record({ workflowId: WF, scheduledFor: '2026-01-01T00:00:00.000Z', decision: 'started' });
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '* * * * *'));
    const b = await s.build({ maxRecordedMissedSlots: 5 });
    b.scheduler.start();
    await b.scheduler.whenIdle();
    const list = firings(s);
    // 00:00 (pre-existing), 5 recorded missed slots (02:55–02:59), 03:00 started.
    expect(list).toEqual([
      ['00:00', 'started'],
      ['02:55', 'skipped_missed'],
      ['02:56', 'skipped_missed'],
      ['02:57', 'skipped_missed'],
      ['02:58', 'skipped_missed'],
      ['02:59', 'skipped_missed'],
      ['03:00', 'started'],
    ]);
    expect(s.env.p.cronFirings.get(WF, '2026-01-01T02:55:00.000Z')?.reason).toContain('+174 older missed slot(s) not recorded');
  });

  it('at most one run per slot, also across a scheduler restart within the same slot', async () => {
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '* * * * *', 'max_concurrent: 5'));
    const first = await s.build();
    first.scheduler.start();
    await first.scheduler.whenIdle();
    await advance(s, first, 30_000); // 00:01 started
    await first.scheduler.stop();
    await s.clock.advanceAsync(10_000); // restart 10 s later (still within tolerance of 00:01)
    const second = await s.build();
    second.scheduler.start();
    await second.scheduler.whenIdle();
    expect(firings(s)).toEqual([['00:01', 'started']]);
    expect(s.env.p.runs.list({ workflowId: WF }).total).toBe(1);
    expect(second.scheduler.cronStatus()[0]?.nextSlot).toBe('2026-01-01T00:02:00.000Z');
  });

  it('re-arms on config reload (changed expression) and stops on removal', async () => {
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '0 3 * * *'));
    const b = await s.build();
    b.scheduler.start();
    await b.scheduler.whenIdle();
    expect(b.scheduler.cronStatus()[0]?.nextSlot).toBe('2026-01-01T03:00:00.000Z');
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '*/5 * * * *'));
    expect((await b.config.reload()).ok).toBe(true);
    await b.scheduler.whenIdle();
    expect(b.scheduler.cronStatus()[0]).toMatchObject({ cron: '*/5 * * * *', nextSlot: '2026-01-01T00:05:00.000Z' });
    s.workflow(WF, scheduleWorkflow(WF, s.env.script('ok.sh', 'exit 0'), '*/5 * * * *').replace('type: schedule, cron: \'*/5 * * * *\', timezone: UTC', 'type: manual'));
    expect((await b.config.reload()).ok).toBe(true);
    expect(b.scheduler.cronStatus()).toEqual([]);
    await advance(s, b, 10 * 60_000);
    expect(s.env.p.cronFirings.listForWorkflow(WF)).toEqual([]);
  });
});
