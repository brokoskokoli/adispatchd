/**
 * Request checks of the hub's HTTP server (WI-36), applied identically to the
 * hub's own routes and to everything passed through to a workspace:
 *
 * 1. `Host` must name this server (DNS-rebinding protection, `hub.server.allowed_hosts`).
 * 2. An `Origin` must be the request's own origin (no CORS, ever).
 * 3. Mutating requests carry `X-Adispatch-Request: 1`, are not cross-site
 *    (`Sec-Fetch-Site`) and have JSON bodies only (CSRF "simple requests").
 * 4. The caller is authenticated with the hub's own `auth` section and needs
 *    the minimum role of the route.
 */
import type { IncomingMessage } from 'node:http';
import { CSRF_HEADER, isAllowedHost, originMatchesHost, type AuthRequest, type AuthService, type Principal } from '../../api/index.js';
import type { AuthRole } from '../../config/index.js';
import { hubRoleAllows, type HubRouteAccess } from './roles.js';

/** A request the hub refuses; becomes `{error: {code, message}}`. */
export class HttpRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpRejection';
  }
}

/** Who calls. `name` is `null` without a login (auth.mode none, anonymous reader). */
export interface HubActor {
  name: string | null;
  role: AuthRole;
  via: 'password' | 'trusted_header' | 'none' | 'anonymous';
}

/** Result of {@link authorize}: the caller, and the principal (session) behind it for stream bookkeeping. */
export interface Authorized {
  /** `null` = anonymous (only on `public` routes). */
  actor: HubActor | null;
  principal: Principal | null;
}

/** Options of {@link checkRequestOrigin}. */
export interface RequestCheckOptions {
  allowedHosts(): readonly string[];
  /** Additional allowed `Origin`s. */
  allowedOrigins?: readonly string[];
}

/** Request as seen by the auth service. */
export function authRequestOf(req: IncomingMessage): AuthRequest {
  return {
    headers: req.headers,
    remoteAddress: req.socket.remoteAddress,
    encrypted: (req.socket as { encrypted?: boolean }).encrypted === true,
  };
}

/** Steps 1–3. Throws {@link HttpRejection}. */
export function checkRequestOrigin(req: IncomingMessage, options: RequestCheckOptions): void {
  const host = req.headers.host;
  if (typeof host !== 'string' || !isAllowedHost(host, options.allowedHosts())) {
    throw new HttpRejection(421, 'host_not_allowed', 'Host header is not allowed (configure hub.server.allowed_hosts for reverse proxies)');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowed = (options.allowedOrigins ?? []).includes(origin as string) || originMatchesHost(origin as string, host);
    if (!allowed) throw new HttpRejection(403, 'origin_not_allowed', 'Request origin is not allowed');
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return;
  if (method === 'OPTIONS') throw new HttpRejection(405, 'method_not_allowed', 'CORS preflight is not supported');
  if (req.headers[CSRF_HEADER] !== '1') {
    throw new HttpRejection(403, 'csrf_header_missing', 'Mutating requests require the header "X-Adispatch-Request: 1"');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpRejection(403, 'cross_site_request', 'Cross-site requests are not allowed');
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (hasBody && type !== 'application/json') throw new HttpRejection(415, 'unsupported_media_type', 'Request bodies must be application/json');
}

const personOf = (p: Principal): HubActor | null =>
  p.via === 'password' || p.via === 'trusted_header' ? { name: p.name, role: p.role, via: p.via } : null;

/**
 * Step 4. Returns the caller (`actor: null` = anonymous, only possible for `public`
 * routes). Throws {@link HttpRejection} 401/403.
 */
export function authorize(auth: AuthService, req: IncomingMessage, required: HubRouteAccess): Authorized {
  if (!auth.enabled) return { actor: { name: null, role: 'admin', via: 'none' }, principal: null };
  const anonymousCaller: Authorized = { actor: null, principal: null };
  const method = req.method ?? 'GET';
  const resolved = auth.resolve(authRequestOf(req));
  if (!resolved.ok) {
    if (required === 'public') return anonymousCaller;
    throw new HttpRejection(resolved.status, resolved.code, resolved.message);
  }
  const principal = resolved.principal;
  if (principal === null) {
    if (!auth.readRequiresLogin && (method === 'GET' || method === 'HEAD')) {
      const anonymous: HubActor = { name: null, role: 'viewer', via: 'anonymous' };
      if (!hubRoleAllows(anonymous.role, required)) throw new HttpRejection(401, 'authentication_required', 'Login required');
      return { actor: anonymous, principal: null };
    }
    if (required === 'public') return anonymousCaller;
    throw new HttpRejection(401, 'authentication_required', 'Login required');
  }
  if (principal.via === 'control_token') {
    // The hub's CLI talks over the control socket; the HTTP server has no use for a token.
    if (required === 'public') return anonymousCaller;
    throw new HttpRejection(403, 'control_token_not_allowed', 'The control token is not accepted by the hub');
  }
  const actor = personOf(principal);
  if (!actor) throw new HttpRejection(401, 'authentication_required', 'Login required');
  if (!hubRoleAllows(actor.role, required)) {
    throw new HttpRejection(403, 'forbidden', `This action requires the role "${required}" (your role: "${actor.role}")`, { requiredRole: required, role: actor.role });
  }
  return { actor, principal };
}

