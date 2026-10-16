/**
 * `start --config-dir <dir> [--data-dir <dir>]` (Spec §4, §14): starts the
 * orchestrator in the foreground, prints the URL, handles SIGTERM/SIGINT
 * (drain → cancel-all) and exits with 0 after an orderly shutdown (also after
 * an API drain / cancel-all), 1 on startup errors or a fatal error.
 *
 * Minimal wiring for WI-10; WI-12 completes the CLI (flags for timeouts etc.).
 */
import path from 'node:path';
import { errorMessage, isOrchestratorError } from '../core/index.js';
import { ConfigLoadError, formatConfigIssue } from '../config/index.js';
import { createApp, installSignalHandlers, isLoopback, type App, type AppOptions, type SignalTarget } from '../app.js';
import { resolveUiDir } from '../ui/index.js';
import type { CliIo, GlobalOptions } from './program.js';

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
  return async (opts: GlobalOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('start: --config-dir is required\n');
      return 2;
    }
    const configDir = path.resolve(opts.configDir);
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    // Static web UI (WI-11): built assets from `dist/ui/public`; the API also runs without them.
    const uiDir = deps.appOptions && 'uiDir' in deps.appOptions ? deps.appOptions.uiDir : (resolveUiDir() ?? undefined);
    let app: App;
    try {
      app = await createApp({ configDir, dataDir, ...(deps.appOptions ?? {}), ...(uiDir ? { uiDir } : {}) });
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        io.stderr(`Configuration in ${configDir} is invalid:\n${err.errors.map((i) => `  ${formatConfigIssue(i)}\n`).join('')}`);
        return 1;
      }
      if (isOrchestratorError(err, 'instance_locked')) {
        io.stderr(`start: ${err.message}\n`);
        return 1;
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
    if (!uiDir) io.stderr('Note: web UI assets not found (run `npm run build`); serving the API only.\n');
    const host = new URL(url).hostname;
    if (!isLoopback(host)) {
      io.stderr(
        `WARNING: the HTTP API is bound to ${host} without authentication. Only expose it behind an authenticating reverse proxy or VPN.\n`,
      );
    }
    const uninstall = installSignalHandlers(app, {
      ...(deps.signals ? { target: deps.signals } : {}),
      ...(deps.appOptions?.drainTimeoutMs !== undefined ? { drainTimeoutMs: deps.appOptions.drainTimeoutMs } : {}),
      ...(deps.appOptions?.cancelTimeoutMs !== undefined ? { cancelTimeoutMs: deps.appOptions.cancelTimeoutMs } : {}),
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
