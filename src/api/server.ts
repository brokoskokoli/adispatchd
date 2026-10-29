/**
 * HTTP API (Spec §15) on Fastify: `/health`, `/ready` and `/api/v1/*`
 * (documented in docs/api.md).
 *
 * Security (Spec §15, §20): authentication is optional (WI-26, `auth.mode`;
 * see auth.ts and the minimum role per route in roles.ts). With `mode: none`
 * bind to loopback (default) or run behind an authenticating proxy/VPN. Mutating requests
 * (POST/PATCH/PUT/DELETE) require the header `X-Adispatch-Request: 1`,
 * a JSON body (or none), and – if the browser sends an `Origin` – an origin
 * matching the `Host` (or an allowed origin); cross-site fetches
 * (`Sec-Fetch-Site: cross-site`) are refused. No CORS headers are ever sent,
 * so browsers cannot read API responses cross-origin and the custom header
 * forces a (failing) preflight for cross-origin writes.
 */
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isMap, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import {
  ACTIVE_STATUSES,
  TECHNICAL_STATUSES,
  TRIGGER_TYPES,
  dataPaths,
  errorMessage,
  isSecretKey,
  isValidRunId,
  jsonErrorPosition,
  noopLogger,
  parseSourceItemKey,
  REDACTED,
  redactValue,
  systemClock,
  tryParseDuration,
  type Clock,
  type Logger,
  type Redactor,
  type RunPaths,
  type SourceAdapter,
  type TechnicalStatus,
} from '../core/index.js';
import { readFileNoFollow } from '../executors/index.js';
import { activeExternalLinks, DEFAULT_DASHBOARD_LAYOUT, externalLinkFrameOrigins, loadConfig, toPublicConfig, type ConfigManager, type ReloadResult } from '../config/index.js';
import type { LifecycleEngine } from '../lifecycle/index.js';
import type { NotificationService } from '../notifications/index.js';
import type { Repositories, RunRecord } from '../persistence/index.js';
import { listKeptFiles, RUN_EVENTS, type RetentionService, type RunController } from '../runs/index.js';
import type { DashboardInfoService } from '../dashboard/index.js';
import type { ParameterOptionsService } from '../parameter-options/index.js';
import type { Scheduler } from '../scheduler/index.js';
import { DEFAULT_MAX_POINTS, downsample, MAX_POINTS, type ResourceMonitor } from '../monitoring/index.js';
import type { ViewService } from '../views/index.js';
import type { AuthRequest, AuthService, Principal } from './auth.js';
import { uiContentSecurityPolicy } from './csp.js';
import { acceptsControlToken, roleAllows, routeAccess, routeKey, type RouteAccess } from './roles.js';
import { ApiError, toErrorResponse } from './errors.js';
import { attachmentDisposition, keptContentType, keptPathSegments, openKeptFile } from './kept.js';
import { readLogPage } from './logs.js';
import { runDetailFields, toBlockView, toRunSummary, toWorkflowView, type ActionView } from './serialize.js';
import type { EventHub } from './sse.js';
import { registerItemHistoryRoutes } from './item-history.js';
import { registerUiActionRoutes, type UiActionLimits } from './ui-actions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated caller (WI-26); `null` without login or with `auth.mode: none`. */
    principal: Principal | null;
  }
  interface FastifyInstance {
    /** `"<METHOD> <url>"` of every registered route (roles test). */
    adispatchRoutes: string[];
  }
}

/** Header that every mutating request must carry (CSRF protection). */
export const CSRF_HEADER = 'x-adispatch-request';
/** Max size of `context.json`/`result.json` returned in run details. */
const MAX_JSON_FILE_BYTES = 1024 * 1024;
/** Max events embedded in the run detail (more via `/runs/:id/events`). */
const DETAIL_EVENT_LIMIT = 500;

/** Readiness of the instance (`/ready`). */
export interface ReadinessReport {
  ready: boolean;
  /**
   * There is no separate config check: an instance only runs with a fully
   * validated configuration (invalid YAML prevents the start, a failed reload
   * keeps the active configuration).
   */
  checks: { database: boolean; recovery: boolean; scheduler: boolean; shuttingDown: boolean };
}

/** Everything the API needs from the application. */
export interface ApiDeps {
  config: ConfigManager;
  repositories: Repositories;
  controller: RunController;
  scheduler: Scheduler;
  lifecycle: LifecycleEngine;
  views: ViewService;
  notifications: NotificationService;
  retention?: RetentionService;
  /** Dashboard info tiles (WI-24); absent = endpoint reports "not configured". */
  dashboard?: DashboardInfoService;
  events: EventHub;
  /** Server resource monitor (WI-23); without it `/system/metrics` reports `enabled: false`. */
  monitor?: ResourceMonitor;
  dataDir: string;
  clock?: Clock;
  logger?: Logger;
  /** Redaction of error texts (shared `SecretRedactor`). */
  redact?: Redactor;
  readiness(): ReadinessReport;
  /** Start a shutdown (drain or cancel-all) in the background; repeated calls escalate. */
  shutdown(mode: 'drain' | 'cancel', reason?: string): void;
  /** Reload the configuration (app also rebuilds adapters, invalidates caches, plans). */
  reloadConfig(): Promise<ReloadResult>;
  /** Track a background operation started by a request (awaited/aborted on shutdown). */
  background(what: string, start: (signal: AbortSignal) => Promise<unknown>): Promise<unknown>;
  /** Static info for `/status`. */
  info: { version: string; startedAt: string; host: string; port: () => number | null };
  /** Hub membership (WI-35): last known state of the shared slot limit; `null`/absent without a hub. */
  hub?: () => { workspace: string; reachable: boolean; paused: boolean; active: number; max: number } | null;
  /** Additional allowed `Origin`s for mutating requests (besides the request's own host). */
  allowedOrigins?: readonly string[];
  /** Directory with static web UI assets (WI-11), served at `/` if present. */
  uiDir?: string;
  /** Authentication (WI-26); absent = behaves like `auth.mode: none`. */
  auth?: AuthService;
  /** Per-user limits of UI actions (WI-27); defaults: UI_ACTION_LIMITS. */
  uiActionLimits?: Partial<UiActionLimits>;
  /** Source adapters by ID (UI actions, WI-27). */
  sources?: (sourceId: string) => SourceAdapter | undefined;
  /** Run-time options of enum parameters (WI-31); absent = only static `values`. */
  parameterOptions?: ParameterOptionsService;
}

// ---------------------------------------------------------------------------
// Request schemas (zod)

const idParam = z.object({ id: z.string().min(1).max(200) });
const parameterParam = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) });
const optionsQuery = z.object({ refresh: z.enum(['true', 'false']).optional() }).strict();
const numericIdParam = z.object({ id: z.coerce.number().int().positive() });
const nullableOverride = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const runtimeBody = z
  .object({
    enabled: nullableOverride(z.boolean()),
    priority: nullableOverride(z.number().finite()),
    maxConcurrent: nullableOverride(z.number().int().min(1)),
  })
  .strict();
const globalRuntimeBody = z.object({ maxConcurrent: z.number().int().min(1).nullable() }).strict();
const startBody = z
  .object({
    item: z.string().min(1).max(2000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const cancelBody = z.object({ reason: z.string().max(500).optional() }).strict();
const recoveryBody = z.object({ assumeGone: z.boolean().optional() }).strict();
const clearBody = z.object({ clearedBy: z.string().max(200).optional() }).strict();
const emptyBody = z.object({}).strict();
const loginBody = z.object({ name: z.string().min(1).max(64), password: z.string().min(1).max(1024) }).strict();
const runsQuery = z
  .object({
    /** One workflow ID or a comma-separated list (WI-32). */
    workflow: z.string().optional(),
    status: z.string().optional(),
    trigger: z.enum(TRIGGER_TYPES).optional(),
    item: z.string().optional(),
    result: z.enum(['success', 'failure']).optional(),
    active: z.enum(['true', 'false']).optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
/** `GET /api/v1/views/:id/items` (WI-32: `sections` may repeat, `limit` = rows per section/table). */
const viewItemsQuery = z
  .object({
    refresh: z.enum(['true', 'false', '1', '0']).optional(),
    sections: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(50)]).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
  })
  .strict();
const eventsQuery = z
  .object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() })
  .strict();
const logsQuery = z
  .object({
    stream: z.enum(['stdout', 'stderr']).default('stdout'),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).optional(),
    tail: z.coerce.number().int().min(0).optional(),
  })
  .strict();
const metricsQuery = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    /** Duration back from now, e.g. `1h`, `900000ms` (combined with `since`: the later start wins). */
    range: z
      .string()
      .refine((v) => tryParseDuration(v) !== undefined, 'Expected a duration such as 15m, 1h or 3600000ms')
      .optional(),
    points: z.coerce.number().int().min(10).max(MAX_POINTS).optional(),
  })
  .strict();
const sseQuery = z
  .object({ run: z.string().optional(), lastEventId: z.coerce.number().int().min(0).optional() })
  .strict();

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(400, 'invalid_request', `Invalid ${what}`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/** Wait one macrotask: errors thrown synchronously at the start of `p` (validation, busy) surface here. */
async function earlyError(p: Promise<unknown>): Promise<unknown> {
  let failed = false;
  let error: unknown;
  p.catch((err: unknown) => {
    failed = true;
    error = err;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return failed ? (error ?? new Error('failed')) : undefined;
}

/** Read a JSON file (bounded); returns `{value}` or `{error}`; `null` if missing. */
/**
 * Read a JSON file a worker may control (context, result) without following
 * symlinks or opening FIFOs (WI-19 review); parse errors report the position only.
 */
async function readJsonFile(file: string, dir: string): Promise<{ value: unknown } | { error: string } | null> {
  const read = await readFileNoFollow(file, { dir, maxBytes: MAX_JSON_FILE_BYTES, what: 'file' });
  if (read.state === 'missing') return null;
  if (read.state === 'invalid') return { error: read.error };
  try {
    return { value: JSON.parse(read.text) as unknown };
  } catch (err) {
    return { error: `not valid JSON${jsonErrorPosition(err)}` };
  }
}

/** Result file of a run: container runs (WI-19) write into `runs/<id>/out/`. */
function resultFileOf(run: RunRecord, paths: RunPaths): { file: string; dir: string } {
  const execute = (run.configSnapshot as { workflow?: { execute?: { type?: unknown } } } | null)?.workflow?.execute;
  return execute?.type === 'container'
    ? { file: path.join(paths.outDir, 'result.json'), dir: paths.outDir }
    : { file: paths.resultFile, dir: paths.runDir };
}

async function fileSize(file: string): Promise<number | null> {
  try {
    const st = await stat(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Host names always accepted (loopback access to the local instance). */
const LOOPBACK_HOST_NAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** Split `name[:port]` / `[v6][:port]` into lower-case name and port (`null` = none). */
function splitHost(value: string): { name: string; port: string | null } | null {
  const v = value.trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  return { name: m[1] as string, port: m[2] ?? null };
}

/**
 * True if the `Host` (or an `Origin`'s host) matches an allowed entry: `name`
 * matches any port, `name:port` only that port. A value without port (the
 * client used the scheme's default port, e.g. behind an HTTPS reverse proxy)
 * matches entries without port and entries with `:80` or `:443`.
 */
export function isAllowedHost(value: string, allowed: readonly string[]): boolean {
  const h = splitHost(value);
  if (!h) return false;
  return allowed.some((entry) => {
    const e = splitHost(entry);
    if (!e || e.name !== h.name) return false;
    if (e.port === null) return true;
    return h.port === null ? e.port === '80' || e.port === '443' : e.port === h.port;
  });
}

/**
 * True if `origin` (an http(s) origin) names exactly `host` (the request's
 * `Host` header). A `Host` without port matches the origin scheme's default
 * port (80/443), e.g. behind a TLS-terminating reverse proxy.
 */
export function originMatchesHost(origin: string, host: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const o = splitHost(url.host);
  const h = splitHost(host);
  if (!o || !h || o.name !== h.name) return false;
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  return (o.port ?? defaultPort) === (h.port ?? defaultPort);
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/** Create the Fastify instance with all routes (not listening yet). */
export async function createApiServer(deps: ApiDeps): Promise<FastifyInstance> {
  const logger = (deps.logger ?? noopLogger).child({ component: 'api' });
  const clock = deps.clock ?? systemClock;
  const redact = deps.redact ?? ((s: string) => s);
  const repos = deps.repositories;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, return503OnClosing: true });

  // Only JSON bodies (an empty body is allowed); no text/plain or form parsers (CSRF "simple requests").
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
    }
  });

  // --- Security hooks -------------------------------------------------------
  const allowedHosts = (): readonly string[] => {
    const bind = deps.info.host.toLowerCase();
    const extra = deps.config.current.global.server.allowedHosts;
    const bindName = bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind;
    const wildcard = bind === '0.0.0.0' || bind === '::' || bind === '[::]';
    return [...LOOPBACK_HOST_NAMES, ...(wildcard || isLoopbackHost(bind) ? [] : [bindName]), ...extra];
  };
  app.addHook('onRequest', async (req) => {
    // DNS-rebinding protection for ALL requests (incl. GET, SSE, static UI): the Host header must name this server.
    const host = req.headers.host;
    if (typeof host !== 'string' || !isAllowedHost(host, allowedHosts())) {
      throw new ApiError(421, 'host_not_allowed', 'Host header is not allowed (configure server.allowed_hosts for reverse proxies)');
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      // Same-origin only: the Origin (scheme default port applied) must name exactly the requested host and port.
      const allowed = (deps.allowedOrigins ?? []).includes(origin) || originMatchesHost(origin, host);
      if (!allowed) throw new ApiError(403, 'origin_not_allowed', 'Request origin is not allowed');
    }
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.method === 'OPTIONS') throw new ApiError(405, 'method_not_allowed', 'CORS preflight is not supported');
    if (req.headers[CSRF_HEADER] !== '1') {
      throw new ApiError(403, 'csrf_header_missing', `Mutating requests require the header "X-Adispatch-Request: 1"`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, 'cross_site_request', 'Cross-site requests are not allowed');
    }
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (hasBody && type !== 'application/json') {
      throw new ApiError(415, 'unsupported_media_type', 'Request bodies must be application/json');
    }
  });
  // --- Authentication / roles (WI-26) ---------------------------------------
  // Every route needs an entry in ROUTE_ROLES (roles.ts): registering one without fails here.
  app.decorate('adispatchRoutes', [] as string[]);
  app.decorateRequest('principal', null);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (routeAccess(method, route.url) === undefined) {
        throw new Error(`Route ${routeKey(method, route.url)} has no minimum role (add it to ROUTE_ROLES in src/api/roles.ts and docs/api.md)`);
      }
      app.adispatchRoutes.push(`${method} ${route.url}`);
    }
  });
  const authRequest = (req: FastifyRequest): AuthRequest => ({
    headers: req.headers,
    remoteAddress: req.raw.socket?.remoteAddress,
    encrypted: (req.raw.socket as { encrypted?: boolean } | undefined)?.encrypted === true,
  });
  const accessOf = (req: FastifyRequest): RouteAccess => {
    const url = req.routeOptions.url;
    const isApiPath = (req.url.split('?')[0] ?? '').startsWith('/api/');
    // Unknown API paths need a login – also when the static UI's catch-all route `/*` matched them.
    if (url === undefined || (url === '/*' && isApiPath)) return isApiPath ? 'viewer' : 'public';
    return routeAccess(req.method, url) ?? 'viewer';
  };
  const authEnabled = (): boolean => deps.auth?.enabled === true;
  app.addHook('onRequest', async (req) => {
    const auth = deps.auth;
    if (!auth || !auth.enabled) return;
    const access = accessOf(req);
    const resolved = auth.resolve(authRequest(req));
    if (!resolved.ok) {
      if (access === 'public') return;
      throw new ApiError(resolved.status, resolved.code, resolved.message);
    }
    let principal = resolved.principal;
    if (!principal && !auth.config.readRequiresLogin && (req.method === 'GET' || req.method === 'HEAD')) {
      principal = { name: 'anonymous', role: 'viewer', via: 'anonymous' };
    }
    req.principal = principal;
    if (access === 'public') return;
    if (!principal) throw new ApiError(401, 'authentication_required', 'Login required');
    // The control token (readable by workers of the service user) only works on the CLI routes.
    const url = req.routeOptions.url;
    if (principal.via === 'control_token' && (url === undefined || url === '/*' || !acceptsControlToken(req.method, url))) {
      throw new ApiError(403, 'control_token_not_allowed', 'The control token is only accepted for the CLI control commands');
    }
    if (!roleAllows(principal.role, access)) {
      throw new ApiError(403, 'forbidden', `This action requires the role "${access}" (your role: "${principal.role}")`, { requiredRole: access, role: principal.role });
    }
  });
  /** The authenticated user behind a request (never the anonymous reader). */
  const actorOf = (req: FastifyRequest): Principal | null => (req.principal && req.principal.via !== 'anonymous' ? req.principal : null);
  /** Audit (WI-26): record the user on the run's events. */
  const auditRun = (req: FastifyRequest, runId: string, action: string, extra: Record<string, unknown> = {}): void => {
    const actor = actorOf(req);
    if (!actor) return;
    deps.controller.recordUserAction(runId, { action, actor: actor.name, role: actor.role, via: actor.via, ...extra });
  };
  app.addHook('onResponse', async (req, reply) => {
    // Audit (WI-26): every write by an authenticated user in the daemon log (no bodies).
    const actor = actorOf(req);
    if (!actor || req.method === 'GET' || req.method === 'HEAD') return;
    logger.info('api write', {
      actor: actor.name,
      role: actor.role,
      via: actor.via,
      method: req.method,
      route: req.routeOptions.url ?? null,
      path: req.url.split('?')[0] ?? '',
      status: reply.statusCode,
    });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    const pathname = req.url.split('?')[0] ?? '';
    if (pathname.startsWith('/api/') || pathname === '/health' || pathname === '/ready') reply.header('cache-control', 'no-store');
    else if (!reply.hasHeader('content-security-policy')) {
      // Web UI: frame-src follows the active configuration (updated by every reload).
      reply.header('content-security-policy', uiContentSecurityPolicy(externalLinkFrameOrigins(deps.config.current.global)));
    }
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err, redact);
    if (status >= 500) logger.error('request failed', { method: req.method, url: req.url, error: err });
    else logger.debug('request rejected', { method: req.method, url: req.url, code: body.error.code });
    void reply.status(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found` } });
  });

  // --- Helpers --------------------------------------------------------------
  const requireRun = (id: string): RunRecord => {
    const run = repos.runs.get(id);
    if (!run) throw new ApiError(404, 'not_found', `Run '${id}' not found`);
    return run;
  };
  const accepted = (reply: FastifyReply, body: unknown): unknown => reply.status(202).send(body);
  const runPaths = (id: string) => {
    if (!isValidRunId(id)) return null;
    return dataPaths(deps.dataDir).run(id);
  };

  // --- Health / readiness ---------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', time: clock.now().toISOString() }));
  app.get('/ready', async (req, reply) => {
    const r = deps.readiness();
    // With authentication only logged-in callers see the individual checks.
    const body = authEnabled() && !req.principal ? { ready: r.ready } : r;
    return reply.status(r.ready ? 200 : 503).send(body);
  });

  // --- Authentication (WI-26) -----------------------------------------------
  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = parse(loginBody, req.body, 'body');
    const auth = deps.auth;
    if (!auth || !auth.enabled) throw new ApiError(400, 'login_not_available', 'Login is only available with auth.mode: password');
    const res = await auth.login(body.name, body.password, authRequest(req));
    if (!res.ok) {
      if (res.retryAfterMs !== undefined) void reply.header('retry-after', String(Math.max(1, Math.ceil(res.retryAfterMs / 1000))));
      throw new ApiError(res.status, res.code, res.message);
    }
    void reply.header('set-cookie', res.cookie);
    return { user: { name: res.principal.name, role: res.principal.role, via: res.principal.via }, expiresAt: res.expiresAt };
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    parse(emptyBody, req.body, 'body');
    if (deps.auth?.enabled && deps.auth.config.mode === 'password') void reply.header('set-cookie', deps.auth.logout(authRequest(req)));
    return { ok: true };
  });
  app.get('/api/v1/auth/me', async (req) => {
    const auth = deps.auth;
    if (!auth || !auth.enabled) return { mode: 'none', readRequiresLogin: false, user: null, role: 'admin', expiresAt: null, error: null };
    const resolved = auth.resolve(authRequest(req));
    const p = req.principal;
    return {
      mode: auth.config.mode,
      readRequiresLogin: auth.config.readRequiresLogin,
      user: p && p.via !== 'anonymous' ? { name: p.name, role: p.role, via: p.via } : null,
      role: p?.role ?? null,
      expiresAt: auth.sessionExpiry(p),
      error: resolved.ok ? null : { status: resolved.status, code: resolved.code, message: resolved.message },
    };
  });

  // --- Status / scheduler / shutdown ----------------------------------------
  app.get('/api/v1/status', async () => statusBody());

  function statusBody(): Record<string, unknown> {
    const s = deps.controller.status;
    const cfg = deps.config.current;
    const byWorkflow: Record<string, { active: number; max: number }> = {};
    for (const wf of deps.config.listWorkflows()) {
      byWorkflow[wf.config.id] = { active: repos.runs.countActive(wf.config.id), max: wf.maxConcurrent };
    }
    const recoveryPending = repos.runs.list({ statuses: ['recovery_pending'], limit: 1 }).total;
    const last = deps.scheduler.lastPlanningStep();
    const overrides = deps.config.getOverrides();
    const state = !s.ready ? 'recovering' : s.stopping ? 'stopping' : s.draining ? 'draining' : s.paused ? 'paused' : 'running';
    const host = deps.info.host;
    const hubInfo = deps.hub?.() ?? null;
    return {
      version: deps.info.version,
      startedAt: deps.info.startedAt,
      time: clock.now().toISOString(),
      readiness: deps.readiness(),
      scheduler: {
        state,
        ready: s.ready,
        paused: s.paused,
        draining: s.draining,
        stopping: s.stopping,
        pollingIntervalMs: cfg.global.scheduler.pollingIntervalMs,
        lastPlanningStep: last
          ? { startedAt: last.startedAt, finishedAt: last.finishedAt, skipped: last.skipped, startedRunIds: last.startedRunIds }
          : null,
      },
      limits: {
        maxConcurrent: deps.config.maxConcurrent,
        configuredMaxConcurrent: cfg.global.scheduler.maxConcurrent,
        override: overrides.global.maxConcurrent ?? null,
      },
      usage: {
        activeRuns: repos.runs.countActive(),
        supervisedRuns: s.activeRuns,
        recoveryPending,
        byWorkflow,
      },
      counts: {
        activeBlocks: repos.blocks.listActive().length,
        failedActions: repos.actions.listFailed().length,
        notifications: repos.notifications.countByState(),
      },
      config: { version: cfg.version, hash: cfg.hash, loadedAt: cfg.loadedAt, configDir: cfg.configDir },
      server: { host, port: deps.info.port(), loopback: isLoopbackHost(host) },
      ...(hubInfo ? { hub: hubInfo } : {}),
      sse: { clients: deps.events.clientCount },
      retention: deps.retention?.lastReport
        ? {
            lastRunAt: deps.retention.lastReport.finishedAt,
            deletedRuns: deps.retention.lastReport.deletedRuns,
            errors: deps.retention.lastReport.errors.length,
          }
        : null,
    };
  }

  app.post('/api/v1/scheduler/pause', async (req) => {
    parse(emptyBody, req.body, 'body');
    deps.controller.pause();
    return statusBody();
  });
  app.post('/api/v1/scheduler/resume', async (req) => {
    parse(emptyBody, req.body, 'body');
    deps.controller.resume();
    void deps.scheduler.planOnce().catch((err: unknown) => logger.warn('planning after resume failed', { error: errorMessage(err) }));
    return statusBody();
  });
  app.patch('/api/v1/scheduler/runtime', async (req) => {
    const body = parse(globalRuntimeBody, req.body, 'body');
    deps.config.setGlobalMaxConcurrent(body.maxConcurrent ?? undefined);
    void deps.scheduler.planOnce().catch(() => undefined);
    return statusBody();
  });
  app.post('/api/v1/shutdown/drain', async (req, reply) => {
    parse(emptyBody, req.body, 'body');
    deps.shutdown('drain');
    return accepted(reply, { accepted: true, mode: 'drain', activeRuns: deps.controller.activeRunIds() });
  });
  app.post('/api/v1/shutdown/cancel-all', async (req, reply) => {
    parse(cancelBody, req.body, 'body');
    const body = (req.body ?? {}) as { reason?: string };
    deps.shutdown('cancel', body.reason);
    return accepted(reply, { accepted: true, mode: 'cancel', activeRuns: deps.controller.activeRunIds() });
  });

  // --- Workflows ------------------------------------------------------------
  const workflowView = (id: string, detail: boolean): Record<string, unknown> => {
    const wf = deps.config.getWorkflow(id);
    if (!wf) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${id}"`);
    const cron = deps.scheduler.cronStatus().find((c) => c.workflowId === id) ?? null;
    const diagnosis = deps.scheduler.lastDiagnosis(id);
    const view = toWorkflowView(wf, {
      activeRuns: repos.runs.countActive(id),
      activeBlocks: repos.blocks.listForWorkflow(id).filter((b) => b.clearedAt === null).length,
      cron,
      diagnosis,
      conditionStatus: deps.scheduler.conditionStatus(id),
      configDir: deps.config.current.configDir,
      redact,
    });
    return detail ? { ...view, diagnosis: diagnosis ?? null, filter: wf.config.filter, hooks: wf.config.hooks } : view;
  };
  app.get('/api/v1/workflows', async () => ({
    workflows: deps.config.listWorkflows().map((wf) => workflowView(wf.config.id, false)),
    overrides: deps.config.getOverrides(),
  }));
  app.get('/api/v1/workflows/:id', async (req) => workflowView(parse(idParam, req.params, 'path').id, true));
  app.patch('/api/v1/workflows/:id/runtime', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(runtimeBody, req.body, 'body');
    if (!deps.config.getWorkflow(id)) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${id}"`);
    const overrides: Record<string, unknown> = {};
    for (const key of ['enabled', 'priority', 'maxConcurrent'] as const) {
      if (key in body) overrides[key] = body[key] ?? undefined; // null resets to the YAML value
    }
    deps.config.setWorkflowOverrides(id, overrides);
    void deps.scheduler.planOnce().catch(() => undefined);
    return workflowView(id, false);
  });
  app.post('/api/v1/workflows/:id/start', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(startBody, req.body, 'body');
    const result = await deps.scheduler.startManual(id, {
      ...(body.item !== undefined ? { itemRef: body.item } : {}),
      ...(body.parameters !== undefined ? { parameters: body.parameters } : {}),
    });
    result.done.catch((err: unknown) => logger.warn('manual run supervision failed', { runId: result.run.id, error: errorMessage(err) }));
    auditRun(req, result.run.id, 'start');
    return accepted(reply, { run: toRunSummary(repos.runs.get(result.run.id) ?? result.run) });
  });
  app.get('/api/v1/workflows/:id/parameters/:name/options', async (req) => {
    const { id, name } = parse(parameterParam, req.params, 'path');
    const q = parse(optionsQuery, req.query, 'query');
    const wf = deps.config.getWorkflow(id);
    if (!wf) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${id}"`);
    const def = Object.hasOwn(wf.config.parameters, name) ? wf.config.parameters[name] : undefined;
    if (!def) throw new ApiError(404, 'unknown_parameter', `Workflow "${id}" has no parameter "${name}"`);
    if (def.type !== 'enum') throw new ApiError(400, 'parameter_has_no_options', `Parameter "${name}" is of type "${def.type}" and has no options`);
    // A script runs for `options_from.command`: only roles that may start runs (viewers must not trigger scripts).
    if (def.optionsFrom?.type === 'command' && authEnabled() && !roleAllows(req.principal?.role ?? null, 'operator')) {
      const role = req.principal?.role ?? null;
      throw new ApiError(403, 'forbidden', `Options of "${name}" come from a script and require the role "operator" (your role: "${role ?? 'none'}")`, {
        requiredRole: 'operator',
        role,
      });
    }
    if (!def.optionsFrom || !deps.parameterOptions) {
      if (def.optionsFrom) throw new ApiError(503, 'not_ready', 'Parameter options are not available');
      return { options: def.values.map((v) => ({ value: v, label: v })), fetchedAt: null, cached: false, allowCustom: def.allowCustom === true };
    }
    // `refresh` (bypassing the cache) only for roles that may start runs: viewers get the cached result (rate limits).
    const mayRefresh = !authEnabled() || roleAllows(req.principal?.role ?? null, 'operator');
    return deps.parameterOptions.get(wf.config, name, { refresh: q.refresh === 'true' && mayRefresh });
  });
  app.post('/api/v1/workflows/:id/dry-run', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    parse(emptyBody, req.body, 'body');
    if (!deps.config.getWorkflow(id)) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${id}"`);
    return deps.scheduler.dryRun(id);
  });

  // --- Runs -----------------------------------------------------------------
  app.get('/api/v1/runs', async (req) => {
    const q = parse(runsQuery, req.query, 'query');
    let statuses: TechnicalStatus[] | undefined;
    if (q.status) {
      statuses = q.status.split(',').map((s) => s.trim()) as TechnicalStatus[];
      const invalid = statuses.filter((s) => !(TECHNICAL_STATUSES as readonly string[]).includes(s));
      if (invalid.length > 0) throw new ApiError(400, 'invalid_request', `Unknown status: ${invalid.join(', ')}`);
    }
    if (q.active === 'true') statuses = statuses ? statuses.filter((s) => ACTIVE_STATUSES.includes(s as never)) : [...ACTIVE_STATUSES];
    if (q.active === 'false') {
      const terminal = TECHNICAL_STATUSES.filter((s) => !(ACTIVE_STATUSES as readonly string[]).includes(s));
      statuses = statuses ? statuses.filter((s) => terminal.includes(s)) : [...terminal];
    }
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    if (statuses && statuses.length === 0) return { runs: [], total: 0, limit, offset };
    const workflows = q.workflow ? [...new Set(q.workflow.split(',').map((w) => w.trim()).filter((w) => w !== ''))] : [];
    const page = repos.runs.list({
      ...(workflows.length === 1 ? { workflowId: workflows[0] } : workflows.length > 1 ? { workflowIds: workflows } : {}),
      ...(statuses ? { statuses } : {}),
      ...(q.trigger ? { triggerType: q.trigger } : {}),
      ...(q.item ? { sourceItemKey: q.item } : {}),
      ...(q.result ? { businessResult: q.result } : {}),
      ...(q.before ? { createdBefore: q.before } : {}),
      limit,
      offset,
    });
    return { runs: page.runs.map(toRunSummary), total: page.total, limit, offset };
  });

  app.get('/api/v1/runs/:id', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const run = requireRun(id);
    const paths = runPaths(id);
    const [input, resultFile, stdoutSize, stderrSize] = paths
      ? await Promise.all([
          readJsonFile(paths.contextFile, paths.runDir),
          readJsonFile(resultFileOf(run, paths).file, resultFileOf(run, paths).dir),
          fileSize(paths.stdoutLog),
          fileSize(paths.stderrLog),
        ])
      : [null, null, null, null];
    const actions: ActionView[] = repos.actions.listForRun(id).map((a) => ({ ...a, attemptsDetail: repos.actions.listAttempts(a.id) }));
    const allEvents = repos.events.listForRun(id);
    const events = allEvents.slice(0, DETAIL_EVENT_LIMIT + 1);
    const truncatedStreams = new Set(
      allEvents
        .filter((e) => e.type === 'diagnostic.log_truncated')
        .map((e) => String(e.payload.stream ?? (e.payload.details as { stream?: unknown } | undefined)?.stream ?? '')),
    );
    const block = repos.blocks.activeFor(run.workflowId, run.sourceItemKey);
    const retryBlock = run.triggerType === 'unblock' ? repos.blocks.clearedByRun(id) : repos.blocks.createdByRun(id);
    const keptEvent = allEvents.findLast((e) => e.type === RUN_EVENTS.keptFiles);
    return redactValue(
      {
        ...toRunSummary(run),
        ...runDetailFields(run),
        input: input && 'value' in input ? input.value : null,
        inputError: input && 'error' in input ? input.error : null,
        resultFile: resultFile && 'value' in resultFile ? resultFile.value : null,
        resultFileError: resultFile && 'error' in resultFile ? resultFile.error : null,
        actions,
        events: events.slice(0, DETAIL_EVENT_LIMIT),
        eventsTruncated: events.length > DETAIL_EVENT_LIMIT,
        logs: {
          stdout: { size: stdoutSize, truncated: truncatedStreams.has('stdout') },
          stderr: { size: stderrSize, truncated: truncatedStreams.has('stderr') },
        },
        block: block ? toBlockView(block, { affectedRunIds: repos.blocks.affectedRunIds(block.id), sourceUrl: run.sourceUrl, workflowName: null }) : null,
        // WI-30: the block whose removal started this lifecycle run, or the block this run created.
        retryBlock: retryBlock ? toBlockView(retryBlock, { affectedRunIds: repos.blocks.affectedRunIds(retryBlock.id), sourceUrl: run.sourceUrl, workflowName: null }) : null,
        kept: keptEvent ? keptSummary(keptEvent.payload) : null,
        supervised: deps.controller.activeRunIds().includes(id),
      },
      redact,
    );
  });

  app.get('/api/v1/runs/:id/events', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const q = parse(eventsQuery, req.query, 'query');
    requireRun(id);
    const limit = q.limit ?? 1000;
    const events = repos.events.listForRun(id, { afterSequence: q.after ?? 0, limit: limit + 1 });
    const page = events.slice(0, limit);
    return { events: page, hasMore: events.length > limit, nextAfter: page.at(-1)?.sequence ?? q.after ?? 0 };
  });

  app.get('/api/v1/runs/:id/logs', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const q = parse(logsQuery, req.query, 'query');
    const run = requireRun(id);
    const paths = runPaths(id);
    if (!paths) throw new ApiError(404, 'not_found', 'No logs for this run');
    const file = q.stream === 'stdout' ? paths.stdoutLog : paths.stderrLog;
    const page = await readLogPage(file, q.stream, {
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.tail !== undefined ? { tail: q.tail } : {}),
    });
    return { runId: id, active: (ACTIVE_STATUSES as readonly string[]).includes(run.status), ...page };
  });

  // Kept files (WI-22): listing and download of `runs/<id>/kept/`.
  app.get('/api/v1/runs/:id/kept', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    requireRun(id);
    const paths = runPaths(id);
    const listing = paths ? await listKeptFiles(paths.keptDir) : { files: [], truncated: false };
    const keptEvent = repos.events.listForRun(id).findLast((e) => e.type === RUN_EVENTS.keptFiles);
    return redactValue(
      {
        runId: id,
        files: listing.files,
        totalBytes: listing.files.reduce((sum, f) => sum + f.size, 0),
        truncated: listing.truncated,
        report: keptEvent ? keptEvent.payload : null,
      },
      redact,
    );
  });
  app.get('/api/v1/runs/:id/kept/*', async (req, reply) => {
    const params = req.params as { id?: unknown; '*'?: unknown };
    const { id } = parse(idParam, { id: params.id }, 'path');
    requireRun(id);
    const segments = keptPathSegments(typeof params['*'] === 'string' ? params['*'] : '');
    const paths = runPaths(id);
    if (!paths) throw new ApiError(404, 'not_found', 'Kept file not found');
    const file = await openKeptFile(paths.keptDir, segments);
    void reply
      .header('content-type', keptContentType(file.name))
      .header('content-disposition', attachmentDisposition(file.name))
      .header('content-length', String(file.size))
      .header('content-security-policy', "default-src 'none'; sandbox");
    if (file.size === 0) {
      await file.handle.close();
      return reply.send('');
    }
    // Exactly the size seen at open time; the stream closes the handle.
    return reply.send(createReadStream('', { fd: file.handle, start: 0, end: file.size - 1 }));
  });

  app.post('/api/v1/runs/:id/cancel', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(cancelBody, req.body, 'body');
    requireRun(id);
    const actor = actorOf(req);
    const r = deps.controller.requestCancel(id, { reason: body.reason ?? (actor ? `cancelled via API by ${actor.name}` : 'cancelled via API') });
    auditRun(req, id, 'cancel', body.reason ? { reason: body.reason } : {});
    return accepted(reply, { runId: r.runId, status: r.status, run: toRunSummary(requireRun(id)) });
  });

  app.post('/api/v1/runs/:id/recovery/retry', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(recoveryBody, req.body, 'body');
    requireRun(id);
    const op = deps.background(`recovery retry ${id}`, () => deps.controller.retryRecovery(id, { assumeGone: body.assumeGone === true }));
    const error = await earlyError(op);
    if (error) throw error;
    // The finalized run released its lock (e.g. a recovered unblock run, WI-30): plan without waiting for the next poll.
    void op.then(() => deps.scheduler.planOnce()).catch(() => undefined);
    auditRun(req, id, 'recovery_retry', { assumeGone: body.assumeGone === true });
    return accepted(reply, { accepted: true, run: toRunSummary(requireRun(id)) });
  });

  // --- Blocks ---------------------------------------------------------------
  const blockView = (blockId: number) => {
    const block = repos.blocks.get(blockId);
    if (!block) throw new ApiError(404, 'not_found', `Block ${blockId} not found`);
    const run = block.runId ? repos.runs.get(block.runId) : null;
    const wf = deps.config.getWorkflow(block.workflowId);
    return toBlockView(block, {
      affectedRunIds: repos.blocks.affectedRunIds(block.id),
      sourceUrl: run?.sourceUrl ?? null,
      workflowName: wf?.config.name ?? null,
    });
  };
  app.get('/api/v1/blocks', async (req) => {
    const q = parse(z.object({ workflow: z.string().optional() }).strict(), req.query, 'query');
    const blocks = repos.blocks.listActive().filter((b) => !q.workflow || b.workflowId === q.workflow);
    return { blocks: blocks.map((b) => blockView(b.id)) };
  });
  app.post('/api/v1/blocks/:id/clear', async (req) => {
    const { id } = parse(numericIdParam, req.params, 'path');
    const body = parse(clearBody, req.body, 'body');
    if (!repos.blocks.get(id)) throw new ApiError(404, 'not_found', `Block ${id} not found`);
    // With authentication the logged-in user is recorded (WI-26 audit), not a client-supplied name.
    const actor = actorOf(req);
    const existing = repos.blocks.get(id);
    // WI-30: `on_retry_unblock` runs with the workflow configuration loaded now (no hook if the workflow is gone).
    const wf = existing && existing.clearedAt === null ? deps.config.getWorkflow(existing.workflowId) : undefined;
    let snapshot = null;
    if (wf && existing) {
      try {
        snapshot = deps.config.snapshotWorkflow(existing.workflowId, existing.itemKey ? parseSourceItemKey(existing.itemKey).sourceId : undefined);
      } catch (err) {
        // E.g. the item's source is no longer a trigger source of the workflow: remove without on_retry_unblock.
        logger.warn('on_retry_unblock skipped: no snapshot of the workflow', { blockId: id, error: errorMessage(err) });
      }
    }
    const block = deps.controller.clearBlock(id, actor ? actor.name : (body.clearedBy ?? 'api'), { snapshot });
    const runId = existing?.clearedAt === null ? block.clearedRunId : null;
    void deps.scheduler.planOnce().catch(() => undefined);
    // Plan again once the lifecycle run released the item lock.
    if (runId) void deps.controller.whenSupervisionEnds(runId)?.then(() => deps.scheduler.planOnce()).catch(() => undefined);
    return { block: blockView(id), runId };
  });

  // --- Lifecycle actions ----------------------------------------------------
  app.get('/api/v1/actions/failed', async () => ({
    actions: repos.actions.listFailed().map((a) => {
      const run = repos.runs.get(a.runId);
      return {
        ...a,
        attemptsDetail: repos.actions.listAttempts(a.id),
        run: run ? toRunSummary(run) : null,
        busy: deps.lifecycle.isBusy(a.runId),
      };
    }),
  }));
  const actionOp = async (req: FastifyRequest, reply: FastifyReply, kind: 'retry' | 'skip') => {
    const { id } = parse(numericIdParam, req.params, 'path');
    parse(emptyBody, req.body, 'body');
    const action = repos.actions.get(id);
    if (!action) throw new ApiError(404, 'not_found', `Action ${id} not found`);
    const op = deps.background(`action ${kind} ${id}`, (signal) =>
      kind === 'retry' ? deps.lifecycle.retryAction(id, { signal }) : deps.lifecycle.skipAction(id, { signal }),
    );
    const error = await earlyError(op);
    if (error) throw error;
    auditRun(req, action.runId, kind === 'retry' ? 'action_retry' : 'action_skip', { actionId: id });
    return accepted(reply, { accepted: true, action: repos.actions.get(id) });
  };
  app.post('/api/v1/actions/:id/retry', async (req, reply) => actionOp(req, reply, 'retry'));
  app.post('/api/v1/actions/:id/skip', async (req, reply) => actionOp(req, reply, 'skip'));

  // --- Views ----------------------------------------------------------------
  app.get('/api/v1/views', async () => ({ views: deps.views.list() }));
  app.get('/api/v1/views/:id', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const view = deps.views.get(id);
    if (!view) throw new ApiError(404, 'view_not_found', `Unknown view "${id}"`);
    return view;
  });
  app.get('/api/v1/views/:id/items', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const q = parse(viewItemsQuery, req.query, 'query');
    const sections = q.sections === undefined ? undefined : Array.isArray(q.sections) ? q.sections : [q.sections];
    if (sections) {
      const view = deps.views.get(id);
      if (!view) throw new ApiError(404, 'view_not_found', `Unknown view "${id}"`);
      const titles = view.sections?.map((s) => s.title) ?? null;
      if (!titles) throw new ApiError(400, 'invalid_request', `View "${id}" has no sections`);
      const unknown = sections.filter((s) => !titles.includes(s));
      if (unknown.length > 0) throw new ApiError(400, 'invalid_request', `Unknown section(s) of view "${id}": ${unknown.map((s) => `"${s}"`).join(', ')}`);
    }
    const result = await deps.views.items(id, {
      refresh: q.refresh === 'true' || q.refresh === '1',
      ...(sections ? { sections } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { ...result, errors: result.errors.map((e) => ({ sourceId: e.sourceId, message: redact(e.message) })) };
  });

  // --- Configuration --------------------------------------------------------
  app.get('/api/v1/config', async () => {
    const cfg = toPublicConfig(deps.config.current);
    return { config: cfg, overrides: deps.config.getOverrides(), externalLinks: activeExternalLinks(deps.config.current.global) };
  });
  app.get('/api/v1/config/files', async () => ({ files: await readConfigFiles(deps.config.current.configDir, redact) }));
  app.post('/api/v1/config/validate', async (req) => {
    parse(emptyBody, req.body, 'body');
    const res = await loadConfig(deps.config.current.configDir, { dataDir: deps.dataDir, version: deps.config.current.version + 1 });
    return res.ok ? { ok: true, errors: [], warnings: res.warnings, hash: res.config.hash } : { ok: false, errors: res.errors, warnings: res.warnings };
  });
  app.post('/api/v1/config/reload', async (req, reply) => {
    parse(emptyBody, req.body, 'body');
    const res = await deps.reloadConfig();
    if (!res.ok) {
      return reply.status(422).send({
        error: { code: 'config_invalid', message: `Configuration is invalid (${res.errors.length} error(s)); the active configuration was kept`, details: { errors: res.errors, warnings: res.warnings } },
      });
    }
    return {
      ok: true,
      version: res.config.version,
      hash: res.config.hash,
      changed: res.changed,
      diff: res.diff,
      resetOverrides: res.resetOverrides,
      warnings: res.warnings,
    };
  });

  // --- Dashboard info tiles (WI-24) -------------------------------------------
  // Reading never starts a script; only the throttled refresh POST does (CSRF/Host/Origin rules as for every POST).
  // WI-32: layout of the dashboard (normalized; the default layout without `layout` in dashboard.yaml).
  app.get('/api/v1/dashboard', async () => {
    const layout = deps.config.current.dashboard?.layout ?? null;
    return { configured: layout !== null, layout: layout ?? DEFAULT_DASHBOARD_LAYOUT };
  });
  app.get('/api/v1/dashboard/info', async () => {
    const configured = deps.dashboard?.configured ?? false;
    return { configured, file: configured ? 'dashboard.yaml' : null, info: deps.dashboard?.list() ?? [] };
  });
  app.post('/api/v1/dashboard/info/:id/refresh', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    parse(emptyBody, req.body, 'body');
    const res = deps.dashboard?.refresh(id) ?? ({ ok: false, reason: 'not_found' } as const);
    if (!res.ok) {
      if (res.reason === 'not_found') throw new ApiError(404, 'not_found', `Unknown info tile "${id}"`);
      if (res.reason === 'stopped') throw new ApiError(503, 'shutting_down', 'Server is shutting down');
      const seconds = Math.max(1, Math.ceil(res.retryAfterMs / 1000));
      void reply.header('retry-after', String(seconds));
      throw new ApiError(429, 'rate_limited', `Refresh of "${id}" is throttled; try again in ${seconds}s`, { retryAfterMs: res.retryAfterMs });
    }
    return accepted(reply, { accepted: true, alreadyRunning: res.alreadyRunning, tile: res.tile });
  });

  // --- Notifications --------------------------------------------------------
  app.get('/api/v1/notifications', async (req) => {
    const q = parse(
      z
        .object({
          state: z.enum(['pending', 'delivered', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .strict(),
      req.query,
      'query',
    );
    return {
      notifications: deps.notifications.list({ ...(q.state ? { state: q.state } : {}), limit: q.limit ?? 100, offset: q.offset ?? 0 }),
      counts: repos.notifications.countByState(),
    };
  });
  app.post('/api/v1/notifications/:id/retry', async (req, reply) => {
    const { id } = parse(numericIdParam, req.params, 'path');
    parse(emptyBody, req.body, 'body');
    const res = deps.notifications.retry(id);
    if (!res) throw new ApiError(404, 'not_found', `Notification ${id} not found`);
    return accepted(reply, res);
  });

  // --- UI actions as an identity (WI-27) ------------------------------------
  registerUiActionRoutes(app, {
    config: deps.config,
    repositories: repos,
    ...(deps.sources ? { sources: deps.sources } : {}),
    redact,
    logger,
    clock,
    ...(deps.uiActionLimits ? { limits: deps.uiActionLimits } : {}),
    authEnabled,
  });

  // --- Item history (WI-33) --------------------------------------------------
  registerItemHistoryRoutes(app, {
    config: deps.config,
    repositories: repos,
    ...(deps.sources ? { sources: deps.sources } : {}),
    redact,
    logger,
    clock,
  });

  // --- System resources (WI-23) ---------------------------------------------
  app.get('/api/v1/system/metrics', async (req) => {
    const q = parse(metricsQuery, req.query, 'query');
    const monitor = deps.monitor;
    const settings = monitor?.settings ?? { ...deps.config.current.global.monitoring, enabled: false };
    const enabled = monitor !== undefined && settings.enabled;
    let sinceMs = q.since ? Date.parse(q.since) : -Infinity;
    if (q.range) sinceMs = Math.max(sinceMs, clock.now().getTime() - (tryParseDuration(q.range) ?? 0));
    const raw = enabled && monitor ? monitor.list(Number.isFinite(sinceMs) ? new Date(sinceMs) : undefined) : [];
    // Bounded payload: at most `points` (default 600) bucket averages.
    const { samples, bucketMs } = downsample(raw, q.points ?? DEFAULT_MAX_POINTS);
    return { enabled, intervalMs: settings.intervalMs, retentionMs: settings.retentionMs, bucketMs, samples };
  });

  // --- SSE --------------------------------------------------------------------
  app.get('/api/v1/events', async (req, reply) => {
    const q = parse(sseQuery, req.query, 'query');
    const header = req.headers['last-event-id'];
    const fromHeader = typeof header === 'string' && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
    const lastEventId = fromHeader ?? q.lastEventId ?? null;
    if (q.run) requireRun(q.run);
    // Logout, session expiry or a reload that removes the user closes the stream (WI-26); the reconnect then fails.
    if (req.principal && deps.auth) {
      const off = deps.auth.registerStream(req.principal, () => reply.raw.end());
      reply.raw.on('close', off);
    }
    reply.hijack();
    deps.events.handle(req.raw, reply.raw, { runId: q.run ?? null, lastEventId });
  });

  // --- Static web UI (WI-11) --------------------------------------------------
  if (deps.uiDir && existsSync(deps.uiDir)) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: path.resolve(deps.uiDir), prefix: '/', index: ['index.html'] });
  }

  return app;
}

/** YAML files of the config dir (read-only display); literal secrets known to the redactor are masked. */
async function readConfigFiles(configDir: string, redact: Redactor): Promise<Array<{ file: string; content: string | null; error?: string }>> {
  const { readdir } = await import('node:fs/promises');
  const files: string[] = [];
  for (const top of ['config.yaml', 'sources.yaml', 'identities.yaml', 'dashboard.yaml']) if (existsSync(path.join(configDir, top))) files.push(top);
  for (const sub of ['workflows', 'views', 'filters']) {
    try {
      const names = (await readdir(path.join(configDir, sub))).filter((n) => /\.ya?ml$/.test(n)).sort();
      for (const n of names) files.push(`${sub}/${n}`);
    } catch {
      // directory missing
    }
  }
  return Promise.all(
    files.map(async (file) => {
      try {
        const st = await stat(path.join(configDir, file));
        if (st.size > 1024 * 1024) return { file, content: null, error: 'file too large' };
        const masked = redactYaml(await readFile(path.join(configDir, file), 'utf8'));
        if ('error' in masked) return { file, content: null, error: masked.error };
        return { file, content: redact(masked.content) };
      } catch (err) {
        return { file, content: null, error: errorMessage(err) };
      }
    }),
  );
}

/** Short form of a `run.kept_files` event for the run detail. */
function keptSummary(payload: Record<string, unknown>): { files: number; bytes: number; skippedCount: number; message: string | null; error: string | null } {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    files: num(payload.files),
    bytes: num(payload.bytes),
    skippedCount: num(payload.skippedCount),
    message: typeof payload.message === 'string' ? payload.message : null,
    error: typeof payload.error === 'string' ? payload.error : null,
  };
}

/** Keys whose values are always masked in displayed YAML (besides {@link isSecretKey}). */
const MASKED_YAML_KEYS = new Set(['url']);
/** Keys whose whole sub-tree of values is masked (header values / header env names). */
const MASKED_YAML_SUBTREES = new Set(['headers', 'headers_env']);

/** `https://host/path?q` → `https://host/[REDACTED]` (only when something follows the host). */
function truncateUrl(value: string): string {
  return value.replace(/^(\s*https?:\/\/[^\s/?#]+)[^\s]*/i, (m, origin: string) => (m === origin ? m : `${origin}/${REDACTED}`));
}

function maskComment(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  // Keep the origin of URLs in comments, never path/query (tokens of webhook URLs).
  return text.replace(/\b(https?:\/\/[^\s/]+)[^\s]*/gi, (_m, origin: string) => `${origin}/${REDACTED}`);
}

/**
 * Structural redaction of a YAML file for read-only display: values of
 * `url` keys, everything below `headers`/`headers_env` and every key that
 * looks secret ({@link isSecretKey}) are replaced, URLs in comments are cut
 * to their origin. Independent of the loaded configuration (also covers
 * edited, not yet reloaded files). Unparseable files are never returned raw.
 */
export function redactYaml(text: string): { content: string } | { error: string } {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const line = e.linePos?.[0]?.line;
    const message = e.message.split(/:\s*\n/)[0] ?? 'invalid YAML';
    return { error: `YAML cannot be displayed (syntax error${line ? ` at line ${line}` : ''}: ${message})` };
  }
  doc.commentBefore = maskComment(doc.commentBefore) ?? null;
  doc.comment = maskComment(doc.comment) ?? null;
  visit(doc, {
    Node(_key, node) {
      // Any URL value (e.g. a literal webhook in `env:`) is cut to scheme + host.
      if (isScalar(node) && typeof node.value === 'string' && /^\s*https?:\/\//i.test(node.value)) {
        node.value = truncateUrl(node.value);
      }
      const n = node as { comment?: string | null; commentBefore?: string | null };
      if (n.comment) n.comment = maskComment(n.comment) ?? null;
      if (n.commentBefore) n.commentBefore = maskComment(n.commentBefore) ?? null;
    },
    Pair(_key, pair, ancestors) {
      const keyName = isScalar(pair.key) ? String(pair.key.value) : '';
      const underMaskedSubtree = ancestors.some((a) => isPair(a) && isScalar(a.key) && MASKED_YAML_SUBTREES.has(String(a.key.value)));
      const mask = MASKED_YAML_KEYS.has(keyName) || isSecretKey(keyName) || underMaskedSubtree || MASKED_YAML_SUBTREES.has(keyName);
      if (!mask) return;
      const maskNode = (value: unknown): void => {
        if (isScalar(value)) {
          if (value.value !== null && value.value !== '') value.value = REDACTED;
        } else if (isMap(value) || isSeq(value)) {
          for (const item of value.items as unknown[]) maskNode(isPair(item) ? item.value : item);
        }
      };
      maskNode(pair.value);
    },
  });
  return { content: doc.toString() };
}
