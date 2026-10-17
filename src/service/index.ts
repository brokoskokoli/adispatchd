/**
 * Component `service` – public API (WI-12): systemd unit generation and
 * install/uninstall plans. Other components import from this module only.
 */
export {
  DEFAULT_SERVICE_USER,
  DEFAULT_STOP_BUFFER_MS,
  DEFAULT_UNIT_DIR,
  DEFAULT_UNIT_NAME,
  EXIT_CONFIG,
  computeTimeoutStopSec,
  formatCliDuration,
  quoteSystemdArg,
  renderSystemdUnit,
  validateUnitOptions,
  type UnitOptions,
} from './unit.js';
export {
  PROTECTED_PATHS,
  ServiceError,
  assertSafeServicePaths,
  environmentFileTemplate,
  executePlan,
  formatPlan,
  planInstall,
  planUninstall,
  systemRunner,
  unitFilePath,
  type ExecResult,
  type InstallPlanInput,
  type ServicePlan,
  type ServiceStep,
  type SystemRunner,
} from './install.js';
