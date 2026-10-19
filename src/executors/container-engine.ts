/**
 * Thin client of a container engine CLI (docker/podman, WI-19): the short
 * management commands `stop`, `rm`, `ps` and `--version`, plus the
 * environment the engine process gets. The long-running `run` is spawned by
 * the container executor itself (in the foreground, supervised like a shell worker).
 */
import { execFile } from 'node:child_process';
import {
  CONTAINER_ENGINE_ENV_KEYS,
  CONTAINER_LABELS,
  errorMessage,
  noopLogger,
  type ContainerEngine,
  type Logger,
} from '../core/index.js';
import { buildMinimalEnv } from './env.js';

/** Dependencies and tuning of the {@link ContainerEngineClient}. */
export interface ContainerEngineClientOptions {
  /** Environment the engine process environment is picked from (default `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Binary per engine (default: the engine name, looked up via PATH). Tests: path of a fake engine. */
  binaries?: Partial<Record<ContainerEngine, string>>;
  logger?: Logger;
  /** Timeout of `ps`, `rm` and `--version` (default 30 s); `stop` gets its grace period on top. */
  commandTimeoutMs?: number;
}

/** Result of an engine command. */
export interface EngineCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Thrown when an engine command could not be run or failed unexpectedly. */
export class ContainerEngineError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ContainerEngineError';
  }
}

const NO_SUCH_CONTAINER = /no such container|no container with name or id/i;

/** See module docs. Stateless; one instance can serve every run. */
export class ContainerEngineClient {
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly binaries: Partial<Record<ContainerEngine, string>>;
  private readonly logger: Logger;
  private readonly commandTimeoutMs: number;

  constructor(options: ContainerEngineClientOptions = {}) {
    this.baseEnv = options.baseEnv ?? process.env;
    this.binaries = { ...(options.binaries ?? {}) };
    this.logger = (options.logger ?? noopLogger).child({ component: 'container-engine' });
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  }

  /** Executable of `engine`. */
  binary(engine: ContainerEngine): string {
    return this.binaries[engine] ?? engine;
  }

  /**
   * Environment of an engine process: the minimal variables (`PATH`, `HOME`,
   * …), the engine's own variables (`DOCKER_HOST`, `XDG_RUNTIME_DIR`, … if
   * set) and `extra` (values of `-e NAME` for the container). Nothing else of
   * the daemon environment.
   */
  env(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const env = buildMinimalEnv(this.baseEnv);
    for (const key of CONTAINER_ENGINE_ENV_KEYS) {
      const value = this.baseEnv[key];
      if (typeof value === 'string') env[key] = value;
    }
    return { ...env, ...extra };
  }

  /**
   * Run `<engine> <args>`. Resolves with the exit code (also ≠ 0); rejects
   * with {@link ContainerEngineError} if the binary cannot be started or the
   * command times out.
   */
  run(engine: ContainerEngine, args: readonly string[], timeoutMs = this.commandTimeoutMs): Promise<EngineCommandResult> {
    const binary = this.binary(engine);
    return new Promise((resolve, reject) => {
      execFile(binary, [...args], { env: this.env(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          if (typeof e.code !== 'number') {
            const why = e.killed ? `timed out after ${timeoutMs} ms` : errorMessage(err);
            reject(new ContainerEngineError(`${binary} ${args[0] ?? ''}: ${why}`, typeof e.code === 'string' ? e.code : 'timeout'));
            return;
          }
          resolve({ code: e.code, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  /**
   * `<engine> stop -t <seconds> <name>`: SIGTERM to the container's init,
   * SIGKILL after the grace period. `not_found` if no such container exists.
   *
   * @throws ContainerEngineError if the engine is unavailable or reports another error
   */
  async stop(engine: ContainerEngine, name: string, graceMs: number): Promise<'stopped' | 'not_found'> {
    const seconds = Math.max(0, Math.ceil(graceMs / 1000));
    const result = await this.run(engine, ['stop', '-t', String(seconds), name], graceMs + this.commandTimeoutMs);
    if (result.code === 0) return 'stopped';
    if (NO_SUCH_CONTAINER.test(result.stderr)) return 'not_found';
    throw new ContainerEngineError(`${this.binary(engine)} stop ${name} failed (exit ${result.code}): ${firstLine(result.stderr)}`);
  }

  /** `<engine> rm -f <name>`; a missing container is not an error. @throws ContainerEngineError */
  async remove(engine: ContainerEngine, name: string): Promise<void> {
    const result = await this.run(engine, ['rm', '-f', name]);
    if (result.code === 0 || NO_SUCH_CONTAINER.test(result.stderr)) return;
    throw new ContainerEngineError(`${this.binary(engine)} rm -f ${name} failed (exit ${result.code}): ${firstLine(result.stderr)}`);
  }

  /**
   * Names of all containers (running or not) of a daemon instance, found by
   * the label `adispatch.instance=<instance>`. @throws ContainerEngineError
   */
  async list(engine: ContainerEngine, instance: string): Promise<string[]> {
    return this.listByLabel(engine, `${CONTAINER_LABELS.instance}=${instance}`);
  }

  /** Names of all containers carrying `label` (`key=value`). @throws ContainerEngineError */
  async listByLabel(engine: ContainerEngine, label: string): Promise<string[]> {
    const result = await this.run(engine, ['ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}']);
    if (result.code !== 0) {
      throw new ContainerEngineError(`${this.binary(engine)} ps failed (exit ${result.code}): ${firstLine(result.stderr)}`);
    }
    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  }

  /** `<engine> --version`: the version line, or the reason the engine is unavailable. */
  async check(engine: ContainerEngine): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
      const result = await this.run(engine, ['--version'], 10_000);
      if (result.code === 0) return { ok: true, version: firstLine(result.stdout) };
      return { ok: false, error: `${this.binary(engine)} --version exited with ${result.code}: ${firstLine(result.stderr)}` };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  /** `rm -f`, never throwing (logged). */
  async removeQuietly(engine: ContainerEngine, name: string): Promise<void> {
    try {
      await this.remove(engine, name);
    } catch (err) {
      this.logger.warn('container could not be removed', { engine, container: name, error: errorMessage(err) });
    }
  }

  /**
   * Remove every container of a run (label `adispatch.run=<runId>`) now and
   * once more after `recheckMs` – a container the engine creates late (after
   * the CLI was killed) is caught by the second look. Never throws.
   */
  async sweepRun(engine: ContainerEngine, runId: string, recheckMs: number, wait: (ms: number) => Promise<void>): Promise<void> {
    for (const pass of [0, 1]) {
      if (pass === 1) await wait(recheckMs);
      try {
        for (const name of await this.listByLabel(engine, `${CONTAINER_LABELS.run}=${runId}`)) {
          this.logger.warn('removing left-over container of the run', { engine, container: name, runId });
          await this.removeQuietly(engine, name);
        }
      } catch (err) {
        this.logger.warn('containers of the run could not be listed', { engine, runId, error: errorMessage(err) });
        return;
      }
    }
  }

  /** Stop and remove a container, never throwing (logged). Used after an abnormal end. */
  async stopAndRemove(engine: ContainerEngine, name: string, graceMs: number): Promise<void> {
    try {
      if ((await this.stop(engine, name, graceMs)) === 'not_found') return;
      await this.remove(engine, name);
    } catch (err) {
      this.logger.warn('container could not be stopped/removed', { engine, container: name, error: errorMessage(err) });
    }
  }
}

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').slice(0, 300);
}
