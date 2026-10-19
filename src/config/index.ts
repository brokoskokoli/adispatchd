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
export { CONFIG_FILE, IDENTITIES_FILE, RESERVED_ENV_PREFIX, SOURCES_FILE, cronError, isValidTimeZone } from './validate.js';
export { DEFAULT_WORKING_DIRECTORY, DEFAULTS, SECRET_DELIVERIES, DASHBOARD_INFO_TYPES, MAX_INFO_TILES, MIN_INFO_CACHE_MS } from './schemas.js';
export { DASHBOARD_FILE, MAX_INFO_TIMEOUT_MS } from './dashboard.js';
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
  validateParameters,
  validateWorkflowParameters,
  type ParameterIssue,
  type ParameterValidationResult,
} from './parameters.js';
export { redactExternalLinkUrl, toPublicConfig } from './public.js';
export { activeExternalLinks, externalLinkFrameOrigins, frameOrigin, isTokenLikeParam, type ExternalLinkInfo } from './external-links.js';
