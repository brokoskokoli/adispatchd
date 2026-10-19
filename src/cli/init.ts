/**
 * `init --config-dir <dir> [--data-dir <dir>] [--port <port>]` (Spec §4):
 * creates the config-dir with a commented example configuration (incl. a named
 * filter in `filters/` and an info tile in `dashboard.yaml`) and example scripts, and the data-dir layout. Never
 * overwrites or modifies existing files (each file is created with `O_EXCL`);
 * existing files are reported as kept. Afterwards the resulting configuration is validated.
 *
 * Exit codes: 0 = done (configuration valid), 1 = resulting configuration
 * invalid (e.g. because of pre-existing files) or I/O error, 2 = usage error.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../core/index.js';
import { formatConfigIssue, loadConfig } from '../config/index.js';
import { DATA_DIR_LAYOUT, initTemplates } from './init-templates.js';
import type { CliIo, InitCliOptions } from './program.js';

/** Result of {@link initDirectories}. */
export interface InitResult {
  configDir: string;
  dataDir: string;
  created: string[];
  kept: string[];
}

/** Create a file only if it does not exist yet. Returns false if it existed. */
async function createExclusive(file: string, content: string, mode: number): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  await chmod(file, mode); // independent of the umask
  return true;
}

/** Create config-dir and data-dir (idempotent, never overwrites). */
export async function initDirectories(options: { configDir: string; dataDir: string; port?: number }): Promise<InitResult> {
  const configDir = path.resolve(options.configDir);
  const dataDir = path.resolve(options.dataDir);
  const created: string[] = [];
  const kept: string[] = [];
  for (const sub of ['', 'workflows', 'views', 'filters', 'scripts', 'scripts/info']) {
    await mkdir(path.join(configDir, sub), { recursive: true, mode: 0o750 });
  }
  for (const file of initTemplates({ ...(options.port !== undefined ? { port: options.port } : {}) })) {
    const target = path.join(configDir, file.path);
    if (await createExclusive(target, file.content, file.mode)) created.push(target);
    else kept.push(target);
  }
  await mkdir(dataDir, { recursive: true, mode: 0o750 });
  for (const sub of DATA_DIR_LAYOUT) {
    await mkdir(path.join(dataDir, sub), { recursive: true, mode: 0o750 });
  }
  return { configDir, dataDir, created, kept };
}

/** Create the `init` handler. */
export function createInitHandler(io: Pick<CliIo, 'stdout' | 'stderr'>) {
  return async (opts: InitCliOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('init: --config-dir is required (e.g. init --config-dir ./config --data-dir ./data)\n');
      return 2;
    }
    let port: number | undefined;
    if (opts.port !== undefined) {
      port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        io.stderr(`init: invalid --port "${opts.port}"\n`);
        return 2;
      }
    }
    let result: InitResult;
    try {
      result = await initDirectories({ configDir: opts.configDir, dataDir: opts.dataDir ?? 'data', ...(port !== undefined ? { port } : {}) });
    } catch (err) {
      io.stderr(`init: ${errorMessage(err)}\n`);
      return 1;
    }
    for (const f of result.created) io.stdout(`created  ${f}\n`);
    for (const f of result.kept) io.stdout(`kept     ${f} (exists, not modified)\n`);
    io.stdout(`data dir ${result.dataDir}\n`);

    const loaded = await loadConfig(result.configDir, { dataDir: result.dataDir });
    for (const w of loaded.warnings) io.stderr(`warning: ${formatConfigIssue(w)}\n`);
    if (!loaded.ok) {
      io.stderr(
        `init: the configuration in ${result.configDir} is invalid (existing files were kept):\n` +
          loaded.errors.map((e) => `  ${formatConfigIssue(e)}\n`).join(''),
      );
      return 1;
    }
    const q = (p: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
    io.stdout(
      [
        '',
        'Next steps:',
        `  adispatch start --config-dir ${q(result.configDir)} --data-dir ${q(result.dataDir)}`,
        `  open http://127.0.0.1:${loaded.config.global.server.port}/ and start the "hello" workflow`,
        '  configure sources.yaml / identities.yaml and enable workflows/coder.yaml for GitHub (see README.md)',
        '',
      ].join('\n'),
    );
    return 0;
  };
}
