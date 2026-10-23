/**
 * Component `parameter-options` – public API (WI-31): options of enum
 * parameters fetched at run time (`options_from`: GitHub branches/tags or a
 * script), cached in memory, and the check of manual-start values against
 * them. Other components import from this module only.
 */
export {
  DEFAULT_OPTIONS_MIN_INTERVAL_MS,
  hasDynamicOptions,
  OPTIONS_ENV,
  OPTIONS_MAX_OUTPUT_BYTES,
  OPTIONS_TMP_DIR,
  ParameterOptionsService,
  type OptionsExecutor,
  type OptionsScriptContext,
  type ParameterOptionsCheck,
  type ParameterOptionsError,
  type ParameterOptionsErrorCode,
  type ParameterOptionsResult,
  type ParameterOptionsServiceOptions,
} from './service.js';
export { MAX_OPTION_LABEL_LENGTH, parseOptionsOutput, type ParameterOption, type ParsedOptions } from './parse.js';
