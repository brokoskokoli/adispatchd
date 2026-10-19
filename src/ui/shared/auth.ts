/**
 * Login and roles in the web UI (WI-26), DOM-free so it is unit-testable:
 * parsing the untrusted `GET /api/v1/auth/me`, deciding what to show (app,
 * login page, access denied), role checks for buttons, and the login page /
 * toolbar user entry built with the safe element builder (text only).
 */
import type { ElementLike, HFn, Listener } from './dom.js';

/** Roles, ordered (viewer < operator < admin). */
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export type AuthMode = 'none' | 'password' | 'trusted_header';

/** Parsed `GET /api/v1/auth/me`. */
export interface AuthMe {
  mode: AuthMode;
  readRequiresLogin: boolean;
  user: { name: string; role: Role; via: string } | null;
  /** Effective role of the caller (`null` = nothing allowed without login). */
  role: Role | null;
  expiresAt: string | null;
  error: { status: number; code: string; message: string } | null;
}

/** State before `/auth/me` answered or when it failed: behave like `mode: none` would be wrong, so allow nothing. */
export const UNKNOWN_ME: AuthMe = { mode: 'password', readRequiresLogin: true, user: null, role: null, expiresAt: null, error: null };

const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** Validate the API payload defensively. */
export function parseAuthMe(value: unknown): AuthMe {
  if (typeof value !== 'object' || value === null) return UNKNOWN_ME;
  const v = value as Record<string, unknown>;
  const mode: AuthMode = v.mode === 'none' || v.mode === 'password' || v.mode === 'trusted_header' ? v.mode : 'password';
  const u = v.user as Record<string, unknown> | null | undefined;
  const user = u && typeof u === 'object' && typeof u.name === 'string' && isRole(u.role) ? { name: u.name.slice(0, 320), role: u.role, via: typeof u.via === 'string' ? u.via : '' } : null;
  const e = v.error as Record<string, unknown> | null | undefined;
  const error =
    e && typeof e === 'object' && typeof e.code === 'string'
      ? { status: typeof e.status === 'number' ? e.status : 401, code: e.code, message: typeof e.message === 'string' ? e.message : e.code }
      : null;
  return {
    mode,
    readRequiresLogin: v.readRequiresLogin !== false,
    user,
    role: isRole(v.role) ? v.role : null,
    expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : null,
    error,
  };
}

/** True if `role` satisfies `required`. */
export function roleAllows(role: Role | null, required: Role): boolean {
  return role !== null && ROLES.indexOf(role) >= ROLES.indexOf(required);
}

/** What the UI shows. */
export type AuthScreen = 'app' | 'login' | 'denied';

/** Decide between app, login page (password mode) and "access denied" (proxy modes). */
export function authScreen(me: AuthMe): AuthScreen {
  if (me.mode === 'none' || me.role !== null) return 'app';
  return me.mode === 'password' ? 'login' : 'denied';
}

/**
 * Why a button that sends a request needing `required` is disabled, or
 * `null` if it is allowed. Every button sends a write (POST/PATCH), so a
 * logged-in user is needed even if reading works anonymously.
 */
export function denyReason(me: AuthMe, required: Role): string | null {
  if (me.mode === 'none') return null;
  if (!me.user) return me.mode === 'password' ? 'Log in to use this action' : 'Not authenticated';
  if (!roleAllows(me.user.role, required)) return `Requires the role ${required} (you are ${me.user.role})`;
  return null;
}

/** Options of {@link loginPage}. */
export interface LoginPageOptions {
  onSubmit: Listener;
  error?: string | null;
  busy?: boolean;
  /** Shown above the form (e.g. "Your session has expired"). */
  notice?: string | null;
  /** Reading is allowed without login: offer a way back. */
  canSkip?: boolean;
}

/** Login page (password mode). Input names: `name`, `password`. */
export function loginPage<E extends ElementLike>(h: HFn<E>, opts: LoginPageOptions): E {
  return h(
    'div',
    { class: 'login-page' },
    h(
      'form',
      { class: 'login-card card', id: 'login-form', 'aria-labelledby': 'login-title', novalidate: true, on: { submit: opts.onSubmit } },
      h('h1', { id: 'login-title' }, 'Sign in'),
      h('p', { class: 'muted login-sub' }, 'Agent Dispatch Daemon'),
      opts.notice ? h('div', { class: 'alert alert-info', role: 'status' }, opts.notice) : null,
      opts.error ? h('div', { class: 'alert alert-error', role: 'alert' }, opts.error) : null,
      h(
        'label',
        { class: 'field' },
        h('span', null, 'User name'),
        h('input', { class: 'input', type: 'text', name: 'name', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 64, autofocus: true }),
      ),
      h(
        'label',
        { class: 'field' },
        h('span', null, 'Password'),
        h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 1024 }),
      ),
      h('div', { class: 'login-actions' }, h('button', { type: 'submit', class: 'btn btn-primary', disabled: opts.busy ?? false }, opts.busy ? 'Signing in…' : 'Sign in'), opts.canSkip ? h('a', { href: '#/' }, 'Continue without login (read only)') : null),
    ),
  );
}

/** "Access denied" page for the proxy mode (no login form: the proxy authenticates). */
export function deniedPage<E extends ElementLike>(h: HFn<E>, me: AuthMe): E {
  const text =
    me.error?.code === 'login_not_allowed'
      ? 'Your login is not allowed to use adispatchd. Ask an administrator to add it to auth.trusted_header.users.'
      : 'You are not authenticated. Open adispatchd through the authenticating proxy (e.g. Tailscale Serve).';
  return h('div', { class: 'login-page' }, h('div', { class: 'login-card card', role: 'alert' }, h('h1', null, 'Access denied'), h('p', null, text), me.error ? h('p', { class: 'muted' }, h('code', null, me.error.code)) : null));
}

/** Toolbar entry: user + role and logout (password mode), or a login link. */
export function userEntry<E extends ElementLike>(h: HFn<E>, me: AuthMe, opts: { onLogout: Listener }): E | null {
  if (me.mode === 'none') return null;
  if (!me.user) {
    // Only while reading anonymously (read_requires_login: false); otherwise the login page is shown anyway.
    return me.mode === 'password' && me.role !== null ? h('a', { class: 'user-entry', href: '#/login' }, 'Log in') : null;
  }
  return h(
    'span',
    { class: 'user-entry', title: me.expiresAt ? `Session valid until ${me.expiresAt}` : null },
    h('span', { class: 'user-name' }, me.user.name),
    ' ',
    h('span', { class: `badge badge-muted role-${me.user.role}` }, me.user.role),
    me.mode === 'password' ? h('button', { type: 'button', class: 'btn btn-plain btn-small', on: { click: opts.onLogout } }, 'Log out') : null,
  );
}
