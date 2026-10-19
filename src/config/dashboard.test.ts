import { afterEach, describe, expect, it } from 'vitest';
import { formatConfigIssue, loadConfig, ConfigManager, type LoadConfigResult } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

async function tempDir(files: Record<string, string>): Promise<TempConfigDir> {
  const t = await createTempConfigDir({ ...BASE_FILES, ...files });
  temps.push(t);
  return t;
}

async function load(files: Record<string, string>): Promise<LoadConfigResult> {
  const t = await tempDir(files);
  return loadConfig(t.dir, { dataDir: t.dataDir });
}

function messages(r: LoadConfigResult): string[] {
  if (r.ok) return [];
  return r.errors.map((e) => `${e.file}: ${e.path}: ${e.message}`);
}

const SCRIPT = { 'scripts/info/disk.sh': '#!/bin/sh\necho 42\n' };

describe('dashboard.yaml (WI-24)', () => {
  it('is optional; without it there are no tiles and the hash is unchanged', async () => {
    const a = await load({});
    if (!a.ok) throw new Error(messages(a).join('\n'));
    expect(a.config.dashboard).toBeNull();
    const b = await load({ ...SCRIPT, 'dashboard.yaml': 'info: []\n' });
    if (!b.ok) throw new Error(messages(b).join('\n'));
    expect(b.config.dashboard).toEqual({ file: 'dashboard.yaml', info: [] });
    expect(b.config.hash).not.toBe(a.config.hash);
  });

  it('normalizes tiles: defaults, resolved command, thresholds', async () => {
    const r = await load({
      ...SCRIPT,
      'dashboard.yaml': [
        'info:',
        '  - id: disk',
        '    title: Disk usage',
        '    type: percent',
        '    command: scripts/info/disk.sh',
        '    warn_above: 80',
        '    critical_above: 95',
        '  - id: open-prs',
        '    type: number',
        '    command: echo',
        '    args: ["3"]',
        '    env: { MODE: fast, LIMIT: 5 }',
        '    unit: PRs',
        '    timeout: 5s',
        '    cache: 10s',
        '    warn_below: 1',
        '',
      ].join('\n'),
    });
    if (!r.ok) throw new Error(messages(r).join('\n'));
    const [disk, prs] = r.config.dashboard?.info ?? [];
    expect(disk).toMatchObject({
      id: 'disk',
      title: 'Disk usage',
      type: 'percent',
      timeoutMs: 15_000,
      cacheMs: 300_000,
      unit: null,
      thresholds: { warnAbove: 80, criticalAbove: 95, warnBelow: null, criticalBelow: null },
    });
    expect(disk?.command).toBe(`${r.config.configDir}/scripts/info/disk.sh`);
    expect(prs).toMatchObject({ title: 'open-prs', command: 'echo', args: ['3'], env: { MODE: 'fast', LIMIT: '5' }, unit: 'PRs', timeoutMs: 5000, cacheMs: 10_000 });
  });

  it('reports schema and semantic errors with path and suggestions', async () => {
    const r = await load({
      ...SCRIPT,
      'dashboard.yaml': [
        'info:',
        '  - id: disk',
        '    type: percent',
        '    command: scripts/info/disk.sh',
        '    cache: 5s',
        '    warn_abve: 80',
        '  - id: disk',
        '    type: text',
        '    command: scripts/info/missing.sh',
        '    warn_above: 3',
        '    unit: GB',
        '    env: { ADISPATCH_X: "1" }',
        '  - id: n',
        '    type: number',
        '    command: echo',
        '    warn_above: 90',
        '    critical_above: 80',
        '    warn_below: 10',
        '    critical_below: 20',
        '  - id: p',
        '    type: percnt',
        '    command: echo',
        '',
      ].join('\n'),
    });
    expect(r.ok).toBe(false);
    const all = messages(r);
    expect(all).toContain('dashboard.yaml: info[0].cache: Duration must be at least 10s');
    expect(all).toContain('dashboard.yaml: info[0]: Unknown key(s): "warn_abve" (did you mean "warn_above"?)');
    expect(all.some((m) => m.startsWith('dashboard.yaml: info[3].type: Invalid option') && m.includes('(did you mean "percent"?)'))).toBe(true);

    // Semantic errors (schema valid).
    const s = await load({
      ...SCRIPT,
      'dashboard.yaml': [
        'info:',
        '  - id: disk',
        '    type: percent',
        '    command: scripts/info/disk.sh',
        '    unit: GB',
        '  - id: disk',
        '    type: text',
        '    command: scripts/info/missing.sh',
        '    warn_above: 3',
        '    env: { ADISPATCH_X: "1" }',
        '  - id: n',
        '    type: number',
        '    command: echo',
        '    warn_above: 90',
        '    critical_above: 80',
        '    warn_below: 10',
        '    critical_below: 20',
        '',
      ].join('\n'),
    });
    const sem = messages(s);
    expect(sem).toContain('dashboard.yaml: info[0].unit: "unit" is only supported for "number" tiles (percent tiles always show %)');
    expect(sem).toContain('dashboard.yaml: info[1].id: Duplicate info tile ID "disk" (also used by info[0])');
    expect(sem).toContain('dashboard.yaml: info[1].warn_above: Thresholds are only supported for "number" and "percent" tiles (type is "text")');
    expect(sem).toContain('dashboard.yaml: info[1].env.ADISPATCH_X: Environment variables with prefix "ADISPATCH_" are reserved');
    expect(sem.some((m) => m.startsWith('dashboard.yaml: info[1].command: Script does not exist: ') && m.endsWith('scripts/info/missing.sh (relative paths are resolved against the config dir)'))).toBe(true);
    expect(sem).toContain('dashboard.yaml: info[2].critical_above: "critical_above" (80) must not be lower than "warn_above" (90)');
    expect(sem).toContain('dashboard.yaml: info[2].critical_below: "critical_below" (20) must not be higher than "warn_below" (10)');
  });

  it('caps timeout (≤ 5m and ≤ cache) and warns about percent thresholds outside 0–100', async () => {
    const r = await load({
      'dashboard.yaml': [
        'info:',
        '  - { id: a, type: number, command: echo, timeout: 6m, cache: 1h }',
        '  - { id: b, type: number, command: echo, timeout: 30s, cache: 20s }',
        '  - { id: c, type: number, command: echo, timeout: 5m, cache: 5m }',
        '',
      ].join('\n'),
    });
    expect(messages(r)).toEqual([
      'dashboard.yaml: info[0].timeout: "timeout" must not exceed 5m',
      'dashboard.yaml: info[1].timeout: "timeout" (30s) must not be longer than "cache" (20s)',
    ]);
    const w = await load({ 'dashboard.yaml': 'info:\n  - { id: p, type: percent, command: echo, warn_above: 80, critical_above: 120, warn_below: -1 }\n' });
    expect(w.ok).toBe(true);
    expect(w.warnings.map(formatConfigIssue).join('\n')).toContain('info[0].critical_above: Threshold 120 is outside 0–100');
    expect(w.warnings.map(formatConfigIssue).join('\n')).toContain('info[0].warn_below: Threshold -1 is outside 0–100');
  });

  it('warns about literal secrets in env', async () => {
    const r = await load({ 'dashboard.yaml': 'info:\n  - { id: x, type: text, command: echo, env: { API_TOKEN: abc } }\n' });
    expect(r.ok).toBe(true);
    expect(r.warnings.map(formatConfigIssue).join('\n')).toContain('info[0].env.API_TOKEN');
  });

  it('is loaded by config reload (change → new hash; invalid → active configuration kept)', async () => {
    const t = await tempDir({ ...SCRIPT, 'dashboard.yaml': 'info:\n  - { id: a, type: number, command: scripts/info/disk.sh }\n' });
    const manager = await ConfigManager.create({ configDir: t.dir, dataDir: t.dataDir });
    const before = manager.current.hash;
    await t.write({ 'dashboard.yaml': 'info:\n  - { id: a, type: number, command: scripts/info/disk.sh, cache: 1m }\n' });
    const ok = await manager.reload();
    expect(ok.ok && ok.changed).toBe(true);
    expect(manager.current.dashboard?.info[0]?.cacheMs).toBe(60_000);
    expect(manager.current.hash).not.toBe(before);
    await t.write({ 'dashboard.yaml': 'info:\n  - { id: a, type: number, command: scripts/info/gone.sh }\n' });
    const bad = await manager.reload();
    expect(bad.ok).toBe(false);
    expect(manager.current.dashboard?.info[0]?.cacheMs).toBe(60_000);
  });
});

describe('shell check names (WI-24)', () => {
  const wf = (conditions: string): Record<string, string> => ({
    'workflows/wf.yaml': `id: wf\ntrigger: { type: source, source: repo_a }\nexecute:\n  type: shell\n  command: /bin/true\n${conditions}`,
  });

  it('accepts an optional name on conditions and the shell filter', async () => {
    const r = await load(
      wf('shell_filter: { name: Not a draft, command: /bin/true }\nconditions:\n  workflow:\n    - { name: Credits available, type: shell, command: /bin/true }\n    - { type: shell, command: /bin/true }\n  item:\n    - { name: "  Spaced  ", type: shell, command: /bin/true }\n'),
    );
    if (!r.ok) throw new Error(messages(r).join('\n'));
    const w = r.config.workflows.wf;
    expect(w?.conditions.workflow[0]?.name).toBe('Credits available');
    expect(w?.conditions.workflow[1]).not.toHaveProperty('name');
    expect(w?.conditions.item[0]?.name).toBe('Spaced');
    expect(w?.shellFilter?.name).toBe('Not a draft');
  });

  it('omits an absent name from the normalized model (hashes of existing workflows stay unchanged)', async () => {
    const plain = await load(wf('conditions:\n  workflow:\n    - { type: shell, command: /bin/true }\n'));
    const named = await load(wf('conditions:\n  workflow:\n    - { name: N, type: shell, command: /bin/true }\n'));
    if (!plain.ok || !named.ok) throw new Error('expected valid');
    expect(plain.config.workflowHashes.wf).not.toBe(named.config.workflowHashes.wf);
    expect(JSON.stringify(plain.config.workflows.wf?.conditions)).not.toContain('"name"');
  });

  it('rejects empty and too long names', async () => {
    const r = await load(wf(`conditions:\n  workflow:\n    - { name: "  ", type: shell, command: /bin/true }\n    - { name: ${'x'.repeat(81)}, type: shell, command: /bin/true }\n`));
    expect(messages(r)).toEqual(
      expect.arrayContaining([
        'workflows/wf.yaml: conditions.workflow[0].name: Must not be empty',
        'workflows/wf.yaml: conditions.workflow[1].name: At most 80 characters',
      ]),
    );
  });
});
