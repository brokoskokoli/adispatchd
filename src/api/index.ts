/**
 * Component `api` – public API (WI-10): Fastify HTTP API under `/api/v1`,
 * `/health`, `/ready`, SSE event hub and log paging (Spec §15, §21).
 * Other components import from this module only.
 */
export { createApiServer, CSRF_HEADER, isAllowedHost, type ApiDeps, type ReadinessReport } from './server.js';
export { ApiError, ERROR_STATUS, toErrorResponse, type ApiErrorBody } from './errors.js';
export {
  EventHub,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_MAX_BUFFER_BYTES,
  DEFAULT_SSE_MAX_REPLAY,
  type EventHubOptions,
  type StreamEvent,
} from './sse.js';
export { readLogPage, DEFAULT_LOG_PAGE_BYTES, MAX_LOG_PAGE_BYTES, type LogPage } from './logs.js';
export { toRunSummary, runOutcome, type RunOutcome, type RunSummary, type ActionView } from './serialize.js';
