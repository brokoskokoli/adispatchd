/**
 * Component `executors` – public API (WI-05): shell executor, worker
 * protocol helpers, result classification and process start identity.
 * Other components import from this module only.
 */
export { ShellExecutor, type ShellExecutorOptions } from './shell-executor.js';
export {
  ContainerExecutor,
  buildContainerInvocation,
  describeContainerExecute,
  type ContainerExecutorOptions,
  type ContainerInvocation,
} from './container-executor.js';
export {
  ContainerEngineClient,
  ContainerEngineError,
  type ContainerEngineClientOptions,
  type EngineCommandResult,
} from './container-engine.js';
export { classifyOutcome } from './classify.js';
export {
  checkProcessIdentity,
  createDarwinInspector,
  createLinuxInspector,
  defaultProcessInspector,
  getStartIdentity,
  isSameProcess,
  killProcessGroupIfSame,
  parseProcStat,
  parsePsOutput,
  processGroupAlive,
  processGroupExists,
  terminateProcessGroupIfSame,
  type TerminateOptions,
  type TerminateResult,
  type CommandRunner,
  type IdentityCheck,
  type KillFn,
  type KillIfSameResult,
  type ProcessInspector,
  type ProcessProbe,
} from './process-identity.js';
export { buildMinimalEnv, buildOrchEnv, contextSource, type OrchSourceInfo, buildWorkerEnv, FALLBACK_PATH, MINIMAL_ENV_KEYS } from './env.js';
export { EventLineParser, parseEventLine, type EventLineHandlers, type EventLineResult } from './event-parser.js';
export { ensureWorkspaceWithin } from './workspace.js';
export { readFileNoFollow, type SafeReadResult } from './safe-read.js';
export { MIN_STREAM_SECRET_LENGTH, REDACTION_MARKER, StreamRedactor } from './stream-redactor.js';
export {
  TOKEN_DIR_NAME,
  TOKEN_FILE_ENV_SUFFIX,
  TOKEN_RENEW_BEFORE_MS,
  TOKEN_RENEW_MAX_RETRY_MS,
  TOKEN_RENEW_RETRY_MS,
  TokenFileSession,
  isTokenDirInWorkspace,
  removeTokenDirs,
  tokenFileEnvName,
  type TokenFileRequest,
  type TokenFileSessionOptions,
} from './token-files.js';
