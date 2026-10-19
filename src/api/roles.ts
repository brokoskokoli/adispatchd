/**
 * Minimum role per HTTP route (WI-26). Every route the API registers must be
 * listed here – `createApiServer` refuses to register a route without an
 * entry, and `roles.test.ts` compares this table with the registered routes
 * and with the table in docs/api.md.
 *
 * `public` = no login needed (health checks, login itself, the static UI
 * shell, which contains no data). HEAD requests use the entry of the GET route.
 *
 * `controlToken: true` marks the routes the CLI control commands call: only
 * there is the local control token accepted (it grants `operator`; worker
 * processes of the same service user can read it – review M1).
 */
import { AUTH_ROLES, type AuthRole } from '../config/index.js';

/** Required access of a route. */
export type RouteAccess = AuthRole | 'public';

/** Entry of {@link ROUTE_ROLES}: a minimum role, or a role plus flags. */
export type RouteRule = RouteAccess | { role: RouteAccess; controlToken?: boolean };

/** `"<METHOD> <route url>"` → minimum role. */
export const ROUTE_ROLES: Readonly<Record<string, RouteRule>> = {
  'GET /health': 'public',
  'GET /ready': 'public',
  // Authentication (WI-26)
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/logout': 'public',
  'GET /api/v1/auth/me': 'public',
  // Status / scheduler / shutdown
  'GET /api/v1/status': { role: 'viewer', controlToken: true },
  'POST /api/v1/scheduler/pause': { role: 'operator', controlToken: true },
  'POST /api/v1/scheduler/resume': { role: 'operator', controlToken: true },
  'PATCH /api/v1/scheduler/runtime': 'operator',
  'POST /api/v1/shutdown/drain': { role: 'operator', controlToken: true },
  'POST /api/v1/shutdown/cancel-all': { role: 'operator', controlToken: true },
  // Workflows
  'GET /api/v1/workflows': 'viewer',
  'GET /api/v1/workflows/:id': 'viewer',
  'PATCH /api/v1/workflows/:id/runtime': 'operator',
  'POST /api/v1/workflows/:id/start': 'operator',
  'POST /api/v1/workflows/:id/dry-run': { role: 'viewer', controlToken: true },
  // Runs
  'GET /api/v1/runs': 'viewer',
  'GET /api/v1/runs/:id': 'viewer',
  'GET /api/v1/runs/:id/events': 'viewer',
  'GET /api/v1/runs/:id/logs': 'viewer',
  'GET /api/v1/runs/:id/kept': 'viewer',
  'GET /api/v1/runs/:id/kept/*': 'viewer',
  'POST /api/v1/runs/:id/cancel': 'operator',
  'POST /api/v1/runs/:id/recovery/retry': 'operator',
  // Blocks / lifecycle actions
  'GET /api/v1/blocks': 'viewer',
  'POST /api/v1/blocks/:id/clear': 'operator',
  'GET /api/v1/actions/failed': 'viewer',
  'POST /api/v1/actions/:id/retry': 'operator',
  'POST /api/v1/actions/:id/skip': 'operator',
  // Views
  'GET /api/v1/views': 'viewer',
  'GET /api/v1/views/:id': 'viewer',
  'GET /api/v1/views/:id/items': 'viewer',
  // Configuration
  'GET /api/v1/config': 'viewer',
  'GET /api/v1/config/files': 'viewer',
  'POST /api/v1/config/validate': 'viewer',
  'POST /api/v1/config/reload': { role: 'operator', controlToken: true },
  // Dashboard info tiles (WI-24)
  'GET /api/v1/dashboard/info': 'viewer',
  'POST /api/v1/dashboard/info/:id/refresh': 'operator',
  // Notifications
  'GET /api/v1/notifications': 'viewer',
  'POST /api/v1/notifications/:id/retry': 'operator',
  // Server resources (WI-23)
  'GET /api/v1/system/metrics': 'viewer',
  // SSE
  'GET /api/v1/events': 'viewer',
  // Static web UI (WI-11): the shell is public so the login page can load; all data comes from the API.
  'GET /*': 'public',
};

/** Table key of a route (`HEAD` → its `GET` entry). */
export function routeKey(method: string, url: string): string {
  return `${method === 'HEAD' ? 'GET' : method.toUpperCase()} ${url}`;
}

/** Minimum role of a route, `undefined` if not in the table. */
export function routeAccess(method: string, url: string): RouteAccess | undefined {
  const rule = ROUTE_ROLES[routeKey(method, url)];
  return rule === undefined ? undefined : typeof rule === 'string' ? rule : rule.role;
}

/** True if the local control token is accepted on this route (CLI control commands). */
export function acceptsControlToken(method: string, url: string): boolean {
  const rule = ROUTE_ROLES[routeKey(method, url)];
  return typeof rule === 'object' && rule.controlToken === true;
}

/** True if `role` satisfies `required` (viewer < operator < admin). */
export function roleAllows(role: AuthRole | null, required: RouteAccess): boolean {
  if (required === 'public') return true;
  if (role === null) return false;
  return AUTH_ROLES.indexOf(role) >= AUTH_ROLES.indexOf(required);
}
