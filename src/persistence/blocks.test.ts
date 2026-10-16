import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockExistsError } from './errors.js';
import type { Persistence } from './persistence.js';
import { CANCELLED, CRASH, FAILURE, SUCCESS, TIMEOUT, completeRun, openTestPersistence, reserveSource } from './testing/helpers.js';

describe('technical failure counter and blocks', () => {
  let p: Persistence;
  let cleanup: () => void;
  const policy = { maxTechnicalFailures: 3 };

  beforeEach(() => {
    ({ p, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  const runOnce = (target: typeof SUCCESS, item = 'project_a:1', workflow = 'coder') =>
    completeRun(p, reserveSource(p, workflow, item).id, target, policy);

  it('counts crashed/start_error/timed_out; failure and cancelled neither count nor reset', () => {
    runOnce(CRASH);
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(1);
    runOnce(FAILURE);
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(1);
    runOnce(CANCELLED);
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(1);
    runOnce(TIMEOUT);
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(2);
    // other item / other workflow are independent
    runOnce(CRASH, 'project_a:2');
    runOnce(CRASH, 'project_a:1', 'reviewer');
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(2);
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:2')).toBe(1);
    expect(p.blocks.consecutiveTechnicalFailures('reviewer', 'project_a:1')).toBe(1);
  });

  it('success resets the counter', () => {
    runOnce(CRASH);
    runOnce(CRASH);
    runOnce(SUCCESS);
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(0);
    runOnce(CRASH);
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(1);
    expect(p.blocks.isBlocked('coder', 'project_a:1')).toBe(false);
  });

  it('a success starts a new counting period: later block only lists failures after it', () => {
    const before = runOnce(CRASH);
    const success = runOnce(SUCCESS);
    const after = [runOnce(CRASH), runOnce(CRASH), runOnce(CRASH)];
    const block = p.blocks.activeFor('coder', 'project_a:1')!;
    expect(block.failureCount).toBe(3);
    const affected = p.blocks.affectedRunIds(block.id);
    expect(affected).toHaveLength(3);
    expect(affected.sort()).toEqual(after.map((r) => r.id).sort());
    expect(affected).not.toContain(before.id);
    expect(affected).not.toContain(success.id);
  });

  it('creates the block in the same transaction as finalizing when the limit is reached', () => {
    runOnce(CRASH);
    runOnce(CRASH);
    const run = reserveSource(p, 'coder', 'project_a:1');
    p.runs.transition(run.id, 'starting');
    p.runs.transition(run.id, 'running');
    const fin = p.runs.beginFinalization(run.id, CRASH, { blockPolicy: policy });
    // block exists while the run is still finalizing (before on_crash runs)
    expect(fin.run.status).toBe('finalizing');
    expect(fin.consecutiveTechnicalFailures).toBe(3);
    expect(fin.blockCreated).not.toBeNull();
    expect(fin.blockCreated).toMatchObject({ workflowId: 'coder', itemKey: 'project_a:1', runId: run.id, failureCount: 3, generation: 0 });
    expect(p.blocks.activeFor('coder', 'project_a:1')?.id).toBe(fin.blockCreated!.id);
    p.runs.finish(run.id);
    expect(p.blocks.affectedRunIds(fin.blockCreated!.id)).toHaveLength(3);
    // further failures (e.g. manual runs) do not create a second active block
    const more = reserveSource(p, 'coder', 'project_a:1');
    p.runs.transition(more.id, 'starting');
    expect(p.runs.beginFinalization(more.id, { status: 'start_error', businessResult: null, reason: 'x' }, { blockPolicy: policy }).blockCreated).toBeNull();
    expect(p.blocks.listActive()).toHaveLength(1);
  });

  it('counter, finalizing and block are one atomic unit (rollback leaves nothing behind)', () => {
    runOnce(CRASH);
    runOnce(CRASH);
    const run = reserveSource(p, 'coder', 'project_a:1');
    p.runs.transition(run.id, 'starting');
    p.runs.transition(run.id, 'running');
    expect(() =>
      p.transaction(() => {
        const fin = p.runs.beginFinalization(run.id, CRASH, { blockPolicy: policy });
        expect(fin.blockCreated).not.toBeNull();
        throw new Error('simulated crash before commit');
      }),
    ).toThrow('simulated crash');
    expect(p.runs.require(run.id).status).toBe('running');
    expect(p.runs.require(run.id).finalStatus).toBeNull();
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(2);
    expect(p.blocks.isBlocked('coder', 'project_a:1')).toBe(false);
    // invalid target is rejected without side effects
    expect(() => p.runs.beginFinalization(run.id, { status: 'completed', businessResult: null, reason: 'x' }, { blockPolicy: policy })).toThrow();
    expect(p.blocks.consecutiveTechnicalFailures('coder', 'project_a:1')).toBe(2);
  });

  it('clearing a block starts a new counting period; history stays', () => {
    runOnce(CRASH);
    runOnce(CRASH);
    runOnce(CRASH);
    const block = p.blocks.activeFor('coder', 'project_a:1')!;
    const cleared = p.blocks.clear(block.id, 'maintainer');
    expect(cleared.clearedAt).not.toBeNull();
    expect(cleared.clearedBy).toBe('maintainer');
    expect(p.blocks.clear(block.id).clearedAt).toBe(cleared.clearedAt); // idempotent
    expect(p.blocks.isBlocked('coder', 'project_a:1')).toBe(false);
    expect(p.blocks.counter('coder', 'project_a:1')).toEqual({ consecutive: 0, generation: 1 });

    runOnce(CRASH);
    runOnce(CRASH);
    expect(p.blocks.isBlocked('coder', 'project_a:1')).toBe(false);
    runOnce(CRASH);
    const second = p.blocks.activeFor('coder', 'project_a:1')!;
    expect(second.generation).toBe(1);
    expect(p.blocks.affectedRunIds(second.id)).toHaveLength(3);
    expect(p.blocks.affectedRunIds(block.id)).toHaveLength(3);
    expect(p.runs.list({ workflowId: 'coder' }).total).toBe(6);
    expect(p.blocks.listForWorkflow('coder', { itemKey: 'project_a:1' })).toHaveLength(2);
  });

  it('uses workflow scope for sourceless runs', () => {
    for (let i = 0; i < 3; i++) {
      const r = p.runs.reserve({ workflowId: 'deploy', triggerType: 'manual', configSnapshot: {} });
      completeRun(p, r.id, CRASH, policy);
    }
    expect(p.blocks.consecutiveTechnicalFailures('deploy', null)).toBe(3);
    const block = p.blocks.activeFor('deploy', null);
    expect(block?.itemKey).toBeNull();
    expect(() => p.blocks.create({ workflowId: 'deploy', itemKey: null, reason: 'dup' })).toThrow(BlockExistsError);
    // an item-scoped block of the same workflow is separate
    expect(p.blocks.isBlocked('deploy', 'project_a:1')).toBe(false);
  });
});
