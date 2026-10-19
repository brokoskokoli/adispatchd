import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

describe('auth (WI-26)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(yaml: string): Promise<Awaited<ReturnType<typeof loadConfig>>> {
    t = await createTempConfigDir({ ...BASE_FILES, 'config.yaml': yaml });
    return loadConfig(t.dir, { dataDir: t.dataDir });
  }
  async function loadOk(yaml: string): Promise<LoadedConfig> {
    const res = await load(yaml);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    return res.config;
  }

  it('defaults to mode none (behaviour before 0.4.0)', async () => {
    const config = await loadOk('server: { port: 8787 }\n');
    expect(config.global.auth).toEqual({
      mode: 'none',
      users: [],
      trustedHeader: { header: 'tailscale-user-login', trustedProxies: ['127.0.0.1', '::1'], users: [] },
      trustedProxies: ['127.0.0.1', '::1'],
      sessionTtlMs: 12 * 60 * 60_000,
      readRequiresLogin: true,
    });
  });

  it('normalizes password and trusted_header settings', async () => {
    const config = await loadOk(`auth:
  mode: trusted_header
  users:
    - { name: alice, password_hash_env: ADISPATCH_PW_ALICE, role: admin }
  trusted_header:
    header: X-Forwarded-User
    trusted_proxies: [127.0.0.1, "100.64.0.0/10", "fd7a:115c:a1e0::/48"]
    users:
      - { login: Alice@Example.com, role: operator }
  trusted_proxies: [10.0.0.1]
  session_ttl: 30m
  read_requires_login: false
`);
    expect(config.global.auth).toEqual({
      mode: 'trusted_header',
      users: [{ name: 'alice', passwordHashEnv: 'ADISPATCH_PW_ALICE', role: 'admin' }],
      trustedHeader: {
        header: 'x-forwarded-user',
        trustedProxies: ['127.0.0.1', '100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
        users: [{ login: 'alice@example.com', role: 'operator' }],
      },
      trustedProxies: ['10.0.0.1'],
      sessionTtlMs: 30 * 60_000,
      readRequiresLogin: false,
    });
  });

  it('rejects unknown modes/roles, bad proxies, reserved headers, duplicates and out-of-range TTLs', async () => {
    const res = await load(`auth:
  mode: basic
  users:
    - { name: alice, password_hash_env: PW_A, role: root }
    - { name: "bad name", password_hash_env: PW_B, role: viewer }
  trusted_header:
    header: Cookie
    trusted_proxies: [localhost, "10.0.0.0/33"]
    users:
      - { login: "a b", role: viewer }
  session_ttl: 10s
  password: plaintext
`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const paths = res.errors.map((e) => e.path);
    for (const p of [
      'auth.mode',
      'auth.users[0].role',
      'auth.users[1].name',
      'auth.trusted_header.header',
      'auth.trusted_header.trusted_proxies[0]',
      'auth.trusted_header.trusted_proxies[1]',
      'auth.trusted_header.users[0].login',
      'auth.session_ttl',
    ]) {
      expect(paths, p).toContain(p);
    }
    expect(res.errors.some((e) => /password/.test(e.message))).toBe(true); // unknown key (no plaintext passwords)

    const dup = await load(`auth:
  mode: password
  users:
    - { name: alice, password_hash_env: PW_A, role: admin }
    - { name: Alice, password_hash_env: PW_B, role: viewer }
  trusted_header:
    users:
      - { login: a@example.com, role: viewer }
      - { login: A@example.com, role: admin }
`);
    expect(!dup.ok && dup.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      'auth.users[1].name: Duplicate user "Alice"',
      'auth.trusted_header.users[1].login: Duplicate login "a@example.com"',
    ]);
  });

  it('warns when a mode has nobody who could log in', async () => {
    const pw = await load('auth: { mode: password }\n');
    expect(pw.warnings.map((w) => w.path)).toContain('auth.users');
    const th = await load('auth: { mode: trusted_header, trusted_header: { trusted_proxies: [] } }\n');
    expect(th.warnings.map((w) => w.path)).toEqual(expect.arrayContaining(['auth.trusted_header.users', 'auth.trusted_header.trusted_proxies']));
  });
});
