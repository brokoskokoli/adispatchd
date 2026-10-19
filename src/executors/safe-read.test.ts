/**
 * Hardened result-file reading (WI-19 review M1): symlinks (to a host file or
 * another run's result), FIFOs, swapped directories and parse errors never
 * expose foreign content.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths, parseWorkerResult, type ExecutionSpec } from '../core/index.js';
import { classifyOutcome } from './classify.js';
import { readFileNoFollow } from './safe-read.js';
import { ShellExecutor } from './shell-executor.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wi19-read-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.runIf(supported)('readFileNoFollow', () => {
  it('reads a regular file', async () => {
    await writeFile(path.join(root, 'result.json'), '{"a":1}');
    expect(await readFileNoFollow(path.join(root, 'result.json'))).toEqual({ state: 'ok', text: '{"a":1}' });
    expect(await readFileNoFollow(path.join(root, 'none.json'))).toEqual({ state: 'missing' });
  });

  it('refuses symlinks to a host file and to another run’s result', async () => {
    await writeFile(path.join(root, 'host-secret'), 'TOP SECRET');
    const other = path.join(root, 'runs', 'other');
    const mine = path.join(root, 'runs', 'mine');
    await mkdir(other, { recursive: true });
    await mkdir(mine, { recursive: true });
    await writeFile(path.join(other, 'result.json'), '{"schema_version":1,"result":"success"}');
    await symlink(path.join(root, 'host-secret'), path.join(mine, 'result.json'));
    expect(await readFileNoFollow(path.join(mine, 'result.json'))).toEqual({ state: 'invalid', error: 'result file is a symbolic link (refused)' });
    await rm(path.join(mine, 'result.json'));
    await symlink(path.join(other, 'result.json'), path.join(mine, 'result.json'));
    expect(await readFileNoFollow(path.join(mine, 'result.json'))).toMatchObject({ state: 'invalid', error: expect.stringContaining('symbolic link') });
  });

  it('refuses a FIFO without blocking and a directory swapped for a symlink', async () => {
    const fifo = path.join(root, 'fifo.json');
    execFileSync('mkfifo', [fifo]);
    expect(await readFileNoFollow(fifo)).toEqual({ state: 'invalid', error: 'result file is not a regular file' });

    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'result.json'), '{}');
    await mkdir(path.join(root, 'run'));
    await symlink(elsewhere, path.join(root, 'run', 'out'));
    const res = await readFileNoFollow(path.join(root, 'run', 'out', 'result.json'), { dir: path.join(root, 'run') });
    expect(res).toEqual({ state: 'invalid', error: 'result file lies outside its directory (refused)' });
  });

  it('enforces the size limit', async () => {
    await writeFile(path.join(root, 'big.json'), 'x'.repeat(100));
    expect(await readFileNoFollow(path.join(root, 'big.json'), { maxBytes: 10 })).toEqual({ state: 'invalid', error: 'result file exceeds 10 bytes' });
  });
});

describe('parseWorkerResult', () => {
  it('reports only the position of a JSON error, never the content', () => {
    const res = parseWorkerResult('{"result": SECRET_CONTENT_xyz}');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toContain('SECRET');
    expect(res.error).toMatch(/^result file is not valid JSON( \(at position \d+(, line \d+ column \d+)?\))?$/);
  });
});

describe.runIf(supported)('ShellExecutor result file symlink', () => {
  it('a worker pointing the result file at a host file → crashed, content not exposed', async () => {
    await writeFile(path.join(root, 'host-secret.json'), '{"schema_version":1,"result":"failure","message":"HOST CONTENT"}');
    const run = dataPaths(path.join(root, 'data')).run('run-20261019T130000000Z-0000aaaa');
    const script = path.join(root, 'w.sh');
    await writeFile(script, `#!/bin/sh\nln -s "${path.join(root, 'host-secret.json')}" "$ADISPATCH_RESULT_FILE"\n`, { mode: 0o755 });
    const spec: ExecutionSpec = {
      runId: 'run-20261019T130000000Z-0000aaaa',
      workflowId: 'wf',
      command: script,
      args: [],
      workingDirectory: path.join(root, 'ws'),
      createDirectory: true,
      env: {},
      secrets: {},
      context: {},
      files: { contextFile: run.contextFile, resultFile: run.resultFile, stdoutLog: run.stdoutLog, stderrLog: run.stderrLog },
      timeouts: {},
      cancelGraceMs: 200,
    };
    const outcome = await (await new ShellExecutor().start(spec)).wait();
    const c = classifyOutcome(outcome);
    expect(c.status).toBe('crashed');
    expect(c.reason).toContain('symbolic link');
    expect(JSON.stringify(outcome)).not.toContain('HOST CONTENT');
  });
});
