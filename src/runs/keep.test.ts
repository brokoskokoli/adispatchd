import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepWorkspaceFiles, listKeptFiles } from './keep.js';

describe('keepWorkspaceFiles', () => {
  let root: string;
  let ws: string;
  let kept: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'orch-keep-'));
    ws = path.join(root, 'ws');
    kept = path.join(root, 'data', 'runs', 'r1', 'kept');
    outside = path.join(root, 'outside');
    mkdirSync(ws);
    mkdirSync(outside);
    mkdirSync(path.join(root, 'data', 'runs', 'r1'), { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (rel: string, content: string | Buffer): void => {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  };
  const keep = (patterns: string[], maxBytes = 1024 * 1024) => keepWorkspaceFiles({ workspace: ws, keptDir: kept, patterns, maxBytes });

  it('copies matching regular files with their relative structure', async () => {
    write('.agent/transcript.jsonl', '{"a":1}\n');
    write('.agent/gate/unit.log', 'unit');
    write('.agent/gate/lint.log', 'lint');
    write('.agent/gate/notes.txt', 'nope');
    write('src/deep/x/report.log', 'deep');
    write('empty.log', '');
    const report = await keep(['.agent/transcript.jsonl', '.agent/gate/*.log', 'src/**/*.log', '*.log']);
    expect(report).toMatchObject({ files: 5, skippedCount: 0, unmatched: [] });
    expect(readFileSync(path.join(kept, '.agent/transcript.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(path.join(kept, '.agent/gate/unit.log'), 'utf8')).toBe('unit');
    expect(readFileSync(path.join(kept, 'src/deep/x/report.log'), 'utf8')).toBe('deep');
    expect(readFileSync(path.join(kept, 'empty.log'), 'utf8')).toBe('');
    expect(existsSync(path.join(kept, '.agent/gate/notes.txt'))).toBe(false);
    expect(existsSync(`${kept}.tmp`)).toBe(false);
    expect(report.bytes).toBe(8 + 4 + 4 + 4);
    expect(report.error).toBeUndefined();
    const listed = await listKeptFiles(kept);
    expect(listed.files.map((f) => f.path)).toEqual(['.agent/gate/lint.log', '.agent/gate/unit.log', '.agent/transcript.jsonl', 'empty.log', 'src/deep/x/report.log']);
  });

  it('a pattern without match is no error; no kept dir is created when nothing matched', async () => {
    const report = await keep(['missing/*.log', 'nope.txt']);
    expect(report).toMatchObject({ files: 0, unmatched: ['missing/*.log', 'nope.txt'] });
    expect(report.message).toContain('no match');
    expect(existsSync(kept)).toBe(false);
  });

  it('skips files exceeding the size limit (sum per run) and keeps smaller later ones', async () => {
    write('a.bin', Buffer.alloc(600));
    write('b.bin', Buffer.alloc(600));
    write('c.bin', Buffer.alloc(100));
    const report = await keep(['*.bin'], 1000);
    expect(report.files).toBe(2);
    expect(report.bytes).toBe(700);
    expect(report.skipped).toEqual([{ path: 'b.bin', reason: 'size_limit', size: 600 }]);
    expect(report.message).toMatch(/1 skipped \(size_limit\)/);
    expect(existsSync(path.join(kept, 'a.bin'))).toBe(true);
    expect(existsSync(path.join(kept, 'b.bin'))).toBe(false);
    expect(existsSync(path.join(kept, 'c.bin'))).toBe(true);
  });

  it('never follows symlinks: neither file links nor directory links (inside or outside)', async () => {
    write('real/inside.log', 'inside');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'escape.log'));
    symlinkSync(path.join(ws, 'real/inside.log'), path.join(ws, 'internal.log'));
    symlinkSync(outside, path.join(ws, 'linkdir'));
    const report = await keep(['*.log', 'linkdir/*', 'linkdir/secret.txt', '**/*.txt', 'real/*.log']);
    expect(report.files).toBe(1);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { path: 'escape.log', reason: 'symlink' },
        { path: 'internal.log', reason: 'symlink' },
      ]),
    );
    expect(report.unmatched).toEqual(expect.arrayContaining(['linkdir/*', 'linkdir/secret.txt', '**/*.txt']));
    expect(existsSync(path.join(kept, 'escape.log'))).toBe(false);
    expect(existsSync(path.join(kept, 'linkdir'))).toBe(false);
    expect(readFileSync(path.join(kept, 'real/inside.log'), 'utf8')).toBe('inside');
  });

  it('skips non-regular files (FIFO) without blocking', async () => {
    try {
      execFileSync('mkfifo', [path.join(ws, 'pipe.log')]);
    } catch {
      return; // mkfifo unavailable
    }
    write('ok.log', 'ok');
    const report = await keep(['*.log']);
    expect(report.files).toBe(1);
    expect(report.skipped).toEqual([{ path: 'pipe.log', reason: 'not_regular_file' }]);
  });

  it('does not overwrite an existing kept dir (resumed finalization) and reports it', async () => {
    write('a.log', 'first');
    await keep(['a.log']);
    write('a.log', 'second');
    const report = await keep(['a.log']);
    expect(report).toMatchObject({ alreadyPresent: true, files: 1, bytes: 5 });
    expect(readFileSync(path.join(kept, 'a.log'), 'utf8')).toBe('first');
  });

  it('reports a missing workspace as error without throwing', async () => {
    rmSync(ws, { recursive: true });
    const report = await keep(['a.log']);
    expect(report.error).toMatch(/workspace not readable/);
    expect(report.files).toBe(0);
  });

  it('works when the workspace path itself is reached via a symlinked parent', async () => {
    const link = path.join(root, 'wslink');
    symlinkSync(ws, link);
    write('a.log', 'x');
    const report = await keepWorkspaceFiles({ workspace: link, keptDir: kept, patterns: ['a.log'], maxBytes: 100 });
    expect(report.files).toBe(1);
  });

  it('redacts secrets while copying (also across read chunks) and counts written bytes', async () => {
    const secret = 'ghs_SECRETTOKENVALUE123';
    // Secret straddles the 64 KiB read chunk boundary.
    const big = Buffer.concat([Buffer.alloc(65_536 - 5, 'a'), Buffer.from(secret), Buffer.from('\nend')]);
    write('big.log', big);
    write('small.log', `token=${secret}\n`);
    const report = await keepWorkspaceFiles({ workspace: ws, keptDir: kept, patterns: ['*.log'], maxBytes: 1024 * 1024, secrets: [secret] });
    const keptBig = readFileSync(path.join(kept, 'big.log'), 'latin1');
    expect(keptBig).not.toContain(secret);
    expect(keptBig).toContain('[REDACTED]\nend');
    expect(readFileSync(path.join(kept, 'small.log'), 'utf8')).toBe('token=[REDACTED]\n');
    const written = keptBig.length + 'token=[REDACTED]\n'.length;
    expect(report.bytes).toBe(written);
    expect((await listKeptFiles(kept)).files.reduce((n, f) => n + f.size, 0)).toBe(written);
  });

  it('applies the size limit to the written (redacted) bytes', async () => {
    // A 4-byte secret becomes the 10-byte marker: 20 source bytes → 50 written bytes.
    write('a.log', 'abcd'.repeat(5));
    const report = await keepWorkspaceFiles({ workspace: ws, keptDir: kept, patterns: ['a.log'], maxBytes: 30, secrets: ['abcd'] });
    expect(report.files).toBe(0);
    expect(report.skipped).toEqual([{ path: 'a.log', reason: 'size_limit', size: 20 }]);
    expect(existsSync(path.join(kept, 'a.log'))).toBe(false);
  });

  it('literal patterns are resolved outside the walk budget; starved wildcard patterns are "not searched"', async () => {
    for (let i = 0; i < 20; i++) write(`many/f${i}.txt`, 'x');
    write('z/report.log', 'r');
    write('exact.log', 'e');
    const report = await keepWorkspaceFiles({
      workspace: ws,
      keptDir: kept,
      patterns: ['many/*.txt', 'z/*.log', 'exact.log', 'nope.log'],
      maxBytes: 1024,
      maxEntries: 5,
    });
    expect(report.walkLimitReached).toBe(true);
    expect(report.message).toContain('directory entry limit reached');
    // The literal pattern after the wildcards is still found; the unmatched literal is "unmatched".
    expect(existsSync(path.join(kept, 'exact.log'))).toBe(true);
    expect(report.unmatched).toEqual(['nope.log']);
    expect(report.notSearched).toEqual(['z/*.log']);
    expect(report.message).toContain('not searched (limit): z/*.log');
    // At most the budget was listed: some, not all of many/*.
    const listed = (await listKeptFiles(kept)).files.filter((f) => f.path.startsWith('many/'));
    expect(listed.length).toBeLessThanOrEqual(5);
  });

  it('reports a pattern naming a directory instead of silently matching it', async () => {
    write('.agent/gate/unit.log', 'u');
    const report = await keep(['.agent/gate', '.agent/*']);
    expect(report.files).toBe(0);
    expect(report.skipped).toEqual([
      { path: '.agent/gate', reason: 'directory', message: 'directories are not copied; use ".agent/gate/**/*" to keep its files' },
    ]);
    // A directory matched only by a wildcard is ignored (no match).
    expect(report.unmatched).toEqual(['.agent/*']);
  });

  it('caps the number of kept files (file_limit)', async () => {
    for (const n of ['a', 'b', 'c']) write(`${n}.log`, n);
    const report = await keepWorkspaceFiles({ workspace: ws, keptDir: kept, patterns: ['*.log'], maxBytes: 1024, maxFiles: 2 });
    expect(report.files).toBe(2);
    expect(report.skipped).toEqual([{ path: 'c.log', reason: 'file_limit', size: 1 }]);
  });

  it('skips a file replaced after the walk (changed)', async () => {
    write('a.log', 'original');
    const report = await keepWorkspaceFiles({
      workspace: ws,
      keptDir: kept,
      patterns: ['a.log'],
      maxBytes: 1024,
      beforeCopy: () => {
        writeFileSync(path.join(ws, 'b.tmp'), 'swapped');
        renameSync(path.join(ws, 'b.tmp'), path.join(ws, 'a.log'));
      },
    });
    expect(report.files).toBe(0);
    expect(report.skipped).toEqual([{ path: 'a.log', reason: 'changed', size: 8 }]);
  });

  it('skips a file whose parent directory was swapped for a symlink to the outside (outside_workspace)', async () => {
    write('d/a.log', 'inside');
    // Same inode reachable outside (hard link), so only the real-path check can catch the swap.
    linkSync(path.join(ws, 'd/a.log'), path.join(outside, 'a.log'));
    const report = await keepWorkspaceFiles({
      workspace: ws,
      keptDir: kept,
      patterns: ['d/a.log'],
      maxBytes: 1024,
      beforeCopy: () => {
        rmSync(path.join(ws, 'd'), { recursive: true });
        symlinkSync(outside, path.join(ws, 'd'));
      },
    });
    expect(report.files).toBe(0);
    expect(report.skipped).toEqual([{ path: 'd/a.log', reason: 'outside_workspace', size: 6 }]);
    expect(existsSync(kept)).toBe(false);
  });

  it('a failed attempt reports nothing as kept', async () => {
    write('a.log', 'a');
    // kept.tmp's parent is a file → mkdir fails → whole attempt fails.
    const badKept = path.join(root, 'file-not-dir', 'kept');
    writeFileSync(path.join(root, 'file-not-dir'), 'x');
    const report = await keepWorkspaceFiles({ workspace: ws, keptDir: badKept, patterns: ['a.log'], maxBytes: 1024 });
    expect(report.error).toBeDefined();
    expect(report).toMatchObject({ files: 0, bytes: 0 });
  });
});
