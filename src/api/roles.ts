/**
 * Minimum role per HTTP route (WI-26). Every route the API registers must be
 * listed here – `createApiServer` refuses to register a route without an
 * entry, and `roles.test.ts` compares this table with the registered routes
 * and with the table in docs/api.md.
 *
 * `public` = no login needed (health checks, login itself, the static UI
 * shell, which contains no data). HEAD requests use the entry of the GET route.
 */
import { AUTH_ROLES, type AuthRole } from '../config/index.js';

/** Required access of a route. */
export type RouteAccess = AuthRole | 'public';

/** `"<METHOD> <route url>"` → minimum role. */
export const ROUTE_ROLES: Readonly<Record<string, RouteAccess>> = {
  'GET /health': 'public',
  'GET /ready': 'public',
  // Authentication (WI-26)
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/logout': 'public',
  'GET /api/v1/auth/me': 'public',
  // Status / scheduler / shutdown
  'GET /api/v1/status': 'viewer',
  'POST /api/v1/scheduler/pause': 'operator',
  'POST /api/v1/scheduler/resume': 'operator',
  'PATCH /api/v1/scheduler/runtime': 'operator',
  'POST /api/v1/shutdown/drain': 'operator',
  'POST /api/v1/shutdown/cancel-all': 'operator',
  // Workflows
  'GET /api/v1/workflows': 'viewer',
  'GET /api/v1/workflows/:id': 'viewer',
  'PATCH /api/v1/workflows/:id/runtime': 'operator',
  'POST /api/v1/workflows/:id/start': 'operator',
  'POST /api/v1/workflows/:id/dry-run': 'viewer',
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
  'POST /api/v1/config/reload': 'operator',
  // Dashboard info tiles (WI-24)
  'GET /api/v1/dashboard/info': 'viewer',
  'POST /api/v1/dashboard/info/:id/refresh': 'operator',
  // Notifications
  'GET /api/v1/notifications': 'viewer',
  'POST /api/v1/notifications/:id/retry': 'operator',
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
  return ROUTE_ROLES[routeKey(method, url)];
}

/** True if `role` satisfies `required` (viewer < operator < admin). */
export function roleAllows(role: AuthRole | null, required: RouteAccess): boolean {
  if (required === 'public') return true;
  if (role === null) return false;
  return AUTH_ROLES.indexOf(role) >= AUTH_ROLES.indexOf(required);
}
