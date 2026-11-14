import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findOrphanedClones } from './clones.js';

describe('findOrphanedClones (WI-40)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('reports clones of sources that are not configured, nothing else', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'adispatchd-clones-'));
    dirs.push(root);
    for (const id of ['issues', 'old-tracker', 'renamed']) mkdirSync(path.join(root, id, '.git'), { recursive: true });
    mkdirSync(path.join(root, 'not-a-clone'));
    writeFileSync(path.join(root, 'stray.txt'), 'x');
    expect(await findOrphanedClones(root, ['issues', 'tracker'])).toEqual(['old-tracker', 'renamed']);
    expect(await findOrphanedClones(path.join(root, 'missing'), [])).toEqual([]);
  });
});
