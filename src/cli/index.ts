/**
 * Component `cli` – public API (commands of the `agent-orchestrator` binary).
 */
export { createProgram, EXIT_NOT_IMPLEMENTED } from './program.js';
export type {
  CliHandlers,
  CliIo,
  ControlCliOptions,
  DryRunCliOptions,
  GlobalOptions,
  InitCliOptions,
  ServiceCliOptions,
  ShutdownCliOptions,
  StartCliOptions,
} from './program.js';
export { processIo } from './program.js';
export { createConfigValidateHandler, EXIT_CONFIG_INVALID, EXIT_CONFIG_VALID } from './config-validate.js';
export { createWorkflowDryRunHandler, type WorkflowDryRunDeps } from './workflow-dry-run.js';
export { createStartHandler, parseStartFlags, type StartDeps } from './start.js';
export { createInitHandler, initDirectories, type InitResult } from './init.js';
export { initTemplates, DATA_DIR_LAYOUT, type TemplateFile } from './init-templates.js';
export {
  createConfigReloadHandler,
  createSchedulerHandler,
  createShutdownHandler,
  createStatusHandler,
  formatStatus,
  EXIT_WAIT_TIMEOUT,
  type ControlDeps,
} from './control.js';
export {
  ApiClient,
  ApiResponseError,
  ApiUnreachableError,
  DEFAULT_API_URL,
  EXIT_UNREACHABLE,
  resolveBaseUrl,
  urlForBind,
} from './http-client.js';
export {
  createServiceInstallHandler,
  createServiceStatusHandler,
  createServiceUninstallHandler,
  defaultEntryPath,
  unitOptionsFromCli,
  type ServiceDeps,
} from './service.js';
