/**
 * End-to-end (WI-31): manual-start parameters whose options come from GitHub
 * (branches/tags via Fake-GitHub) and from a script. The options endpoint,
 * the start check (400 outside the list, 502 when the list is unavailable,
 * `allow_custom`) and the arrival of the values in args/env/context file of a
 * real shell worker; roles with `auth.mode: password`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_PASSWORDS, authEnvSetup, FAST_AUTH, PASSWORD_AUTH_CONFIG } from './api/testing/auth.js';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';
import { CSRF_HEADER } from './api/server.js';

function setup(e: AppEnv): void {
  e.github.setRepoRefs(REPO_A, { defaultBranch: 'main', branches: ['release-1', 'main', 'dev'], tags: ['v1.2.0', 'v1.1.0'] });
  const hosts = e.script('list-hosts.sh', `[ "$1" = "--env" ] || exit 9\nprintf '[{"value":"web-1","label":"Web 1 (%s)"},"web-2"]' "$2"`);
  const broken = e.script('broken-hosts.sh', `echo "inventory offline" >&2; exit 3`);
  const out = path.join(e.marks, 'deploy');
  const worker = e.script(
    'deploy.sh',
    [
      `printf '%s\\n' "$@" > "${out}.args"`,
      `printf '%s' "$DEPLOY_BRANCH" > "${out}.env"`,
      `cp "$ADISPATCH_CONTEXT_FILE" "${out}.context.json"`,
      `printf '{"schema_version":1,"result":"success","message":"ok"}' > "$ADISPATCH_RESULT_FILE"`,
    ].join('\n'),
  );
  writeFileSync(
    path.join(e.configDir, 'workflows', 'deploy.yaml'),
    [
      'id: deploy',
      'trigger: { type: manual }',
      'parameters:',
      '  branch:',
      '    type: enum',
      '    options_from: { github: branches, source: repo_a }',
      '    default: main',
      '  tag:',
      '    type: enum',
      '    options_from: { github: tags, source: repo_a, limit: 50 }',
      '  target:',
      '    type: enum',
      '    options_from:',
      `      command: ${hosts}`,
      "      args: ['--env', 'prod']",
      '      timeout: 5s',
      '      cache: 5m',
      '  note:',
      '    type: enum',
      `    options_from: { command: ${hosts}, args: ['--env', 'qa'] }`,
      '    allow_custom: true',
      'execute:',
      '  type: shell',
      `  command: ${worker}`,
      "  args: ['{parameters.branch}', '{parameters.tag}', '{parameters.target}', '{parameters.note}']",
      "  env: { DEPLOY_BRANCH: '{parameters.branch}' }",
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(e.configDir, 'workflows', 'inventory.yaml'),
    [
      'id: inventory',
      'trigger: { type: manual }',
      'parameters:',
      '  host:',
      '    type: enum',
      `    options_from: { command: ${broken} }`,
      '  ref:',
      '    type: enum',
      '    options_from: { github: tags, source: repo_b }',
      '    allow_custom: false',
      'execute: { type: shell, command: /bin/true }',
      '',
    ].join('\n'),
  );
}

describe('parameter options (auth.mode: none)', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({}, setup);
  });
  afterAll(async () => env?.cleanup());

  it('describes optionsFrom/allowCustom in the workflow view without script arguments', async () => {
    const res = await env.request('GET', '/api/v1/workflows/deploy');
    expect(res.status).toBe(200);
    const p = res.json.parameters;
    expect(p.branch).toMatchObject({ type: 'enum', values: [], default: 'main', allowCustom: false, optionsFrom: { type: 'github', github: 'branches', source: 'repo_a', limit: 100, cacheMs: 60_000 } });
    expect(p.target.optionsFrom).toEqual({ type: 'command', command: expect.stringMatching(/list-hosts\.sh$/), secrets: [], timeoutMs: 5_000, cacheMs: 300_000 });
    expect(p.note).toMatchObject({ allowCustom: true });
    expect(JSON.stringify(res.json.parameters)).not.toContain('--env');
  });

  it('serves GitHub and script options with cache and refresh', async () => {
    const branches = await env.request('GET', '/api/v1/workflows/deploy/parameters/branch/options');
    expect(branches.status).toBe(200);
    expect(branches.json).toMatchObject({ cached: false, allowCustom: false });
    expect(branches.json.options.map((o: { value: string }) => o.value)).toEqual(['main', 'dev', 'release-1']);
    expect(typeof branches.json.fetchedAt).toBe('string');
    expect((await env.request('GET', '/api/v1/workflows/deploy/parameters/branch/options')).json.cached).toBe(true);

    const tags = await env.request('GET', '/api/v1/workflows/deploy/parameters/tag/options');
    expect(tags.json.options).toEqual([
      { value: 'v1.2.0', label: 'v1.2.0' },
      { value: 'v1.1.0', label: 'v1.1.0' },
    ]);
    const hosts = await env.request('GET', '/api/v1/workflows/deploy/parameters/target/options?refresh=true');
    expect(hosts.json).toMatchObject({ options: [{ value: 'web-1', label: 'Web 1 (prod)' }, { value: 'web-2', label: 'web-2' }], cached: false });
    expect((await env.request('GET', '/api/v1/workflows/deploy/parameters/target/options')).json.cached).toBe(true);

    expect((await env.request('GET', '/api/v1/workflows/deploy/parameters/nope/options')).status).toBe(404);
    expect((await env.request('GET', '/api/v1/workflows/nope/parameters/x/options')).status).toBe(404);
    expect((await env.request('GET', '/api/v1/workflows/deploy/parameters/branch/options?refresh=yes')).status).toBe(400);
  });

  it('reports fetch errors in the result (script exit ≠ 0, GitHub not accessible)', async () => {
    const host = await env.request('GET', '/api/v1/workflows/inventory/parameters/host/options');
    expect(host.status).toBe(200);
    expect(host.json).toMatchObject({ options: [], error: { code: 'command_failed', message: 'exit code 3: inventory offline' } });
    env.github.restrictRepo('example/b');
    const ref = await env.request('GET', '/api/v1/workflows/inventory/parameters/ref/options');
    expect(ref.json).toMatchObject({ options: [], error: { code: 'source_error', message: expect.stringContaining('not_found') } });
  });

  it('start: 400 for a value outside the list, 502 when the list is unavailable', async () => {
    const outside = await env.request('POST', '/api/v1/workflows/deploy/start', { parameters: { branch: 'feature/nope', tag: 'v1.1.0', target: 'web-1' } });
    expect(outside.status).toBe(400);
    expect(outside.json.error).toMatchObject({
      code: 'invalid_parameters',
      details: { errors: [{ parameter: 'branch', message: '"feature/nope" is not one of the current options' }] },
    });
    const unavailable = await env.request('POST', '/api/v1/workflows/inventory/start', { parameters: { host: 'h1' } });
    expect(unavailable.status).toBe(502);
    expect(unavailable.json.error).toMatchObject({
      code: 'parameter_options_unavailable',
      details: { parameter: 'host', error: { code: 'command_failed' } },
    });
  });

  it('start with valid and custom values: they arrive in args, env and the context file', async () => {
    const res = await env.request('POST', '/api/v1/workflows/deploy/start', {
      parameters: { tag: 'v1.2.0', target: 'web-2', note: 'free text; $(not a shell)' },
    });
    expect(res.status).toBe(202);
    const run = await env.waitTerminal(res.json.run.id);
    expect(run.status).toBe('completed');
    expect(run.parameters).toEqual({ branch: 'main', tag: 'v1.2.0', target: 'web-2', note: 'free text; $(not a shell)' });
    const out = path.join(env.marks, 'deploy');
    expect(readFileSync(`${out}.args`, 'utf8')).toBe('main\nv1.2.0\nweb-2\nfree text; $(not a shell)\n');
    expect(readFileSync(`${out}.env`, 'utf8')).toBe('main');
    const context = JSON.parse(readFileSync(`${out}.context.json`, 'utf8'));
    expect(context.parameters).toEqual({ branch: 'main', tag: 'v1.2.0', target: 'web-2', note: 'free text; $(not a shell)' });
  });
});

describe('parameter options and roles (auth.mode: password)', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: FAST_AUTH }, (e) => {
      authEnvSetup(e);
      setup(e);
    });
  });
  afterAll(async () => env?.cleanup());

  async function login(name: keyof typeof AUTH_PASSWORDS): Promise<string> {
    const res = await env.app.http.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { [CSRF_HEADER]: '1', 'content-type': 'application/json' },
      payload: JSON.stringify({ name, password: AUTH_PASSWORDS[name] }),
    });
    expect(res.statusCode).toBe(200);
    return String(res.headers['set-cookie']).split(';')[0]!;
  }

  it('viewers may read GitHub options but not trigger option scripts; operators may', async () => {
    const viewer = await login('victor');
    const operator = await login('olga');
    expect((await env.request('GET', '/api/v1/workflows/deploy/parameters/target/options')).status).toBe(401);
    const denied = await env.request('GET', '/api/v1/workflows/deploy/parameters/target/options', undefined, { cookie: viewer });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatchObject({ code: 'forbidden', details: { requiredRole: 'operator', role: 'viewer' } });
    expect((await env.request('GET', '/api/v1/workflows/deploy/parameters/branch/options', undefined, { cookie: viewer })).status).toBe(200);
    const allowed = await env.request('GET', '/api/v1/workflows/deploy/parameters/target/options', undefined, { cookie: operator });
    expect(allowed.status).toBe(200);
    expect(allowed.json.options).toHaveLength(2);
  });
});
