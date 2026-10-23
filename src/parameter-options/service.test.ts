/** WI-31: options of enum parameters at run time (`options_from`). */
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor, type AccessToken, type CredentialProvider } from '../core/index.js';
import type { CommandParameterOptions, ParameterDefinition, WorkflowConfig } from '../config/index.js';
import type { ShellCheckResult } from '../filters/index.js';
import { FakeGitHub, createFakeGitHubSource, staticCredentials } from '../sources/github/testing/index.js';
import { OPTIONS_TMP_DIR, parseOptionsOutput, ParameterOptionsService, type OptionsExecutor, type OptionsScriptContext } from './index.js';

const SECRET = 'ghs_supersecret_token_value_123';

function workflow(parameters: Record<string, ParameterDefinition>): WorkflowConfig {
  return { id: 'deploy', name: 'Deploy', parameters } as unknown as WorkflowConfig;
}

function commandParam(over: Partial<CommandParameterOptions> = {}, allowCustom = false): ParameterDefinition {
  return {
    type: 'enum',
    required: false,
    description: null,
    default: null,
    values: [],
    allowCustom,
    optionsFrom: { type: 'command', command: '/bin/echo', args: [], secrets: {}, timeoutMs: 5_000, cacheMs: 0, ...over },
  };
}

function githubParam(github: 'branches' | 'tags', source = 'project_a', over: { cacheMs?: number; limit?: number } = {}): ParameterDefinition {
  return {
    type: 'enum',
    required: false,
    description: null,
    default: null,
    values: [],
    allowCustom: false,
    optionsFrom: { type: 'github', github, source, limit: over.limit ?? 100, timeoutMs: 5_000, cacheMs: over.cacheMs ?? 60_000 },
  };
}

function ok(stdout: string, extra: Partial<ShellCheckResult> = {}): ShellCheckResult {
  return { value: true, exitCode: 0, signal: null, timedOut: false, stdout, stderr: '', outputTruncated: false, startedAt: '', durationMs: 1, cached: false, ...extra };
}

describe('parseOptionsOutput', () => {
  it('reads one option per line (trimmed, empty lines ignored, duplicates once)', () => {
    expect(parseOptionsOutput(' a \n\nb\r\na\n')).toEqual({ ok: true, options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] });
    expect(parseOptionsOutput('')).toEqual({ ok: true, options: [] });
  });

  it('reads a JSON list of strings or value/label objects', () => {
    expect(parseOptionsOutput('["x", {"value": "y", "label": "Why"}, {"value": "z"}]\n')).toEqual({
      ok: true,
      options: [
        { value: 'x', label: 'x' },
        { value: 'y', label: 'Why' },
        { value: 'z', label: 'z' },
      ],
    });
  });

  it('rejects invalid JSON, wrong entries, too many options and bad values', () => {
    expect(parseOptionsOutput('[1, 2')).toEqual({ ok: false, error: 'output starts with "[" but is not valid JSON' });
    expect(parseOptionsOutput('[1]')).toMatchObject({ ok: false, error: expect.stringContaining('option 1') });
    expect(parseOptionsOutput('[{"value": 3}]')).toMatchObject({ ok: false, error: 'option 1: "value" must be a string' });
    expect(parseOptionsOutput('[{"value": "a", "label": "x\\u0007"}]')).toMatchObject({ ok: false, error: 'option 1: label: Value contains control characters' });
    expect(parseOptionsOutput(Array.from({ length: 501 }, (_, i) => `v${i}`).join('\n'))).toEqual({ ok: false, error: 'more than 500 options (501)' });
    expect(parseOptionsOutput(`ok\n${'x'.repeat(201)}`)).toEqual({ ok: false, error: 'option 2: Value is longer than 200 characters' });
    expect(parseOptionsOutput('a\u0000b')).toMatchObject({ ok: false, error: expect.stringContaining('control characters') });
    expect(parseOptionsOutput('["a\\tb"]')).toMatchObject({ ok: false });
  });
});

describe('ParameterOptionsService – command (fake executor)', () => {
  let clock: FakeClock;
  let calls: Array<{ args: readonly string[]; env: Record<string, string>; context: OptionsScriptContext }>;
  let reply: () => Promise<ShellCheckResult>;
  let service: ParameterOptionsService;

  beforeEach(() => {
    clock = new FakeClock('2026-10-23T12:00:00Z');
    calls = [];
    reply = async () => ok('a\nb\n');
    const executor: OptionsExecutor = async (spec, context) => {
      calls.push({ args: spec.args ?? [], env: { ...(spec.env ?? {}) }, context });
      return reply();
    };
    service = new ParameterOptionsService({ sources: () => undefined, configDir: () => '/cfg', dataDir: '/data', executor, clock, minIntervalMs: 2_000 });
  });

  it('returns static values for enums without options_from', async () => {
    const wf = workflow({ env: { type: 'enum', required: false, description: null, default: null, values: ['a', 'b'] } });
    expect(await service.get(wf, 'env')).toEqual({
      options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }],
      fetchedAt: null,
      cached: false,
      allowCustom: false,
    });
  });

  it('renders args, passes env/context, caches for `cache`, refresh bypasses the cache', async () => {
    const wf = workflow({ target: commandParam({ args: ['--wf={workflow.id}', '{timestamp}'], cacheMs: 60_000 }, true) });
    const first = await service.get(wf, 'target');
    expect(first).toMatchObject({ options: [{ value: 'a' }, { value: 'b' }], cached: false, allowCustom: true, fetchedAt: '2026-10-23T12:00:00.000Z' });
    expect(calls[0]?.args).toEqual(['--wf=deploy', '20261023T120000Z']);
    expect(calls[0]?.env).toMatchObject({ ADISPATCH_WORKFLOW_ID: 'deploy', ADISPATCH_PARAMETER: 'target', ADISPATCH_CONFIG_DIR: '/cfg' });
    expect(calls[0]?.context).toMatchObject({ kind: 'parameter_options', workflow: { id: 'deploy' }, parameter: { name: 'target' } });

    clock.advance(30_000);
    expect(await service.get(wf, 'target')).toMatchObject({ cached: true });
    expect(calls).toHaveLength(1);
    reply = async () => ok('c\n');
    expect(await service.get(wf, 'target', { refresh: true })).toMatchObject({ options: [{ value: 'c' }], cached: false });
    expect(calls).toHaveLength(2);
    // Within the minimum interval even `refresh` gets the last result.
    expect(await service.get(wf, 'target', { refresh: true })).toMatchObject({ options: [{ value: 'c' }], cached: true });
    expect(calls).toHaveLength(2);
    clock.advance(61_000);
    await service.get(wf, 'target');
    expect(calls).toHaveLength(3);
  });

  it('cache 0s fetches every time (after the minimum interval); concurrent requests share one execution', async () => {
    const wf = workflow({ target: commandParam() });
    let release!: () => void;
    reply = () => new Promise((resolve) => (release = () => resolve(ok('x\n'))));
    const a = service.get(wf, 'target');
    const b = service.get(wf, 'target', { refresh: true });
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.options).toEqual([{ value: 'x', label: 'x' }]);
    expect(rb.options).toEqual(ra.options);
    expect(calls).toHaveLength(1);
    reply = async () => ok('y\n');
    clock.advance(2_000);
    expect((await service.get(wf, 'target')).options).toEqual([{ value: 'y', label: 'y' }]);
    expect(calls).toHaveLength(2);
  });

  it('reports exit ≠ 0, timeout, spawn errors and invalid output as errors (errors are not cached)', async () => {
    const wf = workflow({ target: commandParam({ cacheMs: 60_000 }) });
    reply = async () => ok('', { value: 'unknown', exitCode: 3, error: 'check error: exit code 3', stderr: '\nboom: no access\nmore' });
    expect(await service.get(wf, 'target')).toMatchObject({ options: [], error: { code: 'command_failed', message: 'exit code 3: boom: no access' } });
    clock.advance(2_000);
    reply = async () => ok('', { value: false, exitCode: 1 });
    expect((await service.get(wf, 'target')).error).toEqual({ code: 'command_failed', message: 'exit code 1' });
    clock.advance(2_000);
    reply = async () => ok('', { value: 'unknown', exitCode: null, signal: 'SIGTERM', timedOut: true, error: 'timed out after 5000ms' });
    expect((await service.get(wf, 'target')).error).toEqual({ code: 'timeout', message: 'Script timed out after 5s' });
    clock.advance(2_000);
    reply = async () => ok('', { value: 'unknown', exitCode: null, error: 'spawn failed: ENOENT' });
    expect((await service.get(wf, 'target')).error).toEqual({ code: 'command_failed', message: 'spawn failed: ENOENT' });
    clock.advance(2_000);
    reply = async () => ok('[oops');
    expect((await service.get(wf, 'target')).error).toEqual({ code: 'invalid_output', message: 'output starts with "[" but is not valid JSON' });
    clock.advance(2_000);
    reply = async () => ok('a', { outputTruncated: true });
    expect((await service.get(wf, 'target')).error).toEqual({ code: 'invalid_output', message: 'Output exceeds 256 KiB' });
    clock.advance(2_000);
    reply = async () => ok('fine\n');
    expect(await service.get(wf, 'target')).toMatchObject({ options: [{ value: 'fine' }], cached: false });
    expect((await service.get(wf, 'target')).cached).toBe(true);
  });

  it('check: values must be in the current list unless allow_custom; unavailable lists are reported', async () => {
    const wf = workflow({ target: commandParam({ cacheMs: 60_000 }), free: commandParam({}, true) });
    expect(await service.check(wf, { target: 'a', free: 'anything' })).toEqual({ ok: true });
    expect(calls).toHaveLength(1); // `free` (allow_custom) is never fetched for the check
    expect(await service.check(wf, { target: 'zzz' })).toEqual({
      ok: false,
      reason: 'invalid',
      errors: [{ parameter: 'target', message: '"zzz" is not one of the current options' }],
    });
    expect(await service.check(wf, {})).toEqual({ ok: true });
    service.invalidate();
    reply = async () => ok('', { value: false, exitCode: 1 });
    expect(await service.check(wf, { target: 'a' })).toEqual({
      ok: false,
      reason: 'unavailable',
      parameter: 'target',
      error: { code: 'command_failed', message: 'exit code 1' },
    });
  });
});

describe('ParameterOptionsService – command (real processes)', () => {
  let dir: string;
  const tokens: string[] = [];
  const credentials: CredentialProvider = {
    getToken(identity): Promise<AccessToken> {
      tokens.push(identity);
      return Promise.resolve({ token: SECRET, expiresAt: new Date(Date.now() + 3_600_000) });
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'adispatch-options-'));
    tokens.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function script(name: string, body: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it('runs in the config dir with secrets (env and file), redacts them in messages and logs', async () => {
    const dataDir = path.join(dir, 'data');
    const logger = new MemoryLogger();
    const redactor = new SecretRedactor();
    const service = new ParameterOptionsService({ sources: () => undefined, credentials, configDir: () => dir, dataDir, logger, redact: redactor.asRedactor });
    const list = await script('list.sh', 'pwd; test "$GH_TOKEN" = "' + SECRET + '" && echo env-ok; test "$(cat "$FILE_TOKEN_FILE")" = "' + SECRET + '" && echo file-ok');
    const wf = workflow({
      target: commandParam({
        command: list,
        secrets: { GH_TOKEN: { identity: 'reader', delivery: 'env' }, FILE_TOKEN: { identity: 'reader', delivery: 'file' } },
      }),
    });
    const res = await service.get(wf, 'target');
    expect(res.error).toBeUndefined();
    expect(res.options.map((o) => o.value).slice(1)).toEqual(['env-ok', 'file-ok']);
    expect(await import('node:fs/promises').then((fs) => fs.realpath(res.options[0]!.value))).toBe(await import('node:fs/promises').then((fs) => fs.realpath(dir)));
    // Token files are removed afterwards.
    expect(await readdir(path.join(dataDir, OPTIONS_TMP_DIR))).toEqual([]);

    const leak = await script('leak.sh', 'echo "denied for $GH_TOKEN" >&2; exit 4');
    const wf2 = workflow({ target: commandParam({ command: leak, secrets: { GH_TOKEN: { identity: 'reader', delivery: 'env' } } }) });
    const failed = await service.get(wf2, 'target');
    expect(failed.error).toEqual({ code: 'command_failed', message: 'exit code 4: denied for [REDACTED]' });
    expect(logger.records.some((r) => r.msg === "parameter options could not be fetched")).toBe(true);
    expect(JSON.stringify(logger.records)).not.toContain(SECRET);
  });

  it('kills the process group on timeout', async () => {
    const service = new ParameterOptionsService({ sources: () => undefined, configDir: () => dir, dataDir: path.join(dir, 'data') });
    const slow = await script('slow.sh', `sleep 30 & echo $! > "${dir}/child.pid"; sleep 30`);
    const wf = workflow({ target: commandParam({ command: slow, timeoutMs: 300 }) });
    const started = Date.now();
    const res = await service.get(wf, 'target');
    expect(res.error).toEqual({ code: 'timeout', message: 'Script timed out after 300ms' });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number((await import('node:fs/promises').then((fs) => fs.readFile(path.join(dir, 'child.pid'), 'utf8'))).trim());
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 20_000);
});

describe('ParameterOptionsService – GitHub', () => {
  it('lists branches/tags with the source identity, caches them and reports errors', async () => {
    const clock = new FakeClock('2026-10-23T12:00:00Z');
    const github = new FakeGitHub({ clock });
    github.setRepoRefs('example/project-a', { defaultBranch: 'main', branches: ['dev', 'main', 'feature/x'], tags: ['v2', 'v1'] });
    const credentials = staticCredentials();
    const adapter = createFakeGitHubSource(github, { clock, credentials, identity: 'reader' });
    const service = new ParameterOptionsService({ sources: (id) => (id === 'project_a' ? adapter : undefined), configDir: () => '/cfg', dataDir: '/data', clock });
    const wf = workflow({ branch: githubParam('branches'), tag: githubParam('tags', 'project_a', { limit: 1 }), other: githubParam('tags', 'gone') });
    expect((await service.get(wf, 'branch')).options.map((o) => o.value)).toEqual(['main', 'dev', 'feature/x']);
    expect((await service.get(wf, 'tag')).options).toEqual([{ value: 'v2', label: 'v2' }]);
    expect(new Set(credentials.calls)).toEqual(new Set(['reader']));
    const requests = github.requests.length;
    expect((await service.get(wf, 'branch')).cached).toBe(true);
    expect(github.requests.length).toBe(requests);

    expect((await service.get(wf, 'other')).error).toMatchObject({ code: 'source_unavailable' });
    github.failNext({ path: /\/tags$/ }, { status: 403, body: { message: 'Resource not accessible by integration' } });
    clock.advance(120_000);
    const forbidden = await service.get(wf, 'tag');
    expect(forbidden.error).toMatchObject({ code: 'source_error', message: expect.stringContaining('forbidden') });
    github.failNext({ path: /\/tags$/ }, { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '600' } });
    clock.advance(3_000);
    expect((await service.get(wf, 'tag')).error).toMatchObject({ code: 'rate_limited' });
  });
});
