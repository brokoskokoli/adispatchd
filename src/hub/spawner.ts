/**
 * Child process abstraction of the hub (WI-35): the supervisor never spawns
 * directly, so tests can drive it with fakes and real children alike.
 */
import { spawn } from 'node:child_process';

/** What to start for a workspace. */
export interface SpawnSpec {
  workspaceId: string;
  /** Arguments of the `adispatch` CLI (e.g. `start --config-dir …`). */
  args: string[];
  /** Complete environment of the child. */
  env: Record<string, string | undefined>;
}

/** A started child process. */
export interface ChildHandle {
  readonly pid: number | undefined;
  /** Send a signal; `false` if the process is already gone. */
  kill(signal: NodeJS.Signals): boolean;
  /** Exit notification (also called once if the process could not be started: code `null`, signal `null`). */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** Output chunks (UTF-8 text). */
  onOutput(listener: (stream: 'stdout' | 'stderr', chunk: string) => void): void;
}

export interface WorkspaceSpawner {
  spawn(spec: SpawnSpec): ChildHandle;
}

/** Options of {@link processSpawner}. */
export interface ProcessSpawnerOptions {
  /** Node executable (default: the running one). */
  execPath?: string;
  /** Node options before the entry point (default: those of the running process, e.g. `--import tsx` in development). */
  execArgv?: readonly string[];
  /** CLI entry point (default: the entry point of the running process). */
  entry?: string;
}

/**
 * Spawns `node <entry> <args>` in a **new process group**: signals typed at
 * the hub's terminal (Ctrl-C) then reach only the hub, which forwards exactly
 * one signal per signal it received, so the escalation steps of hub and
 * children stay in line.
 */
export function processSpawner(options: ProcessSpawnerOptions = {}): WorkspaceSpawner {
  return {
    spawn(spec) {
      const entry = options.entry ?? process.argv[1];
      if (!entry) throw new Error('cannot determine the CLI entry point for workspace processes');
      const child = spawn(options.execPath ?? process.execPath, [...(options.execArgv ?? process.execArgv), entry, ...spec.args], {
        env: spec.env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let exited = false;
      const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
      const notify = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        for (const l of exitListeners) l(code, signal);
      };
      // `close` fires after the output pipes ended (all lines delivered); a grandchild holding a pipe must not delay the exit forever.
      child.on('close', notify);
      child.on('exit', (code, signal) => {
        setTimeout(() => notify(code, signal), 1_000).unref();
      });
      child.on('error', () => notify(null, null));
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      return {
        get pid() {
          return child.pid;
        },
        kill: (signal) => {
          if (exited) return false;
          try {
            return child.kill(signal);
          } catch {
            return false;
          }
        },
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        onOutput: (listener) => {
          child.stdout.on('data', (c: string) => listener('stdout', c));
          child.stderr.on('data', (c: string) => listener('stderr', c));
        },
      };
    },
  };
}
