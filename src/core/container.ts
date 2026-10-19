/**
 * Shared constants of the container executor (WI-19): fixed paths inside the
 * container, labels, names and the variables the engine process itself needs.
 * Used by config validation, the executor, recovery and the dry-run.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Supported container engines (CLI compatible: `run`, `stop`, `ps`, `rm`). */
export const CONTAINER_ENGINES = ['docker', 'podman'] as const;
export type ContainerEngine = (typeof CONTAINER_ENGINES)[number];

/** `execute.pull` policies (passed as `--pull <policy>`). */
export const CONTAINER_PULL_POLICIES = ['never', 'missing', 'always'] as const;
export type ContainerPullPolicy = (typeof CONTAINER_PULL_POLICIES)[number];

/** Mount modes of `execute.mounts[]`. */
export const CONTAINER_MOUNT_MODES = ['ro', 'rw'] as const;
export type ContainerMountMode = (typeof CONTAINER_MOUNT_MODES)[number];

/** Fixed paths inside the container (the daemon's own mounts). */
export const CONTAINER_PATHS = {
  /** Reserved root of the daemon mounts; user mounts must not target it or anything below. */
  root: '/adispatch',
  /** Context file, mounted read-only. */
  contextFile: '/adispatch/context.json',
  /** Empty per-run output directory, mounted read-write. */
  outDir: '/adispatch/out',
  /** Result file (`ADISPATCH_RESULT_FILE`) inside the output directory. */
  resultFile: '/adispatch/out/result.json',
  /** Token files (`delivery: file`), mounted read-only. */
  secretsDir: '/adispatch/secrets',
  /** Target of the automatic workspace mount (when no mount uses `{workspace.path}`). */
  workspace: '/work',
} as const;

/** Container labels set on every run container. */
export const CONTAINER_LABELS = {
  run: 'adispatch.run',
  workflow: 'adispatch.workflow',
  /** Hash of the data dir: instances never clean up each other's containers. */
  instance: 'adispatch.instance',
} as const;

/** Prefix of container names: `adispatch-<run-id>`. */
export const CONTAINER_NAME_PREFIX = 'adispatch-';

/** Container name of a run. */
export function containerName(runId: string): string {
  return `${CONTAINER_NAME_PREFIX}${runId}`;
}

/** Run ID encoded in a container name, or `null` if the name is not one of ours. */
export function runIdOfContainer(name: string): string | null {
  const trimmed = name.trim().replace(/^\//, '');
  return trimmed.startsWith(CONTAINER_NAME_PREFIX) && trimmed.length > CONTAINER_NAME_PREFIX.length
    ? trimmed.slice(CONTAINER_NAME_PREFIX.length)
    : null;
}

/** Value of the `adispatch.instance` label: first 16 hex chars of SHA-256 over the absolute data dir. */
export function containerInstanceId(dataDir: string): string {
  return createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
}

/**
 * Variables of the daemon environment the engine CLI process needs (besides
 * the minimal worker variables): engine endpoints, contexts and runtime dirs.
 * They are passed to the engine process only, never into the container.
 */
export const CONTAINER_ENGINE_ENV_KEYS = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
  'CONTAINERS_CONF',
  'CONTAINERS_STORAGE_CONF',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

/**
 * Names that belong to the engine process environment (minimal variables +
 * {@link CONTAINER_ENGINE_ENV_KEYS}). `env` entries with such a name are
 * passed as `-e NAME=value` on the command line instead of via the process
 * environment; `secrets` must not use them (they would end up on the command
 * line or change the engine process).
 */
export const CONTAINER_RESERVED_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'USER',
  'LOGNAME',
  'TMPDIR',
  ...CONTAINER_ENGINE_ENV_KEYS,
];

/** One bind mount of a container run (sources are absolute host paths). */
export interface ContainerMount {
  source: string;
  target: string;
  mode: ContainerMountMode;
}

/** Resource limits (`--memory`, `--cpus`, `--pids-limit`); `null` = engine default. */
export interface ContainerResources {
  memory: string | null;
  cpus: number | null;
  pids: number | null;
}

/**
 * Container part of an {@link ExecutionSpec} (WI-19): fully resolved; the
 * executor only maps it to the engine command line. `ExecutionSpec.command`
 * is the engine, `ExecutionSpec.args` the command run in the container.
 */
export interface ContainerExecution {
  engine: ContainerEngine;
  image: string;
  /** `adispatch-<run-id>` */
  name: string;
  /** `adispatch.*` labels. */
  labels: Readonly<Record<string, string>>;
  /** User mounts incl. the workspace mount (rendered), in configuration order. */
  mounts: readonly ContainerMount[];
  /** Target of the workspace mount (`ADISPATCH_WORKSPACE` inside the container). */
  workspaceTarget: string;
  /** Working directory inside the container (`-w`). */
  workdir: string;
  resources: ContainerResources;
  /** `--user`; `null` = image default. */
  user: string | null;
  /** `default` (no flag), `none` or a network name. */
  network: string;
  pull: ContainerPullPolicy;
}

/** Default `--user`: the daemon's own `<uid>:<gid>` (files in the workspace stay owned by the service user); `null` where unknown. */
export function defaultContainerUser(): string | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : null;
}

/** Container path of a token file (`delivery: file`). */
export function containerTokenFilePath(hostFile: string): string {
  return path.posix.join(CONTAINER_PATHS.secretsDir, path.basename(hostFile));
}
