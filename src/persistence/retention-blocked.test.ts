import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeClock } from '../core/index.js';
import type { Persistence } from './persistence.js';
import { CRASH, FAILURE, completeRun, openTestPersistence, reserveSource } from './testing/helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('RetentionRepository – blocked category (retention.blocked_runs)', () => {
  let p: Persistence;
  let clock: FakeClock;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, clock, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  it('classifies the runs of a block period as blocked, not failed, and protects them while the block is active', () => {
    const policy = { maxTechnicalFailures: 2 };
    const first = completeRun(p, reserveSource(p, 'coder', 'a:1').id, CRASH, policy);
    const second = completeRun(p, reserveSource(p, 'coder', 'a:1').id, CRASH, policy);
    const plainFailure = completeRun(p, reserveSource(p, 'coder', 'a:2').id, FAILURE);
    const plainCrash = completeRun(p, reserveSource(p, 'coder', 'a:3').id, CRASH, { maxTechnicalFailures: 3 });
    const block = p.blocks.activeFor('coder', 'a:1')!;
    expect(block).not.toBeNull();
    clock.advance(100 * DAY);
    const cutoff = clock.now();

    // Active block: protected.
    expect(p.retention.runCandidates('blocked', cutoff)).toEqual([]);
    expect(p.retention.runCandidates('failed', cutoff).map((c) => c.runId).sort()).toEqual([plainFailure.id, plainCrash.id].sort());

    p.blocks.clear(block.id, 'test');
    expect(p.retention.runCandidates('blocked', cutoff).map((c) => c.runId).sort()).toEqual([first.id, second.id].sort());
    // Not part of the failed category.
    expect(p.retention.runCandidates('failed', cutoff).map((c) => c.runId)).not.toContain(first.id);
    expect(p.retention.deleteRun(first.id)).toBe(true);
  });
});
