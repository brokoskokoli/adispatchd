/**
 * Process tests with real shell scripts (Spec §8.2, §8.3, §9, §13).
 * Timing: short timeouts only; no test waits on a fixed sleep for its
 * assertion — readiness is signalled by the worker via events.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dataPaths,
  MemoryLogger,
  type ExecutionOutcome,
  type ExecutionSpec,
  type ExecutorDiagnostic,
  type OutputChunk,
  type RunningProcess,
  type WorkerContext,
  type WorkerEvent,
} from '../core/index.js';
import { classifyOutcome } from './classify.js';
import { MINIMAL_ENV_KEYS } from './env.js';
import { REDACTION_MARKER } from './stream-redactor.js';
import { ShellExecutor, type ShellExecutorOptions } from './shell-executor.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

let root: string;
let counter = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wi05-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  proc: RunningProcess;
  spec: ExecutionSpec;
  outputs: OutputChunk[];
  events: WorkerEvent[];
  diagnostics: ExecutorDiagnostic[];
  /** Resolves with the first event of the given type. */
  nextEvent(type: string): Promise<WorkerEvent>;
  wait(): Promise<ExecutionOutcome>;
}

async function writeScript(body: string): Promise<string> {
  const file = path.join(root, `script-${++counter}.sh`);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

async function makeSpec(body: string, overrides: Partial<ExecutionSpec> = {}): Promise<ExecutionSpec> {
  const runId = `run-20261016T190000000Z-${String(++counter).padStart(8, '0')}`;
  const run = dataPaths(path.join(root, 'data')).run(runId);
  const workspace = path.join(root, 'workspaces', 'wf', runId);
  const context: WorkerContext = {
    schema_version: 1,
    run: { id: runId, trigger: 'source', started_at: '2026-10-16T19:00:00.000Z' },
    workflow: { id: 'wf', name: 'Workflow' },
    source: {
      id: 'project_a',
      type: 'github',
      item_id: '123',
      item_key: 'project_a:123',
      url: 'https://github.com/example/project-a/issues/123',
      attributes: { title: 'Implement OAuth' },
    },
    parameters: {},
    workspace: { path: workspace },
  };
  return {
    runId,
    workflowId: 'wf',
    command: await writeScript(body),
    args: [],
    workingDirectory: workspace,
    createDirectory: true,
    env: {},
    secrets: {},
    context,
    files: { contextFile: run.contextFile, resultFile: run.resultFile, stdoutLog: run.stdoutLog, stderrLog: run.stderrLog },
    timeouts: {},
    cancelGraceMs: 500,
    ...overrides,
  };
}

async function launch(spec: ExecutionSpec, options: ShellExecutorOptions = {}): Promise<Harness> {
  const executor = new ShellExecutor({ stdioDrainMs: 1000, ...options });
  const proc = await executor.start(spec);
  const outputs: OutputChunk[] = [];
  const events: WorkerEvent[] = [];
  const diagnostics: ExecutorDiagnostic[] = [];
  const waiters: { type: string; resolve: (e: WorkerEvent) => void }[] = [];
  proc.onOutput((c) => outputs.push(c));
  proc.onDiagnostic((d) => diagnostics.push(d));
  proc.onEvent((e) => {
    events.push(e);
    for (const w of waiters.filter((x) => x.type === e.type)) w.resolve(e);
  });
  return {
    proc,
    spec,
    outputs,
    events,
    diagnostics,
    nextEvent: (type) =>
      new Promise((resolve) => {
        const found = events.find((e) => e.type === type);
        if (found) resolve(found);
        else waiters.push({ type, resolve });
      }),
    wait: () => proc.wait(),
  };
}

async function run(body: string, overrides: Partial<ExecutionSpec> = {}, options: ShellExecutorOptions = {}) {
  const h = await launch(await makeSpec(body, overrides), options);
  const outcome = await h.wait();
  return { ...h, outcome, classification: classifyOutcome(outcome) };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Script fragment: start a background sleeper in the worker's group, publish its pid, signal readiness. */
const BACKGROUND_CHILD = `
sleep 30 &
echo $! > "$ADISPATCH_WORKSPACE/bg.pid"
echo '@@ADISPATCH_EVENT {"type":"ready"}'
`;

async function backgroundPid(spec: ExecutionSpec): Promise<number> {
  return Number((await readFile(path.join(spec.workingDirectory, 'bg.pid'), 'utf8')).trim());
}

const writeResult = (json: string) => `cat > "$ADISPATCH_RESULT_FILE.tmp" <<'EOF'\n${json}\nEOF\nmv "$ADISPATCH_RESULT_FILE.tmp" "$ADISPATCH_RESULT_FILE"`;

describe.runIf(supported)('ShellExecutor – result contract (Spec §8.2 table)', () => {
  it('exit 0 + result success → completed/success', async () => {
    const { outcome, classification } = await run(
      writeResult('{"schema_version":1,"result":"success","message":"done","artifacts":[{"type":"url","url":"https://x"}]}'),
    );
    expect(outcome).toMatchObject({ exitCode: 0, signal: null, cancelled: false, timedOut: false });
    expect(outcome.resultFile.state).toBe('valid');
    expect(classification).toMatchObject({ status: 'completed', businessResult: 'success' });
    expect(classification.result?.message).toBe('done');
  });

  it('exit 0 + result failure → completed/failure', async () => {
    const { classification } = await run(
      writeResult('{"schema_version":1,"result":"failure","message":"OAuth-Anbieter nicht spezifiziert","details":{"missing_information":["OAuth provider"]}}'),
    );
    expect(classification).toMatchObject({ status: 'completed', businessResult: 'failure' });
    expect(classification.result?.details).toEqual({ missing_information: ['OAuth provider'] });
  });

  it('exit 0 without result file → completed/implicit success', async () => {
    const { outcome, classification } = await run('echo hello');
    expect(outcome.resultFile).toEqual({ state: 'missing' });
    expect(classification).toMatchObject({ status: 'completed', businessResult: 'success' });
  });

  it('exit 0 + invalid result file → crashed (protocol error)', async () => {
    const invalidJson = await run(`echo '{"schema_version":1,' > "$ADISPATCH_RESULT_FILE"`);
    expect(invalidJson.outcome.resultFile.state).toBe('invalid');
    expect(invalidJson.classification.status).toBe('crashed');

    const wrongSchema = await run(writeResult('{"schema_version":2,"result":"success"}'));
    expect(wrongSchema.classification).toMatchObject({ status: 'crashed', businessResult: null });

    const tooBig = await run(
      `printf '{"schema_version":1,"result":"success","message":"' > "$ADISPATCH_RESULT_FILE"\n` +
        `head -c 1100000 /dev/zero | tr '\\0' 'a' >> "$ADISPATCH_RESULT_FILE"\nprintf '"}' >> "$ADISPATCH_RESULT_FILE"`,
    );
    expect(tooBig.outcome.resultFile).toMatchObject({ state: 'invalid', error: expect.stringContaining('exceeds') });
    expect(tooBig.classification.status).toBe('crashed');

    const notAFile = await run(`mkdir "$ADISPATCH_RESULT_FILE"`);
    expect(notAFile.outcome.resultFile).toMatchObject({ state: 'invalid', error: 'result file is not a regular file' });
    expect(notAFile.classification.status).toBe('crashed');
  });

  it('exit ≠ 0 → crashed, even with a valid result file', async () => {
    const withSuccess = await run(`${writeResult('{"schema_version":1,"result":"success"}')}\nexit 1`);
    expect(withSuccess.outcome.exitCode).toBe(1);
    expect(withSuccess.classification).toEqual({ status: 'crashed', businessResult: null, reason: 'exit code 1', result: null });

    const withFailure = await run(`${writeResult('{"schema_version":1,"result":"failure"}')}\nexit 2`);
    expect(withFailure.classification).toMatchObject({ status: 'crashed', businessResult: null });

    const noFile = await run('exit 1');
    expect(noFile.classification.status).toBe('crashed');
  });

  it('terminated by a signal (not cancel/timeout) → crashed', async () => {
    const { outcome, classification } = await run(`${writeResult('{"schema_version":1,"result":"success"}')}\nkill -KILL $$`);
    expect(outcome).toMatchObject({ exitCode: null, signal: 'SIGKILL', cancelled: false, timedOut: false });
    expect(classification).toMatchObject({ status: 'crashed', businessResult: null });
  });

  it('process cannot be started → start_error', async () => {
    const missing = await run('', { command: path.join(root, 'does-not-exist') });
    expect(missing.proc.pid).toBeUndefined();
    expect(missing.outcome.spawnError?.code).toBe('ENOENT');
    expect(missing.classification.status).toBe('start_error');

    const spec = await makeSpec('echo hi');
    await chmod(spec.command, 0o644);
    const notExecutable = await launch(spec);
    const outcome = await notExecutable.wait();
    expect(outcome.spawnError?.code).toBe('EACCES');
    expect(classifyOutcome(outcome).status).toBe('start_error');

    const noWorkspace = await run('echo hi', {
      workingDirectory: path.join(root, 'missing-workspace'),
      createDirectory: false,
    });
    expect(noWorkspace.classification.status).toBe('start_error');
  });

  it('process exceeds max_duration → timed_out', async () => {
    const { outcome, classification } = await run(`${writeResult('{"schema_version":1,"result":"success"}')}\nsleep 30`, {
      timeouts: { maxDurationMs: 300 },
      cancelGraceMs: 200,
    });
    expect(outcome.timedOut).toBe('max_duration');
    expect(classification).toMatchObject({ status: 'timed_out', businessResult: null });
  });

  it('controlled cancel → cancelled, even with a result file', async () => {
    const h = await launch(
      await makeSpec(`${writeResult('{"schema_version":1,"result":"success"}')}\necho '@@ADISPATCH_EVENT {"type":"ready"}'\nsleep 30`),
    );
    await h.nextEvent('ready');
    await h.proc.cancel(200);
    const outcome = await h.wait();
    expect(outcome).toMatchObject({ cancelled: true, timedOut: false });
    // SIGTERM hits the whole group. Depending on scheduling, `sh` either dies from the
    // signal itself or first reaps its killed foreground child and exits with 128+15.
    // Both are a controlled cancel; the classification must not depend on which one won.
    expect(outcome.signal === 'SIGTERM' || (outcome.signal === null && outcome.exitCode === 143)).toBe(true);
    expect(classifyOutcome(outcome)).toMatchObject({ status: 'cancelled', businessResult: null });
    expect(classifyOutcome({ ...outcome, signal: null, exitCode: 143 })).toMatchObject({ status: 'cancelled' });
    expect(classifyOutcome({ ...outcome, signal: 'SIGTERM', exitCode: null })).toMatchObject({ status: 'cancelled' });
  });
});

describe.runIf(supported)('ShellExecutor – process group supervision (Spec §13)', () => {
  it('cancel terminates background children of the group and confirms the end', async () => {
    const h = await launch(await makeSpec(`${BACKGROUND_CHILD}\nwait`));
    await h.nextEvent('ready');
    const bg = await backgroundPid(h.spec);
    expect(isAlive(bg)).toBe(true);

    await h.proc.cancel(300);
    expect(isAlive(bg)).toBe(false);
    const outcome = await h.wait();
    expect(classifyOutcome(outcome).status).toBe('cancelled');
  });

  it.each([
    ['idle', { idleTimeoutMs: 300 }],
    // Generous limit so that the worker is surely ready before it fires.
    ['max_duration', { maxDurationMs: 1000 }],
  ] as const)('%s timeout terminates background children of the group', async (kind, timeouts) => {
    // The idle timeout can only fire after the last output (the ready event), i.e. after bg.pid exists.
    const h = await launch(await makeSpec(`${BACKGROUND_CHILD}\nwait`, { timeouts, cancelGraceMs: 300 }));
    await h.nextEvent('ready');
    const bg = await backgroundPid(h.spec);
    expect(isAlive(bg)).toBe(true);
    const outcome = await h.wait();
    expect(outcome.timedOut).toBe(kind);
    expect(classifyOutcome(outcome).status).toBe('timed_out');
    expect(isAlive(bg)).toBe(false);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    // The leader must never end on its own: with `wait` it could return (and exit 0) inside the grace
    // period once the background child was gone, so the SIGKILL escalation was not always observable.
    const h = await launch(await makeSpec(`trap '' TERM\n${BACKGROUND_CHILD}\nwhile :; do sleep 1; done`));
    await h.nextEvent('ready');
    const bg = await backgroundPid(h.spec);
    const before = Date.now();
    await h.proc.cancel(200);
    expect(Date.now() - before).toBeGreaterThanOrEqual(150);
    const outcome = await h.wait();
    expect(outcome).toMatchObject({ cancelled: true, signal: 'SIGKILL' });
    expect(isAlive(bg)).toBe(false);
  });

  it('cleans up processes left in the group after a normal exit', async () => {
    const h = await launch(await makeSpec(`${BACKGROUND_CHILD}\nexit 0`));
    const outcome = await h.wait();
    const bg = await backgroundPid(h.spec);
    expect(isAlive(bg)).toBe(false);
    expect(classifyOutcome(outcome)).toMatchObject({ status: 'completed', businessResult: 'success' });
  });

  it('reports kill_failed and does not report the run as finished when the group cannot be killed', async () => {
    // Simulate an unkillable group: the injected signal function ignores all signals.
    const h = await launch(await makeSpec(`echo '@@ADISPATCH_EVENT {"type":"ready"}'\nsleep 30`), {
      kill: () => undefined,
      killConfirmMs: 100,
    });
    await h.nextEvent('ready');
    await expect(h.proc.cancel(50)).rejects.toMatchObject({ code: 'kill_failed' });
    let finished = false;
    void h.wait().then(() => (finished = true));
    await new Promise((r) => setImmediate(r));
    expect(finished).toBe(false);
    expect(h.diagnostics.some((d) => d.type === 'kill_failed')).toBe(true);

    // Clean up for real; the outcome is reported once the group is actually gone.
    process.kill(-(h.proc.pid as number), 'SIGKILL');
    const outcome = await h.wait();
    expect(classifyOutcome(outcome).status).toBe('cancelled');
  });

  it('captures the start identity of the process group leader', async () => {
    const h = await launch(await makeSpec(`echo '@@ADISPATCH_EVENT {"type":"ready"}'\nsleep 30`));
    expect(h.proc.pid).toBeGreaterThan(1);
    expect(h.proc.startIdentity).toMatchObject({ pid: h.proc.pid, pgid: h.proc.pid });
    expect(h.proc.startIdentity?.token.startsWith(`${process.platform}:`)).toBe(true);
    await h.proc.cancel(200);
  });

  it('discards the start identity if the leader exited while it was captured', async () => {
    // Probe that only answers after the process is gone (reaped) — its PID could be reused by then.
    const inspector = {
      platform: 'test',
      async probe(pid: number) {
        while (isAlive(pid)) await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setImmediate(r));
        return { pgid: pid, token: 'test:stale' };
      },
    };
    const h = await launch(await makeSpec('exit 0'), { inspector });
    expect(h.proc.pid).toBeGreaterThan(1);
    expect(h.proc.startIdentity).toBeUndefined();
    expect(classifyOutcome(await h.wait()).status).toBe('completed');
  });

  it('cancel after the process ended is a no-op', async () => {
    const h = await launch(await makeSpec('exit 0'));
    const outcome = await h.wait();
    await h.proc.cancel();
    expect(outcome.cancelled).toBe(false);
  });
});

describe.runIf(supported)('ShellExecutor – idle timeout (Spec §8.3)', () => {
  it('fires when the worker is silent', async () => {
    const { outcome, classification } = await run('sleep 30', { timeouts: { idleTimeoutMs: 300 }, cancelGraceMs: 200 });
    expect(outcome.timedOut).toBe('idle');
    expect(classification.status).toBe('timed_out');
  });

  it('is reset by output and events', async () => {
    // Runs ~1 s, well beyond the idle timeout, but produces output every ~50 ms.
    const body = `
i=0
while [ $i -lt 16 ]; do
  if [ $((i % 2)) -eq 0 ]; then echo "tick $i"; else echo '@@ADISPATCH_EVENT {"type":"progress"}' >&2; fi
  sleep 0.05
  i=$((i + 1))
done`;
    const before = Date.now();
    const { outcome, classification, events } = await run(body, { timeouts: { idleTimeoutMs: 500 } });
    expect(Date.now() - before).toBeGreaterThan(500);
    expect(outcome.timedOut).toBe(false);
    expect(classification.status).toBe('completed');
    expect(events.filter((e) => e.type === 'progress' && e.stream === 'stderr')).toHaveLength(8);
  });
});

describe.runIf(supported)('ShellExecutor – environment and context (Spec §9.1, §20.3)', () => {
  const LEAK = 'WI05_CONTROLLER_ONLY_VAR';

  afterEach(() => {
    delete process.env[LEAK];
  });

  it('worker sees no undeclared controller variable', async () => {
    process.env[LEAK] = 'leaked';
    const { outcome, spec } = await run(`env > "$ADISPATCH_WORKSPACE/env.txt"`, {
      env: { DECLARED: 'yes' },
      secrets: { GH_TOKEN: 'ghs_secretvalue123' },
    });
    expect(classifyOutcome(outcome).status).toBe('completed');
    const lines = (await readFile(path.join(spec.workingDirectory, 'env.txt'), 'utf8')).split('\n').filter(Boolean);
    const env = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

    expect(env[LEAK]).toBeUndefined();
    expect(env.DECLARED).toBe('yes');
    expect(env.GH_TOKEN).toBe('ghs_secretvalue123');
    expect(env.ADISPATCH_RUN_ID).toBe(spec.runId);
    expect(env.ADISPATCH_WORKFLOW_ID).toBe('wf');
    expect(env.ADISPATCH_SOURCE_TYPE).toBe('github');
    expect(env.ADISPATCH_SOURCE_ID).toBe('project_a');
    expect(env.ADISPATCH_SOURCE_ITEM_ID).toBe('123');
    expect(env.ADISPATCH_SOURCE_URL).toBe('https://github.com/example/project-a/issues/123');
    expect(env.ADISPATCH_CONTEXT_FILE).toBe(spec.files.contextFile);
    expect(env.ADISPATCH_RESULT_FILE).toBe(spec.files.resultFile);
    expect(env.ADISPATCH_WORKSPACE).toBe(spec.workingDirectory);

    // Everything else must come from the minimal set or be added by the shell itself.
    const allowed = new Set<string>([
      ...MINIMAL_ENV_KEYS,
      'DECLARED',
      'GH_TOKEN',
      'PWD',
      'OLDPWD',
      'SHLVL',
      '_',
      '__CF_USER_TEXT_ENCODING', // injected by macOS for every process
    ]);
    const unexpected = Object.keys(env).filter((k) => !allowed.has(k) && !k.startsWith('ADISPATCH_'));
    expect(unexpected).toEqual([]);
  });

  it('writes context.json without secrets and runs in the workspace', async () => {
    const { spec } = await run(`pwd > "$ADISPATCH_WORKSPACE/pwd.txt"\ncp "$ADISPATCH_CONTEXT_FILE" "$ADISPATCH_WORKSPACE/ctx.json"`, {
      secrets: { API_KEY: 'very-secret-key' },
    });
    const ctx = JSON.parse(await readFile(path.join(spec.workingDirectory, 'ctx.json'), 'utf8'));
    expect(ctx).toEqual(spec.context);
    expect(await readFile(spec.files.contextFile, 'utf8')).not.toContain('very-secret-key');
    const pwd = (await readFile(path.join(spec.workingDirectory, 'pwd.txt'), 'utf8')).trim();
    expect(await realpathOf(pwd)).toBe(await realpathOf(spec.workingDirectory));
  });

  it('enforces workspace.base_dir (lexically and via symlinks)', async () => {
    const base = path.join(root, 'workspaces');
    const inside = await run('exit 0', {}, { workspaceBaseDir: base });
    expect(classifyOutcome(inside.outcome).status).toBe('completed');

    const outside = await run('exit 0', { workingDirectory: path.join(root, 'elsewhere') }, { workspaceBaseDir: base });
    expect(outside.outcome.spawnError?.code).toBe('path_traversal');
    expect(outside.proc.pid).toBeUndefined();

    const { symlink } = await import('node:fs/promises');
    await mkdir(path.join(root, 'target'), { recursive: true });
    await symlink(path.join(root, 'target'), path.join(base, 'link'));
    const viaLink = await run('exit 0', { workingDirectory: path.join(base, 'link'), createDirectory: false }, { workspaceBaseDir: base });
    expect(classifyOutcome(viaLink.outcome).status).toBe('start_error');
  });

  it('never creates directories outside base_dir through a symlink', async () => {
    const base = path.join(root, 'workspaces');
    const outsideTarget = path.join(root, 'outside');
    await mkdir(base, { recursive: true });
    await mkdir(outsideTarget, { recursive: true });
    const { readdir, symlink } = await import('node:fs/promises');
    await symlink(outsideTarget, path.join(base, 'wf'));
    const res = await run('exit 0', { workingDirectory: path.join(base, 'wf', 'run-x', 'deep') }, { workspaceBaseDir: base });
    expect(res.outcome.spawnError?.code).toBe('path_traversal');
    expect(classifyOutcome(res.outcome).status).toBe('start_error');
    expect(await readdir(outsideTarget)).toEqual([]);
  });

  it('rejects base_dir itself as workspace', async () => {
    const base = path.join(root, 'workspaces');
    const res = await run('exit 0', { workingDirectory: base }, { workspaceBaseDir: base });
    expect(res.outcome.spawnError?.code).toBe('path_traversal');
    expect(classifyOutcome(res.outcome).status).toBe('start_error');
  });

  it('removes a stale result file before starting', async () => {
    const spec = await makeSpec('exit 0');
    await mkdir(path.dirname(spec.files.resultFile), { recursive: true });
    await writeFile(spec.files.resultFile, '{"schema_version":1,"result":"failure"}');
    const outcome = await (await launch(spec)).wait();
    expect(outcome.resultFile).toEqual({ state: 'missing' });
  });
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}

describe.runIf(supported)('ShellExecutor – logs and events (Spec §9.3, §5.1, §12)', () => {
  it('persists stdout and stderr separately and unchanged, including event lines', async () => {
    const { outcome, spec } = await run(
      `printf 'out1\\n'\nprintf 'err1\\n' >&2\necho '@@ADISPATCH_EVENT {"type":"status","message":"Tests laufen"}'\nprintf 'no newline'`,
    );
    expect(await readFile(spec.files.stdoutLog, 'utf8')).toBe(
      'out1\n@@ADISPATCH_EVENT {"type":"status","message":"Tests laufen"}\nno newline',
    );
    expect(await readFile(spec.files.stderrLog, 'utf8')).toBe('err1\n');
    expect(outcome.logs).toEqual({ stdoutBytes: 76, stderrBytes: 5, truncated: false });
  });

  it('parses events across chunk boundaries; invalid events produce a warning and stay in the log', async () => {
    const { events, diagnostics, spec } = await run(`
printf '@@ADISPATCH_EV'
sleep 0.05
printf 'ENT {"type":"sta'
sleep 0.05
printf 'tus","message":"split"}\\n'
echo '@@ADISPATCH_EVENT {not json'
echo '@@ADISPATCH_EVENT {"type":"progress","value":60}' >&2
echo '@@ADISPATCH_EVENT {"value":1}'`);
    expect(events.map((e) => [e.type, e.stream])).toEqual([
      ['status', 'stdout'],
      ['progress', 'stderr'],
    ]);
    expect(events[0]?.data).toEqual({ type: 'status', message: 'split' });
    expect(events[1]?.data).toEqual({ type: 'progress', value: 60 });
    const warnings = diagnostics.filter((d) => d.type === 'event_parse_warning');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.details?.line).toBe('@@ADISPATCH_EVENT {not json');
    expect(await readFile(spec.files.stdoutLog, 'utf8')).toContain('@@ADISPATCH_EVENT {not json\n');
  });

  it('stops writing at the per-run log limit and reports truncation instead of overwriting', async () => {
    const { outcome, diagnostics, spec, outputs } = await run(
      `i=0\nwhile [ $i -lt 50 ]; do printf '%0100d' 0; i=$((i + 1)); done`,
      { maxLogBytes: 1000 },
    );
    expect((await stat(spec.files.stdoutLog)).size).toBe(1000);
    expect(await readFile(spec.files.stdoutLog, 'utf8')).toBe('0'.repeat(1000));
    const truncations = diagnostics.filter((d) => d.type === 'log_truncated');
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toMatchObject({ stream: 'stdout', details: { limitBytes: 1000, stream: 'stdout' } });
    expect(truncations[0]?.message).toContain('stdout');
    expect(outcome.logs).toEqual({ stdoutBytes: 1000, stderrBytes: 0, truncated: true });
    // Live output is still delivered in full.
    expect(outputs.filter((o) => o.stream === 'stdout').map((o) => o.data).join('')).toHaveLength(5000);
    expect(classifyOutcome(outcome).status).toBe('completed');
  });

  it('shares the log limit between stdout and stderr', async () => {
    const { outcome, diagnostics, spec } = await run(
      `i=0\nwhile [ $i -lt 8 ]; do printf '%0100d' 0; printf '%0100d' 1 >&2; i=$((i + 1)); done`,
      { maxLogBytes: 1000 },
    );
    const out = await readFile(spec.files.stdoutLog, 'utf8');
    const err = await readFile(spec.files.stderrLog, 'utf8');
    // 1600 bytes produced in total, only 1000 persisted across both streams.
    expect(out.length + err.length).toBe(1000);
    expect(out).toBe('0'.repeat(out.length));
    expect(err).toBe(`${'0'.repeat(99)}1`.repeat(8).slice(0, err.length));
    expect(outcome.logs.stdoutBytes + outcome.logs.stderrBytes).toBe(1000);
    expect(outcome.logs.truncated).toBe(true);
    const truncations = diagnostics.filter((d) => d.type === 'log_truncated');
    // Every stream that lost output reports it once, naming itself.
    expect(truncations.length).toBeGreaterThanOrEqual(1);
    expect(new Set(truncations.map((t) => t.stream)).size).toBe(truncations.length);
    for (const t of truncations) {
      expect(t.details?.stream).toBe(t.stream);
      expect(t.stream === 'stdout' ? out.length : err.length).toBeLessThan(800);
    }
  });

  it('reports log write errors instead of claiming a complete log', async () => {
    const spec = await makeSpec('echo hello');
    await mkdir(spec.files.stdoutLog, { recursive: true }); // a directory cannot be opened as log file
    const h = await launch(spec);
    const outcome = await h.wait();
    expect(h.diagnostics.filter((d) => d.type === 'log_write_error')).toHaveLength(1);
    expect(h.diagnostics[0]?.stream).toBe('stdout');
    expect(outcome.logs.truncated).toBe(true);
    expect(classifyOutcome(outcome).status).toBe('completed');
    expect(h.outputs.map((o) => o.data).join('')).toBe('hello\n');
  });

  it('redacts known secret values from logs, live output, events and the result', async () => {
    const secret = 'ghs_TopSecretValue42';
    const { outcome, spec, outputs, events } = await run(
      `echo "token=$GH_TOKEN"\necho "$GH_TOKEN" >&2\necho "@@ADISPATCH_EVENT {\\"type\\":\\"status\\",\\"message\\":\\"$GH_TOKEN\\"}"\n` +
        writeResult(`{"schema_version":1,"result":"success","message":"${secret}"}`),
      { secrets: { GH_TOKEN: secret } },
    );
    const stdout = await readFile(spec.files.stdoutLog, 'utf8');
    expect(stdout).not.toContain(secret);
    expect(stdout).toContain(`token=${REDACTION_MARKER}`);
    expect(await readFile(spec.files.stderrLog, 'utf8')).toBe(`${REDACTION_MARKER}\n`);
    expect(outputs.map((o) => o.data).join('')).not.toContain(secret);
    expect(events[0]?.data.message).toBe(REDACTION_MARKER);
    expect(outcome.resultFile.state === 'valid' && outcome.resultFile.result.message).toBe(REDACTION_MARKER);
  });

  it('a slow listener does not block log capture', async () => {
    const spec = await makeSpec(`i=0\nwhile [ $i -lt 200 ]; do printf '%01023d\\n' $i; i=$((i + 1)); done`);
    const proc = await new ShellExecutor().start(spec);
    let calls = 0;
    let received = 0;
    proc.onOutput((c) => {
      calls++;
      received += c.data.length;
      const until = Date.now() + 2; // deliberately slow consumer
      while (Date.now() < until) {
        /* busy */
      }
    });
    const outcome = await proc.wait();
    expect(outcome.logs.stdoutBytes).toBe(200 * 1024);
    expect((await stat(spec.files.stdoutLog)).size).toBe(200 * 1024);
    // All output reached the slow listener as well, before wait() resolved.
    expect(received).toBe(200 * 1024);
    expect(calls).toBeGreaterThan(0);
  });

  it('closes inherited pipes held by a detached grandchild outside the group', async () => {
    // A grandchild in its own session (setsid) keeps stdout open after the worker exits.
    const spawnDetached =
      "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:['ignore','inherit','inherit']});" +
      "require('fs').writeFileSync(process.argv[1], String(c.pid));c.unref();";
    const spec = await makeSpec(`"$NODE_BIN" -e "${spawnDetached}" "$ADISPATCH_WORKSPACE/gc.pid"\necho done`, {
      env: { NODE_BIN: process.execPath },
    });
    const before = Date.now();
    const h = await launch(spec, { stdioDrainMs: 300 });
    const outcome = await h.wait();
    const gc = Number((await readFile(path.join(spec.workingDirectory, 'gc.pid'), 'utf8')).trim());
    try {
      expect(classifyOutcome(outcome)).toMatchObject({ status: 'completed', businessResult: 'success' });
      expect(Date.now() - before).toBeLessThan(10_000);
      expect(await readFile(spec.files.stdoutLog, 'utf8')).toBe('done\n');
      // Outside the group: not ours to kill (Spec §13), still running.
      expect(isAlive(gc)).toBe(true);
    } finally {
      try {
        process.kill(gc, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  it('delivers early output to listeners registered right after start; throwing listeners do not break capture', async () => {
    const spec = await makeSpec('echo first');
    const executor = new ShellExecutor({ logger: new MemoryLogger() });
    const proc = await executor.start(spec);
    const seen: string[] = [];
    proc.onOutput(() => {
      throw new Error('bad consumer');
    });
    proc.onOutput((c) => seen.push(c.data));
    const outcome = await proc.wait();
    expect(seen.join('')).toBe('first\n');
    expect(outcome.logs.stdoutBytes).toBe(6);
  });
});
