import { describe, expect, it } from 'vitest';
import { appPath, hubOverviewHref, isAppHref } from './base-path.js';
import { createH, sanitizeAttribute } from './dom.js';

describe('appPath', () => {
  it('makes absolute API paths relative to the page, leaves everything else alone', () => {
    expect(appPath('/api/v1/status')).toBe('./api/v1/status');
    expect(appPath('/api/v1/runs?limit=5')).toBe('./api/v1/runs?limit=5');
    expect(appPath('./x')).toBe('./x');
    expect(appPath('https://example.com/x')).toBe('https://example.com/x');
    expect(appPath('//evil.example/x')).toBe('//evil.example/x');
  });

  it('resolves below /w/<id>/, behind a prefix and at the root alike', () => {
    for (const [page, expected] of [
      ['http://hub.test/w/ws1/', 'http://hub.test/w/ws1/api/v1/status'],
      ['http://hub.test/w/ws1/index.html', 'http://hub.test/w/ws1/api/v1/status'],
      ['https://proxy.test/adispatch/w/ws1/', 'https://proxy.test/adispatch/w/ws1/api/v1/status'],
      ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787/api/v1/status'],
      ['http://127.0.0.1:8787/#/runs/abc', 'http://127.0.0.1:8787/api/v1/status'],
    ] as const) {
      expect(new URL(appPath('/api/v1/status'), page).href).toBe(expected);
    }
  });
});

describe('isAppHref', () => {
  it('accepts only the known relative targets', () => {
    for (const ok of ['./', '../../', './w/coder/', './w/a/', './api/v1/runs/r1/kept/out/result.json', './api/v1/runs/r%201/kept/a.txt', './api/v1/runs/r1/kept/file%20(1)!.txt']) expect(isAppHref(ok), ok).toBe(true);
    for (const bad of [
      '',
      '/',
      '//evil.example',
      '../',
      '../../../',
      './w/',
      './w/UP/',
      './w/a/x',
      './w/a',
      './api/v1/../../x',
      './api/v1/%2e%2e/x',
      './api/v1/x y',
      './api/v1/a\\b',
      'javascript:alert(1)',
      './api/v1/a?x=1',
      '.\\api',
    ]) {
      expect(isAppHref(bad), bad).toBe(false);
    }
  });

  it('is applied by the element builder for href only', () => {
    expect(sanitizeAttribute('href', './w/a/')).toBe('./w/a/');
    expect(sanitizeAttribute('href', '../../')).toBe('../../');
    expect(sanitizeAttribute('href', '../../etc')).toBeNull();
    expect(sanitizeAttribute('src', './api/v1/x')).toBeNull();
    const calls: string[] = [];
    const h = createH({ createElement: () => ({ setAttribute: (n: string, v: string) => calls.push(`${n}=${v}`), appendChild: () => undefined, addEventListener: () => undefined }), createTextNode: () => ({}) });
    h('a', { href: './w/a/', class: 'x' }, 'ws');
    h('a', { href: './etc/passwd' }, 'bad');
    expect(calls).toEqual(['href=./w/a/', 'class=x']);
  });
});

describe('hubOverviewHref', () => {
  it('links back only for a page below /w/<id>/ of the workspace the instance reports', () => {
    expect(hubOverviewHref('/w/coder/', 'coder')).toBe('../../');
    expect(hubOverviewHref('/adispatch/w/coder/', 'coder')).toBe('../../');
    expect(hubOverviewHref('/w/coder/index.html', 'coder')).toBe('../../');
    expect(hubOverviewHref('/', 'coder')).toBeNull(); // opened directly on its own port
    expect(hubOverviewHref('/w/docs/', 'coder')).toBeNull();
    expect(hubOverviewHref('/w/coder/', null)).toBeNull();
    expect(hubOverviewHref('/w/coder/', undefined)).toBeNull();
  });
});
