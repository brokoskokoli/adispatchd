/**
 * Test helpers: temporary config directories. Also usable by other
 * components' tests (import from `src/config/testing/fixtures.js`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of `examples/config` in the repository. */
export const EXAMPLE_CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/config');

/** Minimal valid `sources.yaml` + `identities.yaml` content. */
export const BASE_FILES: Readonly<Record<string, string>> = {
  'config.yaml': 'scheduler:\n  max_concurrent: 4\n',
  'identities.yaml': [
    'identities:',
    '  maintainer:',
    '    type: github_app',
    '    app_id: 1',
    '    installation_id: 2',
    '    private_key_env: TEST_MAINTAINER_KEY',
    '  coder:',
    '    type: github_app',
    '    app_id: 3',
    '    installation_id: 4',
    '    private_key_env: TEST_CODER_KEY',
    '',
  ].join('\n'),
  'sources.yaml': [
    'sources:',
    '  repo_a:',
    '    type: github',
    '    owner: example',
    '    repository: a',
    '    identity: maintainer',
    '  repo_b:',
    '    type: github',
    '    owner: example',
    '    repository: b',
    '    identity: maintainer',
    '',
  ].join('\n'),
};

/** A temporary config directory. */
export interface TempConfigDir {
  dir: string;
  dataDir: string;
  /** Write (or overwrite) files, path relative to `dir`. `null` deletes. */
  write(files: Record<string, string | null>): Promise<void>;
  cleanup(): Promise<void>;
}

/** Create a temporary config dir pre-filled with `files`. */
export async function createTempConfigDir(files: Record<string, string | null> = {}): Promise<TempConfigDir> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orch-config-'));
  const dir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  await mkdir(dir, { recursive: true });
  const write = async (entries: Record<string, string | null>): Promise<void> => {
    for (const [rel, content] of Object.entries(entries)) {
      const full = path.join(dir, rel);
      if (content === null) {
        await rm(full, { force: true });
        continue;
      }
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
  await write(files);
  return { dir, dataDir, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}
