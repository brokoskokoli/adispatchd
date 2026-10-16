import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, drive, loadSnapshot, type LifecycleTestEnv } from './testing/helpers.js';

const CONTROLLER_VAR = 'ORCH_LIFECYCLE_TEST_CONTROLLER_SECRET';
const CONTROLLER_VALUE = 'controller-only-value-4711';

describe('shell actions', () => {
  let env: LifecycleTestEnv;
  let dir: string;
  let script: string;
  let out: string;

  beforeEach(() => {
    env = createEnv();
    dir = mkdtempSync(path.join(os.tmpdir(), 'orch-lifecycle-shell-'));
    out = path.join(dir, 'out');
    mkdirSync(out);
    script = path.join(dir, 'action.sh');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        'env > "$OUT/env.txt"',
        'cp "$ORCH_CONTEXT_FILE" "$OUT/context.json"',
        'pwd > "$OUT/pwd.txt"',
        'printf "%s\\n" "$@" > "$OUT/args.txt"',
        'echo "attempt" >> "$OUT/attempts.txt"',
        'exit "${EXIT_CODE:-0}"',
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    process.env[CONTROLLER_VAR] = CONTROLLER_VALUE;
  });

  afterEach(() => {
    delete process.env[CONTROLLER_VAR];
    env.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  function hook(extra = ''): string {
    return `
id: wf
name: Coder WF
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
on_success:
  - type: shell
    command: ${script}
    args: ['{result.message}', '#{item.number}', '{run.id}']
    env:
      OUT: ${out}
      MSG: 'msg={result.message}'
${extra}`;
  }

  it('gets the run/result context and rendered env, but no controller environment', async () => {
    const snapshot = await loadSnapshot(hook());
    const run = env.finalizeSuccess(env.reserve(snapshot).id, 'Tests green');
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('succeeded');

    const envDump = readFileSync(path.join(out, 'env.txt'), 'utf8');
    expect(envDump).not.toContain(CONTROLLER_VAR);
    expect(envDump).not.toContain(CONTROLLER_VALUE);
    expect(envDump).toContain(`ORCH_RUN_ID=${run.id}`);
    expect(envDump).toContain('ORCH_WORKFLOW_ID=wf');
    expect(envDump).toContain('ORCH_SOURCE_ITEM_ID=7');
    expect(envDump).toContain('MSG=msg=Tests green');
    const names = envDump
      .split('\n')
      .map((l) => l.split('=')[0])
      .filter((n): n is string => !!n);
    const allowed = new Set(['PATH', 'HOME', 'LANG', 'TZ', 'USER', 'LOGNAME', 'TMPDIR', 'OUT', 'MSG', 'PWD', 'SHLVL', '_', 'OLDPWD']);
    expect(names.filter((n) => !allowed.has(n) && !n.startsWith('ORCH_') && !n.startsWith('__CF'))).toEqual([]);

    const context = JSON.parse(readFileSync(path.join(out, 'context.json'), 'utf8')) as Record<string, unknown>;
    expect(context).toMatchObject({
      schema_version: 1,
      kind: 'lifecycle_action',
      hook: 'on_success',
      run: { id: run.id, trigger: 'source', status: 'finalizing' },
      workflow: { id: 'wf', name: 'Coder WF' },
      action: { ordinal: 0, type: 'shell', attempt: 1 },
      source: { id: 'repo_a', type: 'github', item_id: '7', item_key: 'repo_a:7' },
      result: { status: 'completed', result: 'success', message: 'Tests green' },
    });
    expect(readFileSync(path.join(out, 'args.txt'), 'utf8')).toBe(`Tests green\n#7\n${run.id}\n`);
    // without an existing workspace the action runs in its own attempt directory
    expect(readFileSync(path.join(out, 'pwd.txt'), 'utf8').trim()).toBe(
      realpathSync(path.join(env.dataDir, 'runs', run.id, 'actions', String(result.actions[0]?.id), 'attempt-1', 'cwd')),
    );
  });

  it('runs in the run workspace when it exists', async () => {
    const snapshot = await loadSnapshot(hook());
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const workspace = path.join(dir, 'workspace');
    mkdirSync(workspace);
    env.p.runs.update(run.id, { workspacePath: workspace });
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('succeeded');
    expect(readFileSync(path.join(out, 'pwd.txt'), 'utf8').trim()).toBe(realpathSync(workspace));
  });

  it('a non-zero exit fails the attempt and is retried per policy', async () => {
    const snapshot = await loadSnapshot(
      hook().replace('      MSG:', '      EXIT_CODE: "3"\n      MSG:') + '    retry: { max_attempts: 2, delay: 2s }\n',
    );
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.failedAction?.attempts).toBe(2);
    expect(result.failedAction?.lastError).toMatchObject({
      code: 'lifecycle_shell_exit',
      retryable: true,
      details: { exitCode: 3 },
    });
    expect(readFileSync(path.join(out, 'attempts.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(env.notifications.map((n) => n.type)).toEqual(['lifecycle_action_failed']);
  });

  it('enforces the action timeout', async () => {
    writeFileSync(script, '#!/bin/sh\nsleep 5\n');
    const snapshot = await loadSnapshot(hook('    timeout: 200ms\n    retry: { max_attempts: 1 }\n'));
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const started = Date.now();
    const result = await drive(env.engine({ shellCancelGraceMs: 100 }).runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.failedAction?.lastError).toMatchObject({ code: 'lifecycle_shell_timeout' });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
