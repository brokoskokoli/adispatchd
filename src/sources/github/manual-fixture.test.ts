/**
 * Keeps the config dir of the manual GitHub test guide (docs/manual-tests/github.md,
 * docs/manual-tests/github-fixture/) from going stale: it must load with the real
 * config loader without errors or warnings, and the test worker must still speak
 * the worker protocol (result file accepted by the real parser, exit codes as
 * documented in the guide).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { parseWorkerResult } from '../../core/worker-protocol.js';
import { GITHUB_API_VERSION } from './http.js';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/manual-tests/github-fixture');
const WORKER = path.join(FIXTURE_DIR, 'scripts/test-worker.sh');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-manual-fixture-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('manual GitHub test fixture (docs/manual-tests/github-fixture)', () => {
  it('is a valid configuration without warnings', async () => {
    const result = await loadConfig(FIXTURE_DIR, { dataDir: path.join(tmp, 'data') });
    if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.errors)}`);
    expect(result.warnings).toEqual([]);
    const c = result.config;
    expect(Object.keys(c.sources).sort()).toEqual(['test_a', 'test_b']);
    expect(Object.keys(c.identities).sort()).toEqual(['coder', 'maintainer', 'reviewer']);
    expect(Object.keys(c.workflows).sort()).toEqual(['coder-test', 'commenter-test', 'reviewer-test']);
    expect(Object.keys(c.views).sort()).toEqual(['dependencies', 'needs-maintainer']);
    // The guide relies on these values (scenario 1 and 5, port in all curl examples).
    expect(c.global.server.port).toBe(8791);
    expect(c.workflows['coder-test']?.maxConcurrent).toBe(2);
    expect(c.workflows['coder-test']?.retry.maxTechnicalFailures).toBe(3);
    expect(c.views['needs-maintainer']?.sources).toEqual(['test_a', 'test_b']);
  });

  it('ships an executable test worker that pins the same API version as the client', () => {
    expect(() => accessSync(WORKER, constants.X_OK)).not.toThrow();
    const versions = [...readFileSync(WORKER, 'utf8').matchAll(/X-GitHub-Api-Version: ([0-9-]+)/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([GITHUB_API_VERSION]));
  });

  it('ships shell helpers that parse and pin the same API version', () => {
    const helpers = path.join(FIXTURE_DIR, 'helpers.sh');
    // bash/zsh syntax (arrays), not POSIX sh: check with bash where available.
    const check = spawnSync('bash', ['-n', helpers], { encoding: 'utf8' });
    if (!check.error) expect(check.status, check.stderr).toBe(0);
    expect(readFileSync(helpers, 'utf8')).toContain(`GH_API_VERSION:-${GITHUB_API_VERSION}`);
  });

  const cases: Array<{ label: string | null; exit: number; result: 'success' | 'failure' | 'invalid' }> = [
    { label: null, exit: 0, result: 'success' },
    { label: 'test:failure', exit: 0, result: 'failure' },
    { label: 'test:crash', exit: 1, result: 'success' }, // file is written but ignored because of exit 1
    { label: 'test:invalid-result', exit: 0, result: 'invalid' },
  ];
  it.each(cases)('test worker with label $label → exit $exit, result $result', ({ label, exit, result }) => {
    const dir = mkdtempSync(path.join(tmp, 'run-'));
    const contextFile = path.join(dir, 'context.json');
    const resultFile = path.join(dir, 'result.json');
    writeFileSync(
      contextFile,
      JSON.stringify({ schema_version: 1, source: { attributes: { labels: ['ready-for-coding', ...(label ? [label] : [])] } } }),
    );
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ORCH_CONTEXT_FILE: contextFile,
      ORCH_RESULT_FILE: resultFile,
      ORCH_RUN_ID: 'run-test',
      ORCH_WORKFLOW_ID: 'coder-test',
      ORCH_WORKSPACE: dir,
    };
    const proc = spawnSync('/bin/sh', [WORKER, '7', 'owner/orch-test-a'], { env, encoding: 'utf8', timeout: 20_000 });
    expect(proc.status, proc.stderr).toBe(exit);
    expect(existsSync(`${resultFile}.tmp.${proc.pid}`)).toBe(false);
    const parsed = parseWorkerResult(readFileSync(resultFile, 'utf8'));
    if (result === 'invalid') {
      expect(parsed.ok).toBe(false);
    } else {
      expect(parsed.ok && parsed.result.result).toBe(result);
    }
  });
});
