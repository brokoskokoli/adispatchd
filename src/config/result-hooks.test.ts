/** WI-17: `on_result` (named outcomes) and `on_error` in workflow configuration. */
import { afterEach, describe, expect, it } from 'vitest';
import { selectCompletionHook } from '../core/index.js';
import { formatConfigIssue, loadConfig, resultHookOutcomes, snapshotWorkflow, type LoadConfigResult, type LoadedConfig } from './index.js';
import { knownKeysAt, suggestKey } from './loader.js';
import { workflowSchema } from './schemas.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

async function load(workflow: string): Promise<LoadConfigResult> {
  const t = await createTempConfigDir({ ...BASE_FILES, 'workflows/wf.yaml': workflow });
  temps.push(t);
  return loadConfig(t.dir, { dataDir: t.dataDir });
}

function expectOk(result: LoadConfigResult): LoadedConfig {
  if (!result.ok) throw new Error(`expected valid config:\n${result.errors.map(formatConfigIssue).join('\n')}`);
  return result.config;
}

function issues(result: LoadConfigResult, severity: 'error' | 'warning'): string[] {
  const list = severity === 'error' ? (result.ok ? [] : result.errors) : result.warnings;
  return list.map((i) => `${i.path}: ${i.message}`);
}

const WF = (extra: string): string =>
  ['id: wf', 'trigger: { type: source, source: repo_a }', 'execute: { type: shell, command: /bin/true }', extra].join('\n');

const LABEL = (label: string): string => `    - type: source.update\n      labels: { add: [${label}] }`;

describe('on_result / on_error configuration (WI-17)', () => {
  it('normalizes on_result entries to on_result.<outcome> hooks with generated action IDs', async () => {
    const config = expectOk(
      await load(
        WF(`on_result:
  approved:
${LABEL('approved')}
    - type: source.comment
      message: 'Outcome {result.outcome}: {result.message}'
  needs_maintainer: []
`),
      ),
    );
    const hooks = config.workflows.wf!.hooks;
    expect(resultHookOutcomes(hooks)).toEqual(['approved', 'needs_maintainer']);
    expect(hooks['on_result.approved']?.map((a) => a.id)).toEqual(['on_result.approved.0', 'on_result.approved.1']);
    expect(hooks['on_result.needs_maintainer']).toEqual([]);
    // Snapshots keep the distinction (JSON round trip).
    const snapshot = snapshotWorkflow(config, 'wf');
    expect(selectCompletionHook(snapshot.workflow.hooks, 'completed', 'failure', 'needs_maintainer')).toBe('on_result.needs_maintainer');
  });

  it('keeps "not given" apart from [] for the technical hooks and on_error', async () => {
    const config = expectOk(await load(WF('on_crash: []\non_error:\n  - type: source.update\n    labels: { add: [x] }\n')));
    const hooks = config.workflows.wf!.hooks;
    expect(hooks.on_crash).toEqual([]);
    expect(hooks.on_timeout).toBeUndefined();
    expect(hooks.on_cancel).toBeUndefined();
    expect(hooks.on_start_error).toBeUndefined();
    expect(hooks.on_error).toHaveLength(1);
    // on_start/on_success/on_failure are always lists.
    expect(hooks.on_start).toEqual([]);
    expect(hooks.on_success).toEqual([]);
    expect(hooks.on_failure).toEqual([]);
    expect(selectCompletionHook(hooks, 'crashed', null)).toBe('on_crash');
    expect(selectCompletionHook(hooks, 'timed_out', null)).toBe('on_error');
  });

  it('rejects on_result keys that are not IDs', async () => {
    const result = await load(WF('on_result:\n  "needs maintainer": []\n'));
    expect(issues(result, 'error')).toEqual([
      'on_result.needs maintainer: Invalid key "needs maintainer": Invalid ID (allowed: letters, digits, "_" and "-", must start with a letter or digit, max. 64)',
    ]);
  });

  it('validates on_result actions with paths', async () => {
    const result = await load(
      WF(`on_start:
  - id: notify
    type: source.comment
    message: started
on_result:
  approved:
    - id: notify
      type: source.comment
      message: '{item.body}'
`),
    );
    expect(issues(result, 'error')).toEqual([
      'on_result.approved[0].id: Duplicate action ID "notify" (also used at on_start[0])',
      'on_result.approved[0].message: Unknown placeholder "{item.body}"',
    ]);
  });

  it('rejects {result.outcome} in on_start like the other result placeholders', async () => {
    const result = await load(WF("on_start:\n  - type: source.comment\n    message: '{result.outcome}'\n"));
    expect(issues(result, 'error')).toEqual(['on_start[0].message: Placeholder "{result.outcome}" is not available in this context']);
  });

  it('warns when on_error can never run', async () => {
    const result = await load(WF('on_crash: []\non_start_error: []\non_timeout: []\non_cancel: []\non_error: []\n'));
    expect(issues(result, 'warning')).toEqual([
      'on_error: "on_error" never runs: "on_crash", "on_start_error", "on_timeout", "on_cancel" are all defined (a defined hook, even [], takes precedence)',
    ]);
  });

  it('suggests the intended key for typos ("did you mean")', async () => {
    const result = await load(WF('on_errors: []\non_result:\n  approved:\n    - type: source.update\n      lables: { add: [x] }\n'));
    const errors = issues(result, 'error');
    expect(errors).toContain(': Unknown key(s): "on_errors" (did you mean "on_error"?)');
    expect(errors).toContain('on_result.approved[0]: Unknown key(s): "lables" (did you mean "labels"?)');
  });

  it('suggests only keys of the action variant selected by "type" and none for short keys (review)', async () => {
    const result = await load(
      WF(`on_success:
  - type: source.comment
    message: done
    comand: x
  - type: shell
    command: /bin/true
    comand: x
on: []
`),
    );
    const errors = issues(result, 'error');
    // `command` only exists for shell actions: no hint for the source.comment variant.
    expect(errors).toContain('on_success[0]: Unknown key(s): "comand"');
    expect(errors).toContain('on_success[1]: Unknown key(s): "comand" (did you mean "command"?)');
    // Two letters away from `id` is too far for a two-letter key.
    expect(errors).toContain(': Unknown key(s): "on"');
  });

  it('offers only keys shared by all variants if the discriminator matches none', () => {
    const at = ['on_success', 0] as const;
    expect(knownKeysAt(workflowSchema, { on_success: [{ type: 'shell' }] }, at).sort()).toEqual(
      ['args', 'command', 'continue_on_error', 'env', 'id', 'retry', 'secrets', 'timeout', 'type'],
    );
    expect(knownKeysAt(workflowSchema, { on_success: [{ type: 'nope' }] }, at).sort()).toEqual(['continue_on_error', 'id', 'retry', 'type']);
    expect(suggestKey('on', ['id', 'on_error'])).toBeUndefined();
    expect(suggestKey('on_errors', ['on_error', 'on_result'])).toBe('on_error');
  });
});
