/**
 * `adispatch hub …` (WI-35): run several workspaces (complete dispatcher
 * instances) as child processes of one hub with a shared run limit.
 *
 * - `hub init`      creates `hub.yaml` and the directories of its workspaces (never overwrites).
 * - `hub validate`  checks `hub.yaml` and the configuration of every workspace.
 * - `hub start`     runs the hub in the foreground (signals: drain, second signal cancels, third forces).
 * - `hub status`, `hub pause|resume|stop-all|drain-all`, `hub workspace start|stop|restart|drain <id>`
 *   talk to the running hub over its control socket (`<data-dir>/hub.sock`).
 *
 * Exit codes: 0 ok, 1 error / invalid configuration, 2 usage error, 3 hub not
 * reachable, 78 (EX_CONFIG) when the hub cannot start because of its
 * configuration or the instance lock.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, formatDuration, isOrchestratorError, parseDuration } from '../core/index.js';
import { APP_VERSION, DEFAULT_CANCEL_TIMEOUT_MS, DEFAULT_DRAIN_TIMEOUT_MS, installSignalHandlers, type SignalTarget } from '../app.js';
import { HUB_FILE, WORKSPACE_ID_PATTERN, formatConfigIssue, loadConfig, loadHubConfig, type ConfigIssue, type HubConfig } from '../config/index.js';
import {
  HUB_CONTROL_SOCKET,
  HubControlClient,
  HubResponseError,
  HubUnreachableError,
  createHub,
  type Hub,
  type HubOptions,
  type HubStatus,
} from '../hub/index.js';
import { EXIT_CONFIG } from '../service/index.js';
import { resolveUiDir } from '../ui/index.js';
import { createExclusive, initDirectories } from './init.js';
import { parseStartFlags } from './start.js';
import { EXIT_WAIT_TIMEOUT } from './control.js';
import { EXIT_UNREACHABLE } from './http-client.js';
import type { CliIo, HubControlCliOptions, HubInitCliOptions, StartCliOptions, GlobalOptions } from './program.js';

type Io = Pick<CliIo, 'stdout' | 'stderr'>;

function issues(list: readonly ConfigIssue[], prefix = ''): string {
  return list.map((i) => `  ${prefix}${formatConfigIssue(i)}\n`).join('');
}

// ---------------------------------------------------------------------------
// hub init

/** `hub.yaml` written by `hub init`. */
export function hubYamlTemplate(options: {
  maxConcurrent: number;
  hubPort: number;
  workspaces: Array<{ id: string; port: number }>;
  /** Absolute directory whose subdirectories `<id>` hold the data dirs (default: `workspaces/<id>/data` below the config dir). */
  workspacesDataDir?: string;
}): string {
  const ws = options.workspaces
    .map((w) =>
      [
        `  - id: ${w.id}`,
        `    config_dir: workspaces/${w.id}/config   # relative paths are relative to this directory`,
        `    data_dir: ${options.workspacesDataDir ? yamlString(path.join(options.workspacesDataDir, w.id)) : `workspaces/${w.id}/data`}       # must not be nested in another data_dir or in the hub's data dir`,
        `    port: ${w.port}                        # loopback port of the workspace instance (unique)`,
        '    enabled: true                          # false: known, but only started with "hub workspace start"',
      ].join('\n'),
    )
    .join('\n');
  return `# hub.yaml – one hub, several workspaces (docs/configuration-reference.md, "hub.yaml").
# Every workspace is a complete adispatchd instance (own config dir, data dir, database, port) that
# the hub starts as a child process under the same user. Validate:  adispatch hub validate --config-dir <dir>

hub:
  # Limit of simultaneously running runs across ALL workspaces (a workspace's own
  # scheduler.max_concurrent stays an additional upper bound). Manual starts are not limited.
  max_concurrent: ${options.maxConcurrent}
  # Address of the hub's own HTTP server: overview page, hub API and the workspace UIs below /w/<id>/.
  # Behind a reverse proxy add its host name to allowed_hosts.
  server: { host: 127.0.0.1, port: ${options.hubPort}, allowed_hosts: [] }

# Login of the hub's web UI and API (optional; same section as in a workspace's config.yaml). Without it nobody is asked to
# log in: keep the server on 127.0.0.1 or put an authenticating proxy in front. Hash: adispatch auth hash-password
# auth:
#   mode: password
#   users:
#     - { name: admin, password_hash_env: HUB_PW_ADMIN, role: admin }

workspaces:${ws === '' ? ` []
  # Add existing instances (or new workspaces) as list items below "workspaces:" (remove the []). Example: a single
  # instance that ran on its own until now:
  # - id: main
  #   config_dir: /etc/adispatchd            # unchanged config-dir of the existing instance
  #   data_dir: /var/lib/adispatchd          # unchanged data-dir (database, logs, runs)
  #   port: 8091                             # new unique loopback port (the hub passes it as --port; server.port in config.yaml is not used)
  #   enabled: true` : `\n${ws}`}
`;
}

/** Plain YAML scalar when safe, otherwise a double-quoted string. */
function yamlString(value: string): string {
  return /^[A-Za-z0-9_@%+=,./-]+$/.test(value) ? value : JSON.stringify(value);
}

function parseWorkspaceSpecs(specs: readonly string[] | undefined, basePort: number): { workspaces: Array<{ id: string; port: number }> } | { error: string } {
  const ids = specs && specs.length > 0 ? specs : ['main'];
  const out: Array<{ id: string; port: number }> = [];
  for (const [i, id] of ids.entries()) {
    if (!WORKSPACE_ID_PATTERN.test(id)) return { error: `invalid workspace ID "${id}" (lower case letters, digits and hyphens)` };
    if (out.some((w) => w.id === id)) return { error: `duplicate workspace ID "${id}"` };
    out.push({ id, port: basePort + i });
  }
  return { workspaces: out };
}

/** `hub init`. */
export function createHubInitHandler(io: Io) {
  return async (opts: HubInitCliOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('hub init: --config-dir is required (e.g. hub init --config-dir ./hub --data-dir ./hub-data --workspace coder --workspace docs)\n');
      return 2;
    }
    const num = (name: string, value: string | undefined, fallback: number): number | undefined => {
      if (value === undefined) return fallback;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        io.stderr(`hub init: invalid --${name} "${value}"\n`);
        return undefined;
      }
      return n;
    };
    const hubPort = num('hub-port', opts.hubPort, 8090);
    const basePort = num('base-port', opts.basePort, 8091);
    const maxConcurrent = num('max-concurrent', opts.maxConcurrent, 5);
    if (hubPort === undefined || basePort === undefined || maxConcurrent === undefined) return 2;
    if (opts.empty && opts.workspace && opts.workspace.length > 0) {
      io.stderr('hub init: --empty and --workspace exclude each other\n');
      return 2;
    }
    const parsed = opts.empty ? { workspaces: [] } : parseWorkspaceSpecs(opts.workspace, basePort);
    if ('error' in parsed) {
      io.stderr(`hub init: ${parsed.error}\n`);
      return 2;
    }
    const configDir = path.resolve(opts.configDir);
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    const workspacesDataDir = opts.workspacesDataDir ? path.resolve(opts.workspacesDataDir) : undefined;
    try {
      await mkdir(configDir, { recursive: true, mode: 0o750 });
      const hubFile = path.join(configDir, HUB_FILE);
      if (await createExclusive(hubFile, hubYamlTemplate({ maxConcurrent, hubPort, workspaces: parsed.workspaces, ...(workspacesDataDir ? { workspacesDataDir } : {}) }), 0o640)) io.stdout(`created  ${hubFile}\n`);
      else io.stdout(`kept     ${hubFile} (exists, not modified; workspaces given on the command line are not added to it)\n`);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      for (const w of parsed.workspaces) {
        const result = await initDirectories({
          configDir: path.join(configDir, 'workspaces', w.id, 'config'),
          dataDir: workspacesDataDir ? path.join(workspacesDataDir, w.id) : path.join(configDir, 'workspaces', w.id, 'data'),
          port: w.port,
        });
        for (const f of result.created) io.stdout(`created  ${f}\n`);
        for (const f of result.kept) io.stdout(`kept     ${f} (exists, not modified)\n`);
      }
    } catch (err) {
      io.stderr(`hub init: ${errorMessage(err)}\n`);
      return 1;
    }
    io.stdout(`hub data dir ${dataDir}\n`);
    const q = (p: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
    const code = await createHubValidateHandler(io)({ configDir, dataDir });
    if (code === 0) {
      io.stdout(
        [
          '',
          'Next steps:',
          `  adispatch hub start --config-dir ${q(configDir)} --data-dir ${q(dataDir)}`,
          `  adispatch hub status --data-dir ${q(dataDir)}`,
          '  as a systemd service (Linux): adispatch service install --hub --dry-run --config-dir … --data-dir …  (docs/operations.md)',
          '',
        ].join('\n'),
      );
    }
    return code;
  };
}

// ---------------------------------------------------------------------------
// hub validate

/** `hub validate`: `hub.yaml` plus the configuration of every workspace (also disabled ones). */
export function createHubValidateHandler(io: Io) {
  return async (opts: GlobalOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('hub validate: --config-dir is required\n');
      return 1;
    }
    const configDir = path.resolve(opts.configDir);
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    const hub = await loadHubConfig(configDir, { dataDir });
    if (hub.warnings.length > 0) io.stderr(`${hub.warnings.length} warning(s) in ${HUB_FILE}:\n${issues(hub.warnings)}`);
    if (!hub.ok) {
      io.stderr(`${HUB_FILE} in ${configDir} is invalid, ${hub.errors.length} error(s):\n${issues(hub.errors)}`);
      return 1;
    }
    let invalid = 0;
    const lines: string[] = [];
    for (const w of hub.config.workspaces) {
      const result = await loadConfig(w.configDir, { dataDir: w.dataDir });
      if (result.warnings.length > 0) io.stderr(`${result.warnings.length} warning(s) in workspace "${w.id}":\n${issues(result.warnings, `[${w.id}] `)}`);
      if (!result.ok) {
        invalid++;
        io.stderr(`Workspace "${w.id}" (${w.configDir}) is invalid, ${result.errors.length} error(s):\n${issues(result.errors, `[${w.id}] `)}`);
        continue;
      }
      const c = result.config;
      lines.push(
        `  ${w.id}${w.enabled ? '' : ' (disabled)'}: port ${w.port}, ${Object.keys(c.workflows).length} workflow(s), ` +
          `${Object.keys(c.sources).length} source(s), scheduler.max_concurrent ${c.global.scheduler.maxConcurrent}`,
      );
    }
    if (invalid > 0) {
      io.stderr(`${invalid} of ${hub.config.workspaces.length} workspace(s) have an invalid configuration\n`);
      return 1;
    }
    const enabled = hub.config.workspaces.filter((w) => w.enabled).length;
    io.stdout(
      `Hub configuration in ${configDir} is valid: ${hub.config.workspaces.length} workspace(s) (${enabled} enabled), hub.max_concurrent ${hub.config.maxConcurrent}\n${lines.map((l) => `${l}\n`).join('')}`,
    );
    return 0;
  };
}

// ---------------------------------------------------------------------------
// hub start

/** Injectable dependencies of `hub start` (tests). */
export interface HubStartDeps {
  /** Extra hub options (tests: fake spawner, short timeouts). */
  hubOptions?: Partial<HubOptions>;
  signals?: SignalTarget;
  exit?: (code: number) => void;
  /** Called once the hub runs (tests). */
  onStarted?: (hub: Hub, config: HubConfig) => void;
}

/** `hub start`. */
export function createHubStartHandler(io: Io, deps: HubStartDeps = {}) {
  return async (opts: StartCliOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('hub start: --config-dir is required\n');
      return 2;
    }
    let flags: ReturnType<typeof parseStartFlags>;
    try {
      flags = parseStartFlags({ ...(opts.drainTimeout !== undefined ? { drainTimeout: opts.drainTimeout } : {}), ...(opts.cancelTimeout !== undefined ? { cancelTimeout: opts.cancelTimeout } : {}) });
    } catch (err) {
      io.stderr(`hub start: ${errorMessage(err)}\n`);
      return 2;
    }
    const configDir = path.resolve(opts.configDir);
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    const loaded = await loadHubConfig(configDir, { dataDir });
    for (const w of loaded.warnings) io.stderr(`warning: ${formatConfigIssue(w)}\n`);
    if (!loaded.ok) {
      io.stderr(`${HUB_FILE} in ${configDir} is invalid:\n${issues(loaded.errors)}`);
      return EXIT_CONFIG;
    }
    const drainTimeoutMs = flags.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const cancelTimeoutMs = flags.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    let hub: Hub;
    try {
      // The HTTP server (hub.server) always runs, unless a test explicitly passes `http: undefined`.
      const http = deps.hubOptions && 'http' in deps.hubOptions ? deps.hubOptions.http : { uiDir: resolveUiDir() };
      hub = createHub({ config: loaded.config, dataDir, version: APP_VERSION, drainTimeoutMs, cancelTimeoutMs, ...(deps.hubOptions ?? {}), ...(http ? { http } : { http: undefined }) });
    } catch (err) {
      if (isOrchestratorError(err, 'instance_locked')) {
        io.stderr(`hub start: ${err.message}\n`);
        return EXIT_CONFIG;
      }
      io.stderr(`hub start: ${errorMessage(err)}\n`);
      return 1;
    }
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const uninstall = installSignalHandlers(hub, {
      ...(deps.signals ? { target: deps.signals } : {}),
      drainTimeoutMs,
      cancelTimeoutMs,
      forceExit: (code) => {
        void hub.forceStop().finally(() => exit(code));
      },
    });
    try {
      await hub.start();
    } catch (err) {
      uninstall();
      io.stderr(`hub start: ${errorMessage(err)}\n`);
      await hub.stopped;
      return 1;
    }
    const enabled = loaded.config.workspaces.filter((w) => w.enabled);
    io.stdout(
      `adispatchd hub running (config ${configDir}, data ${dataDir}): ${enabled.length} workspace(s) started, hub.max_concurrent ${loaded.config.maxConcurrent}\n` +
        (hub.httpUrl ? `web UI and API on ${hub.httpUrl} (workspaces below ${hub.httpUrl}/w/<workspace>/)\n` : '') +
        `control socket ${hub.controlSocketPath}\n` +
        `SIGTERM/Ctrl-C: drain all workspaces (up to ${formatDuration(drainTimeoutMs)}, then cancel); a second signal cancels all runs, a third stops immediately\n`,
    );
    deps.onStarted?.(hub, loaded.config);
    const result = await hub.stopped;
    uninstall();
    if (result.error) io.stderr(`hub stopped with error: ${result.error}\n`);
    else io.stdout('hub stopped\n');
    const t = setTimeout(() => exit(result.exitCode), 5_000);
    t.unref();
    return result.exitCode;
  };
}

// ---------------------------------------------------------------------------
// control commands

/** Injectable dependencies of the control commands (tests). */
export interface HubControlDeps {
  /** Client factory (default: {@link HubControlClient} on the socket). */
  client?: (socketPath: string) => Pick<HubControlClient, 'status' | 'pause' | 'resume' | 'stopAll' | 'drainAll' | 'workspace'>;
  /** Poll interval of `--wait` (default 1 s) and the clock/sleep it uses (tests). */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function socketOf(opts: HubControlCliOptions): string {
  return opts.socket ? path.resolve(opts.socket) : path.join(path.resolve(opts.dataDir ?? 'data'), HUB_CONTROL_SOCKET);
}

/** Text form of {@link HubStatus}. */
export function formatHubStatus(s: HubStatus): string {
  const lines = [
    `adispatchd hub ${s.version} – pid ${s.pid}, started ${s.startedAt}`,
    `state:      ${s.state === 'paused' ? 'PAUSED (no new automatic runs; running runs finish normally)' : s.state}`,
    `slots:      ${s.slots.active}/${s.slots.max} in use`,
  ];
  const rows: string[][] = [['WORKSPACE', 'STATE', 'PID', 'PORT', 'SLOTS', 'RESTARTS', 'NOTE']];
  for (const w of s.workspaces) {
    const note = [w.transition ? `${w.transition}…` : '', w.message ?? '', w.enabled ? '' : 'disabled', w.state === 'running' && !w.connected ? 'no slot connection' : '']
      .filter(Boolean)
      .join('; ');
    rows.push([w.id, w.state, w.pid === null ? '-' : String(w.pid), String(w.port), String(w.slots), `${w.restarts} (${w.crashes} crash${w.crashes === 1 ? '' : 'es'})`, note]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const r of rows) lines.push(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ').trimEnd());
  return `${lines.join('\n')}\n`;
}

async function runControl(
  name: string,
  opts: HubControlCliOptions,
  io: Io,
  deps: HubControlDeps,
  call: (client: NonNullable<ReturnType<NonNullable<HubControlDeps['client']>>>) => Promise<HubStatus>,
  message: (s: HubStatus) => string,
): Promise<number> {
  const socketPath = socketOf(opts);
  const client = deps.client ? deps.client(socketPath) : new HubControlClient(socketPath);
  try {
    const status = await call(client);
    io.stdout(opts.json ? `${JSON.stringify(status, null, 2)}\n` : message(status));
    return 0;
  } catch (err) {
    if (err instanceof HubUnreachableError) {
      io.stderr(`${name}: ${err.message}\n`);
      return EXIT_UNREACHABLE;
    }
    if (err instanceof HubResponseError) {
      io.stderr(`${name}: ${err.message} (HTTP ${err.status}, ${err.code})\n`);
      return 1;
    }
    io.stderr(`${name}: ${errorMessage(err)}\n`);
    return 1;
  }
}

/** `hub status`. */
export function createHubStatusHandler(io: Io, deps: HubControlDeps = {}) {
  return (opts: HubControlCliOptions): Promise<number> => runControl('hub status', opts, io, deps, (c) => c.status(), formatHubStatus);
}

/** True once no workspace has a process any more and none is changing state. */
export function allWorkspacesStopped(s: HubStatus): boolean {
  return s.workspaces.every((w) => w.pid === null && w.transition === null && w.state !== 'starting');
}

/**
 * `--wait` of `hub drain-all` / `hub stop-all`: poll `status` until every workspace has ended (the hub itself keeps
 * running – stop it afterwards with SIGTERM / `systemctl stop`). Exit codes: 0 done, 3 hub gone, 4 timeout.
 */
async function waitForWorkspaces(name: string, opts: HubControlCliOptions, io: Io, deps: HubControlDeps): Promise<number> {
  let deadline: number | undefined;
  const now = deps.now ?? Date.now;
  if (opts.timeout) {
    try {
      deadline = now() + parseDuration(opts.timeout);
    } catch (err) {
      io.stderr(`${name}: invalid --timeout: ${errorMessage(err)}\n`);
      return 2;
    }
  }
  const client = deps.client ? deps.client(socketOf(opts)) : new HubControlClient(socketOf(opts));
  io.stdout('waiting for all workspaces to end...\n');
  for (;;) {
    try {
      const status = await client.status();
      if (allWorkspacesStopped(status)) {
        io.stdout('all workspaces ended\n');
        return 0;
      }
    } catch (err) {
      io.stderr(`${name}: ${errorMessage(err)}\n`);
      return err instanceof HubUnreachableError ? EXIT_UNREACHABLE : 1;
    }
    if (deadline !== undefined && now() >= deadline) {
      io.stderr(`${name}: workspaces still running after ${opts.timeout} (runs are still active; they keep ending in the background)\n`);
      return EXIT_WAIT_TIMEOUT;
    }
    await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(deps.pollIntervalMs ?? 1000);
  }
}

/** `hub pause` / `hub resume` / `hub stop-all` / `hub drain-all`. */
export function createHubGlobalHandler(action: 'pause' | 'resume' | 'stop-all' | 'drain-all', io: Io, deps: HubControlDeps = {}) {
  const texts = {
    pause: 'hub paused: no new automatic runs in any workspace (running runs finish normally; manual starts are not affected)\n',
    resume: 'hub resumed: automatic runs may start again\n',
    'stop-all': 'stop-all: cancelling the runs of all workspaces (on_cancel runs), the workspaces stop\n',
    'drain-all': 'drain-all: no new runs; all workspaces stop when their active runs have finished\n',
  } as const;
  return async (opts: HubControlCliOptions): Promise<number> => {
    const name = `hub ${action}`;
    if ((opts.wait || opts.timeout) && action !== 'drain-all' && action !== 'stop-all') {
      io.stderr(`${name}: --wait/--timeout only apply to drain-all and stop-all\n`);
      return 2;
    }
    if (opts.timeout && !opts.wait) {
      io.stderr(`${name}: --timeout requires --wait\n`);
      return 2;
    }
    const code = await runControl(
      name,
      opts,
      io,
      deps,
      (c) => (action === 'pause' ? c.pause() : action === 'resume' ? c.resume() : action === 'stop-all' ? c.stopAll() : c.drainAll()),
      () => texts[action],
    );
    return code === 0 && opts.wait ? waitForWorkspaces(name, opts, io, deps) : code;
  };
}

/** `hub workspace start|stop|restart|drain <id>`. */
export function createHubWorkspaceHandler(action: 'start' | 'stop' | 'restart' | 'drain', io: Io, deps: HubControlDeps = {}) {
  return (id: string, opts: HubControlCliOptions): Promise<number> =>
    runControl(
      `hub workspace ${action}`,
      opts,
      io,
      deps,
      (c) => c.workspace(id, action),
      (s) => {
        const w = s.workspaces.find((x) => x.id === id);
        return `workspace ${id}: ${w ? `${w.state}${w.transition ? ` (${w.transition}…)` : ''}` : '?'}\n`;
      },
    );
}
