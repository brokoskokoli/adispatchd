/**
 * Errors of the scheduler's manual start / dry-run API. All extend
 * {@link OrchestratorError}; WI-10 maps the stable `code` to HTTP:
 *
 * | code | HTTP |
 * |---|---|
 * | `manual_item_required`, `manual_item_not_supported`, `manual_item_invalid_ref`, `invalid_parameters` | 400 |
 * | `manual_item_not_found` | 404 |
 * | `source_unavailable`, `parameter_options_unavailable` (WI-31) | 502 |
 * | `scheduler_not_accepting` | 503 |
 *
 * Unknown workflows throw `UnknownWorkflowError` (config, `config_unknown_workflow` → 404);
 * an active lock throws `LockConflictError` (persistence, `lock_conflict` → 409).
 */
import { OrchestratorError } from '../core/index.js';

/** Codes of {@link SchedulerError}. */
export type SchedulerErrorCode =
  | 'manual_item_required'
  | 'manual_item_not_supported'
  | 'manual_item_invalid_ref'
  | 'manual_item_not_found'
  | 'invalid_parameters'
  | 'source_unavailable'
  | 'parameter_options_unavailable'
  | 'scheduler_not_accepting';

/** Error of the scheduler API (see module docs for the HTTP mapping). */
export class SchedulerError extends OrchestratorError {
  declare readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(code, message, { ...(details ? { details } : {}), ...(cause !== undefined ? { cause } : {}) });
  }
}
