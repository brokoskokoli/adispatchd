import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from './errors.js';
import type { Persistence } from './persistence.js';
import { openTestPersistence, reserveSource } from './testing/helpers.js';

describe('ActionRepository', () => {
  let p: Persistence;
  let cleanup: () => void;

  beforeEach(() => {
    ({ p, cleanup } = openTestPersistence());
  });
  afterEach(() => cleanup());

  const journal = (runId: string) =>
    p.actions.createJournal(runId, 'on_success', [
      { type: 'source.update', config: { remove_labels: ['in-progress'] } },
      { type: 'source.comment', name: 'report', config: { body: 'done {result.message}' } },
      { type: 'shell', config: { command: 'notify.sh' } },
    ]);

  it('creates a pending journal with ordinals and is idempotent per hook', () => {
    const run = reserveSource(p, 'coder', 'project_a:1');
    const actions = journal(run.id);
    expect(actions.map((a) => [a.ordinal, a.type, a.status])).toEqual([
      [0, 'source.update', 'pending'],
      [1, 'source.comment', 'pending'],
      [2, 'shell', 'pending'],
    ]);
    expect(actions[1]!.name).toBe('report');
    expect(actions[1]!.config).toEqual({ body: 'done {result.message}' });
    const again = journal(run.id);
    expect(again.map((a) => a.id)).toEqual(actions.map((a) => a.id));
    p.actions.createJournal(run.id, 'on_start', [{ type: 'shell', config: {} }]);
    expect(p.actions.listForRun(run.id)).toHaveLength(4);
  });

  it('records attempts, status, external keys; succeeded actions are final', () => {
    const run = reserveSource(p, 'coder', 'project_a:1');
    const [, comment] = journal(run.id);
    const a1 = p.actions.startAttempt(comment!.id);
    expect(a1.attempt).toBe(1);
    expect(p.actions.require(comment!.id).status).toBe('running');
    p.actions.finishAttempt(a1.id, 'failed', { error: { message: 'HTTP 502' } });
    const a2 = p.actions.startAttempt(comment!.id);
    expect(a2.attempt).toBe(2);
    p.actions.finishAttempt(a2.id, 'succeeded', { externalKey: 'comment:123' });
    const done = p.actions.setStatus(comment!.id, 'succeeded', { externalKey: 'comment:123' });
    expect(done).toMatchObject({ status: 'succeeded', externalKey: 'comment:123', attempts: 2, lastError: { message: 'HTTP 502' } });
    expect(p.actions.listAttempts(comment!.id).map((a) => [a.attempt, a.outcome])).toEqual([
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
    expect(() => p.actions.setStatus(comment!.id, 'running')).toThrow(InvalidTransitionError);
    expect(() => p.actions.startAttempt(comment!.id)).toThrow(InvalidTransitionError);
  });

  it('lists failed actions and runs with incomplete chains', () => {
    const run = reserveSource(p, 'coder', 'project_a:1', { sourceUrl: 'https://x/1' });
    const [first] = journal(run.id);
    p.actions.startAttempt(first!.id);
    p.actions.setStatus(first!.id, 'failed', { error: { message: 'gone' } });
    const failed = p.actions.listFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: first!.id, workflowId: 'coder', sourceItemKey: 'project_a:1', sourceUrl: 'https://x/1' });
    expect(p.actions.runIdsWithIncompleteActions()).toEqual([run.id]);
    // manual retry: failed → running allowed
    p.actions.startAttempt(first!.id);
    expect(p.actions.require(first!.id).status).toBe('running');
    // recovery reset: running → pending
    p.actions.setStatus(first!.id, 'pending', { expectedFrom: 'running' });
    expect(() => p.actions.setStatus(first!.id, 'pending', { expectedFrom: 'running' })).toThrow(InvalidTransitionError);
  });
});
