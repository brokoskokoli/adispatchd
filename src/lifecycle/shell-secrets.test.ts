/** `secrets` of `shell` actions (WI-18): env and file delivery, renewal, deletion, redaction. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLogger } from '../core/index.js';
import { RotatingCredentials } from '../executors/testing/rotating-credentials.js';
import { createEnv, drive, loadSnapshot, type LifecycleTestEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';
const MIN = 60_000;

describe.runIf(supported)('shell actions with secrets (WI-18)', () => {
  let env: LifecycleTestEnv;
  let dir: string;
  let out: string;
  let creds: RotatingCredentials;
  let logger: MemoryLogger;

  beforeEach(() => {
    env = createEnv();
    dir = mkdtempSync(path.join(os.tmpdir(), 'orch-lifecycle-secrets-'));
    out = path.join(dir, 'out');
    mkdirSync(out);
    creds = new RotatingCredentials(env.clock, 15 * MIN, 'act');
    logger = new MemoryLogger();
  });
  afterEach(async () => {
    writeFileSync(path.join(out, 'go'), ''); // release a waiting action even if a test failed early
    await new Promise((resolve) => setTimeout(resolve, 100));
    env.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  function script(body: string): string {
    const file = path.join(dir, 'action.sh');
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  function workflow(command: string, secrets: string, extra = ''): string {
    return `
id: wf
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
on_success:
  - type: shell
    command: ${command}
    env:
      OUT: ${out}
    secrets:
${secrets}
${extra}`;
  }

  const engine = () => env.engine({ credentials: creds, logger });

  function attemptDirs(runId: string, actionId: number) {
    const rel = path.join('actions', String(actionId), 'attempt-1');
    return {
      secrets: path.join(env.dataDir, 'runs', runId, rel, 'secrets'),
      stdout: path.join(env.dataDir, 'logs', runId, rel, 'stdout.log'),
      context: path.join(env.dataDir, 'runs', runId, rel, 'context.json'),
    };
  }

  function assertNoToken(runId: string, files: string[]): void {
    const tokens = creds.issued.map((t) => t.token);
    expect(tokens.length).toBeGreaterThan(0);
    const texts = [
      JSON.stringify(env.p.events.listForRun(runId)),
      JSON.stringify(env.p.actions.listForRun(runId)),
      JSON.stringify(logger.records),
      ...files.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8')),
    ];
    for (const text of texts) for (const token of tokens) expect(text).not.toContain(token);
  }

  it('delivery env: the token is in the variable and redacted from the action log', async () => {
    const cmd = script('[ -n "$GH_TOKEN" ] && [ -z "${GH_TOKEN_FILE+x}" ] || exit 3\necho "token=$GH_TOKEN"');
    const snapshot = await loadSnapshot(workflow(cmd, '      GH_TOKEN: { identity: coder }'));
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('succeeded');
    const files = attemptDirs(run.id, result.actions[0]!.id);
    expect(readFileSync(files.stdout, 'utf8')).toBe('token=[REDACTED]\n');
    expect(creds.calls.map((c) => c.identity)).toEqual(['coder']);
    assertNoToken(run.id, [files.stdout, files.context]);
  });

  it('delivery file: the token is in <NAME>_FILE (attempt directory), the file is gone after the action', async () => {
    const cmd = script(
      [
        '[ -z "${GH_TOKEN+x}" ] || exit 3',
        'echo "path=$GH_TOKEN_FILE"',
        'echo "token=$(cat "$GH_TOKEN_FILE")"',
        'cat "$GH_TOKEN_FILE" > "$OUT/seen"',
      ].join('\n'),
    );
    const snapshot = await loadSnapshot(workflow(cmd, '      GH_TOKEN: { identity: coder, delivery: file }'));
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    // No fake-time advance here: the token is not renewed while the action runs.
    const result = await engine().runHook(run, 'on_success', snapshot);
    expect(result.status).toBe('succeeded');
    const files = attemptDirs(run.id, result.actions[0]!.id);
    expect(readFileSync(path.join(out, 'seen'), 'utf8')).toBe(creds.last?.token);
    const stdout = readFileSync(files.stdout, 'utf8');
    expect(stdout).toContain(`path=${path.join(files.secrets, 'GH_TOKEN')}`);
    expect(stdout).toContain('token=[REDACTED]');
    expect(existsSync(files.secrets)).toBe(false);
    assertNoToken(run.id, [files.stdout, files.context]);
  });

  it('delivery file: a long action finds a renewed token; the file is deleted even when the action fails', async () => {
    const cmd = script(
      [
        'echo \'@@ADISPATCH_EVENT {"type":"status","message":"ready"}\'',
        'i=0; while [ ! -f "$OUT/go" ] && [ $i -lt 1500 ]; do i=$((i + 1)); sleep 0.02; done',
        'cat "$GH_TOKEN_FILE" > "$OUT/seen"',
        'echo "token=$(cat "$GH_TOKEN_FILE")"',
        'exit 4',
      ].join('\n'),
    );
    const snapshot = await loadSnapshot(
      workflow(cmd, '      GH_TOKEN: { identity: coder, delivery: file }', '    timeout: 2h\n    retry: { max_attempts: 1 }\n'),
    );
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const pending = engine().runHook(run, 'on_success', snapshot);
    const secretsRoot = path.join(env.dataDir, 'runs', run.id, 'actions');
    let file = '';
    await vi.waitFor(
      () => {
        const actionId = readdirSync(secretsRoot)[0]!;
        file = path.join(secretsRoot, actionId, 'attempt-1', 'secrets', 'GH_TOKEN');
        expect(readFileSync(file, 'utf8')).toBe(creds.issued[0]?.token);
      },
      { timeout: 5_000, interval: 10 },
    );
    for (let step = 0; step < 40; step++) {
      await env.clock.advanceAsync(MIN);
      const expected = creds.last!;
      // Fake time must not run ahead of the real file I/O: wait until the file is written AND the next renewal is armed.
      await vi.waitFor(
        () => {
          expect(readFileSync(file, 'utf8')).toBe(expected.token);
          expect(env.clock.pendingTimers()).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 5 },
      );
      expect(expected.expiresAt.getTime()).toBeGreaterThan(env.clock.nowMs());
    }
    expect(creds.issued.length).toBeGreaterThan(5);
    writeFileSync(path.join(out, 'go'), '');
    const result = await pending;
    expect(result.status).toBe('failed');
    expect(readFileSync(path.join(out, 'seen'), 'utf8')).toBe(creds.last?.token);
    expect(existsSync(path.dirname(file))).toBe(false);
    const files = attemptDirs(run.id, result.actions[0]!.id);
    expect(readFileSync(files.stdout, 'utf8')).toContain('token=[REDACTED]\n');
    assertNoToken(run.id, [files.stdout, files.context]);
  });

  it('a failing token exchange fails the attempt (retryable) without starting the action', async () => {
    creds.failNext = 5;
    const cmd = script('echo started > "$OUT/started"');
    const snapshot = await loadSnapshot(
      workflow(cmd, '      GH_TOKEN: { identity: coder, delivery: file }', '    retry: { max_attempts: 2, delay: 1s }\n'),
    );
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.failedAction?.attempts).toBe(2);
    expect(result.failedAction?.lastError).toMatchObject({ retryable: true, kind: 'transient' });
    expect(existsSync(path.join(out, 'started'))).toBe(false);
    expect(existsSync(attemptDirs(run.id, result.actions[0]!.id).secrets)).toBe(false);
  });

  it('without a credential provider the action fails permanently', async () => {
    const cmd = script('exit 0');
    const snapshot = await loadSnapshot(workflow(cmd, '      GH_TOKEN: { identity: coder }'));
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('failed');
    expect(result.failedAction?.attempts).toBe(1);
    expect(result.failedAction?.lastError).toMatchObject({ code: 'lifecycle_no_credentials', retryable: false });
  });

  it('journal entries from before WI-18 (no secrets field) still run', async () => {
    const cmd = script('[ -z "${GH_TOKEN+x}" ] || exit 3');
    const snapshot = await loadSnapshot(workflow(cmd, '      {}').replace('    secrets:\n      {}\n', ''));
    const action = snapshot.workflow.hooks.on_success[0] as { secrets?: unknown };
    delete action.secrets;
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(engine().runHook(run, 'on_success', snapshot), env.clock);
    expect(result.status).toBe('succeeded');
    expect(creds.calls).toEqual([]);
  });
});
