/**
 * Hub HTTP server (WI-36): hub API with roles and audit, login, the
 * `/w/<id>/` pass-through (identity channel, header hygiene, path rules,
 * streaming), the 503 page and the live event stream. The workspace
 * instances are fakes that check the hub's secret like the real ones.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_HASHES, AUTH_PASSWORDS, fakeScrypt } from '../../api/testing/auth.js';
import { noopLogger } from '../../core/index.js';
import { NO_AUTH_CONFIG, type AuthConfig, type HubConfig } from '../../config/index.js';
import { HubError } from '../errors.js';
import { HUB_ROUTE_ROLES } from './roles.js';
import { createHubHttp, type HubHttp } from './server.js';
import { FakeHubSource, FakeInstance } from './testing/fakes.js';

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);

const PASSWORD_AUTH: AuthConfig = {
  ...NO_AUTH_CONFIG,
  mode: 'password',
  sessionTtlMs: 3_600_000,
  users: [
    { name: 'alice', passwordHashEnv: 'PW_ALICE', role: 'admin' },
    { name: 'olga', passwordHashEnv: 'PW_OLGA', role: 'operator' },
    { name: 'victor', passwordHashEnv: 'PW_VICTOR', role: 'viewer' },
  ],
};

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

function send(base: string, method: string, target: string, opts: { headers?: Record<string, string>; body?: unknown; rawBody?: string } = {}): Promise<Reply> {
  const url = new URL(base);
  const mutating = method !== 'GET' && method !== 'HEAD';
  const payload = opts.rawBody ?? (opts.body !== undefined || mutating ? JSON.stringify(opts.body ?? {}) : undefined);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: target, // verbatim: no normalisation, so traversal attempts reach the server unchanged
        headers: {
          ...(mutating ? { 'x-adispatch-request': '1', 'content-type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Open a streaming GET and collect what arrives. */
function stream(base: string, target: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; chunks: string[]; close(): void; ended: Promise<void> }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'GET', path: target, headers }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (c: string) => chunks.push(c));
      const ended = new Promise<void>((done) => {
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      });
      resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks, close: () => req.destroy(), ended });
    });
    req.on('error', reject);
    req.end();
  });
}

const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let dir: string;
let a: FakeInstance;
let b: FakeInstance;
let source: FakeHubSource;
const servers: HubHttp[] = [];

async function start(auth: AuthConfig = NO_AUTH_CONFIG, extra: { allowedHosts?: string[]; infoIntervalMs?: number; idleMs?: number } = {}): Promise<{ base: string; http: HubHttp }> {
  const config: HubConfig = {
    configDir: '/cfg',
    maxConcurrent: 4,
    server: { host: '127.0.0.1', port: 0, allowedHosts: extra.allowedHosts ?? [] },
    auth,
    workspaces: [],
  };
  const server = await createHubHttp({
    config,
    hub: source,
    dataDir: dir,
    version: 'test',
    logger: noopLogger,
    env: AUTH_HASHES,
    port: 0,
    uiDir: null,
    monitoring: false,
    ...(extra.idleMs ? { proxyIdleTimeoutMs: extra.idleMs } : {}),
    info: { intervalMs: extra.infoIntervalMs ?? 60_000 },
    auth: { scrypt: fakeScrypt, sleep: async () => undefined },
  });
  servers.push(server);
  const { url } = await server.listen();
  return { base: url, http: server };
}

async function login(base: string, name: keyof typeof AUTH_PASSWORDS, target = '/api/v1/auth/login'): Promise<string> {
  const res = await send(base, 'POST', target, { body: { name, password: AUTH_PASSWORDS[name] } });
  expect(res.status).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'orch-hubhttp-'));
  a = new FakeInstance('a', TOKEN_A);
  b = new FakeInstance('b', TOKEN_B);
  await Promise.all([a.listen(), b.listen()]);
  source = new FakeHubSource([a, b]);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all([a.close(), b.close()]);
  rmSync(dir, { recursive: true, force: true });
});

describe('hub API', () => {
  it('reports status and workspaces, including the activity read from the instances', async () => {
    const { base, http: server } = await start(NO_AUTH_CONFIG, { infoIntervalMs: 20 });
    await until(() => a.polls.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    const status = await send(base, 'GET', '/api/v1/hub/status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ version: 'test', state: 'running', paused: false, slots: { max: 4, active: 2, byWorkspace: { a: 2 } }, resources: null });
    expect(status.json.workspaces).toEqual({ total: 2, running: 2, failed: 0, stopped: 0, starting: 0, backoff: 0 });
    const list = await send(base, 'GET', '/api/v1/hub/workspaces');
    expect(list.json.workspaces.map((w: any) => w.id)).toEqual(['a', 'b']);
    const wa = list.json.workspaces[0];
    expect(wa).toMatchObject({ state: 'running', path: '/w/a/', slots: 2, connected: true, activity: { version: '1.2.3', activeRuns: 2, activeBlocks: 1, failedActions: 3, failedNotifications: 1, scheduler: { state: 'running' } } });
    // No local paths, no process IDs, no secrets in the API.
    const text = JSON.stringify([status.json, list.json]);
    expect(text).not.toContain('/cfg');
    expect(text).not.toContain('/data');
    expect(text).not.toContain(TOKEN_A);
    expect(wa).not.toHaveProperty('pid');
    expect(server.routes.length).toBeGreaterThan(10);
    const one = await send(base, 'GET', '/api/v1/hub/workspaces/b');
    expect(one.json.id).toBe('b');
    expect((await send(base, 'GET', '/api/v1/hub/workspaces/none')).status).toBe(404);
  });

  it('leaves out the activity of a workspace that does not run', async () => {
    const { base } = await start(NO_AUTH_CONFIG, { infoIntervalMs: 20 });
    source.set('a', { state: 'stopped', pid: null });
    const one = await send(base, 'GET', '/api/v1/hub/workspaces/a');
    expect(one.json).toMatchObject({ state: 'stopped', activity: null });
  });

  it('controls workspaces and the hub and records every action in the audit log', async () => {
    const { base } = await start();
    expect((await send(base, 'POST', '/api/v1/hub/workspaces/a/start')).json.workspace.id).toBe('a');
    for (const action of ['stop', 'restart', 'drain']) expect((await send(base, 'POST', `/api/v1/hub/workspaces/b/${action}`)).status).toBe(200);
    for (const action of ['pause', 'resume', 'stop-all', 'drain-all']) {
      const res = await send(base, 'POST', `/api/v1/hub/${action}`);
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.status.version).toBe('test');
    }
    expect(source.calls).toEqual(['a:start', 'b:stop', 'b:restart', 'b:drain', 'pause', 'resume', 'stop-all', 'drain-all']);
    const missing = await send(base, 'POST', '/api/v1/hub/workspaces/nope/stop');
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('unknown_workspace');
    source.failNext = new HubError('invalid_state', 'already running', 409);
    expect((await send(base, 'POST', '/api/v1/hub/workspaces/a/start')).status).toBe(409);
    const audit = await send(base, 'GET', '/api/v1/hub/audit?limit=100');
    expect(audit.status).toBe(200);
    const entries = audit.json.entries as any[];
    expect(audit.json.total).toBe(10);
    expect(entries.map((e) => `${e.action}:${e.workspace ?? '-'}:${e.result}${e.error ? `:${e.error}` : ''}`).reverse()).toEqual([
      'workspace.start:a:ok',
      'workspace.stop:b:ok',
      'workspace.restart:b:ok',
      'workspace.drain:b:ok',
      'hub.pause:-:ok',
      'hub.resume:-:ok',
      'hub.stop-all:-:ok',
      'hub.drain-all:-:ok',
      'workspace.stop:nope:failed:unknown_workspace',
      'workspace.start:a:failed:invalid_state',
    ]);
    // Without a login the log says so instead of inventing a user.
    expect(entries[0]).toMatchObject({ actor: null, role: null, via: 'none' });
  });

  it('validates request bodies and uses the CSRF rules of the instances', async () => {
    const { base } = await start();
    expect((await send(base, 'POST', '/api/v1/hub/pause', { body: { x: 1 } })).status).toBe(400);
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { 'x-adispatch-request': '0' } })).json.error.code).toBe('csrf_header_missing');
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { 'sec-fetch-site': 'cross-site' } })).json.error.code).toBe('cross_site_request');
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { origin: 'https://evil.example' } })).json.error.code).toBe('origin_not_allowed');
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { 'content-type': 'text/plain' }, rawBody: 'x' })).status).toBe(415);
    expect((await send(base, 'POST', '/api/v1/hub/pause', { rawBody: '{nope' })).json.error.code).toBe('invalid_json');
    expect(source.calls).toEqual([]);
    const same = new URL(base);
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { origin: `http://${same.host}` } })).status).toBe(200);
  });

  it('refuses a wrong Host header (DNS rebinding) unless allowed', async () => {
    const { base } = await start(NO_AUTH_CONFIG, { allowedHosts: ['hub.example.com'] });
    const bad = await send(base, 'GET', '/api/v1/hub/status', { headers: { host: 'evil.example' } });
    expect(bad.status).toBe(421);
    expect(bad.json.error.code).toBe('host_not_allowed');
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { host: 'hub.example.com' } })).status).toBe(200);
    expect((await send(base, 'GET', '/w/a/', { headers: { host: 'evil.example' } })).status).toBe(421);
    // behind a TLS proxy the origin names the public host
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { host: 'hub.example.com', origin: 'https://hub.example.com' } })).status).toBe(200);
  });

  it('every registered route has a role entry and the table lists only registered routes', async () => {
    const { http: server } = await start();
    const registered = new Set(server.routes.map((r) => r.replace(/^(HEAD|OPTIONS) /, 'GET ')));
    for (const route of registered) expect(HUB_ROUTE_ROLES, route).toHaveProperty([route]);
    // `GET /health`, hub routes, auth routes and the static fallbacks are registered without a UI dir as well.
    for (const key of Object.keys(HUB_ROUTE_ROLES)) {
      if (key === 'GET /*') continue; // registered by the static plugin only with a UI dir
      expect(registered.has(key), key).toBe(true);
    }
  });
});

describe('roles and login (password mode)', () => {
  it('requires a login for the API, lets viewers read, operators control and only admins read the audit log', async () => {
    const { base } = await start(PASSWORD_AUTH);
    expect((await send(base, 'GET', '/api/v1/hub/status')).status).toBe(401);
    expect((await send(base, 'POST', '/api/v1/hub/pause')).status).toBe(401);
    expect((await send(base, 'GET', '/health')).status).toBe(200);
    const victor = await login(base, 'victor');
    const olga = await login(base, 'olga');
    const alice = await login(base, 'alice');
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { cookie: victor } })).status).toBe(200);
    expect((await send(base, 'GET', '/api/v1/hub/workspaces', { headers: { cookie: victor } })).status).toBe(200);
    for (const target of ['/api/v1/hub/pause', '/api/v1/hub/stop-all', '/api/v1/hub/drain-all', '/api/v1/hub/workspaces/a/stop', '/api/v1/hub/workspaces/a/drain']) {
      const denied = await send(base, 'POST', target, { headers: { cookie: victor } });
      expect(denied.status, target).toBe(403);
      expect(denied.json.error).toMatchObject({ code: 'forbidden', details: { requiredRole: 'operator', role: 'viewer' } });
    }
    expect(source.calls).toEqual([]);
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { cookie: olga } })).status).toBe(200);
    expect((await send(base, 'POST', '/api/v1/hub/workspaces/a/restart', { headers: { cookie: olga } })).status).toBe(200);
    expect((await send(base, 'GET', '/api/v1/hub/audit', { headers: { cookie: olga } })).status).toBe(403);
    expect((await send(base, 'GET', '/api/v1/hub/audit', { headers: { cookie: victor } })).status).toBe(403);
    const audit = await send(base, 'GET', '/api/v1/hub/audit', { headers: { cookie: alice } });
    expect(audit.status).toBe(200);
    expect(audit.json.entries.map((e: any) => [e.actor, e.role, e.via, e.action, e.workspace, e.result])).toEqual([
      ['olga', 'operator', 'password', 'workspace.restart', 'a', 'ok'],
      ['olga', 'operator', 'password', 'hub.pause', null, 'ok'],
    ]);
  });

  it('answers /auth/me with the role, rejects bad credentials and ends the session on logout', async () => {
    const { base } = await start(PASSWORD_AUTH);
    expect((await send(base, 'GET', '/api/v1/auth/me')).json).toMatchObject({ mode: 'password', user: null, role: null });
    expect((await send(base, 'POST', '/api/v1/auth/login', { body: { name: 'alice', password: 'wrong' } })).status).toBe(401);
    const cookie = await login(base, 'olga');
    expect((await send(base, 'GET', '/api/v1/auth/me', { headers: { cookie } })).json).toMatchObject({ user: { name: 'olga', role: 'operator', via: 'password' }, role: 'operator' });
    await send(base, 'POST', '/api/v1/auth/logout', { headers: { cookie } });
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { cookie } })).status).toBe(401);
  });

  it('does not accept the instance control token or a spoofed identity header', async () => {
    const { base } = await start(PASSWORD_AUTH);
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { 'x-adispatch-control-token': 'x'.repeat(43) } })).status).toBe(401);
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { 'x-adispatch-hub-user': 'alice', 'x-adispatch-hub-role': 'admin', 'x-adispatch-hub-token': TOKEN_A } })).status).toBe(401);
  });
});

describe('trusted header mode', () => {
  it('takes the user from the proxy header only from a trusted proxy and applies the role', async () => {
    const auth: AuthConfig = { ...NO_AUTH_CONFIG, mode: 'trusted_header', trustedHeader: { header: 'x-user', trustedProxies: ['127.0.0.1'], proxySecretEnv: null, users: [{ login: 'vic@example.com', role: 'viewer' }, { login: 'ops@example.com', role: 'operator' }] } };
    const { base } = await start(auth);
    expect((await send(base, 'GET', '/api/v1/hub/status')).status).toBe(401);
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { 'x-user': 'vic@example.com' } })).status).toBe(200);
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { 'x-user': 'vic@example.com' } })).status).toBe(403);
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { 'x-user': 'stranger@example.com' } })).status).toBe(403);
    expect((await send(base, 'POST', '/api/v1/hub/pause', { headers: { 'x-user': 'ops@example.com' } })).status).toBe(200);
    const alice = await send(base, 'GET', '/api/v1/auth/me', { headers: { 'x-user': 'ops@example.com' } });
    expect(alice.json).toMatchObject({ mode: 'trusted_header', user: { name: 'ops@example.com', role: 'operator', via: 'trusted_header' } });
  });
});

describe('pass-through /w/<id>/', () => {
  it('serves the workspace and forwards the verified identity with the hub secret', async () => {
    const { base } = await start(PASSWORD_AUTH);
    // The UI shell is public (it must be able to show the login page) and carries no identity.
    const shell = await send(base, 'GET', '/w/a/', { headers: { accept: 'text/html' } });
    expect(shell.status).toBe(200);
    expect(shell.text).toBe('<html>instance a</html>');
    expect(shell.headers['set-cookie']).toBeUndefined();
    expect(a.identity(0)).toEqual({ token: TOKEN_A });
    expect(b.seen).toHaveLength(0);
    // The API needs a login.
    expect((await send(base, 'GET', '/w/a/api/v1/echo')).status).toBe(401);
    const cookie = await login(base, 'olga');
    const echo = await send(base, 'GET', '/w/a/api/v1/echo?x=1&y=%20z', { headers: { cookie } });
    expect(echo.status).toBe(200);
    expect(echo.json).toMatchObject({ method: 'GET', url: '/api/v1/echo?x=1&y=%20z', name: 'a' });
    expect(echo.headers['set-cookie']).toBeUndefined();
    const last = a.seen.length - 1;
    expect(a.identity(last)).toEqual({ token: TOKEN_A, role: 'operator', user: 'olga' });
    expect(a.seen[last]!.headers.host).toBe(`127.0.0.1:${a.port}`);
    expect(a.seen[last]!.headers.cookie).toBeUndefined();
  });

  it('never forwards what a client sends as identity, cookies, credentials or proxy headers', async () => {
    const { base } = await start(PASSWORD_AUTH);
    const cookie = await login(base, 'victor');
    const res0 = await send(base, 'GET', '/w/a/api/v1/echo', {
      headers: {
        cookie: `${cookie}; other=1`,
        authorization: 'Bearer secret',
        'x-adispatch-hub-user': 'alice',
        'x-adispatch-hub-role': 'admin',
        'x-adispatch-proxy-secret': 'p',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil.example',
        'tailscale-user-login': 'alice@example.com',
        'x-custom': 'x',
        referer: 'http://evil.example/',
      },
    });
    expect(res0.status).toBe(200);
    const seen = a.seen.at(-1)!;
    expect(a.identity(a.seen.length - 1)).toEqual({ token: TOKEN_A, role: 'viewer', user: 'victor' });
    for (const h of ['cookie', 'authorization', 'x-adispatch-proxy-secret', 'x-forwarded-for', 'x-forwarded-host', 'tailscale-user-login', 'x-custom', 'referer']) {
      expect(seen.headers[h], h).toBeUndefined();
    }
  });

  it('refuses requests that bring hub or control tokens of their own: nothing reaches the workspace', async () => {
    const { base } = await start(PASSWORD_AUTH);
    const cookie = await login(base, 'alice');
    for (const headers of [{ 'x-adispatch-hub-token': TOKEN_A, 'x-adispatch-hub-role': 'admin' }, { 'x-adispatch-control-token': 'c'.repeat(43) }] as Array<Record<string, string>>) {
      const res = await send(base, 'GET', '/w/a/api/v1/echo', { headers: { cookie, ...headers } });
      expect(res.status).toBe(401);
    }
    expect(a.seen).toHaveLength(0);
  });

  it('passes bodies through and applies the CSRF, origin and media type rules before the workspace sees anything', async () => {
    const { base } = await start();
    const ok = await send(base, 'POST', '/w/b/api/v1/echo', { body: { hello: 'world' } });
    expect(ok.json).toMatchObject({ method: 'POST', body: '{"hello":"world"}', name: 'b' });
    expect(b.identity(b.seen.length - 1)).toEqual({ token: TOKEN_B, role: 'admin' }); // hub without login: no user, role admin
    const before = b.seen.length;
    expect((await send(base, 'POST', '/w/b/api/v1/echo', { headers: { 'x-adispatch-request': '0' } })).json.error.code).toBe('csrf_header_missing');
    expect((await send(base, 'POST', '/w/b/api/v1/echo', { headers: { origin: 'https://evil.example' } })).json.error.code).toBe('origin_not_allowed');
    expect((await send(base, 'POST', '/w/b/api/v1/echo', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await send(base, 'POST', '/w/b/api/v1/echo', { headers: { 'content-type': 'text/plain' }, rawBody: 'x' })).status).toBe(415);
    expect((await send(base, 'OPTIONS', '/w/b/api/v1/echo')).status).toBe(405);
    expect((await send(base, 'TRACE', '/w/b/api/v1/echo')).status).toBeGreaterThanOrEqual(400);
    expect(b.seen.length).toBe(before);
  });

  it('refuses traversal, encoded separators, unknown workspaces and malformed targets; workspaces cannot reach each other', async () => {
    const { base } = await start();
    const bad = [
      '/w/a/../b/',
      '/w/a/./',
      '/w/a/%2e%2e/',
      '/w/a/%2E%2E/b',
      '/w/a/x/%2e%2e%2f%2e%2e/',
      '/w/a/..%2fb/',
      '/w/a/%2e%2e%5cb/',
      '/w/a/x%5cy',
      '/w/a/%252e%252e/',
      '/w/a/%00',
      '/w/a/%zz',
      '/w/a/api/v1/..%2f..%2fb',
      '/w/../',
      '/w/..',
      '/w/A/',
      '/w/a%2fb/',
      '/w//',
      '/w/a b/',
    ];
    for (const target of bad) {
      let res: Reply;
      try {
        res = await send(base, 'GET', target);
      } catch {
        continue; // the client refuses to send it at all
      }
      expect([400, 404], `${target} → ${res.status}`).toContain(res.status);
    }
    expect((await send(base, 'GET', '/w/nope/')).json.error.code).toBe('unknown_workspace');
    expect((await send(base, 'GET', '/w/')).status).toBe(404);
    expect((await send(base, 'GET', '/w')).status).toBe(404);
    expect(a.seen).toHaveLength(0);
    expect(b.seen).toHaveLength(0);
    // Legitimate paths are untouched, also those that merely contain dots or encoded characters.
    expect((await send(base, 'GET', '/w/a/api/v1/echo/foo..bar%20baz')).status).toBe(200);
    expect(a.seen.at(-1)!.url).toBe('/api/v1/echo/foo..bar%20baz');
  });

  it('redirects /w/<id> to /w/<id>/ with a relative Location and keeps redirects of the workspace below its prefix', async () => {
    const { base } = await start();
    const r = await send(base, 'GET', '/w/a?x=1');
    expect(r.status).toBe(308);
    expect(r.headers.location).toBe('a/?x=1');
    const inner = await send(base, 'GET', '/w/a/redir');
    expect(inner.status).toBe(302);
    expect(inner.headers.location).toBe('dir/');
    expect(new URL(inner.headers.location as string, `${base}/w/a/redir`).pathname).toBe('/w/a/dir/');
    const out = await send(base, 'GET', '/w/a/redir-out');
    expect(out.status).toBe(302);
    expect(out.headers.location).toBeUndefined();
  });

  it('streams large responses and SSE incrementally, and closes the upstream when the client goes away', async () => {
    const { base } = await start();
    const big = await send(base, 'GET', '/w/a/big');
    expect(big.text.length).toBe(300_000);
    const s = await stream(base, '/w/a/api/v1/events', { accept: 'text/event-stream' });
    expect(s.status).toBe(200);
    expect(String(s.headers['content-type'])).toContain('text/event-stream');
    await until(() => s.chunks.join('').includes('stream.open'));
    for (const res of a.sse) res.write('event: run.event\ndata: {"n":1}\n\n');
    await until(() => s.chunks.join('').includes('run.event'));
    for (const res of a.sse) res.write('event: run.event\ndata: {"n":2}\n\n');
    await until(() => s.chunks.join('').includes('"n":2'));
    s.close();
    await until(() => a.closedStreams === 1);
  });

  it('ends a proxied stream when the session ends (logout)', async () => {
    const { base } = await start(PASSWORD_AUTH);
    const cookie = await login(base, 'victor');
    const s = await stream(base, '/w/a/api/v1/events', { cookie });
    expect(s.status).toBe(200);
    await until(() => s.chunks.join('').includes('stream.open'));
    await send(base, 'POST', '/api/v1/auth/logout', { headers: { cookie } });
    await s.ended;
    await until(() => a.closedStreams === 1);
    expect((await stream(base, '/w/a/api/v1/events', { cookie })).status).toBe(401);
  });

  it('answers the workspace login endpoints itself (one login for all workspaces)', async () => {
    const { base } = await start(PASSWORD_AUTH);
    const me = await send(base, 'GET', '/w/a/api/v1/auth/me');
    expect(me.json).toMatchObject({ mode: 'password', user: null, role: null });
    const cookie = await login(base, 'alice', '/w/b/api/v1/auth/login');
    // The same session works for every workspace and for the hub API.
    expect((await send(base, 'GET', '/w/a/api/v1/auth/me', { headers: { cookie } })).json.user).toMatchObject({ name: 'alice', role: 'admin' });
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { cookie } })).status).toBe(200);
    expect(a.seen.filter((r) => r.url.includes('/auth/'))).toHaveLength(0);
    expect(b.seen.filter((r) => r.url.includes('/auth/'))).toHaveLength(0);
    await send(base, 'POST', '/w/a/api/v1/auth/logout', { headers: { cookie } });
    expect((await send(base, 'GET', '/api/v1/hub/status', { headers: { cookie } })).status).toBe(401);
  });

  it.each([
    ['stopped', { state: 'stopped' as const, pid: null }],
    ['starting', { state: 'starting' as const }],
    ['failed', { state: 'failed' as const, message: 'configuration error <b>x</b>' }],
    ['backoff', { state: 'backoff' as const }],
  ])('shows a clear 503 for a workspace that is %s', async (_name, patch) => {
    const { base } = await start();
    source.set('a', patch);
    const html = await send(base, 'GET', '/w/a/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(html.status).toBe(503);
    expect(html.headers['retry-after']).toBe('5');
    expect(String(html.headers['content-type'])).toContain('text/html');
    expect(html.text).toContain('Workspace unavailable');
    expect(html.text).toContain('href="../../"');
    expect(html.text).not.toContain('<b>x</b>'); // escaped
    expect(String(html.headers['content-security-policy'])).toContain("default-src 'none'");
    const json = await send(base, 'GET', '/w/a/api/v1/status', { headers: { accept: 'application/json' } });
    expect(json.status).toBe(503);
    expect(json.json.error).toMatchObject({ code: 'workspace_unavailable', details: { workspace: 'a' } });
    // The other workspace is unaffected.
    expect((await send(base, 'GET', '/w/b/')).status).toBe(200);
    expect(a.seen.filter((r) => r.url === '/').length).toBe(0);
  });

  it('answers 503 when a workspace that should run refuses the connection and 504 when it stays silent', async () => {
    const { base } = await start();
    await b.close();
    const refused = await send(base, 'GET', '/w/b/api/v1/echo');
    expect(refused.status).toBe(503);
    expect(refused.json.error.code).toBe('workspace_unavailable');
  });
});

describe('pass-through limits', () => {
  it('answers 504 when a workspace stays silent and 413 for oversized bodies', async () => {
    const { base } = await start(NO_AUTH_CONFIG, { idleMs: 150 });
    const slow = await send(base, 'GET', '/w/a/slow');
    expect(slow.status).toBe(504);
    expect(slow.json.error.code).toBe('workspace_timeout');
    const big = await send(base, 'POST', '/w/a/api/v1/echo', { rawBody: JSON.stringify({ x: 'y'.repeat(2.5 * 1024 * 1024) }) }).catch(() => null);
    // Either the hub answers 413 or it cuts the upload off; the workspace never receives the whole body.
    if (big) expect(big.status).toBe(413);
    expect(a.seen.every((r) => r.body.length < 2.5 * 1024 * 1024)).toBe(true);
  });
});

describe('live events', () => {
  it('sends a snapshot first and then only what changed', async () => {
    const { base } = await start();
    const s = await stream(base, '/api/v1/hub/events', { accept: 'text/event-stream' });
    expect(s.status).toBe(200);
    await until(() => s.chunks.join('').includes('event: hub.snapshot'));
    const text = () => s.chunks.join('');
    expect(text()).toContain('event: stream.open');
    const snapshot = JSON.parse(/event: hub\.snapshot\ndata: (.*)\n/.exec(text())![1]!);
    expect(snapshot.payload.workspaces.map((w: any) => w.id)).toEqual(['a', 'b']);
    expect(snapshot.payload.status.slots).toMatchObject({ max: 4, active: 2 });
    source.set('a', { state: 'backoff', message: 'crashed' });
    await until(() => text().includes('event: hub.workspace'));
    const ev = JSON.parse(/event: hub\.workspace\ndata: (.*)\n/.exec(text())![1]!);
    expect(ev.payload).toMatchObject({ id: 'a', state: 'backoff', message: 'crashed' });
    source.paused = true;
    source.set('b', {});
    const statusEvents = (): any[] => [...text().matchAll(/event: hub\.status\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!).payload);
    await until(() => statusEvents().some((e) => e.paused === true));
    expect(statusEvents().at(-1)).toMatchObject({ paused: true, state: 'paused' });
    s.close();
  });

  it('needs a login (viewer) and an operator cannot be told apart from a viewer here', async () => {
    const { base } = await start(PASSWORD_AUTH);
    expect((await stream(base, '/api/v1/hub/events')).status).toBe(401);
    const cookie = await login(base, 'victor');
    const s = await stream(base, '/api/v1/hub/events', { cookie });
    expect(s.status).toBe(200);
    s.close();
  });
});
