/**
 * Command-line interface definition (Spec §4, §14, §19). The command tree is
 * declared here; the behaviour lives in injectable handlers (see `main.ts`).
 */
import { Command } from 'commander';
import { APP_VERSION } from '../app.js';

/** Options available on every command. */
export interface GlobalOptions {
  configDir?: string;
  dataDir?: string;
}

/** Options of commands talking to a running instance over HTTP. */
export interface ControlCliOptions extends GlobalOptions {
  /** Base URL of the running instance (default: `server.host`/`server.port` of the config, else `http://127.0.0.1:8787`). */
  url?: string;
  /** Print the raw JSON response. */
  json?: boolean;
}

/** Options of `workflow dry-run`. */
export interface DryRunCliOptions extends ControlCliOptions {
  /** Evaluate locally even if an instance is running. */
  local?: boolean;
}

/** Options of `drain` / `cancel-all`. */
export interface ShutdownCliOptions extends ControlCliOptions {
  /** Wait until the instance has stopped. */
  wait?: boolean;
  /** Maximum wait time with `--wait` (duration, default unlimited). */
  timeout?: string;
  /** Reason recorded for cancelled runs (`cancel-all`). */
  reason?: string;
}

/** Options of `start`. */
export interface StartCliOptions extends GlobalOptions {
  /** SIGTERM drain timeout before cancel-all (duration, default 10m). */
  drainTimeout?: string;
  /** Time for cancelled runs incl. `on_cancel` before hooks are interrupted (duration, default 2m). */
  cancelTimeout?: string;
  /** Override `server.host`. */
  host?: string;
  /** Override `server.port`. */
  port?: string;
}

/** Options of `init`. */
export interface InitCliOptions extends GlobalOptions {
  /** `server.port` written into a newly created config.yaml. */
  port?: string;
}

/** Options of `hub init`. */
export interface HubInitCliOptions extends GlobalOptions {
  /** Workspace IDs to create (repeatable; default `main`). */
  workspace?: string[];
  /** Port of the first workspace, the next ones get consecutive ports (default 8091). */
  basePort?: string;
  /** `hub.server.port` (default 8090). */
  hubPort?: string;
  /** No example workspace: `workspaces: []` with a commented entry (e.g. to add an existing instance). */
  empty?: boolean;
  /** Directory for the data dirs of the workspaces (`<dir>/<id>`; default: below the hub config dir, which only suits trials). */
  workspacesDataDir?: string;
  /** `hub.max_concurrent` (default 5). */
  maxConcurrent?: string;
}

/** Options of the commands talking to a running hub over its control socket. */
export interface HubControlCliOptions extends GlobalOptions {
  /** Control socket (default `<data-dir>/hub.sock`). */
  socket?: string;
  json?: boolean;
  /** `drain-all`/`stop-all`: wait until every workspace has ended. */
  wait?: boolean;
  /** With `--wait`: give up after this duration (exit code 4). */
  timeout?: string;
}

/** Options of the `service` commands. */
export interface ServiceCliOptions extends GlobalOptions {
  /** Print what would be done (unit file + steps) without changing anything. */
  dryRun?: boolean;
  /** Unit name without `.service` (default `adispatchd`, with `--hub` `adispatchd-hub`). */
  name?: string;
  /** The unit of a hub (`adispatch hub start`) instead of a single instance (WI-37). */
  hub?: boolean;
  /** Dedicated service user (default `adispatchd`). */
  user?: string;
  /** Group (default = user). */
  group?: string;
  /** Create the user if missing. */
  createUser?: boolean;
  /** Absolute node executable (default: the running node). */
  node?: string;
  /** Absolute package entry point (default: this installation's `dist/cli/main.js`). */
  entry?: string;
  /** Environment file for secrets (default `/etc/default/<name>`; `none` disables it). */
  envFile?: string;
  /** Directory for unit files (default `/etc/systemd/system`). */
  unitDir?: string;
  drainTimeout?: string;
  cancelTimeout?: string;
  /** `systemctl enable --now`. */
  now?: boolean;
}

/** Exit code used by commands that are not implemented yet. */
export const EXIT_NOT_IMPLEMENTED = 70;

type Handler<O> = (opts: O) => Promise<number>;

/** Handlers plugged into the command tree; unimplemented commands print a notice. */
export interface CliHandlers {
  init?: Handler<InitCliOptions>;
  start?: Handler<StartCliOptions>;
  configValidate?: Handler<GlobalOptions>;
  configReload?: Handler<ControlCliOptions>;
  workflowDryRun?: (workflowId: string, opts: DryRunCliOptions) => Promise<number>;
  status?: Handler<ControlCliOptions>;
  pause?: Handler<ControlCliOptions>;
  resume?: Handler<ControlCliOptions>;
  drain?: Handler<ShutdownCliOptions>;
  cancelAll?: Handler<ShutdownCliOptions>;
  serviceInstall?: Handler<ServiceCliOptions>;
  serviceStatus?: Handler<ServiceCliOptions>;
  serviceUninstall?: Handler<ServiceCliOptions>;
  authHashPassword?: Handler<GlobalOptions>;
  hubInit?: Handler<HubInitCliOptions>;
  hubValidate?: Handler<GlobalOptions>;
  hubStart?: Handler<StartCliOptions>;
  hubStatus?: Handler<HubControlCliOptions>;
  hubPause?: Handler<HubControlCliOptions>;
  hubResume?: Handler<HubControlCliOptions>;
  hubStopAll?: Handler<HubControlCliOptions>;
  hubDrainAll?: Handler<HubControlCliOptions>;
  hubWorkspace?: Partial<Record<'start' | 'stop' | 'restart' | 'drain', (id: string, opts: HubControlCliOptions) => Promise<number>>>;
}

/** Streams/side effects used by the CLI (injectable for tests). */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

/** CLI I/O bound to the real process streams. */
export const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

const URL_HELP = 'base URL of the running instance (default: server.host/port from --config-dir, else http://127.0.0.1:8787)';

/** Build the `adispatch` command tree. */
export function createProgram(handlers: CliHandlers = {}, io: CliIo = processIo): Command {
  const program = new Command('adispatch')
    .description('Agent Dispatch Daemon (adispatchd) – configuration-driven orchestrator for shell processes and AI agents')
    .version(APP_VERSION)
    .option('--config-dir <path>', 'configuration directory (config.yaml, sources.yaml, workflows/, ...)')
    .option('--data-dir <path>', 'data directory (SQLite database, logs, runs, workspaces)')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError()
    .addHelpText(
      'after',
      [
        '',
        'All commands:',
        '  init                          create config-dir and data-dir with an example configuration',
        '  start                         start the orchestrator (foreground)',
        '  status                        show the status of the running instance',
        '  pause | resume                pause/resume automatic starts of the running instance',
        '  drain                         finish active runs, start nothing new, then stop',
        '  cancel-all                    cancel all runs (on_cancel), then stop',
        '  config validate               validate the configuration offline',
        '  config reload                 reload the configuration of the running instance',
        '  workflow dry-run <workflow>   show candidate selection without starting anything',
        '  auth hash-password            print the scrypt hash of a password (auth.mode: password)',
        '  hub init | validate | start   run several workspaces under one hub with a shared run limit',
        '  hub status | pause | resume | stop-all | drain-all',
        '  hub workspace start|stop|restart|drain <id>',
        '  service install               install the systemd service (Linux)',
        '  service status                show the systemd service status',
        '  service uninstall             remove the systemd service',
        '',
        'Docs: README.md, docs/operations.md, docs/worker-protocol.md, docs/api.md',
        '',
      ].join('\n'),
    );

  const run =
    <O>(name: string, handler: Handler<O> | undefined) =>
    async (...args: unknown[]): Promise<void> => {
      const cmd = args[args.length - 1] as Command;
      if (!handler) {
        io.stderr(`adispatch: "${name}" is not implemented yet\n`);
        io.setExitCode(EXIT_NOT_IMPLEMENTED);
        return;
      }
      io.setExitCode(await handler(cmd.optsWithGlobals<O & object>()));
    };

  program
    .command('init')
    .description('create config-dir and data-dir with a commented example configuration (never overwrites files)')
    .option('--port <port>', 'server.port for a newly created config.yaml (default 8787)')
    .action(run('init', handlers.init));

  program
    .command('start')
    .description('start the orchestrator (scheduler, HTTP API and web UI) in the foreground')
    .option('--drain-timeout <duration>', 'on SIGTERM/SIGINT: wait this long for active runs before cancelling them', '10m')
    .option('--cancel-timeout <duration>', 'time for cancelled runs incl. on_cancel before hooks are interrupted', '2m')
    .option('--host <host>', 'override server.host')
    .option('--port <port>', 'override server.port')
    .action(run('start', handlers.start));

  const control = (name: string, description: string, handler: Handler<ControlCliOptions> | undefined): Command =>
    program
      .command(name)
      .description(description)
      .option('--url <url>', URL_HELP)
      .option('--json', 'print the JSON response')
      .action(run(name, handler));
  control('status', 'show scheduler state, limits, usage and counters of the running instance', handlers.status);
  control('pause', 'pause automatic starts (running runs and manual starts are not affected)', handlers.pause);
  control('resume', 'resume automatic starts', handlers.resume);
  control('drain', 'start nothing new, let active runs finish, then stop the instance (exit 0)', handlers.drain)
    .option('--wait', 'wait until the instance has stopped')
    .option('--timeout <duration>', 'maximum wait time with --wait');
  control('cancel-all', 'cancel all active runs (on_cancel runs), then stop the instance (exit 0)', handlers.cancelAll)
    .option('--reason <text>', 'reason recorded for the cancelled runs')
    .option('--wait', 'wait until the instance has stopped')
    .option('--timeout <duration>', 'maximum wait time with --wait');

  const config = program.command('config').description('configuration commands');
  config
    .command('validate')
    .description('validate the configuration offline (syntax, schema, references, placeholders)')
    .action(run('config validate', handlers.configValidate));
  config
    .command('reload')
    .description('ask the running instance to reload its configuration (atomic; invalid YAML keeps the active config)')
    .option('--url <url>', URL_HELP)
    .option('--json', 'print the JSON response')
    .action(run('config reload', handlers.configReload));

  const workflow = program.command('workflow').description('workflow commands');
  workflow
    .command('dry-run')
    .description('show candidate selection for a workflow without starting anything (running instance, else local)')
    .argument('<workflow-id>', 'workflow ID')
    .option('--json', 'print the structured result as JSON')
    .option('--url <url>', URL_HELP)
    .option('--local', 'always evaluate locally (needs --config-dir), even if an instance is running')
    .action(async (workflowId: string, _opts: unknown, cmd: Command) => {
      if (!handlers.workflowDryRun) {
        io.stderr('adispatch: "workflow dry-run" is not implemented yet\n');
        io.setExitCode(EXIT_NOT_IMPLEMENTED);
        return;
      }
      io.setExitCode(await handlers.workflowDryRun(workflowId, cmd.optsWithGlobals<DryRunCliOptions>()));
    });

  const auth = program.command('auth').description('authentication helpers (auth in config.yaml)');
  auth
    .command('hash-password')
    .description('read a password (terminal without echo, or the first line of stdin) and print its scrypt hash')
    .action(run('auth hash-password', handlers.authHashPassword));

  const hub = program.command('hub').description('hub: several workspaces (instances) as child processes under one shared run limit');
  hub
    .command('init')
    .description('create hub.yaml and the directories of its workspaces (never overwrites files)')
    .option('--workspace <id>', 'workspace ID to create (repeatable, default "main")', (value: string, previous: string[] = []) => [...previous, value])
    .option('--empty', 'create no example workspace (workspaces: [] with a commented entry; to add existing instances)')
    .option('--base-port <port>', 'loopback port of the first workspace (default 8091)')
    .option('--hub-port <port>', 'hub.server.port (default 8090)')
    .option('--workspaces-data-dir <dir>', 'directory for the data dirs of the workspaces, <dir>/<id> (default: below the hub config dir; use /var/lib/... for a service)')
    .option('--max-concurrent <n>', 'hub.max_concurrent (default 5)')
    .action(run('hub init', handlers.hubInit));
  hub
    .command('validate')
    .description('validate hub.yaml and the configuration of every workspace (--config-dir = hub config dir)')
    .action(run('hub validate', handlers.hubValidate));
  hub
    .command('start')
    .description('start the hub and all enabled workspaces in the foreground (--config-dir = hub config dir, --data-dir = hub data dir)')
    .option('--drain-timeout <duration>', 'on SIGTERM/SIGINT: workspaces wait this long for active runs before cancelling them', '10m')
    .option('--cancel-timeout <duration>', 'time for cancelled runs incl. on_cancel before hooks are interrupted', '2m')
    .action(run('hub start', handlers.hubStart));
  const hubControl = (name: string, description: string, handler: Handler<HubControlCliOptions> | undefined, parent: Command = hub): Command =>
    parent
      .command(name)
      .description(description)
      .option('--socket <path>', 'control socket of the hub (default <data-dir>/hub.sock)')
      .option('--json', 'print the JSON response')
      .action(run(`hub ${name}`, handler));
  hubControl('status', 'show workspaces (state, restarts, slots) and the shared limit of the running hub', handlers.hubStatus);
  hubControl('pause', 'no new automatic runs in any workspace; running runs end normally', handlers.hubPause);
  hubControl('resume', 'allow automatic runs again', handlers.hubResume);
  hubControl('stop-all', 'cancel the runs of all workspaces (on_cancel) and stop them; the hub keeps running', handlers.hubStopAll)
    .option('--wait', 'wait until every workspace has ended')
    .option('--timeout <duration>', 'with --wait: give up after this long (exit code 4)');
  hubControl('drain-all', 'let all workspaces finish their active runs, start nothing new, then stop them', handlers.hubDrainAll)
    .option('--wait', 'wait until every workspace has ended')
    .option('--timeout <duration>', 'with --wait: give up after this long (exit code 4)');
  const hubWorkspace = hub.command('workspace').description('control one workspace of the running hub');
  for (const [action, description] of [
    ['start', 'start a stopped, failed or disabled workspace'],
    ['stop', 'cancel its runs (on_cancel) and stop it; it stays stopped'],
    ['restart', 'drain (bounded by the drain timeout, then cancel) and start it again'],
    ['drain', 'finish its active runs, start nothing new, then stop it; it stays stopped'],
  ] as const) {
    hubWorkspace
      .command(action)
      .description(description)
      .argument('<workspace-id>', 'workspace ID from hub.yaml')
      .option('--socket <path>', 'control socket of the hub (default <data-dir>/hub.sock)')
      .option('--json', 'print the JSON response')
      .action(async (id: string, _opts: unknown, cmd: Command) => {
        const handler = handlers.hubWorkspace?.[action];
        if (!handler) {
          io.stderr(`adispatch: "hub workspace ${action}" is not implemented yet\n`);
          io.setExitCode(EXIT_NOT_IMPLEMENTED);
          return;
        }
        io.setExitCode(await handler(id, cmd.optsWithGlobals<HubControlCliOptions>()));
      });
  }

  const service = program.command('service').description('systemd service management (Linux)');
  const serviceCommand = (name: string, description: string, handler: Handler<ServiceCliOptions> | undefined): Command =>
    service
      .command(name)
      .description(description)
      .option('--name <unit>', 'unit name without .service (default adispatchd, with --hub adispatchd-hub)')
      .option('--hub', 'the unit of a hub (adispatch hub start; --config-dir = hub config dir, --data-dir = hub data dir)')
      .option('--unit-dir <path>', 'directory of unit files', '/etc/systemd/system')
      .action(run(`service ${name}`, handler));
  serviceCommand('install', 'install and enable the systemd service (needs root)', handlers.serviceInstall)
    .option('--dry-run', 'only print the unit file and the planned steps')
    .option('--user <name>', 'dedicated service user', 'adispatchd')
    .option('--group <name>', 'service group (default: same as --user)')
    .option('--create-user', 'create the service user if it does not exist')
    .option('--node <path>', 'absolute node executable (default: the running node)')
    .option('--entry <path>', 'absolute package entry point (default: this installation)')
    .option('--env-file <path>', 'environment file for secrets ("none" to disable; default /etc/default/<name>)')
    .option('--drain-timeout <duration>', 'drain timeout on systemctl stop', '10m')
    .option('--cancel-timeout <duration>', 'cancel timeout after the drain timeout', '2m')
    .option('--now', 'start the service immediately');
  serviceCommand('status', 'show the systemd service status', handlers.serviceStatus);
  serviceCommand('uninstall', 'stop, disable and remove the systemd unit (config and data are kept)', handlers.serviceUninstall).option(
    '--dry-run',
    'only print the planned steps',
  );

  return program;
}
