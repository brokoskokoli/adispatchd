import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHubConfig, DEFAULT_HUB_MAX_CONCURRENT, DEFAULT_HUB_PORT, type LoadHubConfigResult } from './hub.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function load(yaml: string | null, dataDir = 'hub-data'): Promise<{ result: LoadHubConfigResult; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orch-hub-'));
  dirs.push(root);
  if (yaml !== null) await writeFile(path.join(root, 'hub.yaml'), yaml);
  return { result: await loadHubConfig(root, { dataDir: path.join(root, dataDir) }), root };
}

function errors(result: LoadHubConfigResult): string[] {
  return result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
}

const WS = (id: string, port: number, extra = ''): string =>
  [`  - id: ${id}`, `    config_dir: ws/${id}/config`, `    data_dir: ws/${id}/data`, `    port: ${port}`, extra].filter(Boolean).join('\n');

describe('loadHubConfig', () => {
  it('loads a valid file, applies defaults and resolves relative paths against the hub config dir', async () => {
    const { result, root } = await load(['workspaces:', WS('coder', 8091), WS('docs', 8092, '    enabled: false'), ''].join('\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.maxConcurrent).toBe(DEFAULT_HUB_MAX_CONCURRENT);
    expect(result.config.server).toEqual({ host: '127.0.0.1', port: DEFAULT_HUB_PORT, allowedHosts: [] });
    expect(result.config.workspaces.map((w) => [w.id, w.port, w.enabled])).toEqual([
      ['coder', 8091, true],
      ['docs', 8092, false],
    ]);
    expect(result.config.workspaces[0]?.configDir).toBe(path.join(root, 'ws/coder/config'));
    expect(Object.isFrozen(result.config)).toBe(true);
  });

  it('reports a missing file', async () => {
    const { result } = await load(null);
    expect(result.ok).toBe(false);
    expect(errors(result)[0]).toContain('hub.yaml not found');
  });

  it('rejects unknown keys (strict) with a hint', async () => {
    const { result } = await load(['hub:', '  max_concurent: 3', 'workspaces: []', 'extra: 1', ''].join('\n'));
    const e = errors(result).join('\n');
    expect(e).toContain('"max_concurent" (did you mean "max_concurrent"?)');
    expect(e).toContain('"extra"');
  });

  it('rejects invalid IDs, ports and limits', async () => {
    const { result } = await load(
      ['hub:', '  max_concurrent: 0', 'workspaces:', '  - id: Coder_1', '    config_dir: a', '    data_dir: b', '    port: 70000', ''].join('\n'),
    );
    const e = errors(result).join('\n');
    expect(e).toContain('hub.max_concurrent: Must be greater than 0');
    expect(e).toContain('workspaces[0].id: Invalid workspace ID');
    expect(e).toContain('workspaces[0].port: Must be between 1 and 65535');
  });

  it('requires unique IDs, config dirs, data dirs and ports', async () => {
    const { result } = await load(
      [
        'workspaces:',
        '  - { id: a, config_dir: c1, data_dir: d1, port: 9001 }',
        '  - { id: a, config_dir: c1, data_dir: d1, port: 9001 }',
        '',
      ].join('\n'),
    );
    const e = errors(result);
    expect(e).toContain('workspaces[1].id: Duplicate workspace ID "a" (already used by workspaces[0])');
    expect(e.some((m) => m.startsWith('workspaces[1].config_dir: Duplicate config_dir'))).toBe(true);
    expect(e.some((m) => m.startsWith('workspaces[1].data_dir: Duplicate data_dir'))).toBe(true);
    expect(e).toContain('workspaces[1].port: Duplicate port "9001" (already used by workspaces[0])');
  });

  it('rejects nested data dirs (both directions), data dir inside config dir and overlap with the hub data dir', async () => {
    const { result } = await load(
      [
        'workspaces:',
        '  - { id: a, config_dir: c1, data_dir: d, port: 9001 }',
        '  - { id: b, config_dir: c2, data_dir: d/inner, port: 9002 }',
        '  - { id: c, config_dir: c3, data_dir: c3/data, port: 9003 }',
        '  - { id: d, config_dir: c4, data_dir: hub-data/ws, port: 9004 }',
        '',
      ].join('\n'),
    );
    const e = errors(result).join('\n');
    expect(e).toContain('workspaces[1].data_dir');
    expect(e).toContain('is nested with the data_dir of workspaces[0]');
    expect(e).toContain('workspaces[2].data_dir: data_dir and config_dir of workspace "c" must not be nested');
    expect(e).toContain('workspaces[3].data_dir');
    expect(e).toContain("overlaps with the hub's own data dir");
  });

  it('rejects a workspace port equal to the hub port and a config dir used as another data dir', async () => {
    const { result } = await load(
      [
        'hub: { server: { port: 9000 } }',
        'workspaces:',
        '  - { id: a, config_dir: c1, data_dir: d1, port: 9000 }',
        '  - { id: b, config_dir: d1, data_dir: d2, port: 9002 }',
        '',
      ].join('\n'),
    );
    const e = errors(result).join('\n');
    expect(e).toContain('workspaces[0].port: Port 9000 is also used by hub.server.port');
    expect(e).toContain('workspaces[1].config_dir');
  });

  it('warns about an empty workspace list and a non-loopback hub address', async () => {
    const { result } = await load(['hub: { server: { host: 0.0.0.0 } }', 'workspaces: []', ''].join('\n'));
    expect(result.ok).toBe(true);
    const w = result.warnings.map((x) => x.message).join('\n');
    expect(w).toContain('No workspaces configured');
    expect(w).toContain('not a loopback address');
  });

  it('rejects a workspace port equal to hub.server.port also for a non-loopback hub host', async () => {
    const { result } = await load(['hub: { server: { host: 0.0.0.0, port: 9000 } }', 'workspaces:', '  - { id: a, config_dir: c1, data_dir: d1, port: 9000 }', ''].join('\n'));
    expect(errors(result).join('\n')).toContain('workspaces[0].port: Port 9000 is also used by hub.server.port');
  });

  it('judges nesting of data dirs on real paths (symlinks)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orch-hub-'));
    dirs.push(root);
    await mkdir(path.join(root, 'real'), { recursive: true });
    await symlink(path.join(root, 'real'), path.join(root, 'link'));
    await writeFile(
      path.join(root, 'hub.yaml'),
      ['workspaces:', '  - { id: a, config_dir: c1, data_dir: real, port: 9001 }', '  - { id: b, config_dir: c2, data_dir: link/inner, port: 9002 }', ''].join('\n'),
    );
    const result = await loadHubConfig(root, { dataDir: path.join(root, 'hub-data') });
    expect(errors(result).join('\n')).toContain('is nested with the data_dir of workspaces[0]');
  });
});
