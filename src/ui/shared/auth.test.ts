import { describe, expect, it } from 'vitest';
import { authScreen, deniedPage, denyReason, loginPage, parseAuthMe, roleAllows, UNKNOWN_ME, userEntry, type AuthMe } from './auth.js';
import { createH, type DocLike, type ElementLike, type NodeLike } from './dom.js';

/** Minimal fake DOM (no HTML parser): text only via createTextNode. */
class FakeText implements NodeLike {
  readonly nodeType = 3;
  constructor(readonly data: string) {}
}
class FakeElement implements ElementLike {
  readonly nodeType = 1;
  attrs: Record<string, string> = {};
  children: Array<FakeElement | FakeText> = [];
  listeners: Record<string, unknown> = {};
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  appendChild(child: NodeLike): unknown {
    this.children.push(child as FakeElement | FakeText);
    return child;
  }
  addEventListener(type: string, listener: unknown): void {
    this.listeners[type] = listener;
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
  }
  find(tag: string): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(c.tag === tag ? [c] : []), ...c.find(tag)] : []));
  }
}
const doc: DocLike<FakeElement, FakeText> = { createElement: (t) => new FakeElement(t), createTextNode: (d) => new FakeText(d) };
const h = createH(doc);

const me = (over: Partial<AuthMe>): AuthMe => ({ ...UNKNOWN_ME, ...over });
const viewer = me({ mode: 'password', user: { name: 'victor', role: 'viewer', via: 'password' }, role: 'viewer' });
const operator = me({ mode: 'password', user: { name: 'olga', role: 'operator', via: 'password' }, role: 'operator' });

describe('parseAuthMe (untrusted API data)', () => {
  it('parses a valid answer and rejects garbage', () => {
    expect(parseAuthMe({ mode: 'none', readRequiresLogin: false, user: null, role: 'admin', expiresAt: null, error: null })).toEqual({
      mode: 'none',
      readRequiresLogin: false,
      user: null,
      role: 'admin',
      expiresAt: null,
      error: null,
    });
    expect(parseAuthMe(null)).toEqual(UNKNOWN_ME);
    expect(parseAuthMe({ mode: 'evil', user: { name: 'x', role: 'root' }, role: 'root' })).toMatchObject({ mode: 'password', user: null, role: null });
    expect(parseAuthMe({ mode: 'trusted_header', error: { status: 403, code: 'login_not_allowed', message: 'm' } }).error).toEqual({ status: 403, code: 'login_not_allowed', message: 'm' });
  });
});

describe('screens and role checks', () => {
  it('shows the app with mode none or any effective role, else login (password) or access denied (proxy)', () => {
    expect(authScreen(me({ mode: 'none', role: 'admin' }))).toBe('app');
    expect(authScreen(viewer)).toBe('app');
    expect(authScreen(me({ mode: 'password', role: 'viewer', readRequiresLogin: false }))).toBe('app');
    expect(authScreen(me({ mode: 'password' }))).toBe('login');
    expect(authScreen(me({ mode: 'trusted_header' }))).toBe('denied');
    expect(authScreen(UNKNOWN_ME)).toBe('login');
  });

  it('role-dependent buttons: disabled with a reason when the role is missing or nobody is logged in', () => {
    expect(denyReason(me({ mode: 'none', role: 'admin' }), 'operator')).toBeNull();
    expect(denyReason(viewer, 'viewer')).toBeNull();
    expect(denyReason(viewer, 'operator')).toBe('Requires the role operator (you are viewer)');
    expect(denyReason(operator, 'operator')).toBeNull();
    expect(denyReason(operator, 'admin')).toBe('Requires the role admin (you are operator)');
    // Anonymous reading (read_requires_login: false): every write button needs a login.
    expect(denyReason(me({ mode: 'password', role: 'viewer', readRequiresLogin: false }), 'viewer')).toBe('Log in to use this action');
    expect(denyReason(me({ mode: 'trusted_header' }), 'viewer')).toBe('Not authenticated');
    expect(roleAllows('admin', 'operator')).toBe(true);
    expect(roleAllows(null, 'viewer')).toBe(false);
  });
});

describe('login page', () => {
  it('has a form with user name and password fields (autocomplete for password managers) and a submit button', () => {
    let submitted = false;
    const page = loginPage(h, { onSubmit: () => (submitted = true) });
    const form = page.find('form')[0]!;
    expect(form.attrs.id).toBe('login-form');
    const inputs = page.find('input');
    expect(inputs.map((i) => [i.attrs.name, i.attrs.type, i.attrs.autocomplete])).toEqual([
      ['name', 'text', 'username'],
      ['password', 'password', 'current-password'],
    ]);
    expect(page.find('button')[0]!.attrs.type).toBe('submit');
    (form.listeners.submit as () => void)();
    expect(submitted).toBe(true);
    expect(page.textContent).toContain('Sign in');
    expect(page.find('a')).toEqual([]);
  });

  it('renders errors and notices as text only; offers read-only access when allowed', () => {
    const page = loginPage(h, { onSubmit: () => undefined, error: '<img src=x onerror=alert(1)>', notice: 'Your session has ended.', canSkip: true, busy: true });
    expect(page.find('img')).toEqual([]);
    expect(page.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(page.textContent).toContain('Your session has ended.');
    expect(page.find('button')[0]!.attrs.disabled).toBe('');
    expect(page.find('a')[0]!.attrs.href).toBe('#/');
  });

  it('access denied page explains the proxy case', () => {
    const page = deniedPage(h, me({ mode: 'trusted_header', error: { status: 403, code: 'login_not_allowed', message: 'x' } }));
    expect(page.textContent).toContain('not allowed');
    expect(page.textContent).toContain('login_not_allowed');
    expect(page.find('form')).toEqual([]);
  });
});

describe('toolbar user entry', () => {
  it('shows user, role and logout (password), only the user (proxy), a login link (anonymous) or nothing (mode none)', () => {
    let out = false;
    const entry = userEntry(h, operator, { onLogout: () => (out = true) })!;
    expect(entry.textContent).toContain('olga');
    expect(entry.textContent).toContain('operator');
    const logout = entry.find('button')[0]!;
    expect(logout.textContent).toBe('Log out');
    (logout.listeners.click as () => void)();
    expect(out).toBe(true);
    const proxy = userEntry(h, me({ mode: 'trusted_header', user: { name: 'alice@example.com', role: 'admin', via: 'trusted_header' }, role: 'admin' }), { onLogout: () => undefined })!;
    expect(proxy.find('button')).toEqual([]);
    expect(userEntry(h, me({ mode: 'password', role: 'viewer', readRequiresLogin: false }), { onLogout: () => undefined })!.attrs.href).toBe('#/login');
    expect(userEntry(h, me({ mode: 'password' }), { onLogout: () => undefined })).toBeNull(); // login page is shown
    expect(userEntry(h, me({ mode: 'none', role: 'admin' }), { onLogout: () => undefined })).toBeNull();
  });
});
