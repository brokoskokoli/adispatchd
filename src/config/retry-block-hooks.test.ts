/** WI-30: `on_retry_block` / `on_retry_unblock` in workflow configuration (schema, normalization, validation). */
import { afterEach, describe, expect, it } from 'vitest';
import { formatConfigIssue, loadConfig, snapshotWorkflow, type LoadConfigResult, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

async function load(workflow: string, extraFiles: Record<string, string> = {}): Promise<LoadConfigResult> {
  const t = await createTempConfigDir({ ...BASE_FILES, ...extraFiles, 'workflows/wf.yaml': workflow });
  temps.push(t);
  return loadConfig(t.dir, { dataDir: t.dataDir });
}

function expectOk(result: LoadConfigResult): LoadedConfig {
  if (!result.ok) throw new Error(`expected valid config:\n${result.errors.map(formatConfigIssue).join('\n')}`);
  return result.config;
}

function errors(result: LoadConfigResult): string[] {
  return (result.ok ? [] : result.errors).map((i) => `${i.path}: ${i.message}`);
}

const SOURCE_WF = (extra: string): string =>
  ['id: wf', 'trigger: { type: source, source: repo_a }', 'execute: { type: shell, command: /bin/true }', extra].join('\n');
const CRON_WF = (extra: string): string =>
  ['id: wf', "trigger: { type: schedule, cron: '0 3 * * *' }", 'execute: { type: shell, command: /bin/true }', extra].join('\n');

describe('retry-block hooks configuration (WI-30)', () => {
  it('both hooks are optional; configured ones normalize with generated action IDs', async () => {
    const plain = expectOk(await load(SOURCE_WF('')));
    expect(plain.workflows.wf!.hooks.on_retry_block).toBeUndefined();
    expect(plain.workflows.wf!.hooks.on_retry_unblock).toBeUndefined();

    const config = expectOk(
      await load(
        SOURCE_WF(`on_retry_block:
  - type: source.update
    labels: { add: [agent-blocked], remove: [ready] }
  - type: source.comment
    message: 'Blocked after {block.failures} failures (last {block.last_status}, run {run.id}, {result.status}, block {block.id} at {block.created_at})'
  - type: shell
    command: /bin/echo
    args: ['{item.key}', '{block.failures}']
on_retry_unblock:
  - id: unblock-labels
    type: source.update
    labels: { add: [ready], remove: [agent-blocked] }
  - type: source.comment
    message: 'Removed by {block.cleared_by} at {block.cleared_at} (block {block.id}, {run.trigger})'
`),
      ),
    );
    const hooks = config.workflows.wf!.hooks;
    expect(hooks.on_retry_block?.map((a) => a.id)).toEqual(['on_retry_block.0', 'on_retry_block.1', 'on_retry_block.2']);
    expect(hooks.on_retry_unblock?.map((a) => a.id)).toEqual(['unblock-labels', 'on_retry_unblock.1']);
    // Survives the snapshot (JSON round trip).
    expect(snapshotWorkflow(config, 'wf').workflow.hooks.on_retry_unblock).toHaveLength(2);
  });

  it('block.* only in the retry-block hooks, block.cleared_* only in on_retry_unblock, no result.* in on_retry_unblock', async () => {
    const result = await load(
      SOURCE_WF(`on_crash:
  - type: source.comment
    message: 'Block {block.id}'
on_retry_block:
  - type: source.comment
    message: 'Removed by {block.cleared_by}'
on_retry_unblock:
  - type: source.comment
    message: 'Result {result.message}'
`),
    );
    expect(errors(result)).toEqual([
      'on_crash[0].message: Placeholder "{block.id}" is only available in "on_retry_block" and "on_retry_unblock"',
      'on_retry_block[0].message: Placeholder "{block.cleared_by}" is only available in "on_retry_unblock"',
      'on_retry_unblock[0].message: Placeholder "{result.message}" is not available in this context',
    ]);
  });

  it('workflows without item: source actions are rejected, shell actions with block.* are fine', async () => {
    const bad = await load(
      CRON_WF(`on_retry_block:
  - type: source.update
    labels: { add: [x] }
on_retry_unblock:
  - type: source.comment
    message: hi
`),
    );
    expect(errors(bad)).toEqual([
      'on_retry_block[0].type: "source.update" needs a source item; the workflow has no source trigger',
      'on_retry_unblock[0].type: "source.comment" needs a source item; the workflow has no source trigger',
    ]);
    expectOk(
      await load(
        CRON_WF(`on_retry_unblock:
  - type: shell
    command: /bin/echo
    args: ['{block.cleared_by}', '{workflow.id}', '{run.trigger}']
`),
      ),
    );
  });

  it('action IDs stay unique workflow-wide across the retry-block hooks', async () => {
    const result = await load(
      SOURCE_WF(`on_crash:
  - id: reset
    type: source.update
    labels: { add: [ready] }
on_retry_unblock:
  - id: reset
    type: source.update
    labels: { add: [ready] }
`),
    );
    expect(errors(result)).toEqual(['on_retry_unblock[0].id: Duplicate action ID "reset" (also used at on_crash[0])']);
  });

  it('retry_block_cleared is subscribable but not enabled by default', async () => {
    const defaults = expectOk(await load(SOURCE_WF('')));
    expect(defaults.global.notifications.on).toEqual(['retry_block_created', 'lifecycle_action_failed', 'recovery_failed']);
    const configured = expectOk(
      await load(SOURCE_WF(''), {
        'config.yaml': `${BASE_FILES['config.yaml'] ?? ''}\nnotifications:\n  on: [retry_block_created, retry_block_cleared]\n`,
      }),
    );
    expect(configured.global.notifications.on).toEqual(['retry_block_created', 'retry_block_cleared']);
  });
});
