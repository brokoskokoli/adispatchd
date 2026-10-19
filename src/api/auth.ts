/**
 * Authentication of web UI and API (WI-26, Spec §20 addendum 0.3.1).
 *
 * Modes (`auth.mode` in config.yaml, read per request – a reload applies):
 * - `none`: no login (behaviour before 0.3.1); this service is not consulted.
 * - `password`: built-in users with scrypt hashes from environment variables,
 *   in-memory sessions (cookie `adispatch_session`, `HttpOnly; SameSite=Strict;
 *   Path=/`, `Secure` over HTTPS), login rate limits per client IP and per
 *   user name, a fixed delay after a failure, no difference between "unknown
 *   user" and "wrong password" (an unknown user costs the same scrypt run).
 * - `trusted_header`: the user comes from a header set by an authenticating
 *   proxy (Tailscale Serve, oauth2-proxy, …); only believed when the TCP peer
 *   (socket address, never `X-Forwarded-For`) is in `trusted_proxies`.
 *
 * In every mode except `none`, the local control token (random, written to
 * `<data-dir>/control.token`, 0600) grants `admin` to loopback connections
 * (CLI control commands).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { noopLogger, systemClock, systemTimers, type Clock, type Logger, type TimerHandle, type Timers } from '../core/index.js';
import type { AuthConfig, AuthRole } from '../config/index.js';
import { dummyHash, nodeScrypt, parsePasswordHash, verifyPassword, type ParsedHash, type ScryptFn } from './password.js';

/** Session cookie name. */
export const SESSION_COOKIE = 'adispatch_session';
/** Header carrying the local control token (CLI). */
export const CONTROL_TOKEN_HEADER = 'x-adispatch-control-token';
/** File name of the control token in the data dir. */
export const CONTROL_TOKEN_FILE = 'control.token';

/** Login rate limits (fixed windows). */
export const LOGIN_LIMITS = {
  windowMs: 15 * 60_000,
  /** Failed attempts per client IP and window. */
  perIp: 20,
  /** Failed attempts per user name (known or not) and window. */
  perUser: 5,
  /** Concurrent password checks (each scrypt run needs ≈ 32 MiB). */
  maxInFlight: 8,
  /** Delay before answering a failed login. */
  failureDelayMs: 1_000,
} as const;

/** Upper bounds of the in-memory stores. */
const MAX_SESSIONS = 10_000;
const MAX_SESSIONS_PER_USER = 50;
const MAX_LIMITER_KEYS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** How a principal was authenticated. */
export type AuthVia = 'password' | 'trusted_header' | 'control_token' | 'anonymous';

/** The authenticated caller of a request. */
export interface Principal {
  name: string;
  role: AuthRole;
  via: AuthVia;
  /** Session key (password mode), used to close SSE streams on logout/expiry. */
  sessionKey?: string;
}

/** What the request carries, independent of Fastify. */
export interface AuthRequest {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** TCP peer address (`socket.remoteAddress`). */
  remoteAddress: string | undefined;
  /** TLS connection to this process. */
  encrypted?: boolean;
}

/** Outcome of resolving a request's credentials. */
export type ResolveResult =
  | { ok: true; principal: Principal | null }
  | { ok: false; status: 401 | 403; code: string; message: string };

/** Outcome of a login attempt. */
export type LoginResult =
  | { ok: true; principal: Principal; cookie: string; expiresAt: string }
  | { ok: false; status: 400 | 401 | 429; code: string; message: string; retryAfterMs?: number };

/** Dependencies of {@link AuthService}. */
export interface AuthServiceOptions {
  /** Current `auth` section (re-read per request: reloads apply). */
  config: () => AuthConfig;
  /** Environment holding the password hashes (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  scrypt?: ScryptFn;
  /** Wait after a failed login (default {@link LOGIN_LIMITS.failureDelayMs}; tests 0). */
  sleep?: (ms: number) => Promise<void>;
  /** Fixed control token (tests); default random. */
  controlToken?: string;
}

interface Session {
  name: string;
  createdAt: number;
  expiresAt: number;
}

/** Fixed-window failure counter with a size cap. */
class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Milliseconds until a new attempt is allowed, 0 = allowed. */
  blockedFor(key: string, now: number): number {
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) return 0;
    return e.count >= this.max ? e.resetAt - now : 0;
  }

  fail(key: string, now: number): void {
    const e = this.entries.get(key);
    if (e && e.resetAt > now) {
      e.count++;
      return;
    }
    if (this.entries.size >= MAX_LIMITER_KEYS) this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  prune(now: number): void {
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
    // Still full: drop the oldest windows (insertion order).
    for (const k of this.entries.keys()) {
      if (this.entries.size < MAX_LIMITER_KEYS) break;
      this.entries.delete(k);
    }
  }
}

/** Normalize `::ffff:1.2.3.4` to `1.2.3.4`; `null` if not an IP. */
export function normalizeIp(address: string | undefined): string | null {
  if (!address) return null;
  const a = address.trim().replace(/^\[|\]$/g, '');
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  const ip = v4 ? v4[1]! : a;
  return isIP(ip) === 0 ? null : ip.toLowerCase();
}

/** True for loopback peers (127.0.0.0/8, ::1). */
export function isLoopbackAddress(address: string | undefined): boolean {
  const ip = normalizeIp(address);
  return ip !== null && (ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.')));
}

/** Matcher for a list of IPs/CIDRs (`node:net` BlockList). */
export function ipMatcher(entries: readonly string[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const [ip, bits] = entry.split('/');
    const family = isIP(ip ?? '');
    if (family === 0) continue;
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(ip!, type);
    else list.addSubnet(ip!, Number(bits), type);
  }
  return (address) => {
    const ip = normalizeIp(address);
    if (!ip) return false;
    return list.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  };
}

function header(req: AuthRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : undefined;
  return v;
}

/** Value of cookie `name` from a `Cookie` header. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const sessionKeyOf = (id: string): string => digest(id).toString('hex');

/** Equal-time comparison of two secrets (via their SHA-256, so lengths never leak). */
export function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Session/login/proxy logic; one instance per app. */
export class AuthService {
  readonly controlToken: string;
  private readonly sessions = new Map<string, Session>();
  private readonly streams = new Map<string, Set<() => void>>();
  private readonly ipLimiter = new FailureLimiter(LOGIN_LIMITS.perIp, LOGIN_LIMITS.windowMs);
  private readonly userLimiter = new FailureLimiter(LOGIN_LIMITS.perUser, LOGIN_LIMITS.windowMs);
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly scrypt: ScryptFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly warnedUsers = new Set<string>();
  private inFlight = 0;
  private sweepTimer: TimerHandle | null = null;
  private matcherCache: { key: string; trusted: (a: string | undefined) => boolean; proxies: (a: string | undefined) => boolean } | null = null;

  constructor(private readonly options: AuthServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'auth' });
    this.scrypt = options.scrypt ?? nodeScrypt;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.env = options.env ?? process.env;
    this.controlToken = options.controlToken ?? randomBytes(32).toString('base64url');
  }

  get config(): AuthConfig {
    return this.options.config();
  }

  /** Authentication active (`mode` ≠ `none`). */
  get enabled(): boolean {
    return this.config.mode !== 'none';
  }

  /** Number of live sessions (status/tests). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Start the periodic sweep of expired sessions (closes their SSE streams). */
  start(): void {
    if (this.sweepTimer) return;
    const tick = (): void => {
      this.sweep();
      this.sweepTimer = this.timers.setTimeout(tick, SWEEP_INTERVAL_MS);
      (this.sweepTimer as { unref?: () => void } | null)?.unref?.();
    };
    this.sweepTimer = this.timers.setTimeout(tick, SWEEP_INTERVAL_MS);
    (this.sweepTimer as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) this.timers.clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Startup/reload check: users whose hash variable is missing or malformed cannot log in (names only, never values). */
  checkUsers(): string[] {
    const cfg = this.config;
    if (cfg.mode !== 'password') return [];
    return cfg.users.filter((u) => !parsePasswordHash(this.env[u.passwordHashEnv])).map((u) => u.name);
  }

  private matchers(): { trusted: (a: string | undefined) => boolean; proxies: (a: string | undefined) => boolean } {
    const cfg = this.config;
    const key = JSON.stringify([cfg.trustedHeader.trustedProxies, cfg.trustedProxies]);
    if (this.matcherCache?.key !== key) {
      this.matcherCache = { key, trusted: ipMatcher(cfg.trustedHeader.trustedProxies), proxies: ipMatcher(cfg.trustedProxies) };
    }
    return this.matcherCache;
  }

  /** The request came over HTTPS (own TLS, or `X-Forwarded-Proto: https` from a trusted proxy in password mode). */
  isHttps(req: AuthRequest): boolean {
    if (req.encrypted) return true;
    const cfg = this.config;
    const fromProxy = cfg.mode === 'trusted_header' ? this.matchers().trusted(req.remoteAddress) : this.matchers().proxies(req.remoteAddress);
    if (!fromProxy) return false;
    const proto = header(req, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    return proto === 'https';
  }

  /** Client IP for rate limits: the TCP peer, or the last `X-Forwarded-For` hop if the peer is a trusted proxy. */
  clientIp(req: AuthRequest): string {
    const peer = normalizeIp(req.remoteAddress) ?? 'unknown';
    if (!this.matchers().proxies(req.remoteAddress)) return peer;
    const xff = header(req, 'x-forwarded-for');
    const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    return normalizeIp(last) ?? peer;
  }

  /**
   * Credentials of a request. `ok: true, principal: null` = anonymous (the
   * route decides); errors are only applied to non-public routes.
   */
  resolve(req: AuthRequest): ResolveResult {
    const cfg = this.config;
    if (cfg.mode === 'none') return { ok: true, principal: null };
    const token = header(req, CONTROL_TOKEN_HEADER);
    if (token !== undefined) {
      if (!isLoopbackAddress(req.remoteAddress)) {
        return { ok: false, status: 401, code: 'control_token_not_local', message: 'The control token is only accepted from loopback connections' };
      }
      if (!secretEquals(token, this.controlToken)) {
        return { ok: false, status: 401, code: 'invalid_control_token', message: 'Invalid control token (restarted instance? the token changes with every start)' };
      }
      return { ok: true, principal: { name: 'control-token', role: 'admin', via: 'control_token' } };
    }
    if (cfg.mode === 'password') {
      const id = readCookie(header(req, 'cookie'), SESSION_COOKIE);
      if (!id || !TOKEN_PATTERN.test(id)) return { ok: true, principal: null };
      const key = sessionKeyOf(id);
      const session = this.sessions.get(key);
      if (!session) return { ok: true, principal: null };
      if (session.expiresAt <= this.clock.now().getTime()) {
        this.dropSession(key);
        return { ok: true, principal: null };
      }
      const user = cfg.users.find((u) => u.name === session.name);
      if (!user) {
        // Removed from the configuration (reload): the session ends.
        this.dropSession(key);
        return { ok: true, principal: null };
      }
      return { ok: true, principal: { name: user.name, role: user.role, via: 'password', sessionKey: key } };
    }
    // trusted_header
    const raw = req.headers[cfg.trustedHeader.header];
    if (raw === undefined) return { ok: true, principal: null };
    if (!this.matchers().trusted(req.remoteAddress)) {
      return { ok: false, status: 401, code: 'untrusted_proxy', message: 'The identity header is only accepted from a trusted proxy' };
    }
    const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
    const login = value?.trim().toLowerCase();
    if (!login || login.length > 320 || /[\s,\x00-\x1f\x7f]/.test(login)) {
      return { ok: false, status: 401, code: 'invalid_identity_header', message: 'The identity header is empty or malformed' };
    }
    const user = cfg.trustedHeader.users.find((u) => u.login === login);
    if (!user) return { ok: false, status: 403, code: 'login_not_allowed', message: 'This login is not allowed to use adispatchd (auth.trusted_header.users)' };
    return { ok: true, principal: { name: user.login, role: user.role, via: 'trusted_header' } };
  }

  /** Password login. */
  async login(name: string, password: string, req: AuthRequest): Promise<LoginResult> {
    const cfg = this.config;
    if (cfg.mode !== 'password') {
      return { ok: false, status: 400, code: 'login_not_available', message: 'Login is only available with auth.mode: password' };
    }
    const now = this.clock.now().getTime();
    const ip = `ip:${this.clientIp(req)}`;
    const userKey = `user:${name.toLowerCase()}`;
    const wait = Math.max(this.ipLimiter.blockedFor(ip, now), this.userLimiter.blockedFor(userKey, now));
    if (wait > 0) {
      this.logger.warn('login rate limited', { ip: ip.slice(3) });
      return { ok: false, status: 429, code: 'too_many_attempts', message: 'Too many failed login attempts; try again later', retryAfterMs: wait };
    }
    if (this.inFlight >= LOGIN_LIMITS.maxInFlight) {
      return { ok: false, status: 429, code: 'too_many_attempts', message: 'Too many concurrent login attempts; try again shortly', retryAfterMs: 1_000 };
    }
    const user = cfg.users.find((u) => u.name.toLowerCase() === name.toLowerCase()) ?? null;
    const stored: ParsedHash | null = user ? parsePasswordHash(this.env[user.passwordHashEnv]) : null;
    if (user && !stored && !this.warnedUsers.has(user.name)) {
      this.warnedUsers.add(user.name);
      this.logger.warn('user cannot log in: password hash variable missing or malformed', { user: user.name, variable: user.passwordHashEnv });
    }
    // Unknown user / unusable hash: same scrypt work against a hash that never matches.
    const target = stored ?? dummyHash(cfg.users.map((u) => parsePasswordHash(this.env[u.passwordHashEnv])).find((h) => h !== null));
    this.inFlight++;
    let match = false;
    try {
      match = await verifyPassword(password, target, this.scrypt);
    } finally {
      this.inFlight--;
    }
    if (!match || !user || !stored) {
      const at = this.clock.now().getTime();
      this.ipLimiter.fail(ip, at);
      this.userLimiter.fail(userKey, at);
      this.logger.warn('login failed', { user: user ? user.name : '(unknown)', ip: ip.slice(3) });
      await this.sleep(LOGIN_LIMITS.failureDelayMs);
      return { ok: false, status: 401, code: 'invalid_credentials', message: 'Invalid user name or password' };
    }
    this.userLimiter.reset(userKey);
    const id = randomBytes(32).toString('base64url');
    const key = sessionKeyOf(id);
    const created = this.clock.now().getTime();
    const expiresAt = created + cfg.sessionTtlMs;
    this.evictFor(user.name, created);
    this.sessions.set(key, { name: user.name, createdAt: created, expiresAt });
    this.logger.info('login', { user: user.name, ip: ip.slice(3) });
    return {
      ok: true,
      principal: { name: user.name, role: user.role, via: 'password', sessionKey: key },
      cookie: this.sessionCookie(id, Math.floor(cfg.sessionTtlMs / 1000), this.isHttps(req)),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** End the session of a request (if any); returns the clearing cookie. */
  logout(req: AuthRequest): string {
    const id = readCookie(header(req, 'cookie'), SESSION_COOKIE);
    if (id && TOKEN_PATTERN.test(id)) {
      const key = sessionKeyOf(id);
      const session = this.sessions.get(key);
      if (session) this.logger.info('logout', { user: session.name });
      this.dropSession(key);
    }
    return this.sessionCookie('', 0, this.isHttps(req));
  }

  /** Expiry of the session behind a principal (ISO), `null` without session. */
  sessionExpiry(principal: Principal | null): string | null {
    const s = principal?.sessionKey ? this.sessions.get(principal.sessionKey) : undefined;
    return s ? new Date(s.expiresAt).toISOString() : null;
  }

  /** Register an open SSE stream of a session; it is closed on logout/expiry. Returns the unregister function. */
  registerStream(sessionKey: string, close: () => void): () => void {
    let set = this.streams.get(sessionKey);
    if (!set) {
      set = new Set();
      this.streams.set(sessionKey, set);
    }
    set.add(close);
    return () => {
      const s = this.streams.get(sessionKey);
      s?.delete(close);
      if (s && s.size === 0) this.streams.delete(sessionKey);
    };
  }

  /** Remove expired sessions and sessions of removed users; close their streams. */
  sweep(): void {
    const now = this.clock.now().getTime();
    const cfg = this.config;
    for (const [key, s] of this.sessions) {
      if (s.expiresAt <= now || cfg.mode !== 'password' || !cfg.users.some((u) => u.name === s.name)) this.dropSession(key);
    }
    this.ipLimiter.prune(now);
    this.userLimiter.prune(now);
  }

  private dropSession(key: string): void {
    this.sessions.delete(key);
    const streams = this.streams.get(key);
    if (streams) {
      this.streams.delete(key);
      for (const close of streams) {
        try {
          close();
        } catch {
          // stream already gone
        }
      }
    }
  }

  /** Bound the stores: oldest sessions of the user, then globally the oldest. */
  private evictFor(name: string, now: number): void {
    const own = [...this.sessions].filter(([, s]) => s.name === name);
    for (const [key] of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_USER + 1))) this.dropSession(key);
    if (this.sessions.size >= MAX_SESSIONS) {
      for (const [key, s] of this.sessions) if (s.expiresAt <= now) this.dropSession(key);
      for (const key of this.sessions.keys()) {
        if (this.sessions.size < MAX_SESSIONS) break;
        this.dropSession(key);
      }
    }
  }

  private sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
    return [`${SESSION_COOKIE}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
  }
}

// ---------------------------------------------------------------------------
// Control token file

/** Path of the control token file. */
export function controlTokenPath(dataDir: string): string {
  return path.join(dataDir, CONTROL_TOKEN_FILE);
}

/** Write the control token atomically with mode 0600 (temp file + rename in the data dir). */
export function writeControlToken(dataDir: string, token: string): string {
  const file = controlTokenPath(dataDir);
  const tmp = path.join(dataDir, `.${CONTROL_TOKEN_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  return file;
}

/** Remove the control token file if it still holds `token` (a newer instance may have replaced it). */
export function removeControlToken(dataDir: string, token: string): void {
  const file = controlTokenPath(dataDir);
  try {
    if (readFileSync(file, 'utf8').trim() === token) unlinkSync(file);
  } catch {
    // missing or unreadable
  }
}

/** Read a control token file; `null` if missing, unreadable or malformed. */
export function readControlToken(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}
