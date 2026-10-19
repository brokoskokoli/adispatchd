/**
 * Token files of the main worker (WI-18) with real processes: delivery as
 * `<NAME>_FILE`, renewal with a fake clock while the worker runs, deletion
 * at every end status and on recovery, and no token in any log, event or
 * database file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock, MemoryLogger, dataPaths, type AccessToken, type TechnicalStatus, type TokenRequestOptions } from '../core/index.js';
import { RotatingCredentials } from '../executors/testing/rotating-credentials.js';
import { createRunsEnv, waitForRun, type RunsTestEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';
const MIN = 60_000;

describe.runIf(supported)('RunController token files (WI-18)', () => {
  let env: RunsTestEnv;
  let clock: FakeClock;
  let creds: RotatingCredentials;
  let logger: MemoryLogger;

  beforeEach(() => {
    env = createRunsEnv();
    clock = new FakeClock(new Date());
    creds = new RotatingCredentials(clock, 15 * MIN);
    logger = new MemoryLogger();
  });
  afterEach(async () => {
    // Release waiting workers even if a test failed early.
    writeFileSync(path.join(env.marks, 'go'), '');
    await new Promise((resolve) => setTimeout(resolve, 100));
    env.cleanup();
  });

  function workflow(command: string, extra = ''): string {
    return `
id: wf
trigger: { type: source, source: repo_a }
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
  env:
    MARKS: ${env.marks}
  secrets:
    GH_TOKEN: { identity: coder, delivery: file }
${extra}`;
  }

  async function harness() {
    const h = env.harness({ credentials: creds, clock, timers: clock, logger });
    await h.controller.recover();
    return h;
  }

  const tokenDir = (runId: string) => path.join(dataPaths(env.dataDir).run(runId).runDir, 'secrets');

  /** Every place a token must never show up: logs, events, run rows, the SQLite files, the daemon log. */
  function assertNoTokenAnywhere(runId: string): void {
    const tokens = creds.issued.map((t) => t.token);
    expect(tokens.length).toBeGreaterThan(0);
    const texts: Array<[string, string]> = [
      ['events', JSON.stringify(env.p.events.listForRun(runId))],
      ['run', JSON.stringify(env.p.runs.get(runId))],
      ['actions', JSON.stringify(env.p.actions.listForRun(runId))],
      ['logger', JSON.stringify(logger.records)],
    ];
    const logDir = dataPaths(env.dataDir).run(runId).logDir;
    for (const f of ['stdout.log', 'stderr.log']) {
      if (existsSync(path.join(logDir, f))) texts.push([f, readFileSync(path.join(logDir, f), 'utf8')]);
    }
    for (const f of readdirSync(env.dataDir).filter((n) => n.startsWith('adispatchd.sqlite'))) {
      texts.push([f, readFileSync(path.join(env.dataDir, f)).toString('latin1')]);
    }
    const runDir = dataPaths(env.dataDir).run(runId).runDir;
    if (existsSync(path.join(runDir, 'context.json'))) texts.push(['context', readFileSync(path.join(runDir, 'context.json'), 'utf8')]);
    for (const [where, text] of texts) {
      for (const token of tokens) expect(text.includes(token), `token in ${where}`).toBe(false);
    }
  }

  it('acceptance: a run longer than the token lifetime always finds a valid token; file gone afterwards; never logged', async () => {
    const script = env.script(
      'worker.sh',
      [
        '[ -z "${GH_TOKEN+x}" ] || { echo "GH_TOKEN must not be set" >&2; exit 3; }',
        'echo "file=$GH_TOKEN_FILE"',
        'echo "first=$(cat "$GH_TOKEN_FILE")"',
        'i=0',
        '# waits for the test\'s "go"; the 120 s wall-clock cap only protects against a hanging test run',
        'end=$(( $(date +%s) + 120 ))',
        'while [ ! -f "$MARKS/go" ] && [ "$(date +%s)" -lt "$end" ]; do',
        '  # a long-running worker reads the token per call, as with `GH_TOKEN=$(cat "$GH_TOKEN_FILE") gh …`',
        '  cat "$GH_TOKEN_FILE" > "$MARKS/seen.tmp" && mv "$MARKS/seen.tmp" "$MARKS/seen"',
        '  if [ $i -eq 0 ]; then echo \'@@ADISPATCH_EVENT {"type":"status","message":"ready"}\'; fi',
        '  i=$((i + 1)); sleep 0.02',
        'done',
        'echo "last=$(cat "$GH_TOKEN_FILE")"',
      ].join('\n'),
    );
    const snapshot = await env.snapshot(workflow(script));
    const h = await harness();
    const run = env.reserve(snapshot);
    h.controller.startRun(run.id);
    await waitForRun(h, env.p, run.id, (r) => r.statusMessage === 'ready');

    const file = path.join(tokenDir(run.id), 'GH_TOKEN');
    expect(statSync(tokenDir(run.id)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(creds.issued[0]?.token);
    // The token directory lies outside the workspace.
    const workspace = env.p.runs.require(run.id).workspacePath as string;
    expect(path.relative(workspace, file).startsWith('..')).toBe(true);

    // 2 hours of fake time in 1-minute steps (token lifetime 15 min).
    for (let step = 0; step < 120; step++) {
      await clock.advanceAsync(MIN);
      const expected = creds.last!;
      // Fake time must not run ahead of the real file I/O: wait until the file is written AND the next renewal is armed.
      await vi.waitFor(
        () => {
          expect(readFileSync(file, 'utf8')).toBe(expected.token);
          expect(clock.pendingTimers()).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 5 },
      );
      expect(expected.expiresAt.getTime()).toBeGreaterThan(clock.nowMs());
    }
    expect(creds.issued.length).toBeGreaterThanOrEqual(20);
    // What the worker read last is a token that is still valid.
    await vi.waitFor(() => expect(readFileSync(path.join(env.marks, 'seen'), 'utf8')).toBe(creds.last?.token), { timeout: 5_000 });

    writeFileSync(path.join(env.marks, 'go'), '');
    const final = await waitForRun(h, env.p, run.id, (r) => r.status === 'completed');
    expect(final.businessResult).toBe('success');
    expect(existsSync(tokenDir(run.id))).toBe(false);
    const stdout = readFileSync(dataPaths(env.dataDir).run(run.id).stdoutLog, 'utf8');
    expect(stdout).toContain(`file=${file}`);
    expect(stdout).toContain('first=[REDACTED]');
    expect(stdout).toContain('last=[REDACTED]');
    assertNoTokenAnywhere(run.id);
    expect(clock.pendingTimers()).toBe(0);
  });

  const endings: Array<{ status: TechnicalStatus; body: string; extra?: string; cancel?: boolean }> = [
    { status: 'completed', body: 'test -f "$GH_TOKEN_FILE" || exit 3' },
    { status: 'crashed', body: 'test -f "$GH_TOKEN_FILE" || exit 0\nexit 1' },
    { status: 'timed_out', body: 'test -f "$GH_TOKEN_FILE" || exit 0\nsleep 30', extra: '' },
    {
      status: 'cancelled',
      body: 'test -f "$GH_TOKEN_FILE" || exit 0\necho \'@@ADISPATCH_EVENT {"type":"status","message":"ready"}\'\nsleep 30',
      cancel: true,
    },
  ];
  for (const ending of endings) {
    it(`deletes the token files when the run ends as ${ending.status}`, async () => {
      const script = env.script('worker.sh', ending.body);
      const yaml = workflow(script).replace('  cancel_grace: 300ms', `  cancel_grace: 300ms${ending.status === 'timed_out' ? '\n  timeout: { max_duration: 1s }' : ''}`);
      const snapshot = await env.snapshot(yaml);
      const h = await harness();
      const run = env.reserve(snapshot);
      h.controller.startRun(run.id);
      if (ending.cancel) {
        await waitForRun(h, env.p, run.id, (r) => r.statusMessage === 'ready');
        expect(existsSync(path.join(tokenDir(run.id), 'GH_TOKEN'))).toBe(true);
        await h.controller.cancelRun(run.id);
      }
      const final = await waitForRun(h, env.p, run.id, (r) => r.status === ending.status);
      expect(final.status).toBe(ending.status);
      expect(existsSync(tokenDir(run.id))).toBe(false);
      assertNoTokenAnywhere(run.id);
    });
  }

  it('deletes the token files on start_error (command cannot be executed)', async () => {
    const snapshot = await env.snapshot(workflow(path.join(env.root, 'missing-command')));
    const h = await harness();
    const run = env.reserve(snapshot);
    h.controller.startRun(run.id);
    const final = await waitForRun(h, env.p, run.id, (r) => r.status === 'start_error');
    expect(final.status).toBe('start_error');
    expect(creds.issued).toHaveLength(1);
    expect(existsSync(tokenDir(run.id))).toBe(false);
    assertNoTokenAnywhere(run.id);
  });

  it('a failing token exchange before the start is a start_error without files', async () => {
    creds.failNext = 1;
    const snapshot = await env.snapshot(workflow('/bin/true'));
    const h = await harness();
    const run = env.reserve(snapshot);
    h.controller.startRun(run.id);
    const final = await waitForRun(h, env.p, run.id, (r) => r.status === 'start_error');
    expect(final.finalReason).toMatch(/token files could not be written: token exchange for coder failed/);
    expect(existsSync(tokenDir(run.id))).toBe(false);
    expect(env.p.events.listForRun(run.id).some((e) => e.type === 'run.spawn')).toBe(false);
  });

  it('env delivery stays the default (GH_TOKEN set, no file)', async () => {
    const script = env.script('worker.sh', '[ -n "$GH_TOKEN" ] && [ -z "${GH_TOKEN_FILE+x}" ] || exit 3\necho "t=$GH_TOKEN"');
    const snapshot = await env.snapshot(workflow(script).replace('{ identity: coder, delivery: file }', '{ identity: coder }'));
    expect(snapshot.workflow.execute.secrets.GH_TOKEN).toEqual({ identity: 'coder', delivery: 'env' });
    const h = await harness();
    const run = env.reserve(snapshot);
    h.controller.startRun(run.id);
    const final = await waitForRun(h, env.p, run.id, (r) => r.status === 'completed');
    expect(final.status).toBe('completed');
    expect(existsSync(tokenDir(run.id))).toBe(false);
    expect(readFileSync(dataPaths(env.dataDir).run(run.id).stdoutLog, 'utf8')).toBe('t=[REDACTED]\n');
  });

  it('recovery after a restart deletes left-over token files (run and action attempts)', async () => {
    const snapshot = await env.snapshot(workflow('/bin/true'));
    const run = env.reserve(snapshot); // a crashed controller left the run behind
    const runDir = dataPaths(env.dataDir).run(run.id).runDir;
    const dirs = [path.join(runDir, 'secrets'), path.join(runDir, 'actions', '1', 'attempt-1', 'secrets')];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, 'GH_TOKEN'), 'ghs_leftover_token');
    }
    const h = env.harness({ credentials: creds, logger });
    await h.controller.recover();
    for (const d of dirs) expect(existsSync(d)).toBe(false);
    expect(logger.records.some((r) => r.msg === 'removed left-over token files')).toBe(true);
  });

  /** Hold the next token exchange until `release()`; optionally honour the abort signal like a real provider. */
  function gateTokenExchange(honourSignal: boolean): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const enteredP = new Promise<void>((resolve) => (entered = resolve));
    const original = creds.getToken.bind(creds);
    creds.getToken = (identity: string, options: TokenRequestOptions = {}): Promise<AccessToken> => {
      entered();
      return new Promise<AccessToken>((resolve, reject) => {
        if (honourSignal) options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        void gate.then(() => original(identity, options).then(resolve, reject));
      });
    };
    return { entered: enteredP, release };
  }

  for (const honourSignal of [true, false]) {
    it(`cancel while the token exchange is in progress → cancelled, no file left (provider ${honourSignal ? 'aborts' : 'ignores the signal'})`, async () => {
      const gate = gateTokenExchange(honourSignal);
      const snapshot = await env.snapshot(workflow(env.script('worker.sh', 'echo started > "$MARKS/started"')));
      const h = await harness();
      const run = env.reserve(snapshot);
      h.controller.startRun(run.id);
      await gate.entered;
      const cancelling = h.controller.cancelRun(run.id);
      gate.release();
      const final = await cancelling;
      expect(final.status).toBe('cancelled');
      expect(existsSync(tokenDir(run.id))).toBe(false);
      expect(existsSync(path.join(env.marks, 'started'))).toBe(false);
      expect(env.p.events.listForRun(run.id).some((e) => e.type === 'run.spawn')).toBe(false);
      if (!honourSignal) assertNoTokenAnywhere(run.id);
    });
  }

  it('the token dir must not lie in the workspace, compared by resolved paths (symlinked workspace) → start_error', async () => {
    const link = path.join(env.root, 'ws-link');
    symlinkSync(env.dataDir, link);
    const yaml = workflow('/bin/true').replace('  cancel_grace: 300ms', `  cancel_grace: 300ms\n  working_directory: '${link}/runs/{run.id}'`);
    const snapshot = await env.snapshot(yaml);
    const h = await harness();
    const run = env.reserve(snapshot);
    h.controller.startRun(run.id);
    const final = await waitForRun(h, env.p, run.id, (r) => r.status === 'start_error');
    expect(final.finalReason).toMatch(/token files must lie outside the workspace/);
    expect(creds.issued).toEqual([]);
    expect(existsSync(tokenDir(run.id))).toBe(false);
  });

  it('recovery also removes token dirs of a finished run whose action was still running at the crash', async () => {
    // Decision: the old action process (if any) is not ours any more and its token would not be renewed;
    // recovery marks the shell action failed (WI-07) and removes its token files.
    const cmd = env.script('action.sh', 'exit 0');
    const snapshot = await env.snapshot(
      workflow('/bin/true', `on_success:\n  - type: shell\n    command: ${cmd}\n    secrets:\n      GH_TOKEN: { identity: coder, delivery: file }\n`),
    );
    const run = env.reserve(snapshot);
    env.p.runs.transition(run.id, 'starting');
    env.p.runs.transition(run.id, 'running', { update: { pid: 999_999 } });
    env.p.runs.beginFinalization(run.id, { status: 'completed', businessResult: 'success', reason: 'exit code 0' });
    const journal = env.p.actions.createJournal(
      run.id,
      'on_success',
      snapshot.workflow.hooks.on_success.map((config) => ({ type: config.type, name: config.id, config })),
    );
    env.p.runs.finish(run.id);
    env.p.actions.startAttempt(journal[0]!.id);
    const attemptSecrets = path.join(dataPaths(env.dataDir).run(run.id).runDir, 'actions', String(journal[0]!.id), 'attempt-1', 'secrets');
    mkdirSync(attemptSecrets, { recursive: true });
    writeFileSync(path.join(attemptSecrets, 'GH_TOKEN'), 'ghs_leftover_action_token');
    const h = env.harness({ credentials: creds, logger });
    await h.controller.recover();
    expect(existsSync(attemptSecrets)).toBe(false);
    expect(env.p.actions.listForHook(run.id, 'on_success').map((a) => a.status)).toEqual(['failed']);
  });

  it('kept files (execute.keep) are redacted with every token the token file held, incl. renewals (WI-22)', async () => {
    const script = env.script(
      'worker.sh',
      [
        'cat "$GH_TOKEN_FILE" > "$ADISPATCH_WORKSPACE/first.txt"',
        'echo \'@@ADISPATCH_EVENT {"type":"status","message":"ready"}\'',
        'end=$(( $(date +%s) + 120 ))',
        'while [ ! -f "$MARKS/go" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 0.02; done',
        'printf "token: %s\\n" "$(cat "$GH_TOKEN_FILE")" > "$ADISPATCH_WORKSPACE/last.txt"',
      ].join('\n'),
    );
    const yaml = workflow(script).replace('  cancel_grace: 300ms', "  cancel_grace: 300ms\n  keep: ['*.txt']");
    const snapshot = await env.snapshot(yaml);
    const h = await harness();
    const run = env.reserve(snapshot);
    h.controller.startRun(run.id);
    await waitForRun(h, env.p, run.id, (r) => r.statusMessage === 'ready');
    const file = path.join(tokenDir(run.id), 'GH_TOKEN');
    await clock.advanceAsync(5 * MIN); // renewal
    const renewed = creds.last!;
    await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toBe(renewed.token), { timeout: 5_000, interval: 5 });
    expect(creds.issued).toHaveLength(2);
    writeFileSync(path.join(env.marks, 'go'), '');
    await waitForRun(h, env.p, run.id, (r) => r.status === 'completed');
    const kept = path.join(dataPaths(env.dataDir).run(run.id).runDir, 'kept');
    expect(readFileSync(path.join(kept, 'first.txt'), 'utf8')).toBe('[REDACTED]');
    expect(readFileSync(path.join(kept, 'last.txt'), 'utf8')).toBe('token: [REDACTED]\n');
    assertNoTokenAnywhere(run.id);
  });
});
