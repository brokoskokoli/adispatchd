/**
 * Component `filters` – public API (WI-04, Spec §6, §7).
 * Other components import from this module only.
 */
export { applyOperator, type PredicateOutcome } from './predicate.js';
export {
  collectFields,
  evaluateFilter,
  notEvaluatedTrace,
  ROOT_PATH,
  type FieldSource,
  type FilterEvaluation,
  type FilterTrace,
  type TraceValue,
} from './evaluate.js';
export { createItemFieldSource, type ItemFieldSourceOptions, type ResolveFieldsFn } from './fields.js';
export { canPushDown, splitForPushdown, type PushdownSplit } from './pushdown.js';
export {
  compareCandidates,
  naturalCompare,
  resolveItemPriority,
  sortCandidates,
  type ItemPriorityConfig,
  type ItemPriorityResult,
  type ItemPriorityRule,
  type PrioritizedCandidate,
} from './priority.js';
export {
  buildCheckContext,
  CHECK_CONTEXT_ENV,
  DEFAULT_CHECK_KILL_GRACE_MS,
  DEFAULT_MAX_CHECK_OUTPUT_BYTES,
  MINIMAL_ENV_KEYS,
  ShellCheckRunner,
  type ShellCheckContext,
  type ShellCheckKind,
  type ShellCheckResult,
  type ShellCheckRunnerOptions,
  type ShellCheckSpec,
} from './shell-check.js';
