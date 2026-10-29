/**
 * Identity forwarded by a hub (WI-36): an instance started by a hub believes
 * `X-Adispatch-Hub-*` only with the hub's secret and only from loopback; it
 * refuses everything else (also with `auth.mode: none`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService, CONTROL_TOKEN_HEADER, HUB_ROLE_HEADER, HUB_TOKEN_HEADER, HUB_USER_HEADER, isInteractive } from './auth.js';
import { startAppEnv, type AppEnv } from './testing/helpers.js';
import { NO_AUTH_CONFIG } from '../config/index.js';

const TOKEN = 'A'.repeat(43);
const LOOPBACK = '127.0.0.1';

function service(extra: Partial<ConstructorParameters<typeof AuthService>[0]> = {}): AuthService {
  return new AuthService({ config: () => NO_AUTH_CONFIG, controlToken: 'C'.repeat(43), ...extra });
}

describe('AuthService with a hub token', () => {
  it('is not enabled by mode none alone, but is when hub-managed (reads then need the hub)', () => {
    expect(service().enabled).toBe(false);
    const managed = service({ hubToken: TOKEN });
    expect(managed.enabled).toBe(true);
    expect(managed.hubManaged).toBe(true);
    expect(managed.readRequiresLogin).toBe(true);
  });

  it('accepts a named user with the secret from loopback', () => {
    const a = service({ hubToken: TOKEN });
    const r = a.resolve({ headers: { [HUB_TOKEN_HEADER]: TOKEN, [HUB_USER_HEADER]: 'alice', [HUB_ROLE_HEADER]: 'operator' }, remoteAddress: LOOPBACK });
    expect(r).toEqual({ ok: true, principal: { name: 'alice', role: 'operator', via: 'hub' } });
    expect(isInteractive(r.ok ? r.principal : null)).toBe(true);
  });

  it('a hub request without user is "open": role from the hub, never a person', () => {
    const a = service({ hubToken: TOKEN });
    const r = a.resolve({ headers: { [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: 'viewer' }, remoteAddress: '::1' });
    expect(r).toEqual({ ok: true, principal: { name: 'hub', role: 'viewer', via: 'hub_open' } });
    expect(isInteractive(r.ok ? r.principal : null)).toBe(false);
  });

  it.each([
    ['wrong secret', { [HUB_TOKEN_HEADER]: 'B'.repeat(43), [HUB_ROLE_HEADER]: 'admin' }, LOOPBACK, 'invalid_hub_token'],
    ['not from loopback', { [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: 'admin' }, '10.1.2.3', 'invalid_hub_token'],
    ['no role', { [HUB_TOKEN_HEADER]: TOKEN }, LOOPBACK, 'invalid_hub_identity'],
    ['unknown role', { [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: 'root' }, LOOPBACK, 'invalid_hub_identity'],
    ['malformed user', { [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: 'admin', [HUB_USER_HEADER]: 'a b' }, LOOPBACK, 'invalid_hub_identity'],
    ['empty user', { [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: 'admin', [HUB_USER_HEADER]: '' }, LOOPBACK, 'invalid_hub_identity'],
    ['duplicate secret header', { [HUB_TOKEN_HEADER]: [TOKEN, TOKEN], [HUB_ROLE_HEADER]: 'admin' }, LOOPBACK, 'invalid_hub_token'],
  ])('rejects %s', (_name, headers, remoteAddress, code) => {
    const r = service({ hubToken: TOKEN }).resolve({ headers: headers as Record<string, string>, remoteAddress });
    expect(r).toMatchObject({ ok: false, status: 401, code });
  });

  it('an instance without a hub never believes the headers', () => {
    // mode none without a hub: authentication is off, the headers are not consulted at all
    const r = service().resolve({ headers: { [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: 'admin' }, remoteAddress: LOOPBACK });
    expect(r).toEqual({ ok: true, principal: null });
    const withPassword = service({ config: () => ({ ...NO_AUTH_CONFIG, mode: 'password' }) });
    expect(withPassword.resolve({ headers: { [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: 'admin' }, remoteAddress: LOOPBACK }).ok).toBe(false);
  });

  it('keeps the control token for the CLI and gives no principal without credentials', () => {
    const a = service({ hubToken: TOKEN });
    expect(a.resolve({ headers: { [CONTROL_TOKEN_HEADER]: 'C'.repeat(43) }, remoteAddress: LOOPBACK })).toMatchObject({ ok: true, principal: { via: 'control_token' } });
    expect(a.resolve({ headers: {}, remoteAddress: LOOPBACK })).toEqual({ ok: true, principal: null });
  });
});

describe('API of a hub-managed instance', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({ app: { auth: { hubToken: TOKEN } } });
  });
  afterAll(async () => env?.cleanup());

  const hubHeaders = (role: string, user?: string): Record<string, string> => ({ [HUB_TOKEN_HEADER]: TOKEN, [HUB_ROLE_HEADER]: role, ...(user ? { [HUB_USER_HEADER]: user } : {}) });

  it('refuses direct access without the hub (mode none)', async () => {
    expect((await env.request('GET', '/api/v1/status')).status).toBe(401);
    expect((await env.request('GET', '/api/v1/runs')).status).toBe(401);
    const me = await env.request('GET', '/api/v1/auth/me');
    expect(me.json).toMatchObject({ mode: 'trusted_header', user: null, role: null, error: { code: 'hub_required' } });
  });

  it('serves the hub with the role it forwards', async () => {
    const status = await env.request('GET', '/api/v1/status', undefined, hubHeaders('viewer', 'vic'));
    expect(status.status).toBe(200);
    const denied = await env.request('POST', '/api/v1/scheduler/pause', {}, hubHeaders('viewer', 'vic'));
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');
    const ok = await env.request('POST', '/api/v1/scheduler/pause', {}, hubHeaders('operator', 'olga'));
    expect(ok.status).toBe(200);
    await env.request('POST', '/api/v1/scheduler/resume', {}, hubHeaders('operator', 'olga'));
  });

  it('answers /auth/me with the forwarded user', async () => {
    const me = await env.request('GET', '/api/v1/auth/me', undefined, hubHeaders('operator', 'olga'));
    expect(me.json).toMatchObject({ user: { name: 'olga', role: 'operator', via: 'hub' }, role: 'operator', error: null });
    const open = await env.request('GET', '/api/v1/auth/me', undefined, hubHeaders('admin'));
    expect(open.json).toMatchObject({ user: null, role: 'admin' });
  });

  it('rejects a wrong secret even on public routes of the API and does not accept the control token elsewhere', async () => {
    const wrong = await env.request('GET', '/api/v1/status', undefined, { ...hubHeaders('admin', 'mallory'), [HUB_TOKEN_HEADER]: 'B'.repeat(43) });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('invalid_hub_token');
    const tok = await env.request('GET', '/api/v1/runs', undefined, { [CONTROL_TOKEN_HEADER]: env.app.auth.controlToken });
    expect(tok.status).toBe(403);
    const cli = await env.request('GET', '/api/v1/status', undefined, { [CONTROL_TOKEN_HEADER]: env.app.auth.controlToken });
    expect(cli.status).toBe(200);
  });
});
