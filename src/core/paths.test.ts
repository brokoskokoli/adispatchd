import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathTraversalError } from './errors.js';
import {
  assertRealPathWithin,
  assertSafeSegment,
  dataPaths,
  isWithin,
  resolveStrictlyWithin,
  resolveWithin,
  sanitizeSegment,
} from './paths.js';

const BASE = '/srv/orch/workspaces';

describe('resolveWithin', () => {
  it('resolves and normalises relative paths inside the base', () => {
    expect(resolveWithin(BASE, 'coder/run-1')).toBe('/srv/orch/workspaces/coder/run-1');
    expect(resolveWithin(BASE, './coder//x/../run-1/')).toBe('/srv/orch/workspaces/coder/run-1');
    expect(resolveWithin(`${BASE}/`, '')).toBe(BASE);
  });

  it('accepts absolute paths inside the base', () => {
    expect(resolveWithin(BASE, '/srv/orch/workspaces/a/b')).toBe('/srv/orch/workspaces/a/b');
  });

  it.each(['..', '../x', 'a/../../x', '/etc/passwd', '/srv/orch/workspaces-evil/x', '/srv/orch'])(
    'rejects escape via %j',
    (rel) => {
      expect(() => resolveWithin(BASE, rel)).toThrow(PathTraversalError);
    },
  );

  it('rejects NUL bytes and relative bases', () => {
    expect(() => resolveWithin(BASE, 'a\0b')).toThrow(PathTraversalError);
    expect(() => resolveWithin('relative/base', 'x')).toThrow(PathTraversalError);
  });

  it('allows names that merely start with dots', () => {
    expect(resolveWithin(BASE, '..hidden')).toBe('/srv/orch/workspaces/..hidden');
  });

  it('resolveStrictlyWithin rejects the base itself', () => {
    expect(() => resolveStrictlyWithin(BASE, '.')).toThrow(PathTraversalError);
    expect(resolveStrictlyWithin(BASE, 'x')).toBe(`${BASE}/x`);
  });

  it('isWithin works lexically', () => {
    expect(isWithin(BASE, `${BASE}/a`)).toBe(true);
    expect(isWithin(BASE, '/srv/orch/workspaces2')).toBe(false);
  });
});

describe('assertRealPathWithin (symlinks)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orch-paths-'));
    await mkdir(path.join(root, 'base', 'inside'), { recursive: true });
    await mkdir(path.join(root, 'outside'));
    await symlink(path.join(root, 'outside'), path.join(root, 'base', 'link'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts real paths inside and rejects symlink escapes', async () => {
    const base = path.join(root, 'base');
    await expect(assertRealPathWithin(base, 'inside')).resolves.toContain('inside');
    await expect(assertRealPathWithin(base, 'link')).rejects.toThrow(PathTraversalError);
  });
});

describe('segments', () => {
  it('assertSafeSegment rejects separators, dots and NUL', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0']) {
      expect(() => assertSafeSegment(bad)).toThrow(PathTraversalError);
    }
    expect(assertSafeSegment('run-1')).toBe('run-1');
  });

  it('sanitizeSegment produces safe segments', () => {
    expect(sanitizeSegment('owner/repo')).toBe('owner_repo');
    expect(sanitizeSegment('..')).toBe('__');
    expect(sanitizeSegment('x'.repeat(300))).toHaveLength(128);
  });
});

describe('dataPaths', () => {
  it('builds the spec layout', () => {
    const p = dataPaths('/var/lib/orch');
    expect(p.database).toBe('/var/lib/orch/adispatchd.sqlite');
    expect(p.defaultWorkspacesDir).toBe('/var/lib/orch/workspaces');
    expect(p.run('run-1')).toMatchObject({
      contextFile: '/var/lib/orch/runs/run-1/context.json',
      resultFile: '/var/lib/orch/runs/run-1/result.json',
      stdoutLog: '/var/lib/orch/logs/run-1/stdout.log',
      stderrLog: '/var/lib/orch/logs/run-1/stderr.log',
    });
    expect(() => p.run('../x')).toThrow(PathTraversalError);
  });
});
