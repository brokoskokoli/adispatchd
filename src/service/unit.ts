/**
 * systemd unit generation (Spec §4, §14, §20.1) – pure functions.
 *
 * The unit starts a fixed, globally installed package version directly with
 * absolute paths (`<node> <package>/dist/cli/main.js start …`), never through
 * `npx`. Stop behaviour is aligned with the orchestrator's shutdown contract
 * (docs/handoff/WI-08.md, docs/operations.md):
 *
 * - `KillMode=mixed`: `systemctl stop` sends SIGTERM only to the main process
 *   (workers keep running while the orchestrator drains); after
 *   `TimeoutStopSec` systemd SIGKILLs the whole cgroup including workers.
 * - `TimeoutStopSec` = drain timeout + cancel timeout + max. `cancel_grace`
 *   + buffer. The worker's SIGTERM → SIGKILL grace runs *inside* the cancel
 *   timeout (after it, hooks are interrupted and the orchestrator exits), so
 *   the grace term is only a safety margin; `cancel_grace` must be smaller
 *   than the cancel timeout to be effective (the CLI warns otherwise).
 * - `Restart=on-failure`: an orderly shutdown (API drain / cancel-all, SIGTERM)
 *   exits with 0 and is not restarted; a crash (exit ≠ 0, signal) is.
 *   Configuration/start errors exit with {@link EXIT_CONFIG} (78, EX_CONFIG),
 *   excluded via `RestartPreventExitStatus=78` (no restart loop).
 */
import path from 'node:path';
import { ValidationError } from '../core/index.js';

/** Exit code of `start` for configuration/startup errors that a restart cannot fix (sysexits EX_CONFIG). */
export const EXIT_CONFIG = 78;

/** Default unit / service name. */
export const DEFAULT_UNIT_NAME = 'adispatchd';
/** Default dedicated service user (and group). */
export const DEFAULT_SERVICE_USER = 'adispatchd';
/** Default directory for unit files. */
export const DEFAULT_UNIT_DIR = '/etc/systemd/system';
/** Extra time on top of drain + cancel + grace before systemd kills the cgroup. */
export const DEFAULT_STOP_BUFFER_MS = 60_000;

/** Input of {@link renderSystemdUnit}. */
export interface UnitOptions {
  /** Unit name without `.service`. */
  unitName: string;
  description?: string;
  /** Dedicated service user and group. */
  user: string;
  group: string;
  /** Absolute path of the node executable. */
  nodePath: string;
  /** Absolute path of the installed package entry point (`…/dist/cli/main.js`). */
  entryPath: string;
  /** Absolute config and data directories. */
  configDir: string;
  dataDir: string;
  /** Optional environment file with secrets (GitHub App keys, webhook URLs); `null` = none. */
  envFile: string | null;
  /** Drain timeout on SIGTERM before cancel-all (passed to `start --drain-timeout`). */
  drainTimeoutMs: number;
  /** Time for cancelled runs incl. `on_cancel` (passed to `start --cancel-timeout`). */
  cancelTimeoutMs: number;
  /** Largest `execute.cancel_grace` of all workflows (SIGTERM → SIGKILL of a worker group). */
  maxCancelGraceMs: number;
  /** Additional stop buffer (default {@link DEFAULT_STOP_BUFFER_MS}). */
  stopBufferMs?: number;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/** `TimeoutStopSec` in whole seconds: drain + cancel + grace + buffer, rounded up. */
export function computeTimeoutStopSec(opts: Pick<UnitOptions, 'drainTimeoutMs' | 'cancelTimeoutMs' | 'maxCancelGraceMs' | 'stopBufferMs'>): number {
  const total = opts.drainTimeoutMs + opts.cancelTimeoutMs + opts.maxCancelGraceMs + (opts.stopBufferMs ?? DEFAULT_STOP_BUFFER_MS);
  return Math.ceil(total / 1000);
}

/** Duration in the CLI's own syntax (`10m`, `90s`, `1500ms`), parseable by `parseDuration`. */
export function formatCliDuration(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new ValidationError(`Invalid duration ${ms}`);
  if (ms === 0) return '0s';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * Quote one `ExecStart` word for systemd: `%` → `%%` (specifiers), `$` → `$$`
 * (no variable expansion); words with whitespace, quotes or backslashes are
 * wrapped in double quotes with C-style escaping.
 */
export function quoteSystemdArg(value: string): string {
  if (/[\0\n\r]/.test(value)) throw new ValidationError('Unit values must not contain NUL or line breaks');
  const escaped = value.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (escaped !== '' && !/[\s"'\\;]/.test(escaped)) return escaped;
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Value for `key=value` lines that take a single path (escapes specifiers). */
function pathValue(value: string): string {
  if (/[\0\n\r]/.test(value)) throw new ValidationError('Unit values must not contain NUL or line breaks');
  return value.replace(/%/g, '%%');
}

function assertAbsolute(label: string, p: string): void {
  if (!path.isAbsolute(p)) throw new ValidationError(`${label} must be an absolute path (got "${p}")`);
}

/** Validate unit options; throws {@link ValidationError}. */
export function validateUnitOptions(opts: UnitOptions): void {
  if (!NAME_PATTERN.test(opts.unitName)) throw new ValidationError(`Invalid unit name "${opts.unitName}"`);
  if (!USER_PATTERN.test(opts.user)) throw new ValidationError(`Invalid user name "${opts.user}"`);
  if (!USER_PATTERN.test(opts.group)) throw new ValidationError(`Invalid group name "${opts.group}"`);
  if (opts.user === 'root') throw new ValidationError('The service must run as a dedicated user, not root (Spec §20.1)');
  assertAbsolute('node path', opts.nodePath);
  assertAbsolute('package entry point', opts.entryPath);
  assertAbsolute('config dir', opts.configDir);
  assertAbsolute('data dir', opts.dataDir);
  if (opts.envFile !== null) assertAbsolute('environment file', opts.envFile);
  for (const [label, p] of [
    ['node path', opts.nodePath],
    ['package entry point', opts.entryPath],
  ] as const) {
    if (/(^|\/)(npx|_npx)(\/|$)/.test(p)) {
      throw new ValidationError(
        `${label} "${p}" points into an npx cache – install the package permanently from its tarball (npm pack → npm install -g ./adispatchd-<version>.tgz) and run "service install" from there`,
      );
    }
  }
  if (/\.ts$/.test(opts.entryPath)) {
    throw new ValidationError(`package entry point "${opts.entryPath}" is a TypeScript source – build the package (npm run build) or install it`);
  }
  for (const [label, ms] of [
    ['drain timeout', opts.drainTimeoutMs],
    ['cancel timeout', opts.cancelTimeoutMs],
    ['cancel grace', opts.maxCancelGraceMs],
  ] as const) {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new ValidationError(`Invalid ${label} ${ms}`);
  }
}

/** Render the systemd unit file. Pure: same input → same output. */
export function renderSystemdUnit(opts: UnitOptions): string {
  validateUnitOptions(opts);
  const timeoutStopSec = computeTimeoutStopSec(opts);
  const exec = [
    opts.nodePath,
    opts.entryPath,
    'start',
    '--config-dir',
    opts.configDir,
    '--data-dir',
    opts.dataDir,
    '--drain-timeout',
    formatCliDuration(opts.drainTimeoutMs),
    '--cancel-timeout',
    formatCliDuration(opts.cancelTimeoutMs),
  ]
    .map(quoteSystemdArg)
    .join(' ');
  const lines = [
    '# Generated by "adispatch service install". Changes are overwritten by the next install.',
    '# Stop contract: SIGTERM drains (drain timeout), then cancels all runs (cancel timeout);',
    `# TimeoutStopSec = drain ${formatCliDuration(opts.drainTimeoutMs)} + cancel ${formatCliDuration(opts.cancelTimeoutMs)} + grace margin ${formatCliDuration(opts.maxCancelGraceMs)} + buffer ${formatCliDuration(opts.stopBufferMs ?? DEFAULT_STOP_BUFFER_MS)}.`,
    '# For planned stops/updates run "adispatch drain --wait" first (see docs/operations.md).',
    '[Unit]',
    `Description=${opts.description ?? 'Agent Dispatch Daemon'}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${opts.user}`,
    `Group=${opts.group}`,
    `ExecStart=${exec}`,
    `WorkingDirectory=${pathValue(opts.dataDir)}`,
    ...(opts.envFile !== null ? [`EnvironmentFile=-${pathValue(opts.envFile)}`] : []),
    'Environment=NODE_ENV=production',
    // Orderly shutdown → exit 0 → no restart; crash → restart → recovery.
    'Restart=on-failure',
    'RestartSec=5s',
    // Configuration/start errors (invalid YAML, instance lock held, newer DB schema): do not restart in a loop.
    `RestartPreventExitStatus=${EXIT_CONFIG}`,
    // SIGTERM only to the orchestrator; workers stay alive while it drains.
    'KillMode=mixed',
    'KillSignal=SIGTERM',
    `TimeoutStopSec=${timeoutStopSec}`,
    'UMask=0027',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'LimitNOFILE=65536',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ];
  return lines.join('\n');
}
