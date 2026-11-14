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
  hookActions,
  type JournalActionConfig,
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
  itemFromRun,
  buildHookTemplateValues,
  buildShellActionContext,
  renderHookText,
  type HookBlockInfo,
  type HookReplyInfo,
  type ShellActionContext,
} from './context.js';
export type { SourceResolver, ReplyCheckActionConfig } from './performers.js';
export { REPLY_CHECK_REASON_MAX } from './performers.js';
export { failureEffect, mergeEffects, neutralizeHtmlComments, updateEffect } from './performers.js';
