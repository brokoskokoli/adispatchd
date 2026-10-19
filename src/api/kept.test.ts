import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentDisposition, keptContentType, keptPathSegments, openKeptFile } from './kept.js';

describe('kept file access', () => {
  let root: string;
  let kept: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'orch-kept-api-'));
    kept = path.join(root, 'kept');
    mkdirSync(path.join(kept, 'sub'), { recursive: true });
    writeFileSync(path.join(kept, 'sub', 'a.log'), 'abc');
    writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('validates requested paths segment by segment', () => {
    expect(keptPathSegments('sub/a.log')).toEqual(['sub', 'a.log']);
    for (const bad of ['', '..', 'a/../b', './a', 'a//b', '/a', 'a/', 'a\\..\\b', 'a\0b', 'x'.repeat(5000)]) {
      expect(() => keptPathSegments(bad), bad).toThrow(/Invalid file path/);
    }
  });

  it('opens regular files only, never through symlinks', async () => {
    const ok = await openKeptFile(kept, ['sub', 'a.log']);
    expect(ok.size).toBe(3);
    await ok.handle.close();
    symlinkSync(path.join(root, 'secret.txt'), path.join(kept, 'link'));
    symlinkSync(root, path.join(kept, 'dirlink'));
    await expect(openKeptFile(kept, ['link'])).rejects.toMatchObject({ statusCode: 404 });
    await expect(openKeptFile(kept, ['dirlink', 'secret.txt'])).rejects.toMatchObject({ statusCode: 404 });
    await expect(openKeptFile(kept, ['sub'])).rejects.toMatchObject({ statusCode: 404 });
    await expect(openKeptFile(kept, ['missing'])).rejects.toMatchObject({ statusCode: 404 });
    await expect(openKeptFile(path.join(root, 'nope'), ['a'])).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses a kept directory that is itself a symlink', async () => {
    const link = path.join(root, 'kept-link');
    symlinkSync(kept, link);
    await expect(openKeptFile(link, ['sub', 'a.log'])).rejects.toMatchObject({ statusCode: 404 });
  });

  it('maps content types conservatively and builds attachment headers', () => {
    expect(keptContentType('a.log')).toBe('text/plain; charset=utf-8');
    expect(keptContentType('t.JSONL')).toBe('application/x-ndjson; charset=utf-8');
    expect(keptContentType('x.html')).toBe('application/octet-stream');
    expect(keptContentType('x.svg')).toBe('application/octet-stream');
    expect(keptContentType('noext')).toBe('application/octet-stream');
    expect(attachmentDisposition("it's (1)*.log")).toBe(`attachment; filename="it's (1)*.log"; filename*=UTF-8''it%27s%20%281%29%2A.log`);
    expect(attachmentDisposition('a "b".log')).toBe(`attachment; filename="a _b_.log"; filename*=UTF-8''a%20%22b%22.log`);
  });
});
