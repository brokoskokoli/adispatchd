/**
 * Worker environment (Spec §9.1, §20.3): workers never inherit the controller
 * environment. They get a minimal set of standard variables, the explicitly
 * declared `env`, resolved secrets and the `ORCH_*` protocol variables.
 */
import { ORCH_ENV, type WorkerContext } from '../core/index.js';

/** Variables copied from the controller environment (if set). */
export const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TZ', 'USER', 'LOGNAME', 'TMPDIR'] as const;

/** PATH used when the controller has none. */
export const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Pick the minimal standard variables from `base` (default `process.env`). */
export function buildMinimalEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }
  env.PATH ??= FALLBACK_PATH;
  return env;
}

/** Source block of a context as used for `ORCH_SOURCE_*` (shape of `WorkerContext.source`). */
export interface OrchSourceInfo {
  id: string;
  type: string;
  item_id: string;
  url: string;
}

/**
 * Extract a `source` block from any context object (main-worker context or a
 * custom shell-action context). Returns `undefined` unless all fields are strings.
 */
export function contextSource(context: WorkerContext | Readonly<Record<string, unknown>>): OrchSourceInfo | undefined {
  const source = (context as { source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return undefined;
  const { id, type, item_id, url } = source as Record<string, unknown>;
  if (typeof id !== 'string' || typeof type !== 'string' || typeof item_id !== 'string' || typeof url !== 'string') {
    return undefined;
  }
  return { id, type, item_id, url };
}

/** `ORCH_*` variables for a worker (Spec §9.1). */
export function buildOrchEnv(input: {
  runId: string;
  workflowId: string;
  context: WorkerContext | Readonly<Record<string, unknown>>;
  contextFile: string;
  resultFile: string;
  workspace: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    [ORCH_ENV.RUN_ID]: input.runId,
    [ORCH_ENV.WORKFLOW_ID]: input.workflowId,
    [ORCH_ENV.CONTEXT_FILE]: input.contextFile,
    [ORCH_ENV.RESULT_FILE]: input.resultFile,
    [ORCH_ENV.WORKSPACE]: input.workspace,
  };
  const source = contextSource(input.context);
  if (source) {
    env[ORCH_ENV.SOURCE_TYPE] = source.type;
    env[ORCH_ENV.SOURCE_ID] = source.id;
    env[ORCH_ENV.SOURCE_ITEM_ID] = source.item_id;
    env[ORCH_ENV.SOURCE_URL] = source.url;
  }
  return env;
}

/**
 * Compose the full worker environment. Precedence (later wins): minimal env
 * < declared `env` < `secrets` < `ORCH_*` (protocol variables cannot be overridden).
 */
export function buildWorkerEnv(parts: {
  base?: NodeJS.ProcessEnv;
  env?: Readonly<Record<string, string>>;
  secrets?: Readonly<Record<string, string>>;
  orch: Readonly<Record<string, string>>;
}): Record<string, string> {
  return {
    ...buildMinimalEnv(parts.base),
    ...parts.env,
    ...parts.secrets,
    ...parts.orch,
  };
}
