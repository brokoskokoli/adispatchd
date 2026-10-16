import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATUSES,
  canTransition,
  hookForOutcome,
  isFilterAll,
  isFilterNot,
  isFilterPredicate,
  isTechnicalFailure,
  isTerminalStatus,
  RUN_STATUS_TRANSITIONS,
  TECHNICAL_STATUSES,
  TERMINAL_STATUSES,
  type FilterNode,
} from './types.js';

describe('run status model', () => {
  it('partitions statuses into active and terminal', () => {
    expect([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].sort()).toEqual([...TECHNICAL_STATUSES].sort());
  });

  it('terminal statuses have no outgoing transitions', () => {
    for (const s of TERMINAL_STATUSES) expect(RUN_STATUS_TRANSITIONS[s]).toEqual([]);
  });

  it('allows the normal path and rejects shortcuts to completed', () => {
    expect(canTransition('reserved', 'starting')).toBe(true);
    expect(canTransition('starting', 'running')).toBe(true);
    expect(canTransition('running', 'finalizing')).toBe(true);
    expect(canTransition('finalizing', 'completed')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(false);
    expect(canTransition('completed', 'running')).toBe(false);
  });

  it('classifies technical failures (Spec §11)', () => {
    expect(['crashed', 'start_error', 'timed_out'].every((s) => isTechnicalFailure(s as never))).toBe(true);
    expect(isTechnicalFailure('cancelled')).toBe(false);
    expect(isTechnicalFailure('completed')).toBe(false);
    expect(isTerminalStatus('recovery_pending')).toBe(false);
  });

  it('maps outcomes to hooks (Spec §8.2)', () => {
    expect(hookForOutcome('completed', 'success')).toBe('on_success');
    expect(hookForOutcome('completed', null)).toBe('on_success');
    expect(hookForOutcome('completed', 'failure')).toBe('on_failure');
    expect(hookForOutcome('crashed', null)).toBe('on_crash');
    expect(hookForOutcome('start_error', null)).toBe('on_start_error');
    expect(hookForOutcome('timed_out', null)).toBe('on_timeout');
    expect(hookForOutcome('cancelled', null)).toBe('on_cancel');
  });
});

describe('filter AST guards', () => {
  it('distinguishes node kinds', () => {
    const node: FilterNode = {
      all: [
        { field: 'labels', operator: 'contains', value: 'ready-for-coding' },
        { not: { field: 'dependencies.blocked_by_open', operator: 'greater_than', value: 0 } },
      ],
    };
    expect(isFilterAll(node)).toBe(true);
    if (!isFilterAll(node)) return;
    expect(isFilterPredicate(node.all[0] as FilterNode)).toBe(true);
    expect(isFilterNot(node.all[1] as FilterNode)).toBe(true);
  });
});
