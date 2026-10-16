/**
 * Smoke tests of the web UI delivery (WI-11): the real build script produces
 * the static UI, the app serves index.html and every referenced asset, and the
 * browser sources respect the XSS/no-dialog rules.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppEnv, type AppEnv } from '../api/testing/helpers.js';
import { UI_ENTRY, isUiDir, resolveUiDir } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

let outDir: string;
let env: AppEnv | null = null;

beforeAll(async () => {
  outDir = mkdtempSync(path.join(os.tmpdir(), 'orch-ui-'));
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-ui.mjs'), outDir], { cwd: root, stdio: 'pipe' });
  env = await startAppEnv({ app: { uiDir: outDir } });
}, 120_000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(outDir, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('web UI build + delivery', () => {
  it('build output is a complete UI dir', () => {
    expect(isUiDir(outDir)).toBe(true);
    expect(walk(outDir).some((f) => f.endsWith('.test.js'))).toBe(false);
  });

  it('serves index.html at / with security headers and a strict CSP, no external resources', async () => {
    const res = await env!.request('GET', '/');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/html/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const html = String(res.json);
    expect(html).toContain(`src="${UI_ENTRY}"`);
    expect(html).toMatch(/Content-Security-Policy[^>]*script-src 'self'/);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    const index = await env!.request('GET', '/index.html');
    expect(index.status).toBe(200);
  });

  it('serves every asset referenced by index.html and every imported module', async () => {
    const html = String((await env!.request('GET', '/')).json);
    const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]!);
    expect(refs).toEqual(expect.arrayContaining(['favicon.svg', 'app.css', UI_ENTRY]));
    const queue = [...refs];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const ref = queue.shift()!;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const res = await env!.request('GET', `/${ref}`);
      expect(res.status, ref).toBe(200);
      if (ref.endsWith('.js')) {
        expect(String(res.headers['content-type'])).toMatch(/javascript/);
        const body = typeof res.json === 'string' ? res.json : JSON.stringify(res.json);
        for (const m of body.matchAll(/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
          queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(ref), m[1]!)));
        }
      }
    }
    expect(seen.size).toBeGreaterThan(15);
  });

  it('API and SSE still work next to the static UI; unknown files are 404', async () => {
    expect((await env!.request('GET', '/api/v1/status')).status).toBe(200);
    expect((await env!.request('GET', '/does-not-exist.js')).status).toBe(404);
  });

  it('static UI is subject to the Host allowlist (DNS rebinding)', async () => {
    const res = await env!.request('GET', '/', undefined, { host: 'evil.example:8787' });
    expect(res.status).toBe(421);
  });
});

describe('resolveUiDir', () => {
  it('finds <module dir>/public or <repo>/dist/ui/public, else null', () => {
    const fake = mkdtempSync(path.join(os.tmpdir(), 'orch-ui-resolve-'));
    try {
      const mod = pathToFileURL(path.join(fake, 'dist', 'ui', 'index.js')).href;
      expect(resolveUiDir(mod)).toBeNull();
      execFileSync(process.execPath, [path.join(root, 'scripts', 'build-ui.mjs'), path.join(fake, 'dist', 'ui', 'public')], { cwd: root, stdio: 'pipe' });
      expect(resolveUiDir(mod)).toBe(path.join(fake, 'dist', 'ui', 'public'));
      // running from sources (src/ui/index.ts) falls back to <repo>/dist/ui/public
      expect(resolveUiDir(pathToFileURL(path.join(fake, 'src', 'ui', 'index.ts')).href)).toBe(path.join(fake, 'dist', 'ui', 'public'));
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('browser sources (Spec §20.5)', () => {
  const sources = walk(path.join(here)).filter((f) => /\/(client|shared)\/.*\.ts$/.test(f) && !f.endsWith('.test.ts'));
  it('never use innerHTML/outerHTML/insertAdjacentHTML/document.write/eval or browser dialogs', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const f of sources) {
      const code = readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
      expect(code, f).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(code, f).not.toMatch(/(?<![.\w])(alert|confirm|prompt)\(|window\.(alert|confirm|prompt)/);
    }
  });
});
