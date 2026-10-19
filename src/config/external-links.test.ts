import { afterEach, describe, expect, it } from 'vitest';
import {
  activeExternalLinks,
  externalLinkFrameOrigins,
  frameOrigin,
  isTokenLikeParam,
  loadConfig,
  redactExternalLinkUrl,
  toPublicConfig,
  type LoadedConfig,
} from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

describe('ui.external_links (WI-25)', () => {
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

  it('defaults to no links (nothing visible, no frame origins)', async () => {
    const config = await loadOk('server: { port: 8787 }\n');
    expect(config.global.ui.externalLinks).toEqual([]);
    expect(activeExternalLinks(config.global)).toEqual([]);
    expect(externalLinkFrameOrigins(config.global)).toEqual([]);
  });

  it('normalizes entries with defaults enabled=true, embed=false', async () => {
    const config = await loadOk(`ui:
  external_links:
    - { id: claude-inspect, label: Claude Inspect, url: "http://127.0.0.1:47717/", embed: true }
    - { id: grafana, label: Grafana, url: "https://grafana.example.com/d/abc?orgId=1" }
    - { id: off, label: Disabled, url: "https://off.example.com/", enabled: false, embed: true }
`);
    expect(config.global.ui.externalLinks).toEqual([
      { id: 'claude-inspect', label: 'Claude Inspect', url: 'http://127.0.0.1:47717/', enabled: true, embed: true },
      { id: 'grafana', label: 'Grafana', url: 'https://grafana.example.com/d/abc?orgId=1', enabled: true, embed: false },
      { id: 'off', label: 'Disabled', url: 'https://off.example.com/', enabled: false, embed: true },
    ]);
    // only active entries, without the `enabled` flag
    expect(activeExternalLinks(config.global)).toEqual([
      { id: 'claude-inspect', label: 'Claude Inspect', url: 'http://127.0.0.1:47717/', embed: true },
      { id: 'grafana', label: 'Grafana', url: 'https://grafana.example.com/d/abc?orgId=1', embed: false },
    ]);
    // frame-src only for active embed entries
    expect(externalLinkFrameOrigins(config.global)).toEqual(['http://127.0.0.1:47717']);
  });

  it('frame origins are normalized and deduplicated', async () => {
    const config = await loadOk(`ui:
  external_links:
    - { id: a, label: A, url: "HTTPS://Tools.Example.com:443/a/", embed: true }
    - { id: b, label: B, url: "https://tools.example.com/b/?x=1#frag", embed: true }
    - { id: c, label: C, url: "http://localhost:7717", embed: true }
`);
    expect(externalLinkFrameOrigins(config.global)).toEqual(['https://tools.example.com', 'http://localhost:7717']);
  });

  it('rejects non-http(s) schemes, relative URLs and credentials without echoing the URL', async () => {
    const res = await load(`ui:
  external_links:
    - { id: js, label: JS, url: "javascript:alert(1)" }
    - { id: file, label: File, url: "file:///etc/passwd" }
    - { id: rel, label: Rel, url: "/inspect/" }
    - { id: cred, label: Cred, url: "https://admin:hunter2@tools.example.com/" }
    - { id: user, label: User, url: "https://admin@tools.example.com/" }
`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => [e.path, e.message])).toEqual([
      ['ui.external_links[0].url', 'Must be an absolute http(s) URL'],
      ['ui.external_links[1].url', 'Must be an absolute http(s) URL'],
      ['ui.external_links[2].url', 'Must be an absolute http(s) URL'],
      ['ui.external_links[3].url', expect.stringContaining('Must not contain credentials')],
      ['ui.external_links[4].url', expect.stringContaining('Must not contain credentials')],
    ]);
    expect(JSON.stringify(res.errors)).not.toContain('hunter2');
    expect(res.errors.every((e) => e.line !== undefined)).toBe(true);
  });

  it('rejects duplicate IDs, invalid IDs, bad labels, unknown keys and non-boolean flags', async () => {
    const res = await load(`ui:
  external_links:
    - { id: tool, label: One, url: "https://a.example.com/" }
    - { id: tool, label: Two, url: "https://b.example.com/" }
    - { id: "bad id", label: X, url: "https://c.example.com/" }
    - { id: empty, label: "  ", url: "https://d.example.com/" }
    - { id: long, label: "${'x'.repeat(41)}", url: "https://e.example.com/" }
    - { id: flags, label: F, url: "https://f.example.com/", embed: "yes", enabled: 1 }
    - { id: extra, label: E, url: "https://g.example.com/", target: _blank }
`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const paths = res.errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'ui.external_links[2].id',
        'ui.external_links[3].label',
        'ui.external_links[4].label',
        'ui.external_links[5].embed',
        'ui.external_links[5].enabled',
        'ui.external_links[6]',
      ]),
    );
    // duplicate IDs are a semantic check: only reported once the schema passes
    const dup = await load(`ui:
  external_links:
    - { id: tool, label: One, url: "https://a.example.com/" }
    - { id: tool, label: Two, url: "https://b.example.com/" }
`);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.map((e) => [e.path, e.message])).toEqual([['ui.external_links[1].id', 'Duplicate external link ID "tool"']]);
  });

  it('warns about token-like query parameters (but accepts the URL)', async () => {
    const res = await load(`ui:
  external_links:
    - { id: inspect, label: Inspect, url: "http://127.0.0.1:7717/?t=abc123" }
    - { id: grafana, label: Grafana, url: "https://grafana.example.com/?orgId=1&access_token=x" }
    - { id: plain, label: Plain, url: "https://plain.example.com/?tab=runs&theme=dark" }
`);
    expect(res.ok).toBe(true);
    const warnings = res.warnings.filter((w) => w.path.startsWith('ui.'));
    expect(warnings.map((w) => w.path)).toEqual(['ui.external_links[0].url', 'ui.external_links[1].url']);
    expect(warnings[0]?.message).toContain('"t"');
    expect(warnings[1]?.message).toContain('"access_token"');
    expect(JSON.stringify(warnings)).not.toContain('abc123');
  });

  it('rejects embed: true for hosts that cannot be expressed in frame-src (IPv6, "*", ";", ",", "_")', async () => {
    const res = await load(`ui:
  external_links:
    - { id: v6, label: V6, url: "http://[::1]:47717/", embed: true }
    - { id: star, label: Star, url: "https://*.example.com/", embed: true }
    - { id: semi, label: Semi, url: "https://a;script-src.example.com/", embed: true }
    - { id: comma, label: Comma, url: "https://a,b.example.com/", embed: true }
    - { id: under, label: Under, url: "https://a_b.example.com/", embed: true }
    - { id: ok, label: Ok, url: "https://*.example.com/", embed: false }
`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.path)).toEqual([0, 1, 2, 3, 4].map((i) => `ui.external_links[${i}].embed`));
    expect(res.errors[0]?.message).toContain('frame-src');
  });

  it('frame-src never contains CSP metacharacters, even if validation were bypassed', () => {
    const links = ['https://*.example.com/', 'https://a;script-src.example.com/', "https://a'b.example.com/", 'https://a,b.example.com/', 'https://a_b.example.com/', 'http://[::1]:1/'].map(
      (url, i) => ({ id: `l${i}`, label: 'L', url, enabled: true, embed: true }),
    );
    links.push({ id: 'good', label: 'G', url: 'https://Good.Example.com:8443/x', enabled: true, embed: true });
    const global = { ui: { externalLinks: links } } as unknown as LoadedConfig['global'];
    expect(externalLinkFrameOrigins(global)).toEqual(['https://good.example.com:8443']);
    for (const l of links.slice(0, -1)) expect(frameOrigin(l.url), l.url).toBeNull();
  });

  it('public config drops disabled links and redacts query strings and fragments', async () => {
    const config = await loadOk(`ui:
  external_links:
    - { id: inspect, label: Inspect, url: "http://127.0.0.1:7717/app/?t=secret-token#k=v", embed: true }
    - { id: plain, label: Plain, url: "https://plain.example.com/d/x" }
    - { id: off, label: Off, url: "https://off.example.com/?token=disabled-secret", enabled: false }
`);
    const pub = toPublicConfig(config);
    expect(pub.global.ui.externalLinks).toEqual([
      { id: 'inspect', label: 'Inspect', url: 'http://127.0.0.1:7717/app/?[REDACTED]#[REDACTED]', enabled: true, embed: true },
      { id: 'plain', label: 'Plain', url: 'https://plain.example.com/d/x', enabled: true, embed: false },
    ]);
    const json = JSON.stringify(pub);
    expect(json).not.toContain('secret-token');
    expect(json).not.toContain('disabled-secret');
    expect(json).not.toContain('off.example.com');
    // the active configuration itself is untouched
    expect(config.global.ui.externalLinks).toHaveLength(3);
    expect(redactExternalLinkUrl('not a url')).toBe('[REDACTED]');
  });

  it('classifies token-like parameter names', () => {
    for (const n of ['t', 'T', 'token', 'access_token', 'apiKey', 'api-key', 'key', 'secret', 'password', 'auth', 'sig']) expect(isTokenLikeParam(n), n).toBe(true);
    for (const n of ['tab', 'theme', 'orgId', 'q', 'session', 'view', 'refresh']) expect(isTokenLikeParam(n), n).toBe(false);
  });
});
