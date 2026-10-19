/**
 * Component `api` – public API (WI-10): Fastify HTTP API under `/api/v1`,
 * `/health`, `/ready`, SSE event hub and log paging (Spec §15, §21).
 * Other components import from this module only.
 */
export { UI_ACTION_LIMITS, type UiActionLimits } from './ui-actions.js';
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
export {
  AuthService,
  CONTROL_TOKEN_FILE,
  CONTROL_TOKEN_HEADER,
  LOGIN_LIMITS,
  SESSION_COOKIE,
  controlTokenPath,
  isLoopbackAddress,
  readControlToken,
  removeControlToken,
  writeControlToken,
  type AuthServiceOptions,
  type Principal,
} from './auth.js';
export { hashPassword, parsePasswordHash, verifyPassword, SCRYPT_DEFAULTS } from './password.js';
export { ROUTE_ROLES, roleAllows, routeAccess, type RouteAccess } from './roles.js';
