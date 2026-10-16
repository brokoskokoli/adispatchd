/**
 * Component `executors` – public API (WI-05): shell executor, worker
 * protocol helpers, result classification and process start identity.
 * Other components import from this module only.
 */
export { ShellExecutor, type ShellExecutorOptions } from './shell-executor.js';
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
export { MIN_STREAM_SECRET_LENGTH, REDACTION_MARKER, StreamRedactor } from './stream-redactor.js';
