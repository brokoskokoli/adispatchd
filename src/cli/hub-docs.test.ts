/**
 * Documentation consistency of the hub operations (WI-37): pinned installation lines match the version, links into
 * operations.md resolve, and the public documents (README EN/DE, website) mention the hub and `service install --hub`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../app.js';

const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** GitHub-style heading slug. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const heading = inFence ? null : /^#{1,6}\s+(.*)$/.exec(line)?.[1];
    if (heading) out.add(slug(heading.replace(/`/g, '')));
  }
  return out;
}

describe('hub documentation', () => {
  const documents = ['README.md', 'README.de.md', 'docs/operations.md', 'docs/manual-tests/systemd.md', 'docs/manual-tests/hub-systemd.md'];

  it('pins the installation lines to the current version', () => {
    for (const rel of documents) {
      const text = read(rel);
      for (const m of text.matchAll(/adispatchd(?:@|-)(\d+\.\d+\.\d+)/g)) expect(m[1], `${rel}: ${m[0]}`).toBe(APP_VERSION);
    }
    expect(read('site/index.html')).toContain(`v${APP_VERSION}`);
    expect(read('site/index.html')).toContain(`"softwareVersion": "${APP_VERSION}"`);
  });

  it('links into operations.md resolve to headings', () => {
    const ops = anchors(read('docs/operations.md'));
    for (const rel of ['README.md', 'README.de.md', 'docs/configuration-reference.md', 'docs/api.md', 'docs/status.md', 'docs/worker-protocol.md']) {
      for (const m of read(rel).matchAll(/operations\.md#([^)\s]+)/g)) expect(ops.has(m[1] ?? ''), `${rel}: operations.md#${m[1]}`).toBe(true);
    }
    for (const heading of ['hub-als-systemd-dienst-seit-0100-wi-37', 'eine-bestehende-einzelinstanz-in-einen-hub-aufnehmen-migration', 'verzeichnisse-eines-hubs']) {
      expect(ops.has(heading), heading).toBe(true);
    }
  });

  it('documents service install --hub, hub init layouts, the migration and drain-all --wait everywhere it belongs', () => {
    const ops = read('docs/operations.md');
    for (const needle of ['service install --hub', '--workspaces-data-dir', 'hub init --empty', 'hub drain-all --wait', 'KillMode=mixed', 'adispatchd-hub']) {
      expect(ops, needle).toContain(needle);
    }
    for (const rel of ['README.md', 'README.de.md']) {
      const text = read(rel);
      expect(text, rel).toContain('service install --hub');
      expect(text, rel).toMatch(/hub start/);
    }
    const site = read('site/index.html');
    expect(site).toContain('service install --hub');
    expect(site).toContain('One hub for several projects');
    expect(site).toContain('Ein Hub für mehrere Projekte');
    expect(read('docs/manual-tests/hub-systemd.md')).toContain('service install --hub');
    expect(read('docs/configuration-reference.md')).toContain('service install --hub');
    expect(read('CHANGELOG.md')).toMatch(new RegExp(`## \\[${APP_VERSION.replace(/\./g, '\\.')}\\] – \\d{4}-\\d{2}-\\d{2}`));
  });
});
