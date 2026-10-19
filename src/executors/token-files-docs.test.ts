/**
 * Documentation guards for token files (WI-18 review): backup excludes must be
 * anchored to the token directories, and every place describing token files
 * must state that 0700/0600 does not isolate runs of the same service.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

describe('token file documentation (WI-18)', () => {
  it('backup excludes are anchored to the token directories only', () => {
    const ops = read('docs/operations.md');
    const excludes = [...ops.matchAll(/--exclude '([^']+)'/g)].map((m) => m[1]);
    expect(excludes).toContain('/runs/*/secrets/');
    expect(excludes).toContain('/runs/*/actions/*/*/secrets/');
    // An unanchored pattern would also drop `secrets/` directories inside workspaces.
    for (const e of excludes) if (e?.includes('secrets')) expect(e.startsWith('/runs/'), e).toBe(true);
  });

  it('states the isolation limit (same service user) wherever token files are described', () => {
    for (const rel of ['docs/spec-v0.1.md', 'docs/worker-protocol.md', 'docs/configuration-reference.md', 'README.de.md']) {
      const text = read(rel).replace(/\s+/g, ' ');
      expect(text, rel).toMatch(/anderen Systembenutzern/);
      expect(text, rel).toContain('/proc/<pid>/environ');
      expect(text, rel).toMatch(/getrennten Benutzern oder (nutzt |in )?Containern? \(WI-19\)/);
    }
  });

  it('states the isolation limit in the English README too', () => {
    const text = read('README.md').replace(/\s+/g, ' ');
    expect(text).toMatch(/other system users/);
    expect(text).toContain('/proc/<pid>/environ');
    expect(text).toMatch(/separate users or in containers \(WI-19\)/);
  });
});
