/**
 * Pass-through of the workspace UIs and APIs below `/w/<id>/` (WI-37).
 *
 * `GET /w/<id>/` serves the workspace's web UI, `/w/<id>/api/v1/…` its API
 * (including the SSE stream) – streamed in both directions to the workspace's
 * loopback port. The workspace is never reachable except through this path
 * (or its loopback port, which accepts nothing without the hub's secret).
 *
 * What the hub does and does not forward:
 * - The path is validated segment by segment (percent-decoded once): `.`/`..`,
 *   encoded slashes, backslashes and NUL are refused – a request can never
 *   leave `/w/<id>/` or reach another workspace.
 * - Request headers are an allow-list. Cookies, `Authorization`, `Origin`,
 *   `Referer`, `X-Forwarded-*`, `X-Adispatch-Control-Token` and every
 *   `X-Adispatch-Hub-*` header of the client are dropped, `Host` is replaced.
 *   The hub adds its own identity headers (`X-Adispatch-Hub-Token/-User/-Role`)
 *   from its authenticated session, never from the client.
 * - Response headers: hop-by-hop headers and `Set-Cookie` are dropped;
 *   absolute-path redirects are rewritten to stay below `/w/<id>/`.
 * - The workspace's login endpoints are not forwarded: `/w/<id>/api/v1/auth/*`
 *   is answered by the hub itself (one login for all workspaces).
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { errorMessage, noopLogger, type Logger } from '../../core/index.js';
import { CSRF_HEADER, HUB_ROLE_HEADER, HUB_TOKEN_HEADER, HUB_USER_HEADER } from '../../api/index.js';
import { WORKSPACE_ID_PATTERN } from '../../config/index.js';
import type { HubActor } from './guard.js';

/** Largest request body passed to a workspace (the workspace API itself accepts 1 MiB). */
export const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
/** Time a workspace may stay silent (no response header, no data) before the hub answers 504. */
export const PROXY_IDLE_TIMEOUT_MS = 120_000;
/** Time to connect to a workspace. */
export const PROXY_CONNECT_TIMEOUT_MS = 5_000;

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']);

const REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'last-event-id',
  'pragma',
  'range',
  'user-agent',
  CSRF_HEADER,
] as const;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const DROPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'set-cookie', 'set-cookie2']);

/** A request path below `/w/` split into workspace ID and the rest. */
export type WorkspacePath =
  | { kind: 'proxy'; id: string; rest: string; query: string }
  | { kind: 'redirect'; id: string; query: string }
  | { kind: 'invalid'; reason: string };

/**
 * Split a request target (`/w/<id>/<rest>?<query>`). `rest` keeps its raw
 * encoding (starts with `/`). Refuses anything that could leave the prefix.
 */
export function parseWorkspacePath(target: string): WorkspacePath {
  if (!target.startsWith('/w/')) return { kind: 'invalid', reason: 'not a workspace path' };
  const q = target.indexOf('?');
  const pathPart = q < 0 ? target : target.slice(0, q);
  const query = q < 0 ? '' : target.slice(q);
  if (query.includes('#')) return { kind: 'invalid', reason: 'fragment in request target' };
  const afterW = pathPart.slice(3);
  const slash = afterW.indexOf('/');
  const id = slash < 0 ? afterW : afterW.slice(0, slash);
  if (!WORKSPACE_ID_PATTERN.test(id)) return { kind: 'invalid', reason: 'invalid workspace ID' };
  if (slash < 0) return { kind: 'redirect', id, query };
  const rest = afterW.slice(slash);
  for (const raw of rest.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { kind: 'invalid', reason: 'malformed percent-encoding' };
    }
    if (decoded === '.' || decoded === '..') return { kind: 'invalid', reason: 'path traversal' };
    if (/[/\\\u0000-\u001f\u007f]/.test(decoded)) return { kind: 'invalid', reason: 'forbidden character in path' };
    // A second decoding must not turn it into something forbidden either (double encoding).
    let twice = decoded;
    try {
      twice = decodeURIComponent(decoded);
    } catch {
      // not double-encoded
    }
    if (twice === '.' || twice === '..' || /[/\\\u0000]/.test(twice)) return { kind: 'invalid', reason: 'path traversal' };
  }
  return { kind: 'proxy', id, rest, query };
}

/**
 * The static web UI shell and its assets: readable without login (as on a workspace instance). Decided on the
 * **decoded** path (`%61pi` is `api`), so an escaped spelling can never make an API path look static; a path that does not
 * decode cleanly is not public either.
 */
export function isPublicWorkspaceRequest(method: string, rest: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  let decoded: string;
  try {
    decoded = rest.split('/').map((seg) => decodeURIComponent(seg)).join('/').toLowerCase();
  } catch {
    return false;
  }
  return !(decoded === '/api' || decoded.startsWith('/api/') || decoded === '/health' || decoded === '/ready' || decoded.startsWith('/health/') || decoded.startsWith('/ready/'));
}

/** Path of `to` relative to the directory of `from` (both absolute, `from` a request path). */
export function relativePath(from: string, to: string): string {
  const fromDir = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let i = 0;
  while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++;
  const up = fromDir.length - i;
  const rel = [...Array<string>(up).fill('..'), ...toParts.slice(i)].join('/');
  return rel === '' ? './' : rel;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** What a workspace can answer with at the moment. */
export interface WorkspaceTarget {
  state: 'starting' | 'running' | 'backoff' | 'stopped' | 'failed';
  transition: 'draining' | 'stopping' | 'restarting' | null;
  port: number;
  message: string | null;
  enabled: boolean;
}

/** Options of {@link createWorkspaceProxy}. */
export interface WorkspaceProxyOptions {
  /** Current state of a workspace, `null` if unknown. */
  target(id: string): WorkspaceTarget | null;
  /** Secret of the workspace's current child process. */
  token(id: string): string | null;
  /** CSP header value of hub pages (the 503 page). */
  csp: string;
  logger?: Logger;
  agent?: http.Agent;
  /** Idle timeout of a workspace connection (default {@link PROXY_IDLE_TIMEOUT_MS}; tests). */
  idleTimeoutMs?: number;
}

/** Identity headers the hub sends for a caller. */
export function identityHeaders(actor: HubActor | null, token: string): Record<string, string> {
  const headers: Record<string, string> = { [HUB_TOKEN_HEADER]: token };
  if (!actor) return headers; // public static request: no identity
  headers[HUB_ROLE_HEADER] = actor.role;
  if (actor.name !== null && (actor.via === 'password' || actor.via === 'trusted_header')) headers[HUB_USER_HEADER] = actor.name;
  return headers;
}

const STATE_TEXT: Record<WorkspaceTarget['state'], string> = {
  starting: 'is starting',
  running: 'is not answering',
  backoff: 'crashed and will be restarted',
  stopped: 'is stopped',
  failed: 'failed to start',
};

/** The 503 page for a workspace that cannot answer (HTML for browsers, JSON otherwise). */
export function unavailableResponse(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  target: WorkspaceTarget | null,
  csp: string,
  reason?: string,
  /** Callers without a login only learn that the workspace is not available (no state, no supervisor messages). */
  detailed = true,
): void {
  if (!detailed) {
    reason = undefined;
    target = null;
  }
  const state = target?.state ?? 'stopped';
  const text = !detailed ? `Workspace "${id}" is not available.` : reason ?? `Workspace "${id}" ${STATE_TEXT[state]}${target?.transition ? ` (${target.transition})` : ''}.`;
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html') && (req.method === 'GET' || req.method === 'HEAD');
  const common = { 'cache-control': 'no-store', 'retry-after': '5', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
  if (!wantsHtml) {
    const body = JSON.stringify({ error: { code: 'workspace_unavailable', message: text, ...(detailed ? { details: { workspace: id, state } } : {}) } });
    res.writeHead(503, { ...common, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  // Links are relative to the requested URL, so the page also works behind a reverse proxy with a path prefix.
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const up = relativePath(pathname, '/');
  const detail = target?.message ? `<p class="muted">${escapeHtml(target.message)}</p>` : '';
  const hint =
    !detailed
      ? 'Try again later, or sign in to see why.'
      : state === 'stopped' && target && !target.enabled
      ? 'This workspace is disabled in hub.yaml; start it from the overview.'
      : state === 'starting' || target?.transition === 'restarting'
        ? 'This page reloads by itself.'
        : 'Start it from the overview.';
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="5">
<title>Workspace unavailable · adispatchd</title>
<link rel="icon" href="${up}favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${up}app.css"><link rel="stylesheet" href="${up}hub.css"></head>
<body><header class="top"><a class="brand" href="${up}" title="Agent Dispatch Daemon hub">adispatchd hub</a></header>
<main class="page unavailable" id="main" tabindex="-1"><h1>Workspace unavailable</h1>
<p role="status">${escapeHtml(text)}</p>${detail}<p>${hint}</p>
<p><a class="btn" href="${up}">Back to the overview</a></p></main></body></html>`;
  res.writeHead(503, { ...common, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'content-security-policy': csp });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** JSON error response of the pass-through. */
function jsonError(res: ServerResponse, status: number, code: string, message: string, close = false): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(close ? { connection: 'close' } : {}) });
  res.end(body);
}

/** Limits the body streamed to a workspace. */
function limitBytes(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > max) cb(new Error('request body too large'));
      else cb(null, chunk);
    },
  });
}

/** Handler that streams one authorized request to the workspace. */
/**
 * Register an open stream of the caller's session; the registered function ends
 * it (logout, session expiry). Returns the unregister function.
 */
export type StreamRegistrar = (close: () => void) => () => void;

export function createWorkspaceProxy(
  options: WorkspaceProxyOptions,
): (req: IncomingMessage, res: ServerResponse, parsed: Extract<WorkspacePath, { kind: 'proxy' }>, actor: HubActor | null, register?: StreamRegistrar) => void {
  const log = (options.logger ?? noopLogger).child({ component: 'hub-proxy' });
  const agent = options.agent ?? new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 8 });
  return (req, res, parsed, actor, register) => {
    const { id, rest, query } = parsed;
    const method = req.method ?? 'GET';
    if (!METHODS.has(method)) return jsonError(res, 405, 'method_not_allowed', `Method ${method} is not supported`);
    const target = options.target(id);
    const token = options.token(id);
    if (!target || target.state !== 'running' || !token) return unavailableResponse(req, res, id, target, options.csp, undefined, actor !== null);

    const headers: OutgoingHttpHeaders = {};
    const hasBody = method !== 'GET' && method !== 'HEAD';
    for (const name of REQUEST_HEADERS) {
      // A request without a body must not announce one: the pooled upstream connection would be out of sync.
      if (!hasBody && (name === 'content-length' || name === 'content-type')) continue;
      const value: IncomingHttpHeaders[string] = req.headers[name];
      if (value !== undefined) headers[name] = value as string;
    }
    if (hasBody && headers['content-length'] === undefined && req.headers['transfer-encoding'] !== undefined) headers['transfer-encoding'] = 'chunked';
    Object.assign(headers, identityHeaders(actor, token));
    headers.host = `127.0.0.1:${target.port}`;
    headers.connection = 'keep-alive';

    let upstream: http.ClientRequest;
    try {
      upstream = http.request({ host: '127.0.0.1', port: target.port, method, path: `${rest}${query}`, headers, agent, setHost: false, timeout: PROXY_CONNECT_TIMEOUT_MS });
    } catch (err) {
      log.warn('request could not be built', { workspace: id, error: errorMessage(err) });
      return jsonError(res, 400, 'invalid_request', 'The request cannot be passed on');
    }
    let responded = false;
    let unregister: (() => void) | undefined;
    const cleanup = (): void => {
      unregister?.();
      unregister = undefined;
    };
    upstream.once('socket', (socket) => {
      // The connect timeout above only covers connecting; afterwards the idle timeout applies.
      const onConnect = (): void => {
        upstream.setTimeout(options.idleTimeoutMs ?? PROXY_IDLE_TIMEOUT_MS);
      };
      if (socket.connecting) socket.once('connect', onConnect);
      else onConnect();
    });
    upstream.on('timeout', () => upstream.destroy(new Error('workspace did not answer in time')));
    upstream.on('error', (err) => {
      cleanup();
      if (responded) return void res.destroy();
      log.debug('workspace request failed', { workspace: id, error: errorMessage(err) });
      const refused = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED';
      if (/too large/.test(err.message)) {
        // The rest of the upload is not read: close the connection after the answer instead of leaving it half-consumed.
        jsonError(res, 413, 'payload_too_large', 'Request body too large', true);
        res.once('finish', () => req.destroy());
        return;
      }
      if (refused) return unavailableResponse(req, res, id, options.target(id), options.csp, `Workspace "${id}" refused the connection.`, actor !== null);
      jsonError(res, 504, 'workspace_timeout', `Workspace "${id}" did not answer: ${err.message}`);
    });
    upstream.on('response', (ures) => {
      responded = true;
      const out: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(ures.headers)) {
        if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
        out[name] = value;
      }
      const location = ures.headers.location;
      if (typeof location === 'string') {
        if (location.startsWith('/') && !location.startsWith('//')) out.location = relativePath(req.url?.split('?')[0] ?? '/', `/w/${id}${location}`);
        else delete out.location; // never send a client to another origin on the workspace's behalf
      }
      res.writeHead(ures.statusCode ?? 502, out);
      if ((ures.headers['content-type'] ?? '').startsWith('text/event-stream')) {
        res.flushHeaders();
        unregister = register?.(() => {
          ures.destroy();
          res.end();
        });
      }
      ures.on('error', () => res.destroy());
      ures.on('end', cleanup);
      ures.pipe(res);
    });
    // Client went away (or the stream was closed by a logout): stop the upstream request too.
    res.on('close', () => {
      cleanup();
      if (!res.writableFinished) upstream.destroy();
    });
    if (method === 'GET' || method === 'HEAD') {
      upstream.end();
      req.resume();
    } else {
      const limit = limitBytes(MAX_PROXY_BODY_BYTES);
      limit.on('error', (err) => upstream.destroy(err));
      req.on('aborted', () => upstream.destroy());
      req.pipe(limit).pipe(upstream);
    }
  };
}
