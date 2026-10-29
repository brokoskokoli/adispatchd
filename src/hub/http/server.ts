/**
 * HTTP server of the hub (WI-36) on `hub.server`:
 *
 * - `/` the overview UI, `/api/v1/hub/…` the hub API (docs/api.md), `/api/v1/auth/…` login;
 * - `/w/<id>/…` the workspace UIs and APIs passed through (`proxy.ts`).
 *
 * Fastify serves the hub's own routes; requests below `/w/` are taken before
 * Fastify (`serverFactory`) because they are streamed unparsed. Both paths go
 * through the same checks (`guard.ts`: Host, Origin, CSRF, login, role).
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type FetchLike,
  type Logger,
  type TimerHandle,
  type Timers,
} from '../../core/index.js';
import { AuthService, allowedHostList, uiContentSecurityPolicy, type AuthServiceOptions } from '../../api/index.js';
import { ResourceMonitor, createSystemProbe, type MetricsSample, type SystemProbe } from '../../monitoring/index.js';
import type { HubConfig } from '../../config/index.js';
import { HubError } from '../errors.js';
import type { HubStatus, HubWorkspaceStatus } from '../hub.js';
import type { HubControl } from '../control-server.js';
import { HubAuditStore } from './audit.js';
import { HubEventStream } from './events.js';
import { HttpRejection, authRequestOf, authorize, checkRequestOrigin, type Authorized, type HubActor } from './guard.js';
import { WorkspaceInfoPoller, type WorkspaceActivity } from './info.js';
import { createWorkspaceProxy, isPublicWorkspaceRequest, parseWorkspacePath, unavailableResponse } from './proxy.js';
import { hubRouteAccess } from './roles.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Caller of the request (hub API); `null` = anonymous on a public route. */
    hubActor: HubActor | null;
    hubPrincipal: Authorized['principal'];
  }
}

/** What the HTTP server needs from the hub. */
export interface HubHttpSource extends HubControl {
  /** Secret of the workspace's current child process. */
  trustTokenOf(id: string): string | null;
  /** Be called after every change of workspace states or slots; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Options of {@link createHubHttp}. */
export interface HubHttpOptions {
  config: HubConfig;
  hub: HubHttpSource;
  /** Data dir of the hub (audit database, disk monitoring). */
  dataDir: string;
  version: string;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** Environment with the password hashes / proxy secret (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Port to listen on instead of `hub.server.port` (tests: 0). */
  port?: number;
  /** Built web UI (`resolveUiDir()`); `null` = API only. */
  uiDir?: string | null;
  /** Server resources; `false` = off. */
  monitoring?: false | { probe?: SystemProbe; intervalMs?: number; primeDelayMs?: number };
  /** Reading the workspaces' activity (tests: fake fetch, short interval). */
  info?: { fetch?: FetchLike; intervalMs?: number };
  /** Idle timeout of workspace connections in the pass-through (tests). */
  proxyIdleTimeoutMs?: number;
  /** Login tuning (tests: fake scrypt, no failure delay). */
  auth?: Partial<Pick<AuthServiceOptions, 'scrypt' | 'sleep'>>;
}

/** A running HTTP server of the hub. */
export interface HubHttp {
  readonly auth: AuthService;
  readonly audit: HubAuditStore;
  /** `"<METHOD> <url>"` of every registered route (roles test). */
  readonly routes: readonly string[];
  /** Start listening; resolves with the address. */
  listen(): Promise<{ host: string; port: number; url: string }>;
  /** Stop: close streams and connections, stop the sampling. */
  close(): Promise<void>;
}

// --- views ---------------------------------------------------------------------

/** Resources shown in the overview (totals only; no process list). */
export interface HubResourcesView {
  at: string;
  cpu: { percent: number; cores: number; load: [number, number, number] };
  memory: { usedBytes: number; totalBytes: number };
  disks: Array<{ path: string; freeBytes: number; totalBytes: number }>;
}

/** One workspace in the API. */
export interface HubWorkspaceView {
  id: string;
  enabled: boolean;
  state: HubWorkspaceStatus['state'];
  transition: HubWorkspaceStatus['transition'];
  /** Loopback port of the instance (informational: it is not reachable without the hub's secret). */
  port: number;
  /** Path of the workspace UI relative to the hub root. */
  path: string;
  startedAt: string | null;
  restarts: number;
  crashes: number;
  lastExit: HubWorkspaceStatus['lastExit'];
  nextRestartAt: string | null;
  message: string | null;
  /** Slots held / the slot connection is established. */
  slots: number;
  connected: boolean;
  /** `null` while the workspace does not run or does not answer. */
  activity: WorkspaceActivity | null;
}

/** `GET /api/v1/hub/status`. */
export interface HubStatusView {
  version: string;
  startedAt: string;
  time: string;
  state: HubStatus['state'];
  paused: boolean;
  slots: HubStatus['slots'];
  resources: HubResourcesView | null;
  workspaces: { total: number; running: number; failed: number; stopped: number; starting: number; backoff: number };
}

export function workspaceView(w: HubWorkspaceStatus, activity: WorkspaceActivity | null): HubWorkspaceView {
  return {
    id: w.id,
    enabled: w.enabled,
    state: w.state,
    transition: w.transition,
    port: w.port,
    path: `/w/${w.id}/`,
    startedAt: w.startedAt,
    restarts: w.restarts,
    crashes: w.crashes,
    lastExit: w.lastExit,
    nextRestartAt: w.nextRestartAt,
    message: w.message,
    slots: w.slots,
    connected: w.connected,
    activity,
  };
}

export function resourcesView(sample: MetricsSample | null): HubResourcesView | null {
  if (!sample) return null;
  return {
    at: sample.at,
    cpu: { percent: sample.cpu.totalPercent, cores: sample.cpu.cores, load: sample.cpu.load },
    memory: { usedBytes: Math.max(0, sample.memory.totalBytes - sample.memory.availableBytes), totalBytes: sample.memory.totalBytes },
    disks: sample.disks.map((d) => ({ path: d.path, freeBytes: d.freeBytes, totalBytes: d.totalBytes })),
  };
}

// --- request schemas -------------------------------------------------------------

const emptyBody = z.object({}).strict();
const loginBody = z.object({ name: z.string().min(1).max(64), password: z.string().min(1).max(1024) }).strict();
const idParam = z.object({ id: z.string().min(1).max(60) });
const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() }).strict();

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new HttpRejection(400, 'invalid_request', `Invalid ${what}`, { issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return result.data;
}

const WORKSPACE_ACTIONS = ['start', 'stop', 'restart', 'drain'] as const;

/** Create the HTTP server of a hub (not listening yet). */
export async function createHubHttp(options: HubHttpOptions): Promise<HubHttp> {
  const { config, hub } = options;
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? systemTimers;
  const logger = (options.logger ?? noopLogger).child({ component: 'hub-http' });
  const csp = uiContentSecurityPolicy([]);
  const audit = new HubAuditStore(options.dataDir, clock);
  const auth = new AuthService({
    config: () => config.auth,
    clock,
    timers,
    logger,
    ...(options.env ? { env: options.env } : {}),
    ...(options.auth ?? {}),
  });
  const allowedHosts = (): readonly string[] => allowedHostList(config.server.host, config.server.allowedHosts);
  const requestCheck = { allowedHosts };

  // --- state shared by API, events and proxy ---
  const activityIds = (): Array<{ id: string; port: number }> =>
    hub
      .status()
      .workspaces.filter((w) => w.state === 'running')
      .map((w) => ({ id: w.id, port: w.port }));
  let notify: () => void = () => undefined;
  const poller = new WorkspaceInfoPoller({
    running: activityIds,
    token: (id) => hub.trustTokenOf(id),
    onChange: () => notify(),
    clock,
    timers,
    logger,
    ...(options.info?.fetch ? { fetch: options.info.fetch } : {}),
    ...(options.info?.intervalMs !== undefined ? { intervalMs: options.info.intervalMs } : {}),
  });
  const monitorOptions = options.monitoring === false ? null : (options.monitoring ?? {});
  const monitor = monitorOptions
    ? new ResourceMonitor({
        probe: monitorOptions.probe ?? createSystemProbe(),
        settings: () => ({
          enabled: true,
          intervalMs: monitorOptions.intervalMs ?? 10_000,
          retentionMs: 5 * 60_000,
          topProcesses: 0,
          minCpuPercent: 100,
          diskPaths: [options.dataDir, ...config.workspaces.map((w) => w.dataDir)],
        }),
        targets: () => ({ daemonPid: process.pid, runs: [] }),
        clock,
        timers,
        logger,
        onSample: (sample) => events.publish('hub.resources', resourcesView(sample)),
        ...(monitorOptions.primeDelayMs !== undefined ? { primeDelayMs: monitorOptions.primeDelayMs } : {}),
      })
    : null;

  const workspaceViews = (status: HubStatus = hub.status()): HubWorkspaceView[] => status.workspaces.map((w) => workspaceView(w, w.state === 'running' ? poller.get(w.id) : null));
  const statusView = (status: HubStatus = hub.status()): HubStatusView => {
    const count = (state: string): number => status.workspaces.filter((w) => w.state === state).length;
    return {
      version: status.version,
      startedAt: status.startedAt,
      time: status.time,
      state: status.state,
      paused: status.paused,
      slots: status.slots,
      resources: resourcesView(monitor?.latest() ?? null),
      workspaces: { total: status.workspaces.length, running: count('running'), failed: count('failed'), stopped: count('stopped'), starting: count('starting'), backoff: count('backoff') },
    };
  };
  const snapshot = (): { status: HubStatusView; workspaces: HubWorkspaceView[] } => {
    const status = hub.status();
    return { status: statusView(status), workspaces: workspaceViews(status) };
  };
  const events = new HubEventStream({ snapshot, clock, timers, logger });

  // Live changes: coalesce notifications, publish only what differs from the last published state.
  let lastGlobal = '';
  const lastWorkspace = new Map<string, string>();
  let flushTimer: TimerHandle | undefined;
  let closed = false;
  const flush = (): void => {
    flushTimer = undefined;
    if (closed || events.clientCount === 0) {
      // Nobody listens: remember nothing, the next client gets a snapshot.
      lastGlobal = '';
      lastWorkspace.clear();
      return;
    }
    const status = hub.status();
    const { time: _time, ...rest } = statusView(status);
    const global = JSON.stringify({ ...rest, resources: null });
    if (global !== lastGlobal) {
      lastGlobal = global;
      events.publish('hub.status', { ...rest, time: status.time });
    }
    for (const w of workspaceViews(status)) {
      const text = JSON.stringify(w);
      if (lastWorkspace.get(w.id) !== text) {
        lastWorkspace.set(w.id, text);
        events.publish('hub.workspace', w);
      }
    }
  };
  notify = () => {
    if (closed || flushTimer) return;
    flushTimer = timers.setTimeout(flush, 50);
    (flushTimer as { unref?: () => void }).unref?.();
  };
  // Every client gets a complete snapshot on connect; afterwards only differences to the last published state are sent.
  const unsubscribe = hub.subscribe(() => notify());

  // --- proxy ---
  const proxy = createWorkspaceProxy({
    target: (id) => {
      const w = hub.status().workspaces.find((x) => x.id === id);
      return w ? { state: w.state, transition: w.transition, port: w.port, message: w.message, enabled: w.enabled } : null;
    },
    token: (id) => hub.trustTokenOf(id),
    csp,
    logger,
    ...(options.proxyIdleTimeoutMs !== undefined ? { idleTimeoutMs: options.proxyIdleTimeoutMs } : {}),
  });

  function rejectRaw(res: http.ServerResponse, err: HttpRejection): void {
    if (res.headersSent) return void res.destroy();
    const body = JSON.stringify({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    res.writeHead(err.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  }

  /** Requests below `/w/`: returns `true` if handled (otherwise Fastify continues, e.g. for the workspace login). */
  function handleWorkspaceRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    try {
      checkRequestOrigin(req, requestCheck);
      const parsed = parseWorkspacePath(req.url ?? '');
      if (parsed.kind === 'invalid') throw new HttpRejection(parsed.reason === 'not a workspace path' ? 404 : 400, 'invalid_path', `Invalid workspace path (${parsed.reason})`);
      if (!hub.status().workspaces.some((w) => w.id === parsed.id)) throw new HttpRejection(404, 'unknown_workspace', `Unknown workspace "${parsed.id}"`);
      if (parsed.kind === 'redirect') {
        res.writeHead(308, { location: `${parsed.id}/${parsed.query}`, 'cache-control': 'no-store' });
        res.end();
        return true;
      }
      const method = req.method ?? 'GET';
      // The login of the hub serves every workspace UI: hand these three paths to the hub's own routes.
      const authPath = /^\/api\/v1\/auth\/(login|logout|me)$/.exec(parsed.rest);
      if (authPath) {
        req.url = parsed.rest + parsed.query;
        return false;
      }
      const required = isPublicWorkspaceRequest(method, parsed.rest) ? 'public' : 'viewer';
      const authorized = authorize(auth, req, required);
      proxy(req, res, parsed, authorized.actor, (close) => (authorized.principal ? auth.registerStream(authorized.principal, close) : () => undefined));
      return true;
    } catch (err) {
      if (err instanceof HttpRejection) {
        rejectRaw(res, err);
        return true;
      }
      logger.error('request failed', { error: errorMessage(err) });
      rejectRaw(res, new HttpRejection(500, 'internal_error', 'Internal error'));
      return true;
    }
  }

  const app: FastifyInstance = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    return503OnClosing: true,
    serverFactory: (handler) => {
      const server = http.createServer((req, res) => {
        const url = req.url ?? '';
        if (url === '/w' || url.startsWith('/w/') || url.startsWith('/w?')) {
          if (url === '/w' || url === '/w/' || url.startsWith('/w?')) {
            rejectRaw(res, new HttpRejection(404, 'not_found', 'Open a workspace as /w/<workspace-id>/'));
            return;
          }
          if (handleWorkspaceRequest(req, res)) return;
        } else if (!url.startsWith('/')) {
          // absolute-form or asterisk-form request targets are not served
          rejectRaw(res, new HttpRejection(400, 'invalid_request', 'Invalid request target'));
          return;
        }
        handler(req, res);
      });
      server.headersTimeout = 20_000;
      // Receiving a request (headers and body, at most 2 MiB) must finish; responses (SSE) are not limited by this.
      server.requestTimeout = 5 * 60_000;
      return server;
    },
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpRejection(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
    }
  });
  app.decorateRequest('hubActor', null);
  app.decorateRequest('hubPrincipal', null);
  const registeredRoutes: string[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (hubRouteAccess(method, route.url) === undefined) throw new Error(`Route ${method} ${route.url} has no minimum role (add it to HUB_ROUTE_ROLES in src/hub/http/roles.ts and docs/api.md)`);
      registeredRoutes.push(`${method} ${route.url}`);
    }
  });
  app.addHook('onRequest', async (req) => {
    checkRequestOrigin(req.raw, requestCheck);
    const url = req.routeOptions.url;
    const isApi = (req.url.split('?')[0] ?? '').startsWith('/api/');
    // Unknown API paths need a login, also when the static catch-all matched them.
    const access = url === undefined || (url === '/*' && isApi) ? (isApi ? 'viewer' : 'public') : (hubRouteAccess(req.method, url) ?? 'viewer');
    const authorized = authorize(auth, req.raw, access);
    req.hubActor = authorized.actor;
    req.hubPrincipal = authorized.principal;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    const pathname = req.url.split('?')[0] ?? '';
    if (pathname.startsWith('/api/') || pathname === '/health') reply.header('cache-control', 'no-store');
    else if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', csp);
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: unknown; code?: unknown; status?: unknown };
    let status = 500;
    let body: { error: { code: string; message: string; details?: unknown } } = { error: { code: 'internal_error', message: 'Internal server error' } };
    if (err instanceof HttpRejection) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
    } else if (err instanceof HubError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message } };
    } else if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      status = e.statusCode;
      body = { error: { code: typeof e.code === 'string' ? e.code.toLowerCase() : 'invalid_request', message: errorMessage(err) } };
    } else logger.error('request failed', { method: req.method, url: req.url, error: err });
    void reply.status(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found` } });
  });

  // --- routes ---
  const actorFields = (actor: HubActor | null): { actor: string | null; role: string | null; via: string } => ({
    actor: actor?.name ?? null,
    role: actor?.name ? actor.role : null,
    via: actor?.via ?? 'none',
  });
  /** Run an action, record it (with the result) in the audit log and in the log. */
  const audited = async <T>(req: FastifyRequest, action: string, workspace: string | null, run: () => Promise<T> | T): Promise<T> => {
    const who = actorFields(req.hubActor);
    try {
      const result = await run();
      audit.record({ ...who, action, workspace, result: 'ok', error: null });
      logger.info('hub action', { action, workspace, actor: who.actor, role: who.role, via: who.via });
      return result;
    } catch (err) {
      const code = err instanceof HubError ? err.code : 'internal_error';
      audit.record({ ...who, action, workspace, result: 'failed', error: code });
      logger.warn('hub action failed', { action, workspace, actor: who.actor, code });
      throw err;
    }
  };
  const viewOf = (id: string): HubWorkspaceView => {
    const status = hub.status();
    const w = status.workspaces.find((x) => x.id === id);
    if (!w) throw new HubError('unknown_workspace', `Unknown workspace "${id}"`, 404);
    return workspaceView(w, w.state === 'running' ? poller.get(id) : null);
  };

  app.get('/health', async () => ({ status: 'ok', time: clock.now().toISOString() }));

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = parse(loginBody, req.body, 'body');
    if (!auth.enabled) throw new HttpRejection(400, 'login_not_available', 'Login is only available with auth.mode: password');
    const res = await auth.login(body.name, body.password, authRequestOf(req.raw));
    if (!res.ok) {
      if (res.retryAfterMs !== undefined) void reply.header('retry-after', String(Math.max(1, Math.ceil(res.retryAfterMs / 1000))));
      throw new HttpRejection(res.status, res.code, res.message);
    }
    void reply.header('set-cookie', res.cookie);
    return { user: { name: res.principal.name, role: res.principal.role, via: res.principal.via }, expiresAt: res.expiresAt };
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    parse(emptyBody, req.body, 'body');
    if (auth.enabled && auth.config.mode === 'password') void reply.header('set-cookie', auth.logout(authRequestOf(req.raw)));
    return { ok: true };
  });
  app.get('/api/v1/auth/me', async (req) => {
    if (!auth.enabled) return { mode: 'none', readRequiresLogin: false, user: null, role: 'admin', expiresAt: null, error: null };
    const resolved = auth.resolve(authRequestOf(req.raw));
    const a = req.hubActor;
    return {
      mode: auth.config.mode,
      readRequiresLogin: auth.config.readRequiresLogin,
      user: a?.name ? { name: a.name, role: a.role, via: a.via } : null,
      role: a?.role ?? null,
      expiresAt: auth.sessionExpiry(req.hubPrincipal),
      error: resolved.ok ? null : { status: resolved.status, code: resolved.code, message: resolved.message },
    };
  });

  app.get('/api/v1/hub/status', async () => statusView());
  app.get('/api/v1/hub/workspaces', async () => ({ workspaces: workspaceViews() }));
  app.get('/api/v1/hub/workspaces/:id', async (req) => viewOf(parse(idParam, req.params, 'path').id));
  for (const action of WORKSPACE_ACTIONS) {
    app.post(`/api/v1/hub/workspaces/:id/${action}`, async (req) => {
      const { id } = parse(idParam, req.params, 'path');
      parse(emptyBody, req.body, 'body');
      await audited(req, `workspace.${action}`, id, () => hub.workspace(id, action));
      // `stop`, `drain` and `restart` return as soon as the request is accepted; `transition` shows the progress.
      return { ok: true, workspace: viewOf(id) };
    });
  }
  const hubWide = [
    ['pause', async () => void hub.pause()],
    ['resume', async () => void hub.resume()],
    ['stop-all', async () => void (await hub.stopAll())],
    ['drain-all', async () => void (await hub.drainAll())],
  ] as const;
  for (const [name, run] of hubWide) {
    app.post(`/api/v1/hub/${name}`, async (req) => {
      parse(emptyBody, req.body, 'body');
      await audited(req, `hub.${name}`, null, run);
      return { ok: true, status: statusView(), workspaces: workspaceViews() };
    });
  }
  app.get('/api/v1/hub/audit', async (req) => {
    const q = parse(auditQuery, req.query, 'query');
    return { ...audit.list(q.limit ?? 100, q.offset ?? 0), limit: q.limit ?? 100, offset: q.offset ?? 0 };
  });
  app.get('/api/v1/hub/events', async (req, reply) => {
    // Logout, session expiry or a reload that removes the user ends the stream.
    if (req.hubPrincipal) {
      const off = auth.registerStream(req.hubPrincipal, () => reply.raw.end());
      reply.raw.on('close', off);
    }
    reply.hijack();
    events.handle(req.raw, reply.raw);
  });

  // Static overview UI. The workspace UI's own index.html is not served here (it belongs below /w/<id>/).
  const uiDir = options.uiDir && existsSync(path.join(options.uiDir, 'hub.html')) ? path.resolve(options.uiDir) : null;
  if (uiDir) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      index: false,
      allowedPath: (pathName) => pathName !== '/index.html',
    });
    app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => reply.sendFile('hub.html'));
  } else {
    app.get('/', async (_req, reply) => reply.status(200).type('text/plain; charset=utf-8').send('adispatchd hub: web UI assets not found (run `npm run build`); the API is available at /api/v1/hub/.\n'));
    app.get('/*', async (_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  }

  return {
    auth,
    audit,
    routes: registeredRoutes,
    async listen() {
      await app.listen({ host: config.server.host, port: options.port ?? config.server.port });
      auth.start();
      poller.start();
      monitor?.start();
      const address = app.server.address() as AddressInfo;
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      return { host: address.address, port: address.port, url: `http://${host}:${address.port}` };
    },
    async close() {
      closed = true;
      unsubscribe();
      if (flushTimer) timers.clearTimeout(flushTimer);
      events.close();
      auth.stop();
      await poller.stop();
      await monitor?.stop();
      app.server.closeAllConnections();
      await app.close().catch((err: unknown) => logger.warn('closing the HTTP server failed', { error: errorMessage(err) }));
      audit.close();
    },
  };
}
