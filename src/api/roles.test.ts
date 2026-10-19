/**
 * Minimum role per endpoint (WI-26): the table in roles.ts must cover exactly
 * the registered routes, docs/api.md must document it, and the API must
 * enforce it (401 without login, 403 below the minimum role). A new route
 * without an entry fails at registration.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from './server.js';
import { ROUTE_ROLES, roleAllows } from './roles.js';
import { authEnvSetup, AUTH_PASSWORDS, FAST_AUTH, PASSWORD_AUTH_CONFIG } from './testing/auth.js';
import { createAppEnv, startAppEnv, type AppEnv } from './testing/helpers.js';

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/api.md');

let env: AppEnv;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  env = await startAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: FAST_AUTH }, authEnvSetup);
  for (const [name, password] of Object.entries(AUTH_PASSWORDS)) {
    const res = await env.request('POST', '/api/v1/auth/login', { name, password });
    expect(res.status, name).toBe(200);
    cookies[name] = String(res.headers['set-cookie']).split(';')[0]!;
  }
});

afterAll(async () => {
  await env?.cleanup();
});

/** Concrete URL for a route pattern. */
function sample(url: string): string {
  return url
    .replace(/\/(blocks|actions|notifications)\/:id/, '/$1/1')
    .replace(/:id/g, 'x')
    .replace(/\*$/, 'file.txt');
}

const entries = Object.entries(ROUTE_ROLES).map(([key, role]) => {
  const [method, url] = key.split(' ') as [string, string];
  return { key, method, url, role };
});

describe('route roles table', () => {
  it('covers exactly the registered routes (HEAD = GET)', async () => {
    const withUi = await createAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: FAST_AUTH });
    authEnvSetup(withUi);
    // Minimal static UI dir so the UI routes (`/`, `/*`) are registered too.
    const ui = path.join(withUi.root, 'ui');
    mkdirSync(path.join(ui, 'js', 'client'), { recursive: true });
    writeFileSync(path.join(ui, 'index.html'), '<!doctype html>');
    try {
      const app = await withUi.createApp({ uiDir: ui });
      await app.http.ready();
      const registered = new Set(app.http.adispatchRoutes.map((r) => r.replace(/^HEAD /, 'GET ')));
      expect([...registered].sort()).toEqual(Object.keys(ROUTE_ROLES).sort());
    } finally {
      await withUi.cleanup();
    }
  });

  it('refuses to register a route without a minimum role', async () => {
    const fresh = await createAppEnv({ start: false });
    try {
      const app = await fresh.createApp();
      expect(() => app.http.get('/api/v1/unlisted', async () => ({}))).toThrow(/no minimum role.*ROUTE_ROLES/);
      expect(() => app.http.post('/api/v1/status', async () => ({}))).toThrow(/POST \/api\/v1\/status has no minimum role/);
    } finally {
      await fresh.cleanup();
    }
  });

  it('is documented in docs/api.md (one row per route with its role)', () => {
    const doc = readFileSync(DOC, 'utf8');
    for (const { key, role } of entries) expect(doc, key).toContain(`| \`${key}\` | ${role} |`);
    const rows = [...doc.matchAll(/^\| `((?:GET|POST|PATCH|PUT|DELETE) [^`]+)` \| (public|viewer|operator|admin) \|/gm)].map((m) => m[1]);
    expect(rows.sort()).toEqual(Object.keys(ROUTE_ROLES).sort());
  });

  it('every write route needs at least operator, except dry-run/validate/auth (no state change)', () => {
    const readOnlyPosts = new Set(['POST /api/v1/workflows/:id/dry-run', 'POST /api/v1/config/validate', 'POST /api/v1/auth/login', 'POST /api/v1/auth/logout']);
    for (const { key, method, role } of entries) {
      if (method === 'GET') expect(['public', 'viewer'], key).toContain(role);
      else if (!readOnlyPosts.has(key)) expect(roleAllows('viewer', role), key).toBe(false);
    }
  });
});

describe('enforcement per endpoint (password mode)', () => {
  const inject = (method: string, url: string, headers: Record<string, string> = {}) =>
    env.app.http.inject({
      method: method as 'GET',
      url,
      headers: { ...(method === 'GET' ? {} : { [CSRF_HEADER]: '1', 'content-type': 'application/json' }), ...headers },
      ...(method === 'GET' ? {} : { payload: '{}' }),
    });

  for (const { key, method, url, role } of entries) {
    if (role === 'public') continue;
    it(`${key}: 401 without login`, async () => {
      const res = await inject(method, sample(url));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('authentication_required');
    });
    if (!roleAllows('viewer', role)) {
      it(`${key}: 403 for a viewer (requires ${role})`, async () => {
        const res = await inject(method, sample(url), { cookie: cookies.victor! });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toMatchObject({ code: 'forbidden', details: { requiredRole: role, role: 'viewer' } });
      });
    } else if (url !== '/api/v1/events') {
      it(`${key}: allowed for a viewer`, async () => {
        const res = await inject(method, sample(url), { cookie: cookies.victor! });
        expect([401, 403]).not.toContain(res.statusCode);
      });
    }
  }

  it('public routes work without login; /ready hides its checks', async () => {
    expect((await inject('GET', '/health')).statusCode).toBe(200);
    const ready = await inject('GET', '/ready');
    expect(ready.json()).toEqual({ ready: true });
    const readyAuthed = await inject('GET', '/ready', { cookie: cookies.victor! });
    expect(readyAuthed.json().checks).toBeDefined();
    expect((await inject('GET', '/api/v1/auth/me')).json()).toMatchObject({ mode: 'password', user: null, role: null });
  });

  it('operator and admin may write (safe sample: pause/resume)', async () => {
    for (const name of ['olga', 'alice']) {
      expect((await inject('POST', '/api/v1/scheduler/pause', { cookie: cookies[name]! })).statusCode, name).toBe(200);
      expect((await inject('POST', '/api/v1/scheduler/resume', { cookie: cookies[name]! })).statusCode, name).toBe(200);
    }
  });

  it('unknown API routes need a login (no route probing), unknown UI paths do not', async () => {
    expect((await inject('GET', '/api/v1/nope')).statusCode).toBe(401);
    expect((await inject('GET', '/api/v1/nope', { cookie: cookies.victor! })).statusCode).toBe(404);
    expect((await inject('GET', '/nope.js')).statusCode).toBe(404);
  });
});
