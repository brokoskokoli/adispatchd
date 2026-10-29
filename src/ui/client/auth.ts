/**
 * Login state of the web UI (WI-26): `GET /api/v1/auth/me` once at start
 * (and after login/logout), role checks for buttons.
 */
import { appPath } from '../shared/base-path.js';
import { denyReason, parseAuthMe, UNKNOWN_ME, type AuthMe, type Role } from '../shared/auth.js';

let me: AuthMe = UNKNOWN_ME;

/** Current login state. */
export function currentAuth(): AuthMe {
  return me;
}

/** Load `/api/v1/auth/me` (no CSRF needed, never throws). */
export async function loadAuth(): Promise<AuthMe> {
  try {
    const res = await fetch(appPath('/api/v1/auth/me'), { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    me = res.ok ? parseAuthMe(await res.json()) : UNKNOWN_ME;
  } catch {
    me = UNKNOWN_ME;
  }
  return me;
}

/** Reason why an action needing `required` is not allowed, `null` if allowed. */
export function denied(required: Role): string | null {
  return denyReason(me, required);
}

/** Event fired on `window` when the API answers 401 (session expired / logged out elsewhere). */
export const UNAUTHORIZED_EVENT = 'adispatch:unauthorized';
