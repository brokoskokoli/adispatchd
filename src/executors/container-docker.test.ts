/**
 * Optional test against a real Docker engine (WI-19), only with
 * `ADISPATCH_CONTAINER_TEST=1` (image `busybox`, pulled if missing and
 * removed again afterwards if this test pulled it). Containers are created
 * with `--rm` and names of this test only.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTAINER_LABELS,
  containerInstanceId,
  containerName,
  dataPaths,
  defaultContainerUser,
  type ExecutionSpec,
  type WorkerEvent,
} from '../core/index.js';
import { classifyOutcome } from './classify.js';
import { ContainerEngineClient } from './container-engine.js';
import { ContainerExecutor } from './container-executor.js';

const enabled = process.env.ADISPATCH_CONTAINER_TEST === '1';
const IMAGE = 'busybox:1.36';

describe.runIf(enabled)('ContainerExecutor with real docker (ADISPATCH_CONTAINER_TEST=1)', () => {
  let root: string;
  let pulled = false;
  let counter = 0;
  const engines = new ContainerEngineClient();

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wi19-docker-'));
    try {
      execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    } catch {
      execFileSync('docker', ['pull', IMAGE], { stdio: 'ignore' });
      pulled = true;
    }
  }, 120_000);

  afterAll(async () => {
    if (pulled) execFileSync('docker', ['image', 'rm', IMAGE], { stdio: 'ignore' });
    await rm(root, { recursive: true, force: true });
  });

  async function spec(script: string): Promise<ExecutionSpec> {
    const runId = `run-20261019T120000000Z-d0c0${String(++counter).padStart(4, '0')}`;
    const dataDir = path.join(root, 'data');
    const run = dataPaths(dataDir).run(runId);
    const workspace = path.join(root, 'ws', runId);
    const extra = path.join(root, 'extra');
    await mkdir(extra, { recursive: true });
    await writeFile(path.join(extra, 'hello.txt'), 'hello from the host\n');
    return {
      runId,
      workflowId: 'wf',
      command: 'docker',
      args: ['sh', '-c', script],
      workingDirectory: workspace,
      createDirectory: true,
      env: { MODE: 'real' },
      secrets: { API_TOKEN: 'real-docker-secret' },
      context: { schema_version: 1, workspace: { path: '/work' } },
      files: { contextFile: run.contextFile, resultFile: path.join(run.outDir, 'result.json'), stdoutLog: run.stdoutLog, stderrLog: run.stderrLog },
      timeouts: {},
      cancelGraceMs: 2000,
      container: {
        engine: 'docker',
        image: IMAGE,
        name: containerName(runId),
        labels: { [CONTAINER_LABELS.run]: runId, [CONTAINER_LABELS.workflow]: 'wf', [CONTAINER_LABELS.instance]: containerInstanceId(dataDir) },
        mounts: [
          { source: workspace, target: '/work', mode: 'rw' },
          { source: extra, target: '/extra', mode: 'ro' },
        ],
        workspaceTarget: '/work',
        workdir: '/work',
        resources: { memory: '128m', cpus: 1, pids: 64 },
        user: defaultContainerUser(),
        network: 'none',
        pull: 'never',
      },
    };
  }

  it('runs busybox, reads the context and writes the result file into the out mount', async () => {
    const s = await spec(
      [
        'cat /extra/hello.txt',
        'echo "mode=$MODE token=$API_TOKEN pwd=$(pwd)"',
        'grep -q schema_version "$ADISPATCH_CONTEXT_FILE" || exit 7',
        'echo data > /work/created.txt',
        '( echo x > /extra/nope.txt ) 2>/dev/null && exit 8',
        'printf \'{"schema_version":1,"result":"success","message":"from docker"}\' > "$ADISPATCH_RESULT_FILE"',
      ].join('\n'),
    );
    const proc = await new ContainerExecutor({ engines }).start(s);
    const outcome = await proc.wait();
    const stderr = await readFile(s.files.stderrLog, 'utf8');
    expect(outcome.exitCode, stderr).toBe(0);
    expect(classifyOutcome(outcome)).toMatchObject({ status: 'completed', businessResult: 'success' });
    expect(classifyOutcome(outcome).result?.message).toBe('from docker');
    expect(await readFile(s.files.stdoutLog, 'utf8')).toBe('hello from the host\nmode=real token=[REDACTED] pwd=/work\n');
    expect(await readFile(path.join(s.workingDirectory, 'created.txt'), 'utf8')).toBe('data\n');
    expect(await engines.list('docker', s.container!.labels[CONTAINER_LABELS.instance]!)).toEqual([]);
  }, 60_000);

  it('cancel stops the container', async () => {
    const s = await spec('echo "@@ADISPATCH_EVENT {\\"type\\":\\"ready\\"}"; while :; do sleep 1; done');
    const proc = await new ContainerExecutor({ engines }).start(s);
    await new Promise<void>((resolve) => proc.onEvent((e: WorkerEvent) => e.type === 'ready' && resolve()));
    await proc.cancel();
    expect(classifyOutcome(await proc.wait()).status).toBe('cancelled');
    expect(await engines.list('docker', s.container!.labels[CONTAINER_LABELS.instance]!)).toEqual([]);
  }, 60_000);
});
