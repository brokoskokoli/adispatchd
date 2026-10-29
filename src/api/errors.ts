/**
 * Consistent API error form `{ error: { code, message, details? } }` and the
 * mapping of component error codes to HTTP status codes.
 */
import { errorMessage, isOrchestratorError, redactValue, type Redactor } from '../core/index.js';

/** Error raised by route handlers with an explicit HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** JSON body of an error response. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** HTTP status per component error code (WI-03/07/08/09 contracts). */
export const ERROR_STATUS: Readonly<Record<string, number>> = {
  validation_error: 400,
  invalid_request: 400,
  manual_item_required: 400,
  manual_item_not_supported: 400,
  manual_item_invalid_ref: 400,
  invalid_parameters: 400,
  lifecycle_not_skippable: 400,
  not_found: 404,
  config_unknown_workflow: 404,
  manual_item_not_found: 404,
  view_not_found: 404,
  lock_conflict: 409,
  blocked: 409,
  block_exists: 409,
  invalid_transition: 409,
  run_not_reserved: 409,
  run_already_started: 409,
  run_not_active: 409,
  run_not_cancellable: 409,
  run_not_controlled: 409,
  run_not_recovery_pending: 409,
  lifecycle_busy: 409,
  lifecycle_not_retryable: 409,
  block_run_active: 409,
  unblock_run_active: 409,
  artifact_invalid_path: 400,
  artifact_not_found: 404,
  artifact_file_not_found: 404,
  artifact_in_use: 409,
  artifact_too_large: 413,
  workflow_not_applicable: 400,
  config_invalid: 422,
  source_unavailable: 502,
  parameter_options_unavailable: 502,
  run_controller_not_ready: 503,
  run_controller_not_accepting: 503,
  scheduler_not_accepting: 503,
  not_ready: 503,
  kill_failed: 500,
};

/** Status + body for any thrown value. Unknown errors become 500 without internals. */
export function toErrorResponse(err: unknown, redact: Redactor = (s) => s): { status: number; body: ApiErrorBody } {
  if (err instanceof ApiError) {
    return {
      status: err.statusCode,
      body: { error: compact(err.code, redact(err.message), err.details === undefined ? undefined : redactValue(err.details, redact)) },
    };
  }
  if (isOrchestratorError(err)) {
    const status = ERROR_STATUS[err.code] ?? 500;
    return {
      status,
      body: { error: compact(err.code, redact(err.message), err.details === undefined ? undefined : redactValue(err.details, redact)) },
    };
  }
  // Fastify errors (body too large, bad JSON, unsupported media type, ...).
  const fe = err as { statusCode?: unknown; code?: unknown; validation?: unknown };
  if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    return {
      status: fe.statusCode,
      body: { error: compact(typeof fe.code === 'string' ? fe.code.toLowerCase() : 'invalid_request', redact(errorMessage(err))) },
    };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } };
}

function compact(code: string, message: string, details?: unknown): ApiErrorBody['error'] {
  return details === undefined ? { code, message } : { code, message, details };
}
