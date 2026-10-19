/**
 * Component `dashboard` – public API (WI-24): info tiles from `dashboard.yaml`,
 * executed in the background, values in memory. Other components import from
 * this module only.
 */
export {
  DashboardInfoService,
  DEFAULT_INFO_MANUAL_MIN_INTERVAL_MS,
  DEFAULT_INFO_MANUAL_PER_MINUTE,
  DEFAULT_INFO_MAX_PARALLEL,
  INFO_ENV,
  INFO_ERROR_RETRY_MAX_MS,
  INFO_MAX_OUTPUT_BYTES,
  type DashboardInfoServiceOptions,
  type InfoExecutor,
  type InfoScriptContext,
  type InfoTileStatus,
  type InfoTileView,
  type RefreshResult,
} from './service.js';
export { firstNonEmptyLine, infoValueStatus, MAX_INFO_TEXT_LENGTH, parseInfoOutput, type InfoValueStatus, type ParsedInfo } from './parse.js';
