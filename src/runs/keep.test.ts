import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
});
