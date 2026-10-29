/**
 * Authentication of web UI and API (WI-26, Spec §20 addendum 0.4.0).
 *
 * Modes (`auth.mode` in config.yaml, read per request – a reload applies):
 * - `none`: no login (behaviour before 0.4.0); this service is not consulted.
 * - `password`: built-in users with scrypt hashes from environment variables,
 *   in-memory sessions (cookie `__Host-adispatch_session` over HTTPS, else
 *   `adispatch_session`; `HttpOnly; SameSite=Strict; Path=/`), login rate
 *   limits per (user, client IP), per user and per IP, a fixed delay after a
 *   failure, no difference between "unknown user" and "wrong password" (an
 *   unknown user costs the same scrypt run).
 * - `trusted_header`: the user comes from a header set by an authenticating
 *   proxy (Tailscale Serve, oauth2-proxy, …); only believed when the TCP peer
 *   (socket address, never `X-Forwarded-For`) is in `trusted_proxies` and –
 *   if `proxy_secret_env` is set – the proxy sends the shared secret in
 *   `X-Adispatch-Proxy-Secret`.
 *
 * Hub (WI-36): an instance started by a hub receives a secret from it (standard
 * input, `hubToken`). The hub authenticates the browser users itself and forwards
 * their identity with `X-Adispatch-Hub-Token` (the secret), `-User` and `-Role`;
 * only the holder of the secret is believed, and only from loopback. Such an
 * instance additionally refuses every request without hub, control token or
 * (if configured) its own login, even with `mode: none`.
 *
 * In every mode except `none`, the local control token (random, written to
 * `<data-dir>/control.token`, 0600, with port and pid) grants `operator` to
 * loopback connections, and only on the routes the CLI control commands use
 * (`controlToken` in roles.ts). Worker processes of the same service user can
 * read the file – the routes are limited accordingly.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { noopLogger, systemClock, systemTimers, type Clock, type Logger, type TimerHandle, type Timers } from '../core/index.js';
import { AUTH_ROLES, type AuthConfig, type AuthRole } from '../config/index.js';
import { dummyHash, nodeScrypt, parsePasswordHash, verifyPassword, type ParsedHash, type ScryptFn } from './password.js';

/** Session cookie name over plain HTTP. */
export const SESSION_COOKIE = 'adispatch_session';
/** Session cookie name over HTTPS (`__Host-` prefix: Secure, Path=/, no Domain – cannot be set by other hosts). */
export const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
/** Header carrying the local control token (CLI). */
export const CONTROL_TOKEN_HEADER = 'x-adispatch-control-token';
/** Header carrying the shared proxy secret (`auth.trusted_header.proxy_secret_env`). */
export const PROXY_SECRET_HEADER = 'x-adispatch-proxy-secret';
/** Headers of the identity a hub forwards to the instance it started (WI-36). */
export const HUB_TOKEN_HEADER = 'x-adispatch-hub-token';
export const HUB_USER_HEADER = 'x-adispatch-hub-user';
export const HUB_ROLE_HEADER = 'x-adispatch-hub-role';
/** Pattern of the secret a hub hands to an instance (32 random bytes, base64url). */
export const HUB_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** File name of the control token in the data dir. */
export const CONTROL_TOKEN_FILE = 'control.token';

/** Login rate limits (fixed windows). */
export const LOGIN_LIMITS = {
  windowMs: 15 * 60_000,
  /** Failed attempts per (user name, client IP) and window: blocks the attacker, not the user elsewhere. */
  perUserIp: 5,
  /** Failed attempts per user name (known or not) from all IPs and window. */
  perUser: 50,
  /** Failed attempts per client IP (IPv6: per /64) and window. */
  perIp: 20,
  /** Concurrent password checks (each scrypt run needs ≈ 32 MiB). */
  maxInFlight: 8,
  /** Delay before answering a failed login. */
  failureDelayMs: 1_000,
} as const;

/** Upper bounds of the in-memory stores. */
const MAX_SESSIONS = 10_000;
const MAX_SESSIONS_PER_USER = 50;
/** Soft cap of each rate-limit store (entries that currently block are never evicted). */
export const MAX_LIMITER_KEYS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** How a principal was authenticated. */
export type AuthVia = 'password' | 'trusted_header' | 'control_token' | 'anonymous' | 'hub' | 'hub_open';

/** The authenticated caller of a request. */
export interface Principal {
  name: string;
  role: AuthRole;
  /**
   * How the caller authenticated. Sensitive routes can require an interactive
   * login ({@link isInteractive}): the control token and the anonymous reader
   * are never a person.
   */
  via: AuthVia;
  /** Session key (password mode), used to close SSE streams on logout/expiry. */
  sessionKey?: string;
}

/**
 * True for a person who logged in (password), was identified by the proxy
 * (trusted_header) or by the hub (`hub`). `hub_open` (hub without login or
 * anonymous reader) is never a person.
 */
export function isInteractive(principal: Principal | null | undefined): boolean {
  return principal?.via === 'password' || principal?.via === 'trusted_header' || principal?.via === 'hub';
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
  /** Environment holding the password hashes and the proxy secret (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  scrypt?: ScryptFn;
  /** Wait after a failed login (default {@link LOGIN_LIMITS.failureDelayMs}; tests 0). */
  sleep?: (ms: number) => Promise<void>;
  /** Fixed control token (tests); default random. */
  controlToken?: string;
  /** Secret of the hub that started this instance (WI-36): its forwarded identities are believed. */
  hubToken?: string;
  /** Soft cap of the rate-limit stores (tests). */
  limiterMaxKeys?: number;
}

interface Session {
  name: string;
  createdAt: number;
  expiresAt: number;
}

interface Stream {
  principal: Principal;
  close: () => void;
}

/** Fixed-window failure counter with a soft size cap that never evicts blocking entries. */
export class FailureLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = MAX_LIMITER_KEYS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

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
    this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) this.prune(now);
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Remove expired windows; while still at the cap, drop the oldest windows
   * that do not block (yet). Blocking entries stay even above the cap – they
   * are only reachable with `max` failed (rate-limited) attempts each.
   */
  prune(now: number): void {
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
    for (const [k, e] of this.entries) {
      if (this.entries.size < this.maxKeys) break;
      if (e.count < this.max) this.entries.delete(k);
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

/** Rate-limit key of an address: IPv4 as is, IPv6 by its /64 prefix (one host usually owns a whole /64). */
export function ipRateKey(address: string | undefined): string {
  const ip = normalizeIp(address);
  if (!ip) return 'unknown';
  if (isIP(ip) === 4) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => (g.includes('.') ? g : (parseInt(g || '0', 16) || 0).toString(16)))
    .join(':')}::/64`;
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

/** All values of cookie `name` from a `Cookie` header, in header order. */
export function readCookies(cookieHeader: string | undefined, name: string): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

/** First value of cookie `name` (convenience). */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  return readCookies(cookieHeader, name)[0];
}

/**
 * Session ID of a request, deterministic with duplicate cookies: the
 * `__Host-` cookie wins (no other host or plain-HTTP page can set it); for a
 * name sent more than once with different values (cookie tossing) the request
 * counts as not logged in rather than picking one.
 */
export function sessionIdOf(cookieHeader: string | undefined): string | undefined {
  for (const name of [SECURE_SESSION_COOKIE, SESSION_COOKIE]) {
    const values = [...new Set(readCookies(cookieHeader, name))];
    if (values.length > 1) return undefined;
    if (values.length === 1) return values[0];
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
  private readonly hubToken: string | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly streams = new Set<Stream>();
  private readonly userIpLimiter: FailureLimiter;
  private readonly userLimiter: FailureLimiter;
  private readonly ipLimiter: FailureLimiter;
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
    this.hubToken = options.hubToken;
    const cap = options.limiterMaxKeys ?? MAX_LIMITER_KEYS;
    this.userIpLimiter = new FailureLimiter(LOGIN_LIMITS.perUserIp, LOGIN_LIMITS.windowMs, cap);
    this.userLimiter = new FailureLimiter(LOGIN_LIMITS.perUser, LOGIN_LIMITS.windowMs, cap);
    this.ipLimiter = new FailureLimiter(LOGIN_LIMITS.perIp, LOGIN_LIMITS.windowMs, cap);
  }

  get config(): AuthConfig {
    return this.options.config();
  }

  /** Authentication active (`mode` ≠ `none`, or the instance is managed by a hub). */
  get enabled(): boolean {
    return this.hubManaged || this.config.mode !== 'none';
  }

  /** The instance was started by a hub (WI-36): anonymous access is never allowed, reading needs a login or the hub. */
  get hubManaged(): boolean {
    return this.hubToken !== undefined;
  }

  /** `auth.read_requires_login`; always `true` for a hub-managed instance with `mode: none`. */
  get readRequiresLogin(): boolean {
    return this.config.readRequiresLogin || (this.hubManaged && this.config.mode === 'none');
  }

  /** Number of live sessions (status/tests). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Number of open SSE streams of authenticated callers (tests). */
  get streamCount(): number {
    return this.streams.size;
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

  /** Startup/reload check: `proxy_secret_env` set but the variable is missing/empty (every request then fails with 401). */
  proxySecretMissing(): boolean {
    const name = this.config.trustedHeader.proxySecretEnv;
    return this.config.mode === 'trusted_header' && name !== null && !this.env[name];
  }

  private matchers(): { trusted: (a: string | undefined) => boolean; proxies: (a: string | undefined) => boolean } {
    const cfg = this.config;
    const key = JSON.stringify([cfg.trustedHeader.trustedProxies, cfg.trustedProxies]);
    if (this.matcherCache?.key !== key) {
      this.matcherCache = { key, trusted: ipMatcher(cfg.trustedHeader.trustedProxies), proxies: ipMatcher(cfg.trustedProxies) };
    }
    return this.matcherCache;
  }

  /** The request came over HTTPS (own TLS, or `X-Forwarded-Proto: https` from a trusted proxy). */
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
   * route decides); errors are only applied to non-public routes. A control
   * token principal must additionally be checked against the route
   * (`acceptsControlToken`).
   */
  resolve(req: AuthRequest): ResolveResult {
    const cfg = this.config;
    if (cfg.mode === 'none' && !this.hubManaged) return { ok: true, principal: null };
    const token = header(req, CONTROL_TOKEN_HEADER);
    if (token !== undefined) {
      if (!isLoopbackAddress(req.remoteAddress)) {
        return { ok: false, status: 401, code: 'control_token_not_local', message: 'The control token is only accepted from loopback connections' };
      }
      if (!secretEquals(token, this.controlToken)) {
        return { ok: false, status: 401, code: 'invalid_control_token', message: 'Invalid control token (restarted instance? the token changes with every start)' };
      }
      return { ok: true, principal: { name: 'control-token', role: 'operator', via: 'control_token' } };
    }
    if (req.headers[HUB_TOKEN_HEADER] !== undefined) return this.resolveHub(req);
    if (cfg.mode === 'none') return { ok: true, principal: null };
    if (cfg.mode === 'password') {
      const id = sessionIdOf(header(req, 'cookie'));
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
    if (cfg.trustedHeader.proxySecretEnv !== null) {
      const expected = this.env[cfg.trustedHeader.proxySecretEnv];
      const sent = header(req, PROXY_SECRET_HEADER);
      // Fail closed: a missing variable never disables the check.
      if (!expected || sent === undefined || !secretEquals(sent, expected)) {
        return { ok: false, status: 401, code: 'invalid_proxy_secret', message: 'The proxy did not send the expected X-Adispatch-Proxy-Secret' };
      }
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

  /** Identity forwarded by the hub that started this instance (WI-36). */
  private resolveHub(req: AuthRequest): ResolveResult {
    const sent = header(req, HUB_TOKEN_HEADER);
    if (this.hubToken === undefined || sent === undefined || !isLoopbackAddress(req.remoteAddress) || !secretEquals(sent, this.hubToken)) {
      return { ok: false, status: 401, code: 'invalid_hub_token', message: 'Invalid hub token (only the hub that started this instance may forward identities)' };
    }
    const role = header(req, HUB_ROLE_HEADER);
    if (role === undefined || !(AUTH_ROLES as readonly string[]).includes(role)) {
      return { ok: false, status: 401, code: 'invalid_hub_identity', message: 'The hub did not send a valid role' };
    }
    const user = header(req, HUB_USER_HEADER);
    if (user === undefined) return { ok: true, principal: { name: 'hub', role: role as AuthRole, via: 'hub_open' } };
    if (user === '' || user.length > 320 || /[\s,\x00-\x1f\x7f]/.test(user)) {
      return { ok: false, status: 401, code: 'invalid_hub_identity', message: 'The hub sent a malformed user name' };
    }
    return { ok: true, principal: { name: user, role: role as AuthRole, via: 'hub' } };
  }

  /** Password login. */
  async login(name: string, password: string, req: AuthRequest): Promise<LoginResult> {
    const cfg = this.config;
    if (cfg.mode !== 'password') {
      return { ok: false, status: 400, code: 'login_not_available', message: 'Login is only available with auth.mode: password' };
    }
    const now = this.clock.now().getTime();
    const clientIp = this.clientIp(req);
    const ipKey = ipRateKey(clientIp);
    const userKey = name.toLowerCase();
    const userIpKey = `${userKey}\u0000${ipKey}`;
    const wait = Math.max(this.userIpLimiter.blockedFor(userIpKey, now), this.userLimiter.blockedFor(userKey, now), this.ipLimiter.blockedFor(ipKey, now));
    if (wait > 0) {
      this.logger.warn('login rate limited', { ip: clientIp });
      return { ok: false, status: 429, code: 'too_many_attempts', message: 'Too many failed login attempts; try again later', retryAfterMs: wait };
    }
    if (this.inFlight >= LOGIN_LIMITS.maxInFlight) {
      return { ok: false, status: 429, code: 'too_many_attempts', message: 'Too many concurrent login attempts; try again shortly', retryAfterMs: 1_000 };
    }
    const user = cfg.users.find((u) => u.name.toLowerCase() === userKey) ?? null;
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
      this.userIpLimiter.fail(userIpKey, at);
      this.userLimiter.fail(userKey, at);
      this.ipLimiter.fail(ipKey, at);
      this.logger.warn('login failed', { user: user ? user.name : '(unknown)', ip: clientIp });
      await this.sleep(LOGIN_LIMITS.failureDelayMs);
      return { ok: false, status: 401, code: 'invalid_credentials', message: 'Invalid user name or password' };
    }
    this.userIpLimiter.reset(userIpKey);
    const id = randomBytes(32).toString('base64url');
    const key = sessionKeyOf(id);
    const created = this.clock.now().getTime();
    const expiresAt = created + cfg.sessionTtlMs;
    this.evictFor(user.name, created);
    this.sessions.set(key, { name: user.name, createdAt: created, expiresAt });
    this.logger.info('login', { user: user.name, ip: clientIp });
    return {
      ok: true,
      principal: { name: user.name, role: user.role, via: 'password', sessionKey: key },
      cookie: this.sessionCookie(id, Math.floor(cfg.sessionTtlMs / 1000), this.isHttps(req)),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** End the session of a request (if any); returns the clearing cookies (both names). */
  logout(req: AuthRequest): string[] {
    for (const name of [SECURE_SESSION_COOKIE, SESSION_COOKIE]) {
      for (const id of readCookies(header(req, 'cookie'), name)) {
        if (!TOKEN_PATTERN.test(id)) continue;
        const key = sessionKeyOf(id);
        const session = this.sessions.get(key);
        if (session) this.logger.info('logout', { user: session.name });
        this.dropSession(key);
      }
    }
    return [this.sessionCookie('', 0, false), this.sessionCookie('', 0, true)];
  }

  /** Expiry of the session behind a principal (ISO), `null` without session. */
  sessionExpiry(principal: Principal | null): string | null {
    const s = principal?.sessionKey ? this.sessions.get(principal.sessionKey) : undefined;
    return s ? new Date(s.expiresAt).toISOString() : null;
  }

  /**
   * Register an open SSE stream of `principal`; it is closed on logout, expiry
   * and when a reload removes the principal or its access ({@link sweep}).
   * Returns the unregister function.
   */
  registerStream(principal: Principal, close: () => void): () => void {
    const stream: Stream = { principal, close };
    this.streams.add(stream);
    return () => {
      this.streams.delete(stream);
    };
  }

  /** Whether an open stream's principal may still read (current configuration). */
  private stillAllowed(p: Principal): boolean {
    const cfg = this.config;
    if (cfg.mode === 'none') return true;
    switch (p.via) {
      case 'password':
        return cfg.mode === 'password' && p.sessionKey !== undefined && this.sessions.has(p.sessionKey) && cfg.users.some((u) => u.name === p.name);
      case 'trusted_header':
        return cfg.mode === 'trusted_header' && cfg.trustedHeader.users.some((u) => u.login === p.name);
      case 'anonymous':
        return !this.readRequiresLogin;
      case 'control_token':
      case 'hub':
      case 'hub_open':
        return true; // the hub ends the stream itself when its own session ends
    }
  }

  /**
   * Remove expired sessions and sessions of removed users, prune the rate
   * limits and close every stream whose principal lost access (called
   * periodically and after each configuration reload).
   */
  sweep(): void {
    const now = this.clock.now().getTime();
    const cfg = this.config;
    for (const [key, s] of this.sessions) {
      if (s.expiresAt <= now || cfg.mode !== 'password' || !cfg.users.some((u) => u.name === s.name)) this.dropSession(key);
    }
    for (const stream of [...this.streams]) if (!this.stillAllowed(stream.principal)) this.closeStream(stream);
    this.userIpLimiter.prune(now);
    this.userLimiter.prune(now);
    this.ipLimiter.prune(now);
  }

  private closeStream(stream: Stream): void {
    this.streams.delete(stream);
    try {
      stream.close();
    } catch {
      // stream already gone
    }
  }

  private dropSession(key: string): void {
    this.sessions.delete(key);
    for (const stream of [...this.streams]) if (stream.principal.sessionKey === key) this.closeStream(stream);
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
    return [`${secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
  }
}

// ---------------------------------------------------------------------------
// Control token file

/** Content of the control token file. */
export interface ControlTokenFile {
  token: string;
  /** Port the instance listens on (the CLI only sends the token to this port). */
  port: number;
  pid: number;
}

/** Path of the control token file. */
export function controlTokenPath(dataDir: string): string {
  return path.join(dataDir, CONTROL_TOKEN_FILE);
}

/** Write the control token atomically with mode 0600 (temp file + rename in the data dir) as JSON with port and pid. */
export function writeControlToken(dataDir: string, content: ControlTokenFile): string {
  const file = controlTokenPath(dataDir);
  const tmp = path.join(dataDir, `.${CONTROL_TOKEN_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(content)}\n`);
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

/** Read a control token file; `null` if missing, unreadable or malformed. */
export function readControlToken(file: string): ControlTokenFile | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<ControlTokenFile>;
    if (typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)) return null;
    if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
    return { token: value.token, port: value.port, pid: typeof value.pid === 'number' ? value.pid : 0 };
  } catch {
    return null;
  }
}

/** Remove the control token file if it still holds `token` (a newer instance may have replaced it). */
export function removeControlToken(dataDir: string, token: string): void {
  const file = controlTokenPath(dataDir);
  if (readControlToken(file)?.token === token) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}
