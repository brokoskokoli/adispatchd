/**
 * Container runs end to end with the fake engine (WI-19): expected engine
 * call, result file with a named outcome, token files, kept files, cancel
 * stops the container, and recovery leaves no orphaned container behind.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTAINER_LABELS,
  containerInstanceId,
  containerName,
  dataPaths,
  systemClock,
  type ProcessStartIdentity,
} from '../core/index.js';
import { getStartIdentity } from '../executors/index.js';
import { createFakeEngine, type FakeEngine } from '../executors/testing/fake-engine.js';
import { RotatingCredentials } from '../executors/testing/rotating-credentials.js';
import { RUN_EVENTS } from './controller.js';
import { ISSUE, REPO, createRunsEnv, waitForStatus, type RunsTestEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

describe.runIf(supported)('RunController with execute.type: container (WI-19)', () => {
  let env: RunsTestEnv;
  let engine: FakeEngine;

  beforeEach(async () => {
    env = createRunsEnv();
    engine = await createFakeEngine();
  });
  afterEach(async () => {
    await engine.cleanup();
    env.cleanup();
  });

  function workflow(script: string, extra = ''): string {
    return `
id: wf
trigger: { type: source, source: repo_a }
execute:
  type: container
  image: localhost/worker:current
  command: ['${script}', '{item.number}']
  env:
    WS: '{workspace.path}'
  secrets:
    GH_TOKEN: { identity: coder, delivery: file }
    API_TOKEN: { identity: maintainer }
  resources: { memory: 1g }
  cancel_grace: 1s
  keep: [notes.txt]
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
on_error:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_result:
  approved:
    - type: source.update
      labels: { add: [approved], remove: [coding] }
${extra}`;
  }

  function harness(creds = new RotatingCredentials(systemClock)) {
    return env.harness({ credentials: creds, containers: engine.client(), containerEngines: () => ['docker'] });
  }

  it('runs the worker in a container: engine call, result file with outcome, token file, kept files', async () => {
    const script = env.script(
      'worker.sh',
      [
        'echo "issue $1 in $WS"',
        'cat "$ADISPATCH_CONTEXT_FILE" > "$ADISPATCH_WORKSPACE/context-copy.json"',
        'echo "token $(cat "$GH_TOKEN_FILE") api $API_TOKEN"',
        'echo "kept" > "$ADISPATCH_WORKSPACE/notes.txt"',
        'printf \'{"schema_version":1,"result":"success","outcome":"approved","message":"ok"}\' > "$ADISPATCH_RESULT_FILE"',
      ].join('\n'),
    );
    const creds = new RotatingCredentials(systemClock);
    const h = harness(creds);
    await h.controller.recover();
    const run = env.reserve(await env.snapshot(workflow(script)));
    const done = await h.controller.startRun(run).done;

    expect(done.status).toBe('completed');
    expect(done.businessResult).toBe('success');
    expect(done.outcome).toBe('approved');
    expect(done.completionHook).toBe('on_result.approved');
    expect(env.github.labels(REPO, ISSUE).sort()).toEqual(['approved', 'manual-label']);

    // Persisted command = the engine call (no secret values).
    const name = containerName(run.id);
    const persisted = done.command as { command: string; args: string[] };
    expect(persisted.command).toBe(engine.docker);
    const args = persisted.args;
    expect(args.slice(0, 5)).toEqual(['run', '--rm', '--init', '--name', name]);
    expect(args).toContain(`${CONTAINER_LABELS.instance}=${containerInstanceId(env.dataDir)}`);
    expect(args.slice(-3)).toEqual(['localhost/worker:current', script, String(ISSUE)]);
    const runDir = dataPaths(env.dataDir).run(run.id).runDir;
    expect(args).toContain(`type=bind,source=${done.workspacePath},target=/work`);
    expect(args).toContain(`type=bind,source=${path.join(runDir, 'secrets')},target=/adispatch/secrets,readonly`);
    expect(args).toContain('GH_TOKEN_FILE=/adispatch/secrets/GH_TOKEN');
    expect(args.join(' ')).toContain('-e WS -e GH_TOKEN_FILE=/adispatch/secrets/GH_TOKEN -e API_TOKEN');
    const tokens = creds.issued.map((t) => t.token);
    expect(tokens).toHaveLength(2);
    for (const token of tokens) expect(JSON.stringify(done)).not.toContain(token);
    const spawn = env.p.events.listForRun(run.id).find((e) => e.type === RUN_EVENTS.spawn);
    expect(spawn?.payload).toMatchObject({ command: engine.docker, container: name, image: 'localhost/worker:current' });

    // The engine process got the values of -e NAME; {workspace.path} in env is the container path.
    const call = (await engine.calls()).find((c) => c.argv[0] === 'run');
    expect(call?.env.WS).toBe('/work');
    expect(call?.env.API_TOKEN).toBe(tokens.find((t) => t.includes('maintainer')));
    expect(call?.argv.join(' ')).not.toContain('_secretvalue');

    // Output (redacted), context with container paths, kept file from the host workspace.
    const stdout = readFileSync(dataPaths(env.dataDir).run(run.id).stdoutLog, 'utf8');
    // (The fake engine maps container paths in env values back to the host.)
    expect(stdout).toMatch(new RegExp(`^issue ${ISSUE} in \\S*${run.id}\\ntoken \\[REDACTED\\] api \\[REDACTED\\]\\n$`));
    const kept = env.p.events.listForRun(run.id).find((e) => e.type === RUN_EVENTS.keptFiles);
    expect(kept?.payload).toMatchObject({ files: 1 });
    expect(readFileSync(path.join(runDir, 'kept', 'notes.txt'), 'utf8')).toBe('kept\n');
    // Token files are gone, the output directory holds the result file.
    expect(existsSync(path.join(runDir, 'secrets'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(runDir, 'out', 'result.json'), 'utf8'))).toMatchObject({ outcome: 'approved' });
    expect(await engine.containers()).toEqual([]);
  });

  it('puts container paths into the context file', async () => {
    const script = env.script('ctx.sh', 'cat "$ADISPATCH_CONTEXT_FILE"');
    const h = harness();
    await h.controller.recover();
    const run = env.reserve(await env.snapshot(workflow(script)));
    await h.controller.startRun(run).done;
    const context = JSON.parse(readFileSync(dataPaths(env.dataDir).run(run.id).contextFile, 'utf8')) as { workspace: { path: string } };
    expect(context.workspace.path).toBe('/work');
  });

  it('cancel stops the container through the engine → cancelled, on_error', async () => {
    const script = env.script('loop.sh', 'echo "@@ADISPATCH_EVENT {\\"type\\":\\"ready\\"}"\nwhile :; do sleep 0.05; done');
    const h = harness();
    await h.controller.recover();
    const run = env.reserve(await env.snapshot(workflow(script)));
    const handle = h.controller.startRun(run);
    await new Promise<void>((resolve) => {
      const unsubscribe = h.bus.subscribe((e) => {
        if (e.type === 'run.event' && e.event.runId === run.id && e.event.type === 'ready') {
          unsubscribe();
          resolve();
        }
      });
    });
    expect(await engine.containers()).toEqual([containerName(run.id)]);
    const final = await h.controller.cancelRun(run.id, { reason: 'test' });
    await handle.done;
    expect(final.status).toBe('cancelled');
    expect(final.completionHook).toBe('on_error');
    const stop = (await engine.calls()).find((c) => c.argv[0] === 'stop');
    expect(stop?.argv).toEqual(['stop', '-t', '1', containerName(run.id)]);
    expect(await engine.containers()).toEqual([]);
  });

  /** DB state a crashed daemon leaves for a running container run (engine process = `pid`). */
  async function crashedWhileRunning(pid: number, identity: ProcessStartIdentity | null) {
    const run = env.reserve(await env.snapshot(workflow('/bin/true')));
    env.p.runs.transition(run.id, 'starting');
    env.p.events.append(run.id, RUN_EVENTS.spawn, { command: 'docker', args: ['run'], workingDirectory: env.workspaces });
    return env.p.runs.transition(run.id, 'running', { update: { pid, processStartIdentity: identity } });
  }

  it('recovery stops the containers of this instance (active run → crashed, orphans without run) and no other', async () => {
    const instance = `${CONTAINER_LABELS.instance}=${containerInstanceId(env.dataDir)}`;
    // The run's container; its process stands in for the engine process of the crashed daemon.
    const pending = env.reserve(await env.snapshot(workflow('/bin/true')));
    const name = containerName(pending.id);
    const orphan = await engine.orphan(name, [instance, `${CONTAINER_LABELS.run}=${pending.id}`]);
    const identity = (await getStartIdentity(orphan.pid as number)) ?? null;
    env.p.runs.transition(pending.id, 'starting');
    env.p.events.append(pending.id, RUN_EVENTS.spawn, { command: 'docker', args: ['run'], workingDirectory: env.workspaces });
    const run = env.p.runs.transition(pending.id, 'running', { update: { pid: orphan.pid as number, processStartIdentity: identity } });
    await engine.orphan(containerName('run-20261019T000000000Z-deadbeef'), [instance]);
    await engine.orphan(containerName('run-of-another-instance'), [`${CONTAINER_LABELS.instance}=0123456789abcdef`]);

    const h = harness();
    const report = await h.controller.recover();
    const final = env.p.runs.require(run.id);
    expect(final.status).toBe('crashed');
    expect(report.finalized.map((f) => f.runId)).toEqual([run.id]);
    expect(await engine.containers()).toEqual([containerName('run-of-another-instance')]);
    const stopped = env.p.events.listForRun(run.id).filter((e) => e.type === RUN_EVENTS.containerStopped);
    expect(stopped.map((e) => e.payload)).toEqual([{ engine: 'docker', container: containerName(run.id), result: 'stopped' }]);
  });

  it('engine unreachable during recovery → recovery_pending; retryRecovery after the engine is back → crashed', async () => {
    const run = await crashedWhileRunning(999_999, null);
    await engine.fail('all');
    const h = harness();
    const report = await h.controller.recover();
    expect(report.pending.map((p) => p.runId)).toEqual([run.id]);
    const pending = env.p.runs.require(run.id);
    expect(pending.status).toBe('recovery_pending');
    expect(String((pending.error as { message?: string } | null)?.message)).toContain(`container ${containerName(run.id)} may still be running`);

    await engine.fail('');
    const final = await h.controller.retryRecovery(run.id);
    expect(final.status).toBe('crashed');
    await waitForStatus(h, env.p, run.id, 'crashed');
  });
});
