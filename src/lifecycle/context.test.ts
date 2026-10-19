import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceError, TemplateError } from '../core/index.js';
import type { LifecycleActionConfig, WorkflowSnapshot } from '../config/index.js';
import type { RunActionRecord } from '../persistence/index.js';
import { buildHookTemplateValues, hookTemplateScope, parseRunSnapshot, renderHookText, resolveActionIdentity } from './context.js';
import { aggregateLifecycleStatus } from './engine.js';
import { describeActionError } from './errors.js';
import { createEnv, drive, loadSnapshot, markedComments, type LifecycleTestEnv } from './testing/helpers.js';

const BASE = `
id: wf
name: Coder WF
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
`;

function patchMessage(snapshot: WorkflowSnapshot, hook: 'on_start' | 'on_success', message: string): WorkflowSnapshot {
  const copy = JSON.parse(JSON.stringify(snapshot)) as WorkflowSnapshot;
  const action = copy.workflow.hooks[hook][0] as { message: string };
  action.message = message;
  return copy;
}

describe('placeholders at runtime', () => {
  let env: LifecycleTestEnv;
  beforeEach(() => {
    env = createEnv();
  });
  afterEach(() => env.cleanup());

  it('renders run/item/result placeholders and literal braces', async () => {
    const snapshot = await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: '{{status}} {result.status}/{result.result}: {result.message} – {item.url} {item.key} {run.trigger}'
`);
    const run = env.finalizeSuccess(env.reserve(snapshot).id, 'OAuth provider missing');
    await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(markedComments(env.github)[0]).toContain(
      '{status} completed/success: OAuth provider missing – https://github.com/example/a/issues/7 repo_a:7 source',
    );
  });

  it('rejects unknown placeholders (config validation bypassed) without posting or retrying', async () => {
    const valid = await loadSnapshot(`${BASE}
on_success:
  - type: source.comment
    message: 'ok'
`);
    const snapshot = patchMessage(valid, 'on_success', 'Done: {result.foo}');
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.failedAction?.attempts).toBe(1);
    expect(result.failedAction?.lastError).toMatchObject({ code: 'template_unknown_placeholder', retryable: false });
    expect(env.github.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('rejects result placeholders in on_start', async () => {
    const valid = await loadSnapshot(`${BASE}
on_start:
  - type: source.comment
    message: 'Coder started, run {run.id} for {item.title}'
`);
    const run = env.reserve(valid);
    const ok = await drive(env.engine().runHook(run, 'on_start', valid), env.clock);
    expect(ok.status).toBe('succeeded');
    expect(markedComments(env.github)[0]).toContain(`Coder started, run ${run.id} for Implement OAuth`);

    const invalid = patchMessage(valid, 'on_start', 'Started: {result.message}');
    const run2 = env.p.runs.reserve({
      workflowId: 'wf',
      triggerType: 'manual',
      sourceId: 'repo_a',
      sourceItemKey: 'repo_a:8',
      configSnapshot: invalid,
    });
    env.github.createIssue('example/a', { number: 8 });
    const failed = await drive(env.engine().runHook(run2, 'on_start'), env.clock);
    expect(failed.failedAction?.lastError).toMatchObject({ code: 'template_unavailable_placeholder', retryable: false });
  });

  it('refuses runs without a valid snapshot', async () => {
    const run = env.p.runs.reserve({ workflowId: 'wf', triggerType: 'manual', configSnapshot: { id: 'wf' } });
    await expect(env.engine().runHook(run, 'on_success')).rejects.toMatchObject({ code: 'lifecycle_invalid_snapshot' });
    expect(() => parseRunSnapshot(null)).toThrow(/snapshot/);
  });
});

describe('context helpers', () => {
  it('builds values per hook scope', async () => {
    const snapshot = await loadSnapshot(`${BASE}
identity: coder
parameters:
  mode: { type: string, default: fast }
on_success:
  - type: source.comment
    message: 'x {parameters.mode}'
`);
    const env = createEnv();
    try {
      const run = env.p.runs.require(env.finalizeSuccess(env.reserve(snapshot).id).id);
      const withParams = { ...run, parameters: { mode: 'fast' } };
      const scope = hookTemplateScope(snapshot, 'on_success');
      expect(scope).toEqual({ run: true, workspace: true, source: true, result: true, linked: true, parameters: ['mode'] });
      expect(hookTemplateScope(snapshot, 'on_start').result).toBe(false);
      const values = buildHookTemplateValues({ run: withParams, snapshot, hook: 'on_success', item: null, now: env.clock.now() });
      expect(renderHookText('{parameters.mode} {workspace.base_dir}', values, scope)).toMatch(/^fast \//);
      const startValues = buildHookTemplateValues({ run, snapshot, hook: 'on_start', item: null, now: env.clock.now() });
      expect(startValues['result.status']).toBeUndefined();
      expect(() => renderHookText('{nope}', values, scope)).toThrow(TemplateError);

      const comment = snapshot.workflow.hooks.on_success[0] as LifecycleActionConfig;
      expect(resolveActionIdentity(comment, snapshot)).toBe('coder'); // workflow identity
      expect(resolveActionIdentity({ ...comment, identity: 'other' } as LifecycleActionConfig, snapshot)).toBe('other');
      const noWorkflowIdentity = { ...snapshot, workflow: { ...snapshot.workflow, identity: null } };
      expect(resolveActionIdentity(comment, noWorkflowIdentity)).toBe('maintainer'); // source identity
    } finally {
      env.cleanup();
    }
  });

  it('classifies errors', () => {
    expect(describeActionError(new SourceError('transient', 'boom', { status: 502, outcomeUnknown: true }))).toMatchObject({
      code: 'source_transient',
      retryable: true,
      outcomeUnknown: true,
      status: 502,
    });
    expect(describeActionError(new SourceError('auth', 'no key')).retryable).toBe(false);
    expect(describeActionError(new TemplateError('unknown_placeholder', 'x')).retryable).toBe(false);
    expect(describeActionError(new Error('token abc123 leaked'), (s) => s.replace('abc123', '[REDACTED]'))).toEqual({
      code: 'lifecycle_unexpected_error',
      message: 'token [REDACTED] leaked',
      retryable: true,
    });
  });

  it('aggregates the lifecycle status over all chains', () => {
    const a = (hook: string, ordinal: number, status: string, continueOnError = false): RunActionRecord =>
      ({ hook, ordinal, status, config: { continueOnError } }) as unknown as RunActionRecord;
    expect(aggregateLifecycleStatus([])).toBeNull();
    expect(aggregateLifecycleStatus([a('on_start', 0, 'succeeded')])).toBe('succeeded');
    expect(aggregateLifecycleStatus([a('on_start', 0, 'failed', true), a('on_start', 1, 'succeeded')])).toBe('succeeded');
    expect(aggregateLifecycleStatus([a('on_start', 0, 'failed'), a('on_start_error', 0, 'succeeded')])).toBe('failed');
    expect(aggregateLifecycleStatus([a('on_start', 0, 'succeeded'), a('on_success', 0, 'pending')])).toBe('pending');
    expect(aggregateLifecycleStatus([a('on_start', 0, 'failed'), a('on_success', 0, 'running')])).toBe('running');
  });
});
