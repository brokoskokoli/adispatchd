/**
 * `service install | status | uninstall` (Spec §4, §14, §20.1) – Linux/systemd.
 *
 * `install` generates the unit with absolute node and package paths (never
 * `npx`), a dedicated user, `Restart=on-failure`, `KillMode=mixed` and a
 * `TimeoutStopSec` derived from drain/cancel timeouts and the largest
 * `cancel_grace` of the configuration, sets ownership/permissions of
 * config-dir (root:<group>, 0750/0640) and data-dir (<user>, 0750), writes an
 * environment file template (never overwrites) and enables the unit.
 * `--dry-run` prints the unit and the planned steps without changing
 * anything (works on every platform). On non-Linux systems the real commands
 * refuse with an explanation.
 *
 * Exit codes: 0 = ok, 1 = failed, 2 = usage error / unsupported platform.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, parseDuration } from '../core/index.js';
import { loadConfig } from '../config/index.js';
import {
  DEFAULT_SERVICE_USER,
  DEFAULT_UNIT_DIR,
  DEFAULT_UNIT_NAME,
  ServiceError,
  assertSafeServicePaths,
  formatCliDuration,
  executePlan,
  formatPlan,
  planInstall,
  planUninstall,
  renderSystemdUnit,
  systemRunner,
  unitFilePath,
  type SystemRunner,
  type UnitOptions,
} from '../service/index.js';
import type { CliIo, ServiceCliOptions } from './program.js';

/** Injectable environment (tests: platform, uid, runner – real systemd is never touched in tests). */
export interface ServiceDeps {
  platform?: NodeJS.Platform;
  /** Effective UID (default `process.geteuid()`). */
  euid?: () => number;
  runner?: SystemRunner;
  /** Node executable (default `process.execPath`). */
  execPath?: string;
  /** Package entry point of this installation (default: `main.js` next to this file). */
  entryPath?: string;
}

type Io = Pick<CliIo, 'stdout' | 'stderr'>;

/** Default `execute.cancel_grace` (Spec defaults, WI-02). */
const DEFAULT_APP_CANCEL_GRACE_MS = 30_000;

/** `main.js` of this installation (`<package>/dist/cli/main.js`); in development the `.ts` source. */
export function defaultEntryPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(dir, 'main.js');
  const file = existsSync(js) ? js : path.join(dir, 'main.ts');
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function unsupported(io: Io, platform: string, command: string): number {
  io.stderr(
    `service ${command}: systemd service management is only supported on Linux (this is ${platform}).\n` +
      '  On macOS run the orchestrator in the foreground: adispatch start --config-dir <dir> --data-dir <dir>\n' +
      '  (or under launchd/your own supervisor). "service install --dry-run" prints the systemd unit anyway.\n',
  );
  return 2;
}

function duration(name: string, value: string | undefined, fallback: string): number {
  try {
    return parseDuration(value ?? fallback);
  } catch (err) {
    throw new ServiceError('service_invalid_option', `invalid --${name} "${value}": ${errorMessage(err)}`);
  }
}

/**
 * Largest `execute.cancel_grace` of the configuration. Outside dry runs the
 * configuration must exist (`config.yaml`) and be valid – `install` changes
 * ownership of the directory recursively, so a typo'd path must not pass.
 * In dry runs a missing/invalid configuration only warns (default 30 s).
 */
async function maxCancelGrace(configDir: string, dataDir: string, io: Io, dryRun: boolean): Promise<number> {
  const configFile = path.join(configDir, 'config.yaml');
  const exists = existsSync(configFile);
  const loaded = exists ? await loadConfig(configDir, { dataDir }) : null;
  if (!loaded || !loaded.ok) {
    const why = !exists
      ? `${configFile} does not exist (create the configuration with "adispatch init" first)`
      : `configuration in ${configDir} is invalid (${loaded?.ok === false ? loaded.errors.length : 0} error(s); see "config validate")`;
    if (!dryRun) throw new ServiceError('service_config_invalid', why);
    io.stderr(`warning: ${why}; TimeoutStopSec assumes a cancel grace of 30s\n`);
    return DEFAULT_APP_CANCEL_GRACE_MS;
  }
  return Math.max(DEFAULT_APP_CANCEL_GRACE_MS, ...Object.values(loaded.config.workflows).map((w) => w.execute.cancelGraceMs));
}

/** Resolve symlinks of existing paths (so `/srv/x -> /etc` cannot bypass the system-path check). */
function realOrResolved(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Warning if a worker's cancel grace cannot take effect within the cancel timeout. */
export function cancelGraceWarning(maxCancelGraceMs: number, cancelTimeoutMs: number): string | null {
  if (maxCancelGraceMs < cancelTimeoutMs) return null;
  return (
    `the largest execute.cancel_grace (${formatCliDuration(maxCancelGraceMs)}) is not smaller than the cancel timeout ` +
    `(${formatCliDuration(cancelTimeoutMs)}): on shutdown the orchestrator may stop before workers are SIGKILLed; ` +
    'raise --cancel-timeout or lower cancel_grace'
  );
}

/** Collect and validate the unit options from the CLI flags. */
export async function unitOptionsFromCli(opts: ServiceCliOptions, deps: ServiceDeps, io: Io): Promise<UnitOptions> {
  const dryRun = opts.dryRun === true;
  if (!opts.configDir || !opts.dataDir) {
    throw new ServiceError('service_invalid_option', 'service install: --config-dir and --data-dir are required (absolute paths recommended, e.g. /etc/adispatchd and /var/lib/adispatchd)');
  }
  const unitName = opts.name ?? DEFAULT_UNIT_NAME;
  const user = opts.user ?? DEFAULT_SERVICE_USER;
  // Check the paths as given and with symlinks resolved (e.g. /srv/x -> /etc, or /var -> /private/var on macOS).
  assertSafeServicePaths({ configDir: path.resolve(opts.configDir), dataDir: path.resolve(opts.dataDir) });
  const configDir = realOrResolved(opts.configDir);
  const dataDir = realOrResolved(opts.dataDir);
  assertSafeServicePaths({ configDir, dataDir });
  const envFile = opts.envFile === 'none' ? null : path.resolve(opts.envFile ?? `/etc/default/${unitName}`);
  return {
    unitName,
    user,
    group: opts.group ?? user,
    nodePath: path.resolve(opts.node ?? deps.execPath ?? process.execPath),
    entryPath: path.resolve(opts.entry ?? deps.entryPath ?? defaultEntryPath()),
    configDir,
    dataDir,
    envFile,
    drainTimeoutMs: duration('drain-timeout', opts.drainTimeout, '10m'),
    cancelTimeoutMs: duration('cancel-timeout', opts.cancelTimeout, '2m'),
    maxCancelGraceMs: await maxCancelGrace(configDir, dataDir, io, dryRun),
  };
}

function pathWarnings(unit: UnitOptions): string[] {
  const warnings: string[] = [];
  for (const [label, p] of [
    ['node', unit.nodePath],
    ['package', unit.entryPath],
  ] as const) {
    if (/^\/(root|home|Users)\//.test(p)) {
      warnings.push(
        `${label} path ${p} lies in a home directory (nvm/user install?) – the service user "${unit.user}" may not be able to read it; ` +
          'prefer a system-wide node and a global install of a fixed version (npm install -g adispatchd@<version>) or pass --node/--entry',
      );
    }
  }
  return warnings;
}

async function userExists(runner: SystemRunner, user: string): Promise<boolean> {
  return (await runner.exec(['id', '-u', user])).code === 0;
}

/** `service install`. */
export function createServiceInstallHandler(io: Io, deps: ServiceDeps = {}) {
  return async (opts: ServiceCliOptions): Promise<number> => {
    const platform = deps.platform ?? process.platform;
    const runner = deps.runner ?? systemRunner;
    const linux = platform === 'linux';
    if (!opts.dryRun && !linux) return unsupported(io, platform, 'install');
    let unit: UnitOptions;
    let content: string;
    try {
      unit = await unitOptionsFromCli(opts, deps, io);
      content = renderSystemdUnit(unit);
    } catch (err) {
      io.stderr(`service install: ${errorMessage(err)}\n`);
      return 2;
    }
    const warnings = pathWarnings(unit);
    const graceWarning = cancelGraceWarning(unit.maxCancelGraceMs, unit.cancelTimeoutMs);
    if (graceWarning) warnings.push(graceWarning);
    const unitDir = path.resolve(opts.unitDir ?? DEFAULT_UNIT_DIR);
    // Probing the user is read-only (`id -u`); on non-Linux dry runs it is skipped.
    const exists = linux ? await userExists(runner, unit.user) : true;
    const input = {
      unit,
      unitDir,
      createUser: opts.createUser === true,
      userExists: exists,
      envFileExists: unit.envFile !== null && runner.exists(unit.envFile),
      startNow: opts.now === true,
      dryRun: opts.dryRun === true,
    };
    let plan;
    try {
      plan = planInstall(input);
    } catch (err) {
      io.stderr(`service install: ${errorMessage(err)}\n`);
      return 1;
    }

    if (opts.dryRun) {
      io.stdout(`# ${unitFilePath(unitDir, unit.unitName)}\n${content}\n`);
      if (!linux) io.stdout(`# note: this is ${platform}; the unit is only usable on Linux with systemd\n`);
      io.stdout(`# planned steps (dry run, nothing was changed):\n${formatPlan(plan)}`);
      for (const n of [...warnings, ...plan.notes]) io.stdout(`# note: ${n}\n`);
      return 0;
    }
    const euid = deps.euid ?? (() => process.geteuid?.() ?? -1);
    if (euid() !== 0) {
      io.stderr('service install: must run as root (e.g. sudo "$(command -v node)" "$(command -v adispatch)" service install ...)\n');
      return 1;
    }
    for (const w of warnings) io.stderr(`warning: ${w}\n`);
    if ((await runner.exec(['systemctl', '--version'])).code !== 0) {
      io.stderr('service install: systemctl not found – is this a systemd system?\n');
      return 1;
    }
    const result = await executePlan(plan, runner, io.stdout);
    if (!result.ok) {
      io.stderr(`service install failed at "${result.failedStep?.description}": ${result.error}\n`);
      return 1;
    }
    for (const n of plan.notes) io.stdout(`note: ${n}\n`);
    io.stdout(`service ${unit.unitName} installed (${unitFilePath(unitDir, unit.unitName)})\n`);
    return 0;
  };
}

/** `service uninstall`. */
export function createServiceUninstallHandler(io: Io, deps: ServiceDeps = {}) {
  return async (opts: ServiceCliOptions): Promise<number> => {
    const platform = deps.platform ?? process.platform;
    const plan = planUninstall({ unitName: opts.name ?? DEFAULT_UNIT_NAME, unitDir: path.resolve(opts.unitDir ?? DEFAULT_UNIT_DIR) });
    if (opts.dryRun) {
      io.stdout(`# planned steps (dry run, nothing was changed):\n${formatPlan(plan)}`);
      for (const n of plan.notes) io.stdout(`# note: ${n}\n`);
      return 0;
    }
    if (platform !== 'linux') return unsupported(io, platform, 'uninstall');
    const euid = deps.euid ?? (() => process.geteuid?.() ?? -1);
    if (euid() !== 0) {
      io.stderr('service uninstall: must run as root\n');
      return 1;
    }
    const result = await executePlan(plan, deps.runner ?? systemRunner, io.stdout);
    if (!result.ok) {
      io.stderr(`service uninstall failed at "${result.failedStep?.description}": ${result.error}\n`);
      return 1;
    }
    for (const n of plan.notes) io.stdout(`note: ${n}\n`);
    return 0;
  };
}

/** `service status`: `systemctl status <unit>` (read-only). */
export function createServiceStatusHandler(io: Io, deps: ServiceDeps = {}) {
  return async (opts: ServiceCliOptions): Promise<number> => {
    const platform = deps.platform ?? process.platform;
    if (platform !== 'linux') return unsupported(io, platform, 'status');
    const unitName = opts.name ?? DEFAULT_UNIT_NAME;
    const r = await (deps.runner ?? systemRunner).exec(['systemctl', 'status', '--no-pager', '--lines', '20', `${unitName}.service`]);
    if (r.stdout) io.stdout(r.stdout);
    if (r.stderr) io.stderr(r.stderr);
    // systemctl status: 0 = active, 3 = inactive, 4 = unknown unit.
    if (r.code === 4) io.stderr(`unit ${unitName}.service is not installed (adispatch service install ...)\n`);
    return r.code === 0 ? 0 : 1;
  };
}
