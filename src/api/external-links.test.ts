/**
 * WI-25: external tools in the toolbar – API delivery of the active links and
 * the UI's Content-Security-Policy (`frame-src` only for embedded tools,
 * updated by a config reload).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { UI_CSP_DIRECTIVES, uiContentSecurityPolicy } from './csp.js';
import { startAppEnv, type AppEnv } from './testing/helpers.js';

const LINKS = `ui:
  external_links:
    - { id: claude-inspect, label: Claude Inspect, url: "http://127.0.0.1:47717/", embed: true }
    - { id: grafana, label: Grafana, url: "https://grafana.example.com/d/x" }
    - { id: hidden, label: Hidden, url: "https://hidden.example.com/", enabled: false, embed: true }
`;

let env: AppEnv | null = null;
const uiDirs: string[] = [];
afterEach(async () => {
  await env?.cleanup();
  env = null;
});
afterAll(() => {
  for (const d of uiDirs) rmSync(d, { recursive: true, force: true });
});

async function start(configExtra: string): Promise<AppEnv> {
  // Minimal static UI (the real build is covered by src/ui/ui.test.ts).
  const uiDir = mkdtempSync(path.join(os.tmpdir(), 'orch-ui-links-'));
  uiDirs.push(uiDir);
  writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>t</title>\n');
  writeFileSync(path.join(uiDir, 'app.css'), 'body{}\n');
  env = await startAppEnv({ configExtra, app: { uiDir } });
  return env;
}

function directives(csp: unknown): Map<string, string> {
  return new Map(
    String(csp)
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.split(/\s+/)[0]!, d] as [string, string]),
  );
}

describe('uiContentSecurityPolicy', () => {
  it('keeps the strict base policy and appends frame-src only with origins', () => {
    expect(uiContentSecurityPolicy([])).toBe(UI_CSP_DIRECTIVES.join('; '));
    expect(uiContentSecurityPolicy([])).not.toContain('frame-src');
    expect(uiContentSecurityPolicy(['http://127.0.0.1:47717', 'https://tools.example.com'])).toBe(
      `${UI_CSP_DIRECTIVES.join('; ')}; frame-src http://127.0.0.1:47717 https://tools.example.com`,
    );
  });
});

describe('external links (WI-25)', () => {
  it('GET /api/v1/config lists only the active links (id, label, url, embed)', async () => {
    const e = await start(LINKS);
    const res = await e.request('GET', '/api/v1/config');
    expect(res.status).toBe(200);
    expect(res.json.externalLinks).toEqual([
      { id: 'claude-inspect', label: 'Claude Inspect', url: 'http://127.0.0.1:47717/', embed: true },
      { id: 'grafana', label: 'Grafana', url: 'https://grafana.example.com/d/x', embed: false },
    ]);
    // The public config view leaves out disabled entries (their URLs may carry tokens).
    expect(res.json.config.global.ui.externalLinks.map((l: { id: string }) => l.id)).toEqual(['claude-inspect', 'grafana']);
    expect(JSON.stringify(res.json)).not.toContain('hidden.example.com');
  });

  it('UI-path 404s and HEAD requests carry the UI CSP as well', async () => {
    const e = await start(LINKS);
    const missing = await e.request('GET', '/missing/page.html');
    expect(missing.status).toBe(404);
    expect(directives(missing.headers['content-security-policy']).get('frame-src')).toBe('frame-src http://127.0.0.1:47717');
    expect(missing.headers['x-frame-options']).toBe('DENY');
    for (const url of ['/', '/index.html']) {
      const head = await e.request('HEAD', url);
      expect(head.status, url).toBe(200);
      expect(directives(head.headers['content-security-policy']).get('default-src'), url).toBe("default-src 'none'");
      expect(directives(head.headers['content-security-policy']).get('frame-src'), url).toBe('frame-src http://127.0.0.1:47717');
    }
    // API 404 stays without the UI policy
    const api404 = await e.request('GET', '/api/v1/nope');
    expect(api404.status).toBe(404);
    expect(api404.headers['content-security-policy']).toBeUndefined();
  });

  it('without links: empty list and the unchanged strict CSP without frame-src', async () => {
    const e = await start('');
    expect((await e.request('GET', '/api/v1/config')).json.externalLinks).toEqual([]);
    const res = await e.request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe(UI_CSP_DIRECTIVES.join('; '));
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('UI responses allow frame-src exactly for the enabled embed entries', async () => {
    const e = await start(LINKS);
    for (const url of ['/', '/index.html', '/app.css']) {
      const res = await e.request('GET', url);
      expect(res.status, url).toBe(200);
      const d = directives(res.headers['content-security-policy']);
      expect(d.get('frame-src'), url).toBe('frame-src http://127.0.0.1:47717');
      expect(d.get('default-src')).toBe("default-src 'none'");
      expect(d.get('script-src')).toBe("script-src 'self'");
    }
    // API responses are unchanged (no UI policy); kept-file downloads keep their own sandbox CSP.
    const api = await e.request('GET', '/api/v1/status');
    expect(api.headers['content-security-policy']).toBeUndefined();
    expect(api.headers['cache-control']).toBe('no-store');
  });

  it('a config reload updates frame-src (added, changed, disabled)', async () => {
    const e = await start('');
    const csp = async (): Promise<string | undefined> => directives((await e.request('GET', '/')).headers['content-security-policy']).get('frame-src');
    expect(await csp()).toBeUndefined();

    const file = path.join(e.configDir, 'config.yaml');
    const base = readFileSync(file, 'utf8');
    const reload = async (extra: string): Promise<void> => {
      writeFileSync(file, `${base}\n${extra}`);
      const res = await e.request('POST', '/api/v1/config/reload', {});
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    };

    await reload(LINKS);
    expect(await csp()).toBe('frame-src http://127.0.0.1:47717');

    await reload(`ui:
  external_links:
    - { id: claude-inspect, label: Claude Inspect, url: "https://inspect.example.com/inspect/", embed: true }
    - { id: grafana, label: Grafana, url: "https://grafana.example.com/", embed: true }
`);
    expect(await csp()).toBe('frame-src https://inspect.example.com https://grafana.example.com');
    expect((await e.request('GET', '/api/v1/config')).json.externalLinks.map((l: { id: string }) => l.id)).toEqual(['claude-inspect', 'grafana']);

    await reload(`ui:
  external_links:
    - { id: claude-inspect, label: Claude Inspect, url: "https://inspect.example.com/", embed: true, enabled: false }
    - { id: grafana, label: Grafana, url: "https://grafana.example.com/", embed: false }
`);
    expect(await csp()).toBeUndefined();
    expect((await e.request('GET', '/api/v1/config')).json.externalLinks).toEqual([
      { id: 'grafana', label: 'Grafana', url: 'https://grafana.example.com/', embed: false },
    ]);
  });

  it('an invalid link keeps the active configuration (and its CSP)', async () => {
    const e = await start(LINKS);
    const file = path.join(e.configDir, 'config.yaml');
    writeFileSync(file, `${readFileSync(file, 'utf8').replace('http://127.0.0.1:47717/', 'javascript:alert(1)')}`);
    const res = await e.request('POST', '/api/v1/config/reload', {});
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).toContain('ui.external_links[0].url');
    expect(directives((await e.request('GET', '/')).headers['content-security-policy']).get('frame-src')).toBe('frame-src http://127.0.0.1:47717');
  });
});
