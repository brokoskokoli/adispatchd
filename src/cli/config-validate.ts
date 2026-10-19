/**
 * `config validate` (Spec §19): offline validation of a config directory.
 * Exit code 0 = valid (warnings allowed), 1 = invalid.
 */
import path from 'node:path';
import { formatConfigIssue, loadConfig, type ConfigIssue } from '../config/index.js';
import type { CliIo, GlobalOptions } from './program.js';

/** Exit codes of `config validate`. */
export const EXIT_CONFIG_VALID = 0;
export const EXIT_CONFIG_INVALID = 1;

function list(issues: ConfigIssue[]): string {
  return issues.map((i) => `  ${formatConfigIssue(i)}\n`).join('');
}

/** Create the `config validate` handler. */
export function createConfigValidateHandler(io: Pick<CliIo, 'stdout' | 'stderr'>) {
  return async (opts: GlobalOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('config validate: --config-dir is required\n');
      return EXIT_CONFIG_INVALID;
    }
    const configDir = path.resolve(opts.configDir);
    // The data dir only determines the default workspace.base_dir.
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    const result = await loadConfig(configDir, { dataDir });
    if (result.warnings.length > 0) {
      io.stderr(`${result.warnings.length} warning(s):\n${list(result.warnings)}`);
    }
    if (!result.ok) {
      io.stderr(`Configuration in ${configDir} is invalid, ${result.errors.length} error(s):\n${list(result.errors)}`);
      return EXIT_CONFIG_INVALID;
    }
    const c = result.config;
    io.stdout(
      `Configuration in ${configDir} is valid: ` +
        `${Object.keys(c.workflows).length} workflow(s), ${Object.keys(c.views).length} view(s), ` +
        `${Object.keys(c.filters).length} named filter(s), ` +
        `${Object.keys(c.sources).length} source(s), ${Object.keys(c.identities).length} identities. ` +
        `Hash ${c.hash.slice(0, 12)}\n`,
    );
    return EXIT_CONFIG_VALID;
  };
}
