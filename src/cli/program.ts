/**
 * Command-line interface definition (Spec §4). Commands are stubs in WI-01
 * and get wired up by later work items (WI-02, WI-09, WI-10, WI-12).
 */
import { Command } from 'commander';

/** Options available on every command. */
export interface GlobalOptions {
  configDir?: string;
  dataDir?: string;
}

/** Exit code used by commands that are not implemented yet. */
export const EXIT_NOT_IMPLEMENTED = 70;

/** Handlers that later work items plug in; unimplemented commands print a notice. */
export interface CliHandlers {
  init?: (opts: GlobalOptions) => Promise<number>;
  start?: (opts: GlobalOptions) => Promise<number>;
  configValidate?: (opts: GlobalOptions) => Promise<number>;
  configReload?: (opts: GlobalOptions) => Promise<number>;
  workflowDryRun?: (workflowId: string, opts: GlobalOptions) => Promise<number>;
  serviceInstall?: (opts: GlobalOptions) => Promise<number>;
  serviceStatus?: (opts: GlobalOptions) => Promise<number>;
  serviceUninstall?: (opts: GlobalOptions) => Promise<number>;
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

/** Build the `agent-orchestrator` command tree. */
export function createProgram(handlers: CliHandlers = {}, io: CliIo = processIo): Command {
  const program = new Command('agent-orchestrator')
    .description('Configuration-driven orchestrator for shell processes and AI agents')
    .version('0.1.0')
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
        '  start                         start the orchestrator',
        '  config validate               validate the configuration offline',
        '  config reload                 reload the configuration of the running instance',
        '  workflow dry-run <workflow>   show candidate selection without starting anything',
        '  service install               install the systemd service',
        '  service status                show the systemd service status',
        '  service uninstall             remove the systemd service',
        '',
      ].join('\n'),
    );

  const run =
    (name: string, handler: ((opts: GlobalOptions) => Promise<number>) | undefined) =>
    async (_opts: unknown, cmd: Command): Promise<void> => {
      if (!handler) {
        io.stderr(`agent-orchestrator: "${name}" is not implemented yet\n`);
        io.setExitCode(EXIT_NOT_IMPLEMENTED);
        return;
      }
      io.setExitCode(await handler(cmd.optsWithGlobals<GlobalOptions>()));
    };

  program
    .command('init')
    .description('create config-dir and data-dir with an example configuration')
    .action(run('init', handlers.init));

  program
    .command('start')
    .description('start the orchestrator (scheduler, HTTP API and web UI)')
    .action(run('start', handlers.start));

  const config = program.command('config').description('configuration commands');
  config
    .command('validate')
    .description('validate the configuration offline')
    .action(run('config validate', handlers.configValidate));
  config
    .command('reload')
    .description('ask the running instance to reload its configuration')
    .action(run('config reload', handlers.configReload));

  const workflow = program.command('workflow').description('workflow commands');
  workflow
    .command('dry-run')
    .description('show candidate selection for a workflow without starting anything')
    .argument('<workflow-id>', 'workflow ID')
    .action(async (workflowId: string, _opts: unknown, cmd: Command) => {
      if (!handlers.workflowDryRun) {
        io.stderr('agent-orchestrator: "workflow dry-run" is not implemented yet\n');
        io.setExitCode(EXIT_NOT_IMPLEMENTED);
        return;
      }
      io.setExitCode(await handlers.workflowDryRun(workflowId, cmd.optsWithGlobals<GlobalOptions>()));
    });

  const service = program.command('service').description('systemd service management (Linux)');
  service
    .command('install')
    .description('install the systemd service')
    .action(run('service install', handlers.serviceInstall));
  service
    .command('status')
    .description('show the systemd service status')
    .action(run('service status', handlers.serviceStatus));
  service
    .command('uninstall')
    .description('remove the systemd service')
    .action(run('service uninstall', handlers.serviceUninstall));

  return program;
}
