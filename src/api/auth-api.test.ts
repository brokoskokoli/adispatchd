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

/** Manual workflow (workflow-scoped blocks) whose on_retry_unblock records {block.cleared_by} (WI-30). */
function unblockWorkflow(e: AppEnv, id: string): void {
  manualWorkflow(e, id);
  const record = e.script(`${id}-unblock.sh`, `printf '%s' "$1" > "${path.join(e.marks, `${id}-cleared-by`)}"`);
  const file = path.join(e.configDir, 'workflows', `${id}.yaml`);
  writeFileSync(file, `${readFileSync(file, 'utf8')}on_retry_unblock:\n  - type: shell\n    command: ${record}\n    args: ['{block.cleared_by}']\n`);
}

describe('auth.mode: password', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: FAST_AUTH }, (e) => {
      authEnvSetup(e);
      manualWorkflow(e, 'slow');
      unblockWorkflow(e, 'gated');
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

  it('WI-30: on_retry_unblock sees the logged-in user as {block.cleared_by}; an active run → 409', async () => {
    const cookie = await login(env, 'olga');
    const block = env.app.persistence.blocks.create({ workflowId: 'gated', itemKey: null, reason: 'test', failureCount: 3 });
    // A run of the block scope is active: removal with on_retry_unblock is refused, nothing changes.
    const start = await call(env, 'POST', '/api/v1/workflows/gated/start', { headers: { cookie } });
    expect(start.status).toBe(202);
    const refused = await call(env, 'POST', `/api/v1/blocks/${block.id}/clear`, { headers: { cookie } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('block_run_active');
    expect(env.app.persistence.blocks.get(block.id)?.clearedAt).toBeNull();
    writeFileSync(path.join(env.marks, 'release-gated'), '');
    await env.waitTerminal(start.json.run.id);

    const res = await call(env, 'POST', `/api/v1/blocks/${block.id}/clear`, { headers: { cookie }, body: { clearedBy: 'someone-else' } });
    expect(res.status).toBe(200);
    expect(res.json.block).toMatchObject({ clearedBy: 'olga', clearedRunId: res.json.runId });
    const run = await env.waitTerminal(res.json.runId);
    expect(run).toMatchObject({ triggerType: 'unblock', status: 'completed', businessResult: 'success' });
    expect(readFileSync(path.join(env.marks, 'gated-cleared-by'), 'utf8')).toBe('olga');
  });

  it('writes a fresh control token file (0600, port, pid) at start; it works from loopback on CLI routes only', async () => {
    const file = controlTokenPath(env.dataDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const content = JSON.parse(readFileSync(file, 'utf8')) as { token: string; port: number; pid: number };
    expect(content).toEqual({ token: env.app.auth.controlToken, port: Number(new URL(env.app.url!).port), pid: process.pid });
    const token = content.token;
    // Not an operator/admin everywhere: routes outside the CLI commands refuse it (review M1).
    const blocked = await call(env, 'POST', '/api/v1/workflows/slow/start', { headers: { [CONTROL_TOKEN_HEADER]: token } });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('control_token_not_allowed');
    expect((await call(env, 'GET', '/api/v1/runs', { headers: { [CONTROL_TOKEN_HEADER]: token } })).status).toBe(403);
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

  it('warns about local forging as soon as one trusted proxy entry is loopback (WI-27 review)', () => {
    // 127.0.0.1 is trusted next to 100.64.0.0/10: local processes can still connect through loopback.
    expect(env.logger.records.some((r) => r.msg.includes('trusted_header without proxy_secret_env and a trusted loopback proxy'))).toBe(true);
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

  it('a reload that removes a login closes its open SSE stream (review minor 4)', async () => {
    const url = `${env.app.url}/api/v1/events`;
    const alice = await connectSse(url, { 'tailscale-user-login': 'alice@example.com' });
    const victor = await connectSse(url, { 'tailscale-user-login': 'victor@example.com' });
    await victor.waitFor((m) => m.event === 'stream.open');
    const file = path.join(env.configDir, 'config.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace("      - { login: Victor@Example.com, role: viewer }\n", ''));
    const res = await env.app.reloadConfig();
    expect(res.ok).toBe(true);
    await victor.closed;
    expect((await call(env, 'GET', '/api/v1/status', as('victor@example.com'))).status).toBe(403);
    // Alice keeps her stream.
    await alice.waitFor((m) => m.event === 'config.reloaded');
    alice.close();
  });
});

describe('auth.mode: trusted_header behind Tailscale Serve (loopback only)', () => {
  it('warns that any local process can forge the identity; with proxy_secret_env the header needs the secret', async () => {
    const base = ['auth:', '  mode: trusted_header', '  trusted_header:', '    users: [{ login: alice@example.com, role: operator }]'];
    const forgeable = await startAppEnv({ configExtra: `${base.join('\n')}\n` });
    try {
      expect(forgeable.logger.records.some((r) => r.level === 'warn' && r.msg.includes('trusted_header without proxy_secret_env and a trusted loopback proxy'))).toBe(true);
    } finally {
      await forgeable.cleanup();
    }
    const secured = await startAppEnv({ configExtra: `${base.join('\n')}\n    proxy_secret_env: TEST_PROXY_SECRET\n` }, (e) => {
      e.env.TEST_PROXY_SECRET = 'proxy-secret-value';
    });
    try {
      expect(secured.logger.records.some((r) => r.msg.includes('trusted_header without proxy_secret_env'))).toBe(false);
      const id = { 'tailscale-user-login': 'alice@example.com' };
      const forged = await call(secured, 'GET', '/api/v1/status', { headers: id });
      expect(forged.status).toBe(401);
      expect(forged.json.error.code).toBe('invalid_proxy_secret');
      expect((await call(secured, 'GET', '/api/v1/status', { headers: { ...id, 'x-adispatch-proxy-secret': 'proxy-secret-value' } })).status).toBe(200);
      expect(JSON.stringify(secured.logger.records)).not.toContain('proxy-secret-value');
    } finally {
      await secured.cleanup();
    }
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
