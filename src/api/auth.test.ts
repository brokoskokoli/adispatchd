import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MemoryLogger, type Clock } from '../core/index.js';
import type { AuthConfig } from '../config/index.js';
import {
  AuthService,
  CONTROL_TOKEN_HEADER,
  LOGIN_LIMITS,
  controlTokenPath,
  ipMatcher,
  isLoopbackAddress,
  readControlToken,
  readCookie,
  removeControlToken,
  writeControlToken,
  type AuthRequest,
} from './auth.js';
import { hashPassword, parsePasswordHash, verifyPassword, type ScryptFn } from './password.js';

/** Fast deterministic stand-in for scrypt (the real one is tested separately). */
const fakeScrypt: ScryptFn = async (password, salt, keyLength) =>
  createHash('sha512').update(salt).update(password).digest().subarray(0, keyLength);

const baseConfig = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  mode: 'password',
  users: [
    { name: 'alice', passwordHashEnv: 'PW_ALICE', role: 'admin' },
    { name: 'victor', passwordHashEnv: 'PW_VICTOR', role: 'viewer' },
    { name: 'nohash', passwordHashEnv: 'PW_MISSING', role: 'operator' },
  ],
  trustedHeader: {
    header: 'tailscale-user-login',
    trustedProxies: ['127.0.0.1', '::1'],
    users: [{ login: 'alice@example.com', role: 'operator' }],
  },
  trustedProxies: ['127.0.0.1', '::1'],
  sessionTtlMs: 60 * 60_000,
  readRequiresLogin: true,
  ...over,
});

const env = {
  PW_ALICE: await hashPassword('correct horse', fakeScrypt),
  PW_VICTOR: await hashPassword('viewer pass', fakeScrypt),
};

class FakeClock implements Clock {
  t = Date.parse('2026-10-19T10:00:00Z');
  now(): Date {
    return new Date(this.t);
  }
}

const local = (headers: Record<string, string> = {}, remoteAddress = '127.0.0.1'): AuthRequest => ({ headers, remoteAddress });

function service(over: Partial<AuthConfig> = {}, opts: { scrypt?: ScryptFn; clock?: FakeClock } = {}) {
  let cfg = baseConfig(over);
  const clock = opts.clock ?? new FakeClock();
  const sleep = vi.fn(async () => undefined);
  const logger = new MemoryLogger();
  const auth = new AuthService({ config: () => cfg, env, clock, sleep, logger, scrypt: opts.scrypt ?? fakeScrypt });
  return { auth, clock, sleep, logger, setConfig: (c: Partial<AuthConfig>) => (cfg = baseConfig(c)) };
}

const cookieOf = (setCookie: string): Record<string, string> => ({ cookie: setCookie.split(';')[0]! });

describe('password hashes (scrypt)', () => {
  it('hashes with node:crypto scrypt and verifies (real scrypt, default parameters)', async () => {
    const hash = await hashPassword('s3cret-password');
    expect(hash).toMatch(/^scrypt:32768:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain('$');
    const parsed = parsePasswordHash(hash)!;
    expect(await verifyPassword('s3cret-password', parsed)).toBe(true);
    expect(await verifyPassword('s3cret-passworD', parsed)).toBe(false);
    expect(await hashPassword('s3cret-password')).not.toBe(hash); // random salt
  });

  it('rejects malformed hashes and parameters outside the bounds', () => {
    const salt = Buffer.alloc(16, 1).toString('base64url');
    const key = Buffer.alloc(32, 2).toString('base64url');
    expect(parsePasswordHash(undefined)).toBeNull();
    expect(parsePasswordHash('')).toBeNull();
    expect(parsePasswordHash('plaintext')).toBeNull();
    expect(parsePasswordHash(`bcrypt:32768:8:1:${salt}:${key}`)).toBeNull();
    expect(parsePasswordHash(`scrypt:1000:8:1:${salt}:${key}`)).toBeNull(); // not a power of two
    expect(parsePasswordHash(`scrypt:1024:8:1:${salt}:${key}`)).toBeNull(); // too weak
    expect(parsePasswordHash(`scrypt:1048576:8:1:${salt}:${key}`)).toBeNull(); // 1 GiB memory
    expect(parsePasswordHash(`scrypt:32768:8:99:${salt}:${key}`)).toBeNull();
    expect(parsePasswordHash(`scrypt:32768:8:1:short:${key}`)).toBeNull();
    expect(parsePasswordHash(`scrypt:32768:8:1:${salt}:${key}`)).not.toBeNull();
  });
});

describe('AuthService – password login', () => {
  it('logs in, sets a session cookie with HttpOnly, SameSite=Strict, Path=/ and no Secure over plain HTTP', async () => {
    const { auth } = service();
    const res = await auth.login('alice', 'correct horse', local());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cookie).toMatch(/^adispatch_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Strict$/);
    expect(res.principal).toMatchObject({ name: 'alice', role: 'admin', via: 'password' });
    const me = auth.resolve(local(cookieOf(res.cookie)));
    expect(me).toMatchObject({ ok: true, principal: { name: 'alice', role: 'admin' } });
  });

  it('sets Secure when X-Forwarded-Proto: https comes from a trusted proxy (TCP peer), not from anyone else', async () => {
    const { auth } = service({ trustedProxies: ['10.0.0.0/8'] });
    const viaProxy = await auth.login('alice', 'correct horse', local({ 'x-forwarded-proto': 'https' }, '10.1.2.3'));
    expect(viaProxy.ok && viaProxy.cookie).toMatch(/; Secure$/);
    const spoofed = await auth.login('alice', 'correct horse', local({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.1.2.3' }, '192.168.1.9'));
    expect(spoofed.ok && spoofed.cookie).not.toMatch(/Secure/);
    expect(auth.isHttps({ headers: {}, remoteAddress: '192.168.1.9', encrypted: true })).toBe(true);
  });

  it('does not distinguish unknown users from wrong passwords and runs scrypt exactly once in both cases', async () => {
    const scrypt = vi.fn(fakeScrypt);
    const { auth, sleep } = service({}, { scrypt });
    const wrong = await auth.login('alice', 'wrong', local());
    expect(scrypt).toHaveBeenCalledTimes(1);
    const unknown = await auth.login('mallory', 'wrong', local());
    expect(scrypt).toHaveBeenCalledTimes(2);
    const noHash = await auth.login('nohash', 'anything', local());
    expect(scrypt).toHaveBeenCalledTimes(3);
    for (const r of [wrong, unknown, noHash]) {
      expect(r).toEqual({ ok: false, status: 401, code: 'invalid_credentials', message: 'Invalid user name or password' });
    }
    // The unknown user is checked against a dummy hash with the same parameters as the configured ones.
    expect(scrypt.mock.calls[1]![3]).toEqual(scrypt.mock.calls[0]![3]);
    expect(scrypt.mock.calls[1]![2]).toBe(scrypt.mock.calls[0]![2]);
    // Fixed delay after every failure.
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(LOGIN_LIMITS.failureDelayMs);
  });

  it('never logs the password or an unknown user name', async () => {
    const { auth, logger } = service();
    await auth.login('alice', 'wrong-secret-1', local());
    await auth.login('correct horse', 'wrong-secret-2', local());
    await auth.login('alice', 'correct horse', local());
    const text = JSON.stringify(logger.records);
    expect(text).not.toContain('wrong-secret');
    expect(text).not.toContain('correct horse');
    expect(text).toContain('(unknown)');
  });

  it('rate-limits per user name (also with the correct password) and resets after the window', async () => {
    const { auth, clock } = service();
    for (let i = 0; i < LOGIN_LIMITS.perUser; i++) {
      expect(await auth.login('alice', `bad${i}`, local({}, `10.0.0.${i}`))).toMatchObject({ status: 401 });
    }
    const limited = await auth.login('alice', 'correct horse', local({}, '10.0.0.99'));
    expect(limited).toMatchObject({ ok: false, status: 429, code: 'too_many_attempts' });
    expect(!limited.ok && limited.retryAfterMs).toBeGreaterThan(0);
    // Unknown names are limited the same way (no enumeration through the limiter).
    for (let i = 0; i < LOGIN_LIMITS.perUser; i++) await auth.login('ghost', 'x', local({}, `10.0.1.${i}`));
    expect(await auth.login('ghost', 'x', local({}, '10.0.1.99'))).toMatchObject({ status: 429 });
    clock.t += LOGIN_LIMITS.windowMs + 1;
    expect((await auth.login('alice', 'correct horse', local())).ok).toBe(true);
  });

  it('rate-limits per client IP across user names; behind a trusted proxy the last X-Forwarded-For hop counts', async () => {
    const { auth } = service();
    for (let i = 0; i < LOGIN_LIMITS.perIp; i++) await auth.login(`user${i}`, 'x', local({}, '203.0.113.5'));
    expect(await auth.login('alice', 'correct horse', local({}, '203.0.113.5'))).toMatchObject({ status: 429 });
    expect((await auth.login('alice', 'correct horse', local({}, '203.0.113.6'))).ok).toBe(true);

    const proxied = service();
    for (let i = 0; i < LOGIN_LIMITS.perIp; i++) await proxied.auth.login(`u${i}`, 'x', local({ 'x-forwarded-for': '198.51.100.7' }));
    expect(await proxied.auth.login('alice', 'correct horse', local({ 'x-forwarded-for': '198.51.100.7' }))).toMatchObject({ status: 429 });
    expect((await proxied.auth.login('alice', 'correct horse', local({ 'x-forwarded-for': 'spoofed, 198.51.100.8' }))).ok).toBe(true);
  });

  it('expires sessions after session_ttl, ends them on logout and when the user is removed', async () => {
    const { auth, clock, setConfig } = service();
    const a = await auth.login('alice', 'correct horse', local());
    if (!a.ok) throw new Error('login failed');
    clock.t += 60 * 60_000 - 1;
    expect(auth.resolve(local(cookieOf(a.cookie)))).toMatchObject({ principal: { name: 'alice' } });
    clock.t += 1;
    expect(auth.resolve(local(cookieOf(a.cookie)))).toEqual({ ok: true, principal: null });
    const v = await auth.login('victor', 'viewer pass', local());
    if (!v.ok) throw new Error('login failed');

    const closed = vi.fn();
    const v2 = auth.resolve(local(cookieOf(v.cookie)));
    if (!v2.ok || !v2.principal?.sessionKey) throw new Error('no session');
    auth.registerStream(v2.principal.sessionKey, closed);
    const clear = auth.logout(local(cookieOf(v.cookie)));
    expect(clear).toMatch(/^adispatch_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict$/);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(auth.resolve(local(cookieOf(v.cookie)))).toEqual({ ok: true, principal: null });

    const b = await auth.login('alice', 'correct horse', local());
    if (!b.ok) throw new Error('login failed');
    setConfig({ users: [{ name: 'victor', passwordHashEnv: 'PW_VICTOR', role: 'viewer' }] });
    expect(auth.resolve(local(cookieOf(b.cookie)))).toEqual({ ok: true, principal: null });
  });

  it('takes the role from the current configuration (reload) and ignores malformed or forged cookies', async () => {
    const { auth, setConfig } = service();
    const v = await auth.login('victor', 'viewer pass', local());
    if (!v.ok) throw new Error('login failed');
    setConfig({ users: [{ name: 'victor', passwordHashEnv: 'PW_VICTOR', role: 'operator' }] });
    expect(auth.resolve(local(cookieOf(v.cookie)))).toMatchObject({ principal: { role: 'operator' } });
    expect(auth.resolve(local({ cookie: 'adispatch_session=x' }))).toEqual({ ok: true, principal: null });
    expect(auth.resolve(local({ cookie: `adispatch_session=${'A'.repeat(43)}` }))).toEqual({ ok: true, principal: null });
  });

  it('sweeps expired sessions and closes their streams', async () => {
    const { auth, clock } = service();
    const a = await auth.login('alice', 'correct horse', local());
    if (!a.ok) throw new Error('login failed');
    const closed = vi.fn();
    auth.registerStream(a.principal.sessionKey!, closed);
    clock.t += 2 * 60 * 60_000;
    auth.sweep();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(auth.sessionCount).toBe(0);
  });

  it('refuses login outside password mode and reports users without a usable hash', async () => {
    const { auth } = service({ mode: 'trusted_header' });
    expect(await auth.login('alice', 'correct horse', local())).toMatchObject({ status: 400, code: 'login_not_available' });
    expect(service().auth.checkUsers()).toEqual(['nohash']);
  });
});

describe('AuthService – trusted header', () => {
  const h = (value?: string): Record<string, string> => (value === undefined ? {} : { 'tailscale-user-login': value });
  it('accepts the header only from a trusted proxy (TCP peer)', () => {
    const { auth } = service({ mode: 'trusted_header' });
    expect(auth.resolve(local(h('Alice@Example.com')))).toEqual({ ok: true, principal: { name: 'alice@example.com', role: 'operator', via: 'trusted_header' } });
    expect(auth.resolve(local(h('alice@example.com'), '::ffff:127.0.0.1'))).toMatchObject({ ok: true });
    expect(auth.resolve(local({ ...h('alice@example.com'), 'x-forwarded-for': '127.0.0.1' }, '100.64.1.2'))).toMatchObject({ ok: false, status: 401, code: 'untrusted_proxy' });
  });
  it('unknown login → 403, missing header → anonymous, malformed → 401', () => {
    const { auth } = service({ mode: 'trusted_header' });
    expect(auth.resolve(local(h('mallory@example.com')))).toMatchObject({ ok: false, status: 403, code: 'login_not_allowed' });
    expect(auth.resolve(local(h()))).toEqual({ ok: true, principal: null });
    expect(auth.resolve(local(h('a@example.com, alice@example.com')))).toMatchObject({ ok: false, status: 401 });
    expect(auth.resolve(local(h('')))).toMatchObject({ ok: false, status: 401 });
  });
  it('supports CIDR ranges and IPv6', () => {
    const m = ipMatcher(['100.64.0.0/10', 'fd7a:115c:a1e0::/48', '::1']);
    expect(m('100.100.1.1')).toBe(true);
    expect(m('100.128.0.1')).toBe(false);
    expect(m('fd7a:115c:a1e0::5')).toBe(true);
    expect(m('::1')).toBe(true);
    expect(m('::ffff:100.100.1.1')).toBe(true);
    expect(m('garbage')).toBe(false);
    expect(m(undefined)).toBe(false);
  });
});

describe('AuthService – control token', () => {
  it('grants admin only from loopback and only with the exact token', () => {
    const { auth } = service();
    const ok = auth.resolve(local({ [CONTROL_TOKEN_HEADER]: auth.controlToken }));
    expect(ok).toEqual({ ok: true, principal: { name: 'control-token', role: 'admin', via: 'control_token' } });
    expect(auth.resolve(local({ [CONTROL_TOKEN_HEADER]: auth.controlToken }, '::1'))).toMatchObject({ ok: true });
    expect(auth.resolve(local({ [CONTROL_TOKEN_HEADER]: auth.controlToken }, '192.168.1.20'))).toMatchObject({ ok: false, status: 401, code: 'control_token_not_local' });
    expect(auth.resolve(local({ [CONTROL_TOKEN_HEADER]: `${auth.controlToken}x` }))).toMatchObject({ ok: false, status: 401, code: 'invalid_control_token' });
    expect(auth.resolve(local({ [CONTROL_TOKEN_HEADER]: auth.controlToken }, '127.0.0.1'))).toMatchObject({ ok: true });
    expect(isLoopbackAddress('127.8.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });
  it('is random per instance (32 bytes)', () => {
    const a = service().auth.controlToken;
    const b = service().auth.controlToken;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-token-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('is written atomically with mode 0600, replaced on restart and removed only by its owner', () => {
    const t1 = service().auth.controlToken;
    const file = writeControlToken(dir, t1);
    expect(file).toBe(controlTokenPath(dir));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readControlToken(file)).toBe(t1);
    // A pre-existing world-readable file is replaced by a fresh 0600 file.
    writeFileSync(file, 'old\n', { mode: 0o644 });
    const t2 = service().auth.controlToken;
    writeControlToken(dir, t2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(`${t2}\n`);
    removeControlToken(dir, t1); // not ours any more
    expect(readControlToken(file)).toBe(t2);
    removeControlToken(dir, t2);
    expect(readControlToken(file)).toBeNull();
    expect(readControlToken(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('readCookie', () => {
  it('finds the named cookie', () => {
    expect(readCookie('a=1; adispatch_session=abc; b=2', 'adispatch_session')).toBe('abc');
    expect(readCookie('xadispatch_session=abc', 'adispatch_session')).toBeUndefined();
    expect(readCookie(undefined, 'x')).toBeUndefined();
  });
});
