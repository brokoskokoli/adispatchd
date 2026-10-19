import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATUSES,
  canTransition,
  hookForOutcome,
  isFilterAll,
  isHookName,
  outcomeOfHook,
  selectCompletionHook,
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

  it('reaches every terminal status only via finalizing', () => {
    for (const from of TECHNICAL_STATUSES) {
      for (const to of TERMINAL_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(from === 'finalizing');
      }
    }
    expect(RUN_STATUS_TRANSITIONS.recovery_pending).toEqual(['finalizing']);
    for (const from of ACTIVE_STATUSES) {
      if (from !== 'finalizing') expect(canTransition(from, 'finalizing'), from).toBe(true);
    }
  });

  it('finalizing may only move to the persisted target', () => {
    const target = { status: 'crashed', businessResult: null, reason: 'exit code 1' } as const;
    expect(canTransition('finalizing', 'crashed', target)).toBe(true);
    expect(canTransition('finalizing', 'completed', target)).toBe(false);
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

  it('selects on_result.<outcome> for completed runs if defined (WI-17)', () => {
    const hooks = { on_success: [], on_failure: [], 'on_result.approved': [], 'on_result.quiet': [] };
    expect(selectCompletionHook(hooks, 'completed', 'success', 'approved')).toBe('on_result.approved');
    expect(selectCompletionHook(hooks, 'completed', 'failure', 'approved')).toBe('on_result.approved');
    expect(selectCompletionHook(hooks, 'completed', 'failure', 'other')).toBe('on_failure');
    expect(selectCompletionHook(hooks, 'completed', 'success', null)).toBe('on_success');
    // Outcomes only apply to completed runs.
    expect(selectCompletionHook(hooks, 'crashed', null, 'approved')).toBe('on_crash');
  });

  it('falls back to on_error for technical outcomes without a defined specific hook (WI-17)', () => {
    const onlyError = { on_error: [] };
    expect(selectCompletionHook(onlyError, 'crashed', null)).toBe('on_error');
    expect(selectCompletionHook(onlyError, 'start_error', null)).toBe('on_error');
    expect(selectCompletionHook(onlyError, 'timed_out', null)).toBe('on_error');
    expect(selectCompletionHook(onlyError, 'cancelled', null)).toBe('on_error');
    // A defined specific hook wins, even when empty.
    expect(selectCompletionHook({ on_error: [], on_timeout: [] }, 'timed_out', null)).toBe('on_timeout');
    // Neither defined: the specific hook (without actions).
    expect(selectCompletionHook({}, 'cancelled', null)).toBe('on_cancel');
    // on_error never applies to completed runs.
    expect(selectCompletionHook(onlyError, 'completed', 'failure')).toBe('on_failure');
  });

  it('recognizes journal hook names', () => {
    expect(isHookName('on_error')).toBe(true);
    expect(isHookName('on_result.needs_maintainer')).toBe(true);
    expect(isHookName('on_result.')).toBe(false);
    expect(isHookName('on_result.a b')).toBe(false);
    expect(isHookName('on_whatever')).toBe(false);
    expect(outcomeOfHook('on_result.approved')).toBe('approved');
    expect(outcomeOfHook('on_success')).toBeNull();
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
