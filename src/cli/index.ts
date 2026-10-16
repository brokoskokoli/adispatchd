/**
 * Component `cli` – public API. Commands are completed in WI-12.
 */
export { createProgram, EXIT_NOT_IMPLEMENTED } from './program.js';
export type { CliHandlers, CliIo, DryRunCliOptions, GlobalOptions } from './program.js';
export { processIo } from './program.js';
export { createConfigValidateHandler, EXIT_CONFIG_INVALID, EXIT_CONFIG_VALID } from './config-validate.js';
export { createWorkflowDryRunHandler, type WorkflowDryRunDeps } from './workflow-dry-run.js';
