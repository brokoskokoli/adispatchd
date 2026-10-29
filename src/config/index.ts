/**
 * Component `config` – public API (WI-02): YAML schemas, loader, semantic
 * validation, ConfigManager with reload/overrides, workflow snapshots and
 * manual-start parameter validation. Other components import from this
 * module only.
 */
export * from './model.js';
export { actionTemplates, linkedFieldUsage, type LinkedFieldUsage } from './linked-usage.js';
export { formatConfigIssue } from './issues.js';
export {
  FILTERS_DIR,
  loadConfig,
  MAX_CONFIG_FILE_BYTES,
  VIEWS_DIR,
  WORKFLOWS_DIR,
  type LoadConfigOptions,
  type LoadConfigResult,
} from './loader.js';
export {
  DEFAULT_HUB_MAX_CONCURRENT,
  DEFAULT_HUB_PORT,
  HUB_FILE,
  loadHubConfig,
  NO_AUTH_CONFIG,
  WORKSPACE_ID_PATTERN,
  type HubConfig,
  type HubWorkspaceConfig,
  type LoadHubConfigOptions,
  type LoadHubConfigResult,
} from './hub.js';
export { CONFIG_FILE, IDENTITIES_FILE, RESERVED_ENV_PREFIX, SOURCES_FILE, cronError, isValidTimeZone } from './validate.js';
export {
  DEFAULT_WORKING_DIRECTORY,
  DEFAULTS,
  MAX_DEFAULT_MONITORING_INTERVAL_MS,
  MAX_MONITORING_SAMPLES,
  MIN_MONITORING_INTERVAL_MS,
  MIN_MONITORING_SAMPLES,
  SECRET_DELIVERIES,
  DASHBOARD_INFO_TYPES,
  DASHBOARD_LAYOUT_LIMITS,
  DASHBOARD_WIDGETS,
  MAX_INFO_TILES,
  MIN_INFO_CACHE_MS,
  MAX_VIEW_SECTIONS,
  MAX_VIEW_SECTION_TITLE_LENGTH,
  MAX_VIEW_SORT_KEYS,
  MAX_VIEW_SORT_ORDER_VALUES,
  MAX_PARAMETER_OPTIONS,
  PARAMETER_OPTIONS_DEFAULTS,
  PARAMETER_OPTIONS_GITHUB_KINDS,
} from './schemas.js';
export { DASHBOARD_FILE, MAX_INFO_TIMEOUT_MS } from './dashboard.js';
export { DEFAULT_DASHBOARD_LAYOUT, tabSlug } from './dashboard-layout.js';
export { MAX_EXPANDED_FILTER_NODES, MAX_FILTER_USE_DEPTH } from './named-filters.js';
export {
  ConfigLoadError,
  ConfigManager,
  diffWorkflows,
  type ConfigChangeEvent,
  type ConfigChangeListener,
  type ConfigDiff,
  type ConfigLoader,
  type ConfigManagerOptions,
  type EffectiveWorkflow,
  type GlobalOverrides,
  type ReloadResult,
  type WorkflowOverrides,
} from './manager.js';
export {
  snapshotWorkflow,
  UnknownWorkflowError,
  WORKFLOW_SNAPSHOT_VERSION,
  workflowIdentityRefs,
  workflowSecrets,
  type WorkflowSecretInfo,
  type WorkflowSnapshot,
} from './snapshot.js';
export {
  automaticParameterValues,
  MAX_OPTION_VALUE_LENGTH,
  optionValueProblem,
  validateParameters,
  validateWorkflowParameters,
  type ParameterIssue,
  type ParameterValidationResult,
} from './parameters.js';
export { redactExternalLinkUrl, toPublicConfig } from './public.js';
export { coversLoopback, isIdentityForgeableLocally, isLoopbackProxyEntry } from './auth.js';
export { activeExternalLinks, externalLinkFrameOrigins, frameOrigin, isTokenLikeParam, type ExternalLinkInfo } from './external-links.js';
