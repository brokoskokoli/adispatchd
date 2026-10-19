/**
 * Container executor with the fake engine (WI-19): command line, secrets
 * only in the engine environment, result file via the output mount, cancel
 * and timeout stop the container, engine errors.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTAINER_LABELS,
  CONTAINER_PATHS,
  containerInstanceId,
  containerName,
  dataPaths,
  type ContainerExecution,
  type ExecutionSpec,
  type WorkerContext,
  type WorkerEvent,
} from '../core/index.js';
import { classifyOutcome } from './classify.js';
import { ContainerEngineClient } from './container-engine.js';
import { buildContainerInvocation, ContainerExecutor } from './container-executor.js';
import { createFakeEngine, type FakeEngine } from './testing/fake-engine.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

let root: string;
let engine: FakeEngine;
let counter = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wi19-'));
  engine = await createFakeEngine();
});

afterEach(async () => {
  await engine.cleanup();
  await rm(root, { recursive: true, force: true });
});

async function makeSpec(script: string, overrides: Partial<ExecutionSpec> = {}, container: Partial<ContainerExecution> = {}): Promise<ExecutionSpec> {
  const runId = `run-20261019T120000000Z-${String(++counter).padStart(8, '0')}`;
  const dataDir = path.join(root, 'data');
  const run = dataPaths(dataDir).run(runId);
  const workspace = path.join(root, 'workspaces', 'wf', runId);
  const agents = path.join(root, 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, 'reviewer.md'), 'be nice\n');
  const context: WorkerContext = {
    schema_version: 1,
    run: { id: runId, trigger: 'manual', started_at: '2026-10-19T12:00:00.000Z' },
    workflow: { id: 'wf', name: 'Workflow' },
    parameters: {},
    workspace: { path: CONTAINER_PATHS.workspace },
  };
  return {
    runId,
    workflowId: 'wf',
    command: 'docker',
    args: ['/bin/sh', '-c', script],
    workingDirectory: workspace,
    createDirectory: true,
    env: {},
    secrets: {},
    context,
    files: {
      contextFile: run.contextFile,
      resultFile: path.join(run.outDir, 'result.json'),
      stdoutLog: run.stdoutLog,
      stderrLog: run.stderrLog,
    },
    timeouts: {},
    cancelGraceMs: 1000,
    container: {
      engine: 'docker',
      image: 'localhost/worker:current',
      name: containerName(runId),
      labels: {
        [CONTAINER_LABELS.run]: runId,
        [CONTAINER_LABELS.workflow]: 'wf',
        [CONTAINER_LABELS.instance]: containerInstanceId(dataDir),
      },
      mounts: [
        { source: workspace, target: '/work', mode: 'rw' },
        { source: agents, target: '/home/worker/agents', mode: 'ro' },
      ],
      workspaceTarget: '/work',
      workdir: '/work',
      resources: { memory: '8g', cpus: 3, pids: 4096 },
      user: '1000:1000',
      network: 'none',
      pull: 'missing',
      ...container,
    },
    ...overrides,
  };
}

function executor(options: { stopSettleMs?: number } = {}): ContainerExecutor {
  return new ContainerExecutor({ engines: engine.client(), stdioDrainMs: 500, ...options });
}

function nextEvent(proc: { onEvent(l: (e: WorkerEvent) => void): unknown }, type: string): Promise<WorkerEvent> {
  return new Promise((resolve) => {
    proc.onEvent((e) => {
      if (e.type === type) resolve(e);
    });
  });
}

describe('buildContainerInvocation', () => {
  it('builds the documented engine call; secrets only as -e NAME with the value in passEnv', async () => {
    const spec = await makeSpec('true', {
      env: { MODE: 'review', TZ: 'Europe/Berlin', GH_TOKEN_FILE: '/x/runs/r/secrets/GH_TOKEN' },
      secrets: { API_TOKEN: 'super-secret-value' },
      tokenFiles: { dir: '/x/runs/r/secrets', env: { GH_TOKEN_FILE: '/x/runs/r/secrets/GH_TOKEN' } },
    });
    const { command, args, passEnv } = buildContainerInvocation(spec, '/usr/bin/docker');
    const c = spec.container!;
    expect(command).toBe('/usr/bin/docker');
    expect(args.slice(0, 5)).toEqual(['run', '--rm', '--init', '--name', c.name]);
    const line = args.join(' ');
    expect(line).toContain(`--label adispatch.run=${spec.runId} --label adispatch.workflow=wf --label adispatch.instance=${c.labels['adispatch.instance']}`);
    expect(line).toContain('--cap-drop ALL --security-opt no-new-privileges');
    expect(line).toContain('--user 1000:1000 --network none --memory 8g --cpus 3 --pids-limit 4096 --pull missing');
    expect(line).not.toContain('--userns');
    expect(args).toContain(`type=bind,source=${spec.workingDirectory},target=/work`);
    expect(args).toContain(`type=bind,source=${path.join(root, 'agents')},target=/home/worker/agents,readonly`);
    expect(args).toContain(`type=bind,source=${spec.files.contextFile},target=/adispatch/context.json,readonly`);
    expect(args).toContain(`type=bind,source=${path.dirname(spec.files.resultFile)},target=/adispatch/out`);
    expect(args).toContain('type=bind,source=/x/runs/r/secrets,target=/adispatch/secrets,readonly');
    expect(line).toContain('--workdir /work');
    // env: by name; reserved names of the engine process on the command line; token files rewritten.
    expect(line).toContain('-e MODE -e TZ=Europe/Berlin -e GH_TOKEN_FILE=/adispatch/secrets/GH_TOKEN -e API_TOKEN');
    expect(line).toContain('-e ADISPATCH_CONTEXT_FILE=/adispatch/context.json');
    expect(line).toContain('-e ADISPATCH_RESULT_FILE=/adispatch/out/result.json');
    expect(line).toContain('-e ADISPATCH_WORKSPACE=/work');
    expect(line).not.toContain('super-secret-value');
    expect(passEnv).toEqual({ MODE: 'review', API_TOKEN: 'super-secret-value' });
    expect(args.slice(-4)).toEqual(['localhost/worker:current', '/bin/sh', '-c', 'true']);
  });

  it('adds --userns keep-id for podman and leaves out optional flags', async () => {
    const spec = await makeSpec('true', {}, {
      engine: 'podman',
      network: 'default',
      resources: { memory: null, cpus: null, pids: null },
      user: null,
    });
    const line = buildContainerInvocation(spec).args.join(' ');
    expect(line).not.toContain('--userns');
    expect(line).not.toMatch(/--network|--memory|--cpus|--pids-limit|--user /);
    const withUser = buildContainerInvocation({ ...spec, container: { ...spec.container!, user: '1000:1000' } }).args.join(' ');
    expect(withUser).toContain('--userns keep-id --user 1000:1000');
  });
});

describe.runIf(supported)('ContainerExecutor (fake engine)', () => {
  it('runs the container, captures output and events and reads the result file from the out mount', async () => {
    const spec = await makeSpec(
      [
        'echo "hello from $MODE"',
        'echo "@@ADISPATCH_EVENT {\\"type\\":\\"status\\",\\"message\\":\\"working\\"}"',
        'test -r "$ADISPATCH_CONTEXT_FILE" || exit 9',
        'cat /home/worker/agents/reviewer.md',
        'echo "$API_TOKEN" >&2',
        'printf \'{"schema_version":1,"result":"success","message":"done in %s"}\' "$PWD" > "$ADISPATCH_RESULT_FILE"',
      ].join('\n'),
      { env: { MODE: 'review' }, secrets: { API_TOKEN: 'super-secret-value' } },
    );
    const proc = await executor().start(spec);
    const events: WorkerEvent[] = [];
    proc.onEvent((e) => events.push(e));
    const outcome = await proc.wait();
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    const classification = classifyOutcome(outcome);
    expect(classification).toMatchObject({ status: 'completed', businessResult: 'success' });
    // The fake engine runs the command on the host in the translated workdir (/work → workspace).
    expect(classification.result?.message).toMatch(new RegExp(`done in .*${spec.runId}$`));
    expect(events.map((e) => e.type)).toEqual(['status']);
    expect(await readFile(spec.files.stdoutLog, 'utf8')).toBe('hello from review\n@@ADISPATCH_EVENT {"type":"status","message":"working"}\nbe nice\n');
    // The secret reached the container but is redacted in the logs.
    expect(await readFile(spec.files.stderrLog, 'utf8')).toBe('[REDACTED]\n');

    const calls = await engine.calls();
    const run = calls.find((c) => c.argv[0] === 'run');
    expect(run).toBeDefined();
    expect(run!.argv.join(' ')).not.toContain('super-secret-value');
    expect(run!.env.API_TOKEN).toBe('super-secret-value');
    expect(run!.env.MODE).toBe('review');
    // Nothing of the daemon environment except the minimal variables reaches the engine process.
    expect(Object.keys(run!.env).filter((k) => !['PATH', 'HOME', 'LANG', 'TZ', 'USER', 'LOGNAME', 'TMPDIR', 'API_TOKEN', 'MODE'].includes(k) && !k.startsWith('XDG_') && !k.startsWith('DOCKER_') && !k.startsWith('__CF_'))).toEqual([]);
    expect(await engine.containers()).toEqual([]);
    // Normal end: no stop/rm needed (--rm).
    expect(calls.map((c) => c.argv[0])).toEqual(['run']);
  });

  it('describe() returns the spawned command line', async () => {
    const spec = await makeSpec('true');
    const ex = executor();
    const described = ex.describe(spec);
    await (await ex.start(spec)).wait();
    const run = (await engine.calls()).find((c) => c.argv[0] === 'run');
    expect(described.command).toBe(engine.docker);
    expect(described.args).toEqual(run!.argv);
  });

  it('cancel stops the container through the engine (stop -t <grace>) → cancelled', async () => {
    const spec = await makeSpec('echo "@@ADISPATCH_EVENT {\\"type\\":\\"ready\\"}"; while :; do sleep 0.05; done', { cancelGraceMs: 2000 });
    const proc = await executor().start(spec);
    await nextEvent(proc, 'ready');
    expect(await engine.containers()).toEqual([spec.container!.name]);
    await proc.cancel();
    const outcome = await proc.wait();
    expect(classifyOutcome(outcome).status).toBe('cancelled');
    const calls = await engine.calls();
    const stop = calls.find((c) => c.argv[0] === 'stop');
    expect(stop?.argv).toEqual(['stop', '-t', '2', spec.container!.name]);
    expect(stop?.env.API_TOKEN).toBeUndefined();
    expect(await engine.containers()).toEqual([]);
  });

  it('max_duration stops the container → timed_out', async () => {
    const spec = await makeSpec('while :; do sleep 0.05; done', { timeouts: { maxDurationMs: 300 } });
    const proc = await executor().start(spec);
    const outcome = await proc.wait();
    expect(classifyOutcome(outcome).status).toBe('timed_out');
    expect((await engine.calls()).some((c) => c.argv[0] === 'stop')).toBe(true);
    expect(await engine.containers()).toEqual([]);
  });

  it('a container exit code ≠ 0 is crashed; the result file is ignored', async () => {
    const spec = await makeSpec('echo \'{"schema_version":1,"result":"success"}\' > "$ADISPATCH_RESULT_FILE"; exit 3');
    const outcome = await (await executor().start(spec)).wait();
    expect(outcome.exitCode).toBe(3);
    expect(classifyOutcome(outcome)).toMatchObject({ status: 'crashed', reason: 'exit code 3' });
  });

  it('engine errors (exit 125) end as crashed; a missing engine binary as start_error', async () => {
    const spec = await makeSpec('true', {}, { image: 'fake/missing' });
    const outcome = await (await executor().start(spec)).wait();
    expect(outcome.exitCode).toBe(125);
    expect(classifyOutcome(outcome).status).toBe('crashed');

    const missing = new ContainerExecutor({ engines: new ContainerEngineClient({ binaries: { docker: path.join(root, 'no-such-docker') } }) });
    const spec2 = await makeSpec('true');
    const outcome2 = await (await missing.start(spec2)).wait();
    expect(classifyOutcome(outcome2).status).toBe('start_error');
  });

  it('rejects mount paths the engine syntax cannot express (start_error, engine not called)', async () => {
    const spec = await makeSpec('true', {}, { mounts: [{ source: path.join(root, 'a,b'), target: '/data', mode: 'ro' }] });
    const outcome = await (await executor().start(spec)).wait();
    expect(classifyOutcome(outcome).status).toBe('start_error');
    expect(outcome.spawnError?.message).toContain('must not contain commas');
    expect(await engine.calls()).toEqual([]);
  });

  it('a missing static mount source is a start_error', async () => {
    const spec = await makeSpec('true', {}, { mounts: [{ source: path.join(root, 'gone'), target: '/data', mode: 'ro' }] });
    const outcome = await (await executor().start(spec)).wait();
    expect(classifyOutcome(outcome).status).toBe('start_error');
    expect(outcome.spawnError?.message).toContain('mount source does not exist');
  });

  it('falls back to signalling the engine process when the stop does not end it', async () => {
    // The engine cannot stop the container ("daemon unreachable"): the engine CLI is signalled instead.
    const spec = await makeSpec('echo "@@ADISPATCH_EVENT {\\"type\\":\\"ready\\"}"; while :; do sleep 0.05; done', { cancelGraceMs: 300 });
    const proc = await executor({ stopSettleMs: 200 }).start(spec);
    await nextEvent(proc, 'ready');
    await engine.fail('stop');
    await proc.cancel();
    const outcome = await proc.wait();
    expect(classifyOutcome(outcome).status).toBe('cancelled');
  });
});
