import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

describe('server.allowed_hosts (WI-10, DNS-rebinding protection)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  it('normalizes allowed hosts to lower case', async () => {
    t = await createTempConfigDir({ ...BASE_FILES, 'config.yaml': 'server: { allowed_hosts: [Adispatchd.Example.com, "proxy.example.com:8443", "[::1]"] }\n' });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    expect(res.ok && res.config.global.server.allowedHosts).toEqual(['adispatchd.example.com', 'proxy.example.com:8443', '[::1]']);
  });

  it('rejects entries with scheme, path or wildcards', async () => {
    t = await createTempConfigDir({ ...BASE_FILES, 'config.yaml': 'server: { allowed_hosts: ["https://x.example", "*.example.com"] }\n' });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.map((e) => e.path)).toEqual(['server.allowed_hosts[0]', 'server.allowed_hosts[1]']);
  });
});
