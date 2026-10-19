import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const IDENTITIES = `identities:
  maintainer: { type: github_app, app_id: 1, installation_id: 2, private_key_env: K1, ui_actions: true }
  coder: { type: github_app, app_id: 3, installation_id: 4, private_key_env: K2 }
  board: { type: github_token, token_env: T1, ui_actions: true }
`;

describe('identities.ui_actions (WI-27)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(config: string, identities = IDENTITIES) {
    t = await createTempConfigDir({ ...BASE_FILES, 'config.yaml': config, 'identities.yaml': identities });
    return loadConfig(t.dir, { dataDir: t.dataDir });
  }

  it('defaults to false and is normalized for both identity types', async () => {
    const res = await load('auth: { mode: password, users: [{ name: a, password_hash_env: PW_A, role: admin }] }\n');
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.config.identities.maintainer?.uiActions).toBe(true);
    expect(res.config.identities.coder?.uiActions).toBe(false);
    expect(res.config.identities.board?.uiActions).toBe(true);
    expect(res.warnings.filter((w) => w.path.endsWith('ui_actions'))).toEqual([]);
  });

  it('warns when ui_actions is enabled without authentication', async () => {
    const res = await load('scheduler: { max_concurrent: 1 }\n');
    expect(res.ok).toBe(true);
    const warnings = res.warnings.filter((w) => w.path.endsWith('ui_actions'));
    expect(warnings.map((w) => `${w.file}: ${w.path}`)).toEqual(['identities.yaml: identities.maintainer.ui_actions', 'identities.yaml: identities.board.ui_actions']);
    expect(warnings[0]?.message).toMatch(/need a login/);
  });

  it('is an error with a header login a local process could forge (loopback proxy)', async () => {
    const th = (proxies: string) =>
      `auth:\n  mode: trusted_header\n  trusted_header:\n    trusted_proxies: [${proxies}]\n    users: [{ login: a@example.com, role: admin }]\n`;
    for (const proxies of ['127.0.0.1', '"::1"', '"127.0.0.0/8"', '"10.0.0.5", "::1"']) {
      const res = await load(th(proxies));
      expect(res.ok, proxies).toBe(false);
      if (res.ok) continue;
      expect(res.errors.map((e) => `${e.file}: ${e.path}`)).toEqual(['identities.yaml: identities.maintainer.ui_actions', 'identities.yaml: identities.board.ui_actions']);
      expect(res.errors[0]?.message).toMatch(/forge the login header.*auth\.mode password/);
      await t?.cleanup();
      t = undefined;
    }
    // A remote proxy only: allowed; without ui_actions: allowed.
    expect((await load(th('"100.64.0.10"'))).ok).toBe(true);
    await t?.cleanup();
    t = undefined;
    expect((await load(th('127.0.0.1'), 'identities:\n  maintainer: { type: github_app, app_id: 1, installation_id: 2, private_key_env: K1 }\n  coder: { type: github_app, app_id: 3, installation_id: 4, private_key_env: K2 }\n')).ok).toBe(true);
  });

  it('rejects non-boolean values', async () => {
    const res = await load('scheduler: { max_concurrent: 1 }\n', 'identities:\n  maintainer: { type: github_app, app_id: 1, installation_id: 2, private_key_env: K, ui_actions: "yes" }\n  coder: { type: github_app, app_id: 3, installation_id: 4, private_key_env: K2 }\n');
    expect(res.ok).toBe(false);
  });
});
