/**
 * `start --config-dir <dir> [--data-dir <dir>] [--drain-timeout 10m]
 * [--cancel-timeout 2m] [--host h] [--port p]` (Spec §4, §14): starts the
 * orchestrator in the foreground, prints the URL, warns on non-loopback
 * binds, handles SIGTERM/SIGINT (drain with `--drain-timeout`, then
 * cancel-all with `--cancel-timeout`; a second signal cancels immediately)
 * and exits with 0 after an orderly shutdown (also after an API drain /
 * cancel-all), 2 on usage errors, {@link EXIT_CONFIG} (78, EX_CONFIG) on
 * configuration/start errors a restart cannot fix (invalid configuration,
 * instance lock held, database migration error; the systemd unit sets
 * `RestartPreventExitStatus=78`), 1 on other startup errors or a fatal error.
 */
import path from 'node:path';
import { errorMessage, formatDuration, isOrchestratorError, parseDuration } from '../core/index.js';
import { ConfigLoadError, formatConfigIssue } from '../config/index.js';
import {
  DEFAULT_CANCEL_TIMEOUT_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  createApp,
  installSignalHandlers,
  isLoopback,
  type App,
  type AppOptions,
  type SignalTarget,
} from '../app.js';
import { resolveUiDir } from '../ui/index.js';
import { EXIT_CONFIG } from '../service/index.js';
import { cancelGraceWarning } from './service.js';
import type { CliIo, StartCliOptions } from './program.js';

function durationFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  try {
    return parseDuration(value);
  } catch (err) {
    throw new Error(`invalid --${name} "${value}": ${errorMessage(err)}`);
  }
}

/** Parse the `start` flags (throws on invalid values). */
export function parseStartFlags(opts: StartCliOptions): { drainTimeoutMs?: number; cancelTimeoutMs?: number; host?: string; port?: number } {
  const out: { drainTimeoutMs?: number; cancelTimeoutMs?: number; host?: string; port?: number } = {};
  const drain = durationFlag('drain-timeout', opts.drainTimeout);
  const cancel = durationFlag('cancel-timeout', opts.cancelTimeout);
  if (drain !== undefined) out.drainTimeoutMs = drain;
  if (cancel !== undefined) out.cancelTimeoutMs = cancel;
  if (opts.host !== undefined) out.host = opts.host;
  if (opts.port !== undefined) {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port "${opts.port}"`);
    out.port = port;
  }
  return out;
}

/** Injectable dependencies (tests). */
export interface StartDeps {
  /** Extra app options (tests: Fake-GitHub fetch, env, port 0). */
  appOptions?: Partial<AppOptions>;
  /** Signal source (default `process`). */
  signals?: SignalTarget;
  /** Hard exit used as safety net if the event loop does not drain after stop (default `process.exit`). */
  exit?: (code: number) => void;
  /** Called once the app listens (tests). */
  onStarted?: (app: App) => void;
}

/** Create the `start` handler. */
export function createStartHandler(io: Pick<CliIo, 'stdout' | 'stderr'>, deps: StartDeps = {}) {
  return async (opts: StartCliOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('start: --config-dir is required\n');
      return 2;
    }
    let flags: ReturnType<typeof parseStartFlags>;
    try {
      flags = parseStartFlags(opts);
    } catch (err) {
      io.stderr(`start: ${errorMessage(err)}\n`);
      return 2;
    }
    const configDir = path.resolve(opts.configDir);
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    // Static web UI (WI-11): built assets from `dist/ui/public`; the API also runs without them.
    const uiDir = deps.appOptions && 'uiDir' in deps.appOptions ? deps.appOptions.uiDir : (resolveUiDir() ?? undefined);
    const appOptions: AppOptions = {
      configDir,
      dataDir,
      ...flags,
      ...(deps.appOptions ?? {}),
      ...(uiDir ? { uiDir } : {}),
    };
    let app: App;
    try {
      app = await createApp(appOptions);
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        io.stderr(`Configuration in ${configDir} is invalid:\n${err.errors.map((i) => `  ${formatConfigIssue(i)}\n`).join('')}`);
        return EXIT_CONFIG;
      }
      if (isOrchestratorError(err, 'instance_locked') || isOrchestratorError(err, 'migration_error')) {
        io.stderr(`start: ${err.message}\n`);
        return EXIT_CONFIG;
      }
      io.stderr(`start: ${errorMessage(err)}\n`);
      return 1;
    }
    let url: string;
    try {
      url = await app.start();
    } catch (err) {
      io.stderr(`start: cannot listen: ${errorMessage(err)}\n`);
      await app.shutdown({ mode: 'cancel', cancelTimeoutMs: 0 });
      return 1;
    }
    io.stdout(`agent-orchestrator listening on ${url} (config ${configDir}, data ${dataDir})\n`);
    io.stdout(
      `SIGTERM/Ctrl-C: drain up to ${formatDuration(appOptions.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS)}, ` +
        `then cancel all runs (${formatDuration(appOptions.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS)}); a second signal cancels immediately\n`,
    );
    const graceWarning = cancelGraceWarning(
      Math.max(0, ...Object.values(app.config.current.workflows).map((w) => w.execute.cancelGraceMs)),
      appOptions.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
    );
    if (graceWarning) io.stderr(`warning: ${graceWarning}\n`);
    if (!uiDir) io.stderr('Note: web UI assets not found (run `npm run build`); serving the API only.\n');
    const host = new URL(url).hostname;
    if (!isLoopback(host)) {
      io.stderr(
        `WARNING: the HTTP API is bound to ${host} without authentication. Only expose it behind an authenticating reverse proxy or VPN ` +
          '(add its host name to server.allowed_hosts; see docs/operations.md).\n',
      );
    }
    const uninstall = installSignalHandlers(app, {
      ...(deps.signals ? { target: deps.signals } : {}),
      ...(appOptions.drainTimeoutMs !== undefined ? { drainTimeoutMs: appOptions.drainTimeoutMs } : {}),
      ...(appOptions.cancelTimeoutMs !== undefined ? { cancelTimeoutMs: appOptions.cancelTimeoutMs } : {}),
      ...(deps.exit ? { forceExit: deps.exit } : {}),
    });
    deps.onStarted?.(app);
    const result = await app.stopped;
    uninstall();
    if (result.error) io.stderr(`agent-orchestrator stopped with error: ${result.error}\n`);
    else io.stdout('agent-orchestrator stopped\n');
    // Safety net: if some handle keeps the event loop alive, exit anyway (does not keep the process alive itself).
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const t = setTimeout(() => exit(result.exitCode), 5_000);
    t.unref();
    return result.exitCode;
  };
}
