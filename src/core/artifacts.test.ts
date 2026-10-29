import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { artifactInputName, artifactInputRelPath, artifactRoute, createArtifactId, isValidArtifactId } from './artifacts.js';
import { dataPaths } from './paths.js';

describe('artifact ids (WI-35)', () => {
  it('creates sortable, path-safe ids', () => {
    const clock = new FakeClock('2026-10-29T10:00:00.123Z');
    const id = createArtifactId({ clock, randomBytes: () => Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) });
    expect(id).toBe('art-20261029T100000123Z-deadbeef');
    expect(isValidArtifactId(id)).toBe(true);
    for (const bad of ['', 'art-1', '../x', 'run-20261029T100000123Z-deadbeef', `${id}/x`]) expect(isValidArtifactId(bad)).toBe(false);
    clock.advance(5);
    expect(createArtifactId({ clock }) > id).toBe(true);
  });

  it('lays out artifacts below data-dir/artifacts', () => {
    expect(dataPaths('/data').artifactsDir).toBe('/data/artifacts');
  });
});

describe('input names (WI-35)', () => {
  it('uses the sanitized artifact name; files keep their extension', () => {
    expect(artifactInputName({ name: 'Weekly report', kind: 'folder', fileName: 'out' })).toBe('Weekly_report');
    expect(artifactInputName({ name: 'report', kind: 'file', fileName: 'report.pdf' })).toBe('report.pdf');
    expect(artifactInputName({ name: 'report.md', kind: 'file', fileName: 'report.pdf' })).toBe('report.md');
    expect(artifactInputName({ name: 'data', kind: 'file', fileName: 'LICENSE' })).toBe('data');
    expect(artifactInputName({ name: '../../etc/passwd', kind: 'file', fileName: 'x.txt' })).toBe('.._.._etc_passwd.txt');
    expect(artifactInputName({ name: '..', kind: 'folder', fileName: 'x' })).toBe('__');
    expect(artifactInputRelPath({ name: 'a b', kind: 'folder', fileName: 'x' })).toBe('inputs/a_b');
  });

  it('builds the UI route', () => {
    expect(artifactRoute('art-1')).toBe('#/artifacts/art-1');
  });
});
