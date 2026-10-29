/**
 * Component `api` – public API (WI-10): Fastify HTTP API under `/api/v1`,
 * `/health`, `/ready`, SSE event hub and log paging (Spec §15, §21).
 * Other components import from this module only.
 */
export { uiContentSecurityPolicy } from './csp.js';
export { UI_ACTION_LIMITS, type UiActionLimits } from './ui-actions.js';
export { createApiServer, CSRF_HEADER, allowedHostList, isAllowedHost, originMatchesHost, type ApiDeps, type ReadinessReport } from './server.js';
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
  HUB_ROLE_HEADER,
  HUB_TOKEN_HEADER,
  HUB_TOKEN_PATTERN,
  HUB_USER_HEADER,
  LOGIN_LIMITS,
  SESSION_COOKIE,
  controlTokenPath,
  isInteractive,
  isLoopbackAddress,
  type AuthRequest,
  type AuthVia,
  type LoginResult,
  type ResolveResult,
  readControlToken,
  removeControlToken,
  writeControlToken,
  type AuthServiceOptions,
  type Principal,
} from './auth.js';
export { hashPassword, parsePasswordHash, verifyPassword, SCRYPT_DEFAULTS } from './password.js';
export { ROUTE_ROLES, roleAllows, routeAccess, type RouteAccess } from './roles.js';
