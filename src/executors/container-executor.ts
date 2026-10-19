/**
 * Container executor (WI-19): runs the main worker in a throw-away container
 * via the engine CLI in the foreground (`<engine> run --rm …`). Output,
 * events, timeouts, the result file and the classification work exactly as
 * with the shell executor (the engine process is supervised like a shell
 * worker; its exit code is the container's). Cancel and timeout first stop
 * the container (`<engine> stop -t <grace> <name>`), then the engine process
 * is treated like a shell worker.
 *
 * Secrets never appear on the engine command line: the container gets
 * `-e NAME` and the value is set in the engine process environment.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ContainerExecuteConfig } from '../config/index.js';
import {
  CONTAINER_LABELS,
  CONTAINER_PATHS,
  CONTAINER_RESERVED_ENV_NAMES,
  OrchestratorError,
  containerInstanceId,
  containerName,
  containerTokenFilePath,
  defaultContainerUser,
  type ContainerExecution,
  type ExecutionSpec,
  type Executor,
  type RunningProcess,
} from '../core/index.js';
import { ContainerEngineClient } from './container-engine.js';
import { buildOrchEnv } from './env.js';
import { startSupervised, supervisorDeps, type LaunchStrategy, type ShellExecutorOptions, type SupervisorDeps } from './shell-executor.js';

/** Dependencies and tuning of the {@link ContainerExecutor}. */
export interface ContainerExecutorOptions extends ShellExecutorOptions {
  /** Engine client (binary lookup, engine env, stop/rm); default: a client over `baseEnv`. */
  engines?: ContainerEngineClient;
  /** Max wait for the engine process to end after `<engine> stop` before it is signalled. Default 10 s. */
  stopSettleMs?: number;
}

/** Engine command line of a container run plus the values passed via the engine environment. */
export interface ContainerInvocation {
  /** Engine binary. */
  command: string;
  args: string[];
  /** Values of the `-e NAME` variables (set in the engine process environment, never on the command line). */
  passEnv: Record<string, string>;
}

const UNSAFE_MOUNT_CHARS = /[,"\n\r\0]/;

function mountArg(source: string, target: string, readonly: boolean): string {
  return `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`;
}

/**
 * Build the `<engine> run …` command line for `spec` (pure; also used for
 * the persisted run command and the dry-run). Order of the container
 * environment: `env` < token-file paths < secrets < `ADISPATCH_*`.
 */
export function buildContainerInvocation(spec: ExecutionSpec, engineBinary?: string): ContainerInvocation {
  const c = requireContainer(spec);
  const args = ['run', '--rm', '--init', '--name', c.name];
  for (const [key, value] of Object.entries(c.labels)) args.push('--label', `${key}=${value}`);
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  if (c.user !== null) {
    // Rootless podman: map the daemon user to the same UID inside the container.
    if (c.engine === 'podman') args.push('--userns', 'keep-id');
    args.push('--user', c.user);
  }
  if (c.network !== 'default') args.push('--network', c.network);
  if (c.resources.memory !== null) args.push('--memory', c.resources.memory);
  if (c.resources.cpus !== null) args.push('--cpus', String(c.resources.cpus));
  if (c.resources.pids !== null) args.push('--pids-limit', String(c.resources.pids));
  args.push('--pull', c.pull);

  for (const m of c.mounts) args.push('--mount', mountArg(m.source, m.target, m.mode === 'ro'));
  args.push('--mount', mountArg(spec.files.contextFile, CONTAINER_PATHS.contextFile, true));
  args.push('--mount', mountArg(path.dirname(spec.files.resultFile), CONTAINER_PATHS.outDir, false));
  if (spec.tokenFiles) args.push('--mount', mountArg(spec.tokenFiles.dir, CONTAINER_PATHS.secretsDir, true));
  args.push('--workdir', c.workdir);

  const passEnv: Record<string, string> = {};
  const passByName = (name: string, value: string): void => {
    passEnv[name] = value;
    args.push('-e', name);
  };
  const tokenEnv = spec.tokenFiles?.env ?? {};
  for (const [name, value] of Object.entries(spec.env)) {
    if (name in tokenEnv) continue;
    // Names of the engine's own environment cannot be passed via its environment: on the command line (never secrets).
    if (CONTAINER_RESERVED_ENV_NAMES.includes(name)) args.push('-e', `${name}=${value}`);
    else passByName(name, value);
  }
  for (const [name, hostPath] of Object.entries(tokenEnv)) args.push('-e', `${name}=${containerTokenFilePath(hostPath)}`);
  for (const [name, value] of Object.entries(spec.secrets)) passByName(name, value);
  const orch = buildOrchEnv({
    runId: spec.runId,
    workflowId: spec.workflowId,
    context: spec.context,
    contextFile: CONTAINER_PATHS.contextFile,
    resultFile: CONTAINER_PATHS.resultFile,
    workspace: c.workspaceTarget,
  });
  for (const [name, value] of Object.entries(orch)) args.push('-e', `${name}=${value}`);

  args.push(c.image, ...spec.args);
  return { command: engineBinary ?? c.engine, args, passEnv };
}

function requireContainer(spec: ExecutionSpec): ContainerExecution {
  if (!spec.container) throw new OrchestratorError('invalid_spec', 'container executor needs spec.container');
  return spec.container;
}

/** Runtime checks before the engine is started (paths the engine's `--mount` syntax cannot express, secret names). */
async function checkContainerSpec(spec: ExecutionSpec): Promise<void> {
  const c = requireContainer(spec);
  const hostPaths = [...c.mounts.map((m) => m.source), spec.files.contextFile, path.dirname(spec.files.resultFile)];
  if (spec.tokenFiles) hostPaths.push(spec.tokenFiles.dir);
  for (const p of [...hostPaths, ...c.mounts.map((m) => m.target), c.workdir]) {
    if (!path.isAbsolute(p)) throw new OrchestratorError('invalid_path', `container mount path must be absolute: ${p}`);
    if (UNSAFE_MOUNT_CHARS.test(p)) {
      throw new OrchestratorError('invalid_path', `container mount path must not contain commas, double quotes or line breaks: ${p}`);
    }
  }
  for (const name of Object.keys(spec.secrets)) {
    if (CONTAINER_RESERVED_ENV_NAMES.includes(name) || name.startsWith('ADISPATCH_')) {
      throw new OrchestratorError('invalid_spec', `secret "${name}" cannot be passed to a container`);
    }
  }
  for (const m of c.mounts) {
    // The engine would fail with a less helpful message (or create a directory).
    await stat(m.source).catch((err: unknown) => {
      throw new OrchestratorError('ENOENT', `mount source does not exist: ${m.source}`, { cause: err });
    });
  }
}

/** Executor for `execute.type: container`. */
export class ContainerExecutor implements Executor {
  readonly type = 'container';
  private readonly deps: SupervisorDeps;
  private readonly engines: ContainerEngineClient;
  private readonly stopSettleMs: number;

  constructor(options: ContainerExecutorOptions = {}) {
    this.deps = supervisorDeps(options);
    this.engines = options.engines ?? new ContainerEngineClient({ baseEnv: this.deps.baseEnv, logger: this.deps.logger });
    this.stopSettleMs = options.stopSettleMs ?? 10_000;
  }

  describe(spec: ExecutionSpec): { command: string; args: string[] } {
    const invocation = buildContainerInvocation(spec, this.engines.binary(requireContainer(spec).engine));
    return { command: invocation.command, args: invocation.args };
  }

  start(spec: ExecutionSpec): Promise<RunningProcess> {
    const engines = this.engines;
    const log = this.deps.logger.child({ component: 'container-executor', runId: spec.runId });
    let containerName: string | undefined;
    let engineName: ContainerExecution['engine'] | undefined;
    const strategy: LaunchStrategy = {
      component: 'container-executor',
      stopSettleMs: this.stopSettleMs,
      prepare: () => checkContainerSpec(spec),
      process: () => {
        const c = requireContainer(spec);
        containerName = c.name;
        engineName = c.engine;
        const invocation = buildContainerInvocation(spec, engines.binary(c.engine));
        return { command: invocation.command, args: invocation.args, env: engines.env(invocation.passEnv) };
      },
      stop: async (graceMs) => {
        if (!containerName || !engineName) return;
        try {
          const result = await engines.stop(engineName, containerName, graceMs);
          log.info('container stopped', { container: containerName, result });
        } catch (err) {
          log.warn('container could not be stopped through the engine', { container: containerName, error: err });
        }
      },
      afterExit: async (abnormal) => {
        // `--rm` removes a container that ended normally; after a stop/kill make sure nothing is left.
        if (abnormal && containerName && engineName) await engines.stopAndRemove(engineName, containerName, 0);
      },
    };
    return startSupervised(spec, this.deps, strategy);
  }
}

/** Mount source that is the workspace itself (`{workspace.path}`, optionally with a trailing `/`). */
const WORKSPACE_ITSELF = /^\{\s*workspace\.path\s*\}\/?$/;

/**
 * Engine command line of a container workflow without a run (dry-run, API):
 * templates stay unresolved (`{item.number}`; `{workspace.path}` in mount
 * sources = host workspace), the run ID is `<run-id>`, the data dir is
 * `<data-dir>` unless given. Secrets appear by name only (`-e NAME`).
 */
export function describeContainerExecute(
  execute: ContainerExecuteConfig,
  info: { workflowId: string; dataDir?: string },
): { command: string; args: string[] } {
  const runId = '<run-id>';
  const dataDir = info.dataDir ?? '<data-dir>';
  const runDir = path.join(dataDir, 'runs', runId);
  const workspaceTarget = execute.mounts.find((m) => WORKSPACE_ITSELF.test(m.source))?.target ?? CONTAINER_PATHS.workspace;
  const mounts = execute.mounts.map((m) => ({ source: m.source, target: m.target, mode: m.mode }));
  if (!execute.mounts.some((m) => WORKSPACE_ITSELF.test(m.source))) {
    mounts.unshift({ source: '{workspace.path}', target: CONTAINER_PATHS.workspace, mode: 'rw' });
  }
  const secrets: Record<string, string> = {};
  const tokenEnv: Record<string, string> = {};
  for (const [name, ref] of Object.entries(execute.secrets)) {
    if (ref.delivery === 'file') tokenEnv[`${name}_FILE`] = path.join(runDir, 'secrets', name);
    else secrets[name] = '';
  }
  const spec: ExecutionSpec = {
    runId,
    workflowId: info.workflowId,
    command: execute.engine,
    args: [...execute.command],
    workingDirectory: '{workspace.path}',
    createDirectory: execute.createDirectory,
    env: { ...execute.env, ...tokenEnv },
    secrets,
    context: {},
    files: {
      contextFile: path.join(runDir, 'context.json'),
      resultFile: path.join(runDir, 'out', 'result.json'),
      stdoutLog: '',
      stderrLog: '',
    },
    timeouts: {},
    cancelGraceMs: execute.cancelGraceMs,
    ...(Object.keys(tokenEnv).length > 0 ? { tokenFiles: { dir: path.join(runDir, 'secrets'), env: tokenEnv } } : {}),
    container: {
      engine: execute.engine,
      image: execute.image,
      name: containerName(runId),
      labels: {
        [CONTAINER_LABELS.run]: runId,
        [CONTAINER_LABELS.workflow]: info.workflowId,
        [CONTAINER_LABELS.instance]: info.dataDir !== undefined ? containerInstanceId(info.dataDir) : '<instance>',
      },
      mounts,
      workspaceTarget,
      workdir: execute.workdir ?? workspaceTarget,
      resources: { ...execute.resources },
      user: execute.user ?? defaultContainerUser(),
      network: execute.network,
      pull: execute.pull,
    },
  };
  const { command, args } = buildContainerInvocation(spec);
  return { command, args };
}

