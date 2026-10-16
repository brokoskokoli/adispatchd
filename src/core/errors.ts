/**
 * Shared error classes. Components throw these (or subclasses) so that callers
 * can react on a stable `code` instead of parsing messages. Messages must
 * never contain secrets (Spec §20.4).
 */

/** Base class for all expected orchestrator errors. */
export class OrchestratorError extends Error {
  /** Stable machine-readable code, e.g. `template_unknown_placeholder`. */
  readonly code: string;
  /** Optional JSON-serialisable diagnostic details (no secrets). */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: { cause?: unknown; details?: Record<string, unknown> } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
  }
}

/** Invalid input to a pure helper (duration, size, id, ...). */
export class ValidationError extends OrchestratorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, details ? { details } : {});
  }
}

/** A path would escape its permitted base directory or is otherwise unsafe. */
export class PathTraversalError extends OrchestratorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('path_traversal', message, details ? { details } : {});
  }
}

/**
 * Classification of failures talking to an external source.
 * - `auth`: credentials invalid/expired
 * - `forbidden`: authenticated but not permitted (fail-closed, Spec §20.7)
 * - `not_found`: item/resource does not exist (or is invisible)
 * - `rate_limited`: retry after `retryAfterMs`
 * - `transient`: network/5xx; retrying may help
 * - `invalid`: request rejected as invalid (4xx other than above)
 */
export type SourceErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'transient' | 'invalid';

/** Error raised by {@link SourceAdapter} / {@link CredentialProvider} implementations. */
export class SourceError extends OrchestratorError {
  readonly kind: SourceErrorKind;
  /** Whether repeating the same call may succeed. */
  readonly retryable: boolean;
  /**
   * True when a mutating call may have taken effect although it failed
   * (e.g. timeout after the request was sent). Lifecycle retries must then
   * reconcile (e.g. `findCommentByMarker`) instead of blindly repeating (Spec §10).
   */
  readonly outcomeUnknown: boolean;
  /** Suggested wait before retrying, if known. */
  readonly retryAfterMs: number | undefined;
  /** HTTP status, if the error originated from an HTTP response. */
  readonly status: number | undefined;

  constructor(
    kind: SourceErrorKind,
    message: string,
    options: {
      cause?: unknown;
      details?: Record<string, unknown>;
      retryable?: boolean;
      outcomeUnknown?: boolean;
      retryAfterMs?: number;
      status?: number;
    } = {},
  ) {
    super(`source_${kind}`, message, options);
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'transient' || kind === 'rate_limited');
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}

/** Narrowing helper for {@link OrchestratorError} with an optional code check. */
export function isOrchestratorError(err: unknown, code?: string): err is OrchestratorError {
  return err instanceof OrchestratorError && (code === undefined || err.code === code);
}

/** Render any thrown value as a short message string (for persisting `error_json`). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
