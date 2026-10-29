/** Safety rules of collecting workspace paths as artifacts (WI-35), like `execute.keep` (WI-22). */
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectArtifact, inspectArtifactPath, type InspectedSource } from './collect.js';

describe('collecting artifacts from a workspace (WI-35)', () => {
  let tmp: string;
  let ws: string;
  let out: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'orch-art-collect-'));
    ws = path.join(tmp, 'ws');
    out = path.join(tmp, 'out');
    mkdirSync(ws);
    mkdirSync(out);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const put = (rel: string, content: string): void => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  };
  const inspect = async (rel: string): Promise<InspectedSource> => {
    const res = await inspectArtifactPath(ws, rel);
    if (!res.ok) throw new Error(`${res.reason}: ${res.message}`);
    return res.source;
  };

  it('inspects files and folders; reports missing paths', async () => {
    put('out/report.pdf', 'pdf');
    put('out/dir/a.txt', 'a');
    expect(await inspect('out/report.pdf')).toMatchObject({ kind: 'file', name: 'report.pdf', size: 3 });
    expect(await inspect('out/dir')).toMatchObject({ kind: 'folder', name: 'dir' });
    expect(await inspectArtifactPath(ws, 'out/none.pdf')).toMatchObject({ ok: false, reason: 'missing' });
    expect(await inspectArtifactPath(ws, 'out/report.pdf/x')).toMatchObject({ ok: false, reason: 'not_regular_file' });
    expect(await inspectArtifactPath(path.join(tmp, 'gone'), 'a')).toMatchObject({ ok: false, reason: 'error' });
  });

  it('refuses traversal and absolute paths', async () => {
    put('a.txt', 'a');
    for (const rel of ['../out', '/etc/passwd', 'a/../../x', 'a//b', './a.txt', '', 'a\\b', 'a\0b']) {
      expect(await inspectArtifactPath(ws, rel)).toMatchObject({ ok: false, reason: 'error' });
    }
  });

  it('refuses symlinks as the path itself and as any component, also pointing inside the workspace', async () => {
    put('real/data.txt', 'x');
    writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
    symlinkSync(path.join(tmp, 'secret.txt'), path.join(ws, 'link.txt'));
    symlinkSync('real', path.join(ws, 'linkdir'));
    symlinkSync(tmp, path.join(ws, 'outside'));
    expect(await inspectArtifactPath(ws, 'link.txt')).toMatchObject({ ok: false, reason: 'symlink' });
    expect(await inspectArtifactPath(ws, 'linkdir')).toMatchObject({ ok: false, reason: 'symlink' });
    expect(await inspectArtifactPath(ws, 'linkdir/data.txt')).toMatchObject({ ok: false, reason: 'symlink' });
    expect(await inspectArtifactPath(ws, 'outside/secret.txt')).toMatchObject({ ok: false, reason: 'symlink' });
  });

  it('copies a file with its content and size', async () => {
    put('out/report.pdf', 'hello');
    const res = await collectArtifact({ source: await inspect('out/report.pdf'), dest: path.join(out, 'content'), maxBytes: 100, secrets: [] });
    expect(res).toMatchObject({ ok: true, kind: 'file', fileName: 'report.pdf', size: 5, fileCount: 1 });
    expect(readFileSync(path.join(out, 'content'), 'utf8')).toBe('hello');
  });

  it('copies a folder recursively and skips symlinks and special files inside it', async () => {
    put('res/a.txt', 'a');
    put('res/sub/b.txt', 'bb');
    put('res/.hidden', 'h');
    writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
    symlinkSync(path.join(tmp, 'secret.txt'), path.join(ws, 'res', 'link.txt'));
    symlinkSync(tmp, path.join(ws, 'res', 'sub', 'outdir'));
    const res = await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'content'), maxBytes: 100, secrets: [] });
    expect(res).toMatchObject({ ok: true, kind: 'folder', fileName: 'res', size: 4, fileCount: 3, skippedCount: 2 });
    expect(res.ok && res.skipped.map((s) => `${s.path}:${s.reason}`).sort()).toEqual(['link.txt:symlink', 'sub/outdir:symlink']);
    expect(readdirSync(path.join(out, 'content')).sort()).toEqual(['.hidden', 'a.txt', 'sub']);
    expect(existsSync(path.join(out, 'content', 'link.txt'))).toBe(false);
    expect(readdirSync(path.join(out, 'content', 'sub'))).toEqual(['b.txt']);
  });

  it('copies hard links by content (they are regular files)', async () => {
    put('res/a.txt', 'a');
    linkSync(path.join(ws, 'res', 'a.txt'), path.join(ws, 'res', 'b.txt'));
    const res = await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'content'), maxBytes: 100, secrets: [] });
    expect(res).toMatchObject({ ok: true, fileCount: 2, size: 2 });
  });

  it('enforces the size limit for files and folders (nothing partial is reported as success)', async () => {
    put('big.bin', 'x'.repeat(50));
    put('res/a', 'x'.repeat(30));
    put('res/b', 'x'.repeat(30));
    expect(await collectArtifact({ source: await inspect('big.bin'), dest: path.join(out, 'f'), maxBytes: 49, secrets: [] })).toMatchObject({
      ok: false,
      reason: 'size_limit',
    });
    expect(existsSync(path.join(out, 'f'))).toBe(false);
    expect(await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'd'), maxBytes: 59, secrets: [] })).toMatchObject({
      ok: false,
      reason: 'size_limit',
    });
    expect(await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'd2'), maxBytes: 60, secrets: [] })).toMatchObject({ ok: true, size: 60 });
    // The limit applies to the written bytes (after redaction) when secrets are known.
    expect(await collectArtifact({ source: await inspect('big.bin'), dest: path.join(out, 'g'), maxBytes: 49, secrets: ['not-present'] })).toMatchObject({
      ok: false,
      reason: 'size_limit',
    });
  });

  it('enforces the file and entry limits and refuses empty folders', async () => {
    put('res/a', '1');
    put('res/b', '2');
    put('res/c', '3');
    expect(await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'x'), maxBytes: 100, secrets: [], maxFiles: 2 })).toMatchObject({
      ok: false,
      reason: 'file_limit',
    });
    expect(await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'y'), maxBytes: 100, secrets: [], maxEntries: 2 })).toMatchObject({
      ok: false,
      reason: 'entry_limit',
    });
    mkdirSync(path.join(ws, 'empty/inner'), { recursive: true });
    expect(await collectArtifact({ source: await inspect('empty'), dest: path.join(out, 'z'), maxBytes: 100, secrets: [] })).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('redacts secrets, also across read chunks', async () => {
    const secret = 'ghs_SuperSecretToken123';
    const big = `${'a'.repeat(65_530)}${secret}${'b'.repeat(100)}`;
    put('out/log.txt', `token=${secret}\n`);
    put('res/big.txt', big);
    const file = await collectArtifact({ source: await inspect('out/log.txt'), dest: path.join(out, 'f'), maxBytes: 1_000_000, secrets: [secret] });
    expect(file.ok).toBe(true);
    expect(readFileSync(path.join(out, 'f'), 'utf8')).toBe('token=[REDACTED]\n');
    const folder = await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'd'), maxBytes: 1_000_000, secrets: [secret] });
    expect(folder.ok).toBe(true);
    expect(readFileSync(path.join(out, 'd', 'big.txt'), 'utf8')).not.toContain(secret);
    expect(readFileSync(path.join(out, 'd', 'big.txt'), 'utf8')).toContain('[REDACTED]');
  });

  it('skips a file that is replaced by a symlink after the walk (changed)', async () => {
    put('res/a.txt', 'a');
    put('res/b.txt', 'b');
    writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
    const res = await collectArtifact({
      source: await inspect('res'),
      dest: path.join(out, 'content'),
      maxBytes: 100,
      secrets: [],
      beforeCopy: (rel) => {
        if (rel !== 'b.txt') return;
        rmSync(path.join(ws, 'res', 'b.txt'));
        symlinkSync(path.join(tmp, 'secret.txt'), path.join(ws, 'res', 'b.txt'));
      },
    });
    expect(res).toMatchObject({ ok: true, fileCount: 1 });
    expect(readdirSync(path.join(out, 'content'))).toEqual(['a.txt']);
    expect(res.ok && res.skipped).toEqual([{ path: 'b.txt', reason: 'symlink' }]);
  });

  it('does not collect a file whose parent was swapped for a symlink to the outside (outside_workspace)', async () => {
    put('res/sub/a.txt', 'a');
    mkdirSync(path.join(tmp, 'elsewhere'));
    linkSync(path.join(ws, 'res/sub/a.txt'), path.join(tmp, 'elsewhere', 'a.txt'));
    const res = await collectArtifact({
      source: await inspect('res'),
      dest: path.join(out, 'content'),
      maxBytes: 100,
      secrets: [],
      beforeCopy: (rel) => {
        if (rel !== 'sub/a.txt') return;
        rmSync(path.join(ws, 'res/sub'), { recursive: true });
        symlinkSync(path.join(tmp, 'elsewhere'), path.join(ws, 'res/sub'));
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(['empty', 'not_regular_file']).toContain(res.reason);
    expect(existsSync(path.join(out, 'content', 'sub', 'a.txt'))).toBe(false);
  });

  it('keeps unreadable entries out and reports an error for an unreadable file', async () => {
    if (process.getuid?.() === 0) return; // root reads everything
    put('res/a.txt', 'a');
    put('res/locked.txt', 'l');
    chmodSync(path.join(ws, 'res/locked.txt'), 0o000);
    const res = await collectArtifact({ source: await inspect('res'), dest: path.join(out, 'content'), maxBytes: 100, secrets: [] });
    expect(res).toMatchObject({ ok: true, fileCount: 1, skippedCount: 1 });
    expect(res.ok && res.skipped[0]).toMatchObject({ path: 'locked.txt', reason: 'error' });
  });
});
