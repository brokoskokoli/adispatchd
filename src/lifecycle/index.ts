/**
 * Component `lifecycle` – public API (WI-07): lifecycle hook chains with
 * action journal, retries, manual retry/skip and recovery (Spec §10).
 * Other components import from this module only.
 */
export {
  LifecycleEngine,
  LIFECYCLE_ACTION_EVENT,
  LIFECYCLE_CHAIN_EVENT,
  DEFAULT_ACTION_RETRY,
  actionConfig,
  aggregateLifecycleStatus,
  stoppedAt,
  type HookContext,
  type HookResult,
  type LifecycleActionFailedPayload,
  type LifecycleEngineOptions,
} from './engine.js';
export { LifecycleError, LifecycleBusyError, describeActionError, type ActionErrorInfo } from './errors.js';
export {
  parseRunSnapshot,
  resolveActionIdentity,
  hookTemplateScope,
  buildHookTemplateValues,
  buildShellActionContext,
  renderHookText,
  type ShellActionContext,
} from './context.js';
export type { SourceResolver } from './performers.js';
