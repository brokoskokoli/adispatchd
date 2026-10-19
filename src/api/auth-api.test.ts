/**
 * Authentication over the API (WI-26): password login/logout/session cookie,
 * read_requires_login, trusted_header, control token, SSE with/without session,
 * audit of writes (run events, block clearedBy, daemon log).
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_TOKEN_HEADER, controlTokenPath } from './auth.js';
import { CSRF_HEADER } from './server.js';
import { AUTH_PASSWORDS, authEnvSetup, FAST_AUTH, PASSWORD_AUTH_CONFIG } from './testing/auth.js';
import { connectSse, startAppEnv, type AppEnv } from './testing/helpers.js';

interface InjectOptions {
  headers?: Record<string, string>;
  body?: unknown;
  remoteAddress?: string;
}

async function call(env: AppEnv, method: string, url: string, opts: InjectOptions = {}) {
  const mutating = method !== 'GET';
  const res = await env.app.http.inject({
    method: method as 'GET',
    url,
    headers: { ...(mutating ? { [CSRF_HEADER]: '1', 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    ...(mutating ? { payload: JSON.stringify(opts.body ?? {}) } : {}),
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, json, headers: res.headers };
}

async function login(env: AppEnv, name: keyof typeof AUTH_PASSWORDS): Promise<string> {
  const res = await call(env, 'POST', '/api/v1/auth/login', { body: { name, password: AUTH_PASSWORDS[name] } });
  expect(res.status).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

function manualWorkflow(e: AppEnv, id: string): void {
  const release = path.join(e.marks, `release-${id}`);
  const script = e.script(`${id}.sh`, `while [ ! -f "${release}" ]; do sleep 0.05; done`);
  writeFileSync(path.join(e.configDir, 'workflows', `${id}.yaml`), `id: ${id}\nname: ${id}\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: ${script}\n  cancel_grace: 300ms\n`);
}

describe('auth.mode: password', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: FAST_AUTH }, (e) => {
      authEnvSetup(e);
      manualWorkflow(e, 'slow');
    });
  });
  afterAll(async () => env?.cleanup());

  it('login → session cookie → API access → logout → 401', async () => {
    expect((await call(env, 'GET', '/api/v1/status')).status).toBe(401);
    const res = await call(env, 'POST', '/api/v1/auth/login', { body: { name: 'olga', password: AUTH_PASSWORDS.olga } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ user: { name: 'olga', role: 'operator', via: 'password' } });
    expect(Date.parse(res.json.expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^adispatch_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Strict$/);
    const cookie = setCookie.split(';')[0]!;
    expect((await call(env, 'GET', '/api/v1/status', { headers: { cookie } })).status).toBe(200);
    expect((await call(env, 'GET', '/api/v1/auth/me', { headers: { cookie } })).json).toMatchObject({
      mode: 'password',
      user: { name: 'olga', role: 'operator' },
      role: 'operator',
      readRequiresLogin: true,
    });
    const out = await call(env, 'POST', '/api/v1/auth/logout', { headers: { cookie } });
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/^adispatch_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict/);
    expect((await call(env, 'GET', '/api/v1/status', { headers: { cookie } })).status).toBe(401);
  });

  it('Secure cookie when the trusted proxy says HTTPS', async () => {
    const res = await call(env, 'POST', '/api/v1/auth/login', {
      body: { name: 'victor', password: AUTH_PASSWORDS.victor },
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure$/);
    const untrusted = await call(env, 'POST', '/api/v1/auth/login', {
      body: { name: 'victor', password: AUTH_PASSWORDS.victor },
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '192.0.2.10',
    });
    expect(String(untrusted.headers['set-cookie'])).not.toMatch(/Secure/);
  });

  it('wrong password and unknown user give the same answer; the login itself needs the CSRF header', async () => {
    const wrong = await call(env, 'POST', '/api/v1/auth/login', { body: { name: 'alice', password: 'nope' }, remoteAddress: '192.0.2.20' });
    const unknown = await call(env, 'POST', '/api/v1/auth/login', { body: { name: 'nobody', password: 'nope' }, remoteAddress: '192.0.2.20' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual(wrong.json);
    expect(wrong.json.error.code).toBe('invalid_credentials');
    const noCsrf = await env.app.http.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"name":"alice","password":"x"}' });
    expect(noCsrf.statusCode).toBe(403);
    const form = await env.app.http.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { [CSRF_HEADER]: '1', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=alice&password=x' });
    expect(form.statusCode).toBe(415);
  });

  it('rate limit → 429 with Retry-After', async () => {
    let last = await call(env, 'POST', '/api/v1/auth/login', { body: { name: 'ratelimited', password: 'x' }, remoteAddress: '192.0.2.30' });
    for (let i = 0; i < 6; i++) last = await call(env, 'POST', '/api/v1/auth/login', { body: { name: 'ratelimited', password: 'x' }, remoteAddress: '192.0.2.30' });
    expect(last.status).toBe(429);
    expect(last.json.error.code).toBe('too_many_attempts');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('SSE needs a session; logout closes the open stream', async () => {
    const url = `${env.app.url}/api/v1/events`;
    await expect(connectSse(url)).rejects.toThrow(/SSE status 401/);
    const cookie = await login(env, 'victor');
    const sse = await connectSse(url, { cookie });
    await sse.waitFor((m) => m.event === 'stream.open');
    await call(env, 'POST', '/api/v1/auth/logout', { headers: { cookie } });
    await sse.closed;
    await expect(connectSse(url, { cookie })).rejects.toThrow(/SSE status 401/);
  });

  it('audit: manual start and cancel carry the user in the run events; the daemon log records writes without bodies', async () => {
    const cookie = await login(env, 'olga');
    const start = await call(env, 'POST', '/api/v1/workflows/slow/start', { headers: { cookie } });
    expect(start.status).toBe(202);
    const runId = start.json.run.id as string;
    await env.waitRun(runId, (r) => r.status === 'running');
    expect((await call(env, 'POST', `/api/v1/runs/${runId}/cancel`, { headers: { cookie }, body: {} })).status).toBe(202);
    await env.waitTerminal(runId);
    const detail = await call(env, 'GET', `/api/v1/runs/${runId}`, { headers: { cookie } });
    const audit = detail.json.events.filter((e: { type: string }) => e.type === 'audit.user_action').map((e: { payload: unknown }) => e.payload);
    expect(audit).toEqual([
      { action: 'start', actor: 'olga', role: 'operator', via: 'password' },
      { action: 'cancel', actor: 'olga', role: 'operator', via: 'password' },
    ]);
    const cancelEvent = detail.json.events.find((e: { type: string }) => e.type === 'run.cancel_requested');
    expect(cancelEvent.payload.reason).toBe('cancelled via API by olga');
    const writes = env.logger.records.filter((r) => r.msg === 'api write');
    expect(writes.some((r) => r.fields.actor === 'olga' && r.fields.route === '/api/v1/workflows/:id/start' && r.fields.status === 202)).toBe(true);
    const logText = JSON.stringify(env.logger.records);
    for (const pw of Object.values(AUTH_PASSWORDS)) expect(logText).not.toContain(pw);
    expect(logText).not.toContain(env.app.auth.controlToken);
  });

  it('audit: a cleared block records the logged-in user, not the client-supplied name', async () => {
    const block = env.app.persistence.blocks.create({ workflowId: 'slow', itemKey: null, reason: 'test', failureCount: 1 });
    const cookie = await login(env, 'olga');
    const res = await call(env, 'POST', `/api/v1/blocks/${block.id}/clear`, { headers: { cookie }, body: { clearedBy: 'someone-else' } });
    expect(res.status).toBe(200);
    expect(res.json.block.clearedBy).toBe('olga');
  });

  it('writes a fresh control token file (0600) at start; it grants admin from loopback only', async () => {
    const file = controlTokenPath(env.dataDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = readFileSync(file, 'utf8').trim();
    expect(token).toBe(env.app.auth.controlToken);
    expect((await call(env, 'POST', '/api/v1/scheduler/pause', { headers: { [CONTROL_TOKEN_HEADER]: token } })).status).toBe(200);
    expect((await call(env, 'POST', '/api/v1/scheduler/resume', { headers: { [CONTROL_TOKEN_HEADER]: token } })).status).toBe(200);
    const remote = await call(env, 'GET', '/api/v1/status', { headers: { [CONTROL_TOKEN_HEADER]: token }, remoteAddress: '192.0.2.40' });
    expect(remote.status).toBe(401);
    expect(remote.json.error.code).toBe('control_token_not_local');
    expect((await call(env, 'GET', '/api/v1/status', { headers: { [CONTROL_TOKEN_HEADER]: 'x'.repeat(43) } })).status).toBe(401);
    // The same header on a public route does not break it.
    expect((await call(env, 'GET', '/health', { headers: { [CONTROL_TOKEN_HEADER]: 'wrong' }, remoteAddress: '192.0.2.40' })).status).toBe(200);
  });
});

describe('auth.read_requires_login: false', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({ configExtra: `${PASSWORD_AUTH_CONFIG}  read_requires_login: false\n`, app: FAST_AUTH }, authEnvSetup);
  });
  afterAll(async () => env?.cleanup());

  it('reading works anonymously, writing needs a login', async () => {
    expect((await call(env, 'GET', '/api/v1/status')).status).toBe(200);
    expect((await call(env, 'GET', '/api/v1/auth/me')).json).toMatchObject({ user: null, role: 'viewer', readRequiresLogin: false });
    expect((await call(env, 'POST', '/api/v1/scheduler/pause')).status).toBe(401);
    expect((await call(env, 'POST', '/api/v1/workflows/x/dry-run')).status).toBe(401);
    const sse = await connectSse(`${env.app.url}/api/v1/events`);
    await sse.waitFor((m) => m.event === 'stream.open');
    sse.close();
    const cookie = await login(env, 'olga');
    expect((await call(env, 'POST', '/api/v1/scheduler/pause', { headers: { cookie } })).status).toBe(200);
  });
});

describe('auth.mode: trusted_header', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({
      configExtra: [
        'auth:',
        '  mode: trusted_header',
        '  trusted_header:',
        '    trusted_proxies: [127.0.0.1, ::1, 100.64.0.0/10]',
        '    users:',
        '      - { login: alice@example.com, role: operator }',
        '      - { login: Victor@Example.com, role: viewer }',
        '',
      ].join('\n'),
    });
  });
  afterAll(async () => env?.cleanup());

  const as = (login: string | null, remoteAddress = '127.0.0.1'): InjectOptions => ({ headers: login === null ? {} : { 'tailscale-user-login': login }, remoteAddress });

  it('accepts the header from trusted proxies only', async () => {
    expect((await call(env, 'POST', '/api/v1/scheduler/pause', as('alice@example.com'))).status).toBe(200);
    expect((await call(env, 'POST', '/api/v1/scheduler/resume', as('alice@example.com', '100.100.7.7'))).status).toBe(200);
    const spoofed = await call(env, 'GET', '/api/v1/status', as('alice@example.com', '192.0.2.50'));
    expect(spoofed.status).toBe(401);
    expect(spoofed.json.error.code).toBe('untrusted_proxy');
  });

  it('missing header → 401, unknown login → 403, viewer cannot write; logins are case-insensitive', async () => {
    expect((await call(env, 'GET', '/api/v1/status', as(null))).status).toBe(401);
    const unknown = await call(env, 'GET', '/api/v1/status', as('mallory@example.com'));
    expect(unknown.status).toBe(403);
    expect(unknown.json.error.code).toBe('login_not_allowed');
    expect((await call(env, 'GET', '/api/v1/status', as('victor@example.com'))).status).toBe(200);
    expect((await call(env, 'POST', '/api/v1/scheduler/pause', as('VICTOR@example.com'))).status).toBe(403);
    expect((await call(env, 'GET', '/api/v1/auth/me', as('mallory@example.com'))).json).toMatchObject({ mode: 'trusted_header', user: null, error: { status: 403, code: 'login_not_allowed' } });
    expect((await call(env, 'POST', '/api/v1/auth/login', { body: { name: 'a', password: 'b' } })).json.error.code).toBe('login_not_available');
  });

  it('SSE only with the header from the proxy', async () => {
    const url = `${env.app.url}/api/v1/events`;
    await expect(connectSse(url)).rejects.toThrow(/401/);
    const sse = await connectSse(url, { 'tailscale-user-login': 'victor@example.com' });
    await sse.waitFor((m) => m.event === 'stream.open');
    sse.close();
  });
});

describe('auth.mode: none (default)', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv();
  });
  afterAll(async () => env?.cleanup());

  it('keeps the previous behaviour: no login, full /ready, me reports mode none', async () => {
    expect((await call(env, 'GET', '/api/v1/status')).status).toBe(200);
    expect((await call(env, 'POST', '/api/v1/scheduler/pause')).status).toBe(200);
    expect((await call(env, 'GET', '/ready')).json.checks).toBeDefined();
    expect((await call(env, 'GET', '/api/v1/auth/me')).json).toEqual({ mode: 'none', readRequiresLogin: false, user: null, role: 'admin', expiresAt: null, error: null });
    expect((await call(env, 'POST', '/api/v1/auth/login', { body: { name: 'a', password: 'b' } })).status).toBe(400);
    // No audit records without authentication.
    expect(env.logger.records.some((r) => r.msg === 'api write')).toBe(false);
  });
});
