import { describe, expect, it } from 'vitest';
import { appPath, isAppHref } from './base-path.js';
import { artifactDownloadHref, artifactFileHref, artifactHref, buildFileTree, parseStartParameters } from './artifacts.js';

describe('artifact UI helpers (WI-35)', () => {
  it('builds a file tree with directories first, sorted', () => {
    const tree = buildFileTree([
      { path: 'b.txt', size: 2 },
      { path: 'sub/z.css', size: 3 },
      { path: 'sub/a.css', size: 1 },
      { path: 'sub/deep/x.md', size: 4 },
      { path: 'a.txt', size: 1 },
    ]);
    expect(tree.map((n) => [n.name, n.size])).toEqual([['sub', null], ['a.txt', 1], ['b.txt', 2]]);
    const sub = tree[0]!;
    expect(sub.children.map((n) => n.path)).toEqual(['sub/deep', 'sub/a.css', 'sub/z.css']);
    expect(sub.children[0]!.children[0]).toMatchObject({ name: 'x.md', path: 'sub/deep/x.md', size: 4 });
    expect(buildFileTree([])).toEqual([]);
  });

  it('encodes every path segment of download links', () => {
    expect(artifactFileHref('art-1', 'sub dir/ü #1.txt')).toBe('/api/v1/artifacts/art-1/files/sub%20dir/%C3%BC%20%231.txt');
    expect(artifactDownloadHref('art-1')).toBe('/api/v1/artifacts/art-1/download');
    expect(artifactHref('art-1')).toBe('#/artifacts/art-1');
  });

  it('parses the optional start parameters', () => {
    expect(parseStartParameters('  ')).toEqual({ ok: true, value: undefined });
    expect(parseStartParameters('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseStartParameters('[1]')).toMatchObject({ ok: false });
    expect(parseStartParameters('{oops')).toMatchObject({ ok: false, error: 'Parameters are not valid JSON' });
  });

  it('download links stay valid page-relative links below /w/<id>/ (hub), as the safe element builder requires', () => {
    for (const href of [artifactDownloadHref('art-1'), artifactFileHref('art-1', 'sub dir/ü #1 (a)!.txt'), artifactFileHref('a%b', 'x/y.zip')]) {
      expect(isAppHref(href), href).toBe(false); // absolute: would leave /w/<id>/ and be refused by the element builder
      expect(isAppHref(appPath(href)), href).toBe(true);
      expect(appPath(href).startsWith('./api/v1/artifacts/')).toBe(true);
    }
  });
});
