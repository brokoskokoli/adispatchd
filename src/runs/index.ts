/**
 * Component `runs` – public API (WI-08): run controller (start, cancel,
 * finalization, retry blocks, workspace cleanup), crash recovery,
 * pause/drain/cancel-all shutdown and the in-process event bus.
 * Other components import from this module only.
 */
export {
  RunController,
  RUN_EVENTS,
  type RecoveryReport,
  type RunControllerOptions,
  type RunHandle,
  type ShutdownMode,
  type ShutdownOptions,
  type ShutdownResult,
  type StartRunOptions,
} from './controller.js';
export {
  RunEventBus,
  PersistedEventPublisher,
  type BusEvent,
  type BusEventType,
  type BusListener,
  type ControllerStatus,
} from './event-bus.js';
export { RunControllerError } from './errors.js';
export { buildExecutionSpec, executionTemplateValues, type ExecutionInput, type PreparedExecution } from './execution.js';
export { removeWorkspace, shouldCleanupWorkspace, type WorkspaceRemoval } from './workspace.js';
export { RetentionService, type RetentionReport, type RetentionServiceOptions } from './retention.js';
