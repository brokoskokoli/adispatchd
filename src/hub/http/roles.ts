/**
 * Minimum role per route of the hub's HTTP server (WI-36), same rules and
 * roles as the instances (WI-26): reading from `viewer`, controlling workspaces
 * from `operator`, the audit log for `admin`. Every route the server registers
 * must be listed (the server refuses others), and `http.test.ts` compares this
 * table with the table in docs/api.md.
 */
import { AUTH_ROLES, type AuthRole } from '../../config/index.js';

/** Required access of a route. */
export type HubRouteAccess = AuthRole | 'public';

/** `"<METHOD> <route url>"` → minimum role. */
export const HUB_ROUTE_ROLES: Readonly<Record<string, HubRouteAccess>> = {
  'GET /health': 'public',
  // Authentication: the hub's own login (also served below /w/<id>/ for the workspace UIs)
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/logout': 'public',
  'GET /api/v1/auth/me': 'public',
  // Overview
  'GET /api/v1/hub/status': 'viewer',
  'GET /api/v1/hub/workspaces': 'viewer',
  'GET /api/v1/hub/workspaces/:id': 'viewer',
  'GET /api/v1/hub/events': 'viewer',
  // Control
  'POST /api/v1/hub/workspaces/:id/start': 'operator',
  'POST /api/v1/hub/workspaces/:id/stop': 'operator',
  'POST /api/v1/hub/workspaces/:id/restart': 'operator',
  'POST /api/v1/hub/workspaces/:id/drain': 'operator',
  'POST /api/v1/hub/pause': 'operator',
  'POST /api/v1/hub/resume': 'operator',
  'POST /api/v1/hub/stop-all': 'operator',
  'POST /api/v1/hub/drain-all': 'operator',
  // Audit
  'GET /api/v1/hub/audit': 'admin',
  // Static overview UI: the shell contains no data
  'GET /': 'public',
  'GET /*': 'public',
};

/** Minimum role of a route, `undefined` if not in the table (`HEAD` uses the `GET` entry). */
export function hubRouteAccess(method: string, url: string): HubRouteAccess | undefined {
  return HUB_ROUTE_ROLES[`${method === 'HEAD' ? 'GET' : method.toUpperCase()} ${url}`];
}

/** True if `role` satisfies `required` (viewer < operator < admin). */
export function hubRoleAllows(role: AuthRole | null, required: HubRouteAccess): boolean {
  if (required === 'public') return true;
  if (role === null) return false;
  return AUTH_ROLES.indexOf(role) >= AUTH_ROLES.indexOf(required);
}
