import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { createProgram, type CliIo } from './program.js';
import { createInitHandler } from './init.js';
import { DATA_DIR_LAYOUT, initTemplates } from './init-templates.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const r = mkdtempSync(path.join(os.tmpdir(), 'orch-init-'));
  roots.push(r);
  return r;
}

function captureIo(): CliIo & { out: string; err: string; code: number | undefined } {
  const io = {
    out: '',
    err: '',
    code: undefined as number | undefined,
    stdout: (t: string) => {
      io.out += t;
    },
    stderr: (t: string) => {
      io.err += t;
    },
    setExitCode: (c: number) => {
      io.code = c;
    },
  };
  return io;
}

async function init(args: string[]) {
  const io = captureIo();
  await createProgram({ init: createInitHandler(io) }, io).parseAsync(['init', ...args], { from: 'user' });
  return io;
}

describe('cli init', () => {
  it('creates the Spec §4 layout with a valid, commented example configuration', async () => {
    const root = tempRoot();
    const configDir = path.join(root, 'config');
    const dataDir = path.join(root, 'data');
    const io = await init(['--config-dir', configDir, '--data-dir', dataDir, '--port', '18999']);
    expect(io.err).toBe('');
    expect(io.code).toBe(0);
    for (const f of initTemplates()) {
      expect(existsSync(path.join(configDir, f.path)), f.path).toBe(true);
      expect(statSync(path.join(configDir, f.path)).mode & 0o777).toBe(f.mode);
    }
    for (const d of DATA_DIR_LAYOUT) expect(statSync(path.join(dataDir, d)).isDirectory()).toBe(true);
    expect(io.out).toContain('Next steps:');
    expect(io.out).toContain(`adispatch start --config-dir ${configDir} --data-dir ${dataDir}`);

    const config = readFileSync(path.join(configDir, 'config.yaml'), 'utf8');
    expect(config).toContain('port: 18999');
    expect(config).toContain('allowed_hosts: []');
    expect(config).toMatch(/AUTHENTICATING reverse proxy/);

    const loaded = await loadConfig(configDir, { dataDir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.warnings).toEqual([]);
    expect(Object.keys(loaded.config.workflows).sort()).toEqual(['coder', 'hello', 'nightly-maintenance']);
    // Only the self-contained manual workflow is enabled; GitHub/cron examples are disabled.
    expect(Object.values(loaded.config.workflows).filter((w) => w.enabled).map((w) => w.id)).toEqual(['hello']);
    expect(loaded.config.workflows.hello?.execute.command).toBe(path.join(configDir, 'scripts/hello.sh'));
    expect(loaded.config.global.workspace.baseDir).toBe(path.join(dataDir, 'workspaces'));
  });

  it('never overwrites existing files', async () => {
    const root = tempRoot();
    const configDir = path.join(root, 'config');
    const dataDir = path.join(root, 'data');
    mkdirSync(path.join(configDir, 'workflows'), { recursive: true });
    const own = 'server: { host: 127.0.0.1, port: 9999 }\n# mine\n';
    writeFileSync(path.join(configDir, 'config.yaml'), own);
    const ownScript = '#!/bin/sh\necho mine\n';
    mkdirSync(path.join(configDir, 'scripts'));
    writeFileSync(path.join(configDir, 'scripts', 'hello.sh'), ownScript, { mode: 0o700 });
    const before = statSync(path.join(configDir, 'config.yaml')).mtimeMs;

    const io = await init(['--config-dir', configDir, '--data-dir', dataDir]);
    expect(io.code).toBe(0);
    expect(readFileSync(path.join(configDir, 'config.yaml'), 'utf8')).toBe(own);
    expect(statSync(path.join(configDir, 'config.yaml')).mtimeMs).toBe(before);
    expect(readFileSync(path.join(configDir, 'scripts', 'hello.sh'), 'utf8')).toBe(ownScript);
    expect(statSync(path.join(configDir, 'scripts', 'hello.sh')).mode & 0o777).toBe(0o700);
    expect(io.out).toMatch(/kept {5}.*config\.yaml \(exists, not modified\)/);
    expect(io.out).toMatch(/created .*workflows\/hello\.yaml/);

    // A second run creates nothing and changes nothing.
    const snapshot = initTemplates().map((f) => readFileSync(path.join(configDir, f.path), 'utf8'));
    const again = await init(['--config-dir', configDir, '--data-dir', dataDir]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain('created  ');
    expect(initTemplates().map((f) => readFileSync(path.join(configDir, f.path), 'utf8'))).toEqual(snapshot);
  });

  it('reports an invalid resulting configuration and usage errors', async () => {
    const root = tempRoot();
    const configDir = path.join(root, 'config');
    mkdirSync(path.join(configDir, 'workflows'), { recursive: true });
    writeFileSync(path.join(configDir, 'workflows', 'broken.yaml'), 'id: broken\n');
    const io = await init(['--config-dir', configDir, '--data-dir', path.join(root, 'data')]);
    expect(io.code).toBe(1);
    expect(io.err).toContain('workflows/broken.yaml');
    expect(readFileSync(path.join(configDir, 'workflows', 'broken.yaml'), 'utf8')).toBe('id: broken\n');

    expect((await init([])).code).toBe(2);
    expect((await init(['--config-dir', configDir, '--port', 'x'])).code).toBe(2);
  });
});
