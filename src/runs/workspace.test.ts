import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeWorkspace, shouldCleanupWorkspace } from './workspace.js';

describe('shouldCleanupWorkspace', () => {
  it('follows always | on_success | never', () => {
    expect(shouldCleanupWorkspace('always', 'crashed', null)).toBe(true);
    expect(shouldCleanupWorkspace('never', 'completed', 'success')).toBe(false);
    expect(shouldCleanupWorkspace('on_success', 'completed', 'success')).toBe(true);
    expect(shouldCleanupWorkspace('on_success', 'completed', 'failure')).toBe(false);
    expect(shouldCleanupWorkspace('on_success', 'cancelled', null)).toBe(false);
  });
});

describe('removeWorkspace', () => {
  let root: string;
  let base: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'orch-ws-'));
    base = path.join(root, 'workspaces');
    mkdirSync(base);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes a workspace strictly below base_dir (symlinks inside are not followed)', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep'), 'x');
    const ws = path.join(base, 'wf', 'run-1');
    mkdirSync(path.join(ws, 'sub'), { recursive: true });
    symlinkSync(outside, path.join(ws, 'link'));
    expect(await removeWorkspace(base, ws)).toEqual({ removed: true, path: ws });
    expect(existsSync(ws)).toBe(false);
    expect(existsSync(path.join(outside, 'keep'))).toBe(true);
  });

  it('never deletes base_dir itself, paths outside, symlinked workspaces or escapes via symlinked parents', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(path.join(outside, 'run-2'), { recursive: true });
    expect(await removeWorkspace(base, base)).toMatchObject({ removed: false, reason: 'outside_base_dir' });
    expect(await removeWorkspace(base, path.join(base, '..', 'outside'))).toMatchObject({ removed: false, reason: 'outside_base_dir' });
    symlinkSync(outside, path.join(base, 'evil'));
    expect(await removeWorkspace(base, path.join(base, 'evil'))).toMatchObject({ removed: false, reason: 'symlink' });
    expect(await removeWorkspace(base, path.join(base, 'evil', 'run-2'))).toMatchObject({ removed: false, reason: 'outside_base_dir' });
    expect(existsSync(path.join(outside, 'run-2'))).toBe(true);
    expect(existsSync(base)).toBe(true);
    expect(await removeWorkspace(base, path.join(base, 'missing'))).toMatchObject({ removed: false, reason: 'missing' });
  });
});
