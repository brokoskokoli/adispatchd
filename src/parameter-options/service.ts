/**
 * Options of enum parameters fetched at run time (WI-31, `options_from`):
 * branches/tags of a GitHub source or the output of a trusted script.
 *
 * - GitHub: `SourceAdapter.listRefs` with the source identity; errors
 *   (permissions, rate limit, network) become an error in the result.
 * - Command: executed like the dashboard info tiles (WI-24) – argument list
 *   without a shell, minimal environment plus declared `secrets` (WI-18,
 *   `env` or token file), working directory = config dir, own process group,
 *   killed on timeout, bounded output. Exit ≠ 0, timeout or invalid output →
 *   error with a short, redacted message (first stderr line).
 * - Results are cached per workflow+parameter for `cache` (only successes);
 *   concurrent requests share one fetch; a parameter is fetched at most once
 *   per {@link DEFAULT_OPTIONS_MIN_INTERVAL_MS} (also with `refresh` and
 *   `cache: 0s`) – faster requests get the last result (`cached: true`).
 * - {@link ParameterOptionsService.check} validates the values of a manual
 *   start against the current options (parameters without `allow_custom`).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  buildTemplateValues,
  displayText,
  errorMessage,
  noopLogger,
  renderTemplate,
  SourceError,
  systemClock,
  type Clock,
  type CredentialProvider,
  type Logger,
  type Redactor,
  type SourceAdapter,
  type Timers,
} from '../core/index.js';
import type { CommandParameterOptions, EnumParameter, GitHubParameterOptions, ParameterValue, WorkflowConfig } from '../config/index.js';
import { TOKEN_DIR_NAME, TokenFileSession, type TokenFileRequest } from '../executors/index.js';
import { firstNonEmptyLine } from '../dashboard/index.js';
import { ShellCheckRunner, type ShellCheckResult, type ShellCheckSpec } from '../filters/index.js';
import { parseOptionsOutput, type ParameterOption } from './parse.js';

/** Default min. distance between two fetches of the same parameter. */
export const DEFAULT_OPTIONS_MIN_INTERVAL_MS = 2_000;
/** Output limit per stream of an options script (500 options with labels fit). */
export const OPTIONS_MAX_OUTPUT_BYTES = 256 * 1024;
/** Longest rate-limit wait of a GitHub fetch (interactive). */
const GITHUB_MAX_RETRY_WAIT_MS = 5_000;
/** Max. length of an error message. */
const MAX_ERROR_LENGTH = 300;
/** Directory below the data dir for token files of options scripts. */
export const OPTIONS_TMP_DIR = 'parameter-options';

/** Environment variables set for every options script (besides `ADISPATCH_CHECK_CONTEXT_FILE`). */
export const OPTIONS_ENV = {
  workflowId: 'ADISPATCH_WORKFLOW_ID',
  parameter: 'ADISPATCH_PARAMETER',
  configDir: 'ADISPATCH_CONFIG_DIR',
  dataDir: 'ADISPATCH_DATA_DIR',
} as const;

/** Stable error codes of an options result. */
export type ParameterOptionsErrorCode = 'source_unavailable' | 'source_error' | 'rate_limited' | 'timeout' | 'command_failed' | 'invalid_output';

/** Error of an options fetch (message short and redacted). */
export interface ParameterOptionsError {
  code: ParameterOptionsErrorCode;
  message: string;
}

/** Options of one parameter as returned by the API. */
export interface ParameterOptionsResult {
  options: ParameterOption[];
  /** Time of the fetch the result comes from (`null` for static `values`). */
  fetchedAt: string | null;
  /** True if served from the cache (or the last result within the minimum interval). */
  cached: boolean;
  allowCustom: boolean;
  error?: ParameterOptionsError;
}

/** Context file content of an options script (`ADISPATCH_CHECK_CONTEXT_FILE`). Contains no secrets. */
export interface OptionsScriptContext {
  schema_version: 1;
  kind: 'parameter_options';
  workflow: { id: string };
  parameter: { name: string };
  config_dir: string;
  data_dir: string;
}

/** Executes one options script (default: a {@link ShellCheckRunner}). Must not throw. */
export type OptionsExecutor = (spec: ShellCheckSpec, context: OptionsScriptContext, signal: AbortSignal) => Promise<ShellCheckResult>;

/** Dependencies of {@link ParameterOptionsService}. */
export interface ParameterOptionsServiceOptions {
  /** Source adapters by ID. */
  sources: (sourceId: string) => SourceAdapter | undefined;
  /** Tokens for `secrets` of options scripts. */
  credentials?: CredentialProvider;
  configDir: () => string;
  /** `{workspace.base_dir}` in `args`. */
  workspaceBaseDir?: () => string;
  dataDir: string;
  executor?: OptionsExecutor;
  clock?: Clock;
  /** Timers of token-file renewals (FakeClock in tests). */
  timers?: Timers;
  logger?: Logger;
  redact?: Redactor;
  hostEnv?: Readonly<Record<string, string | undefined>>;
  minIntervalMs?: number;
}

/** Result of {@link ParameterOptionsService.check}. */
export type ParameterOptionsCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid'; errors: Array<{ parameter: string; message: string }> }
  | { ok: false; reason: 'unavailable'; parameter: string; error: ParameterOptionsError };

interface Entry {
  fingerprint: string;
  /** Last result (success or error) and when it was fetched. */
  last: ParameterOptionsResult | null;
  lastAt: number | null;
  /** Last successful result (for the TTL cache). */
  success: ParameterOptionsResult | null;
  successAt: number | null;
  inflight: Promise<ParameterOptionsResult> | null;
}

/** True if `def` takes its options from `options_from`. */
export function hasDynamicOptions(def: unknown): def is EnumParameter & { optionsFrom: NonNullable<EnumParameter['optionsFrom']> } {
  return (def as EnumParameter | undefined)?.type === 'enum' && !!(def as EnumParameter).optionsFrom;
}

/** See module docs. One instance per daemon. */
export class ParameterOptionsService {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly redact: Redactor;
  private readonly executor: OptionsExecutor;
  private readonly minIntervalMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly abort = new AbortController();

  constructor(private readonly options: ParameterOptionsServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = (options.logger ?? noopLogger).child({ component: 'parameter-options' });
    this.redact = options.redact ?? ((s: string) => s);
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_OPTIONS_MIN_INTERVAL_MS;
    if (options.executor) this.executor = options.executor;
    else {
      const runner = new ShellCheckRunner({
        clock: this.clock,
        logger: this.logger,
        maxOutputBytes: OPTIONS_MAX_OUTPUT_BYTES,
        ...(options.hostEnv ? { hostEnv: options.hostEnv } : {}),
      });
      this.executor = (spec, context, signal) => runner.run(spec, context, { signal });
    }
  }

  /** Drop all cached results (configuration reload). Running fetches finish but are not reused. */
  invalidate(): void {
    this.entries.clear();
  }

  /** Abort running fetches (shutdown). */
  stop(): void {
    this.abort.abort();
  }

  /**
   * Options of parameter `name` of `workflow`. Static enums return their
   * `values`. `refresh` bypasses the cache (not the minimum interval).
   * Never throws for fetch problems (they are reported in `error`).
   */
  async get(workflow: WorkflowConfig, name: string, opts: { refresh?: boolean } = {}): Promise<ParameterOptionsResult> {
    const def = Object.hasOwn(workflow.parameters, name) ? workflow.parameters[name] : undefined;
    if (!def || def.type !== 'enum') throw new Error(`Parameter "${name}" of workflow "${workflow.id}" is not an enum`);
    const allowCustom = def.allowCustom === true;
    const source = def.optionsFrom;
    if (!source) return { options: def.values.map((v) => ({ value: v, label: v })), fetchedAt: null, cached: false, allowCustom };

    const key = `${workflow.id}\u0000${name}`;
    const fingerprint = JSON.stringify(source);
    let entry = this.entries.get(key);
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, last: null, lastAt: null, success: null, successAt: null, inflight: null };
      this.entries.set(key, entry);
    }
    const now = this.now();
    const withCustom = (r: ParameterOptionsResult, cached: boolean): ParameterOptionsResult => ({ ...r, cached, allowCustom });
    if (!opts.refresh && entry.success && entry.successAt !== null && source.cacheMs > 0 && now - entry.successAt < source.cacheMs) {
      return withCustom(entry.success, true);
    }
    if (entry.inflight) return withCustom(await entry.inflight, false);
    if (entry.last && entry.lastAt !== null && now - entry.lastAt < this.minIntervalMs) return withCustom(entry.last, true);

    const current = entry;
    const p = this.fetch(workflow, name, source).then((result) => {
      const at = this.now();
      current.last = result;
      current.lastAt = at;
      if (!result.error) {
        current.success = result;
        current.successAt = at;
      }
      return result;
    });
    current.inflight = p;
    try {
      return withCustom(await p, false);
    } finally {
      current.inflight = null;
    }
  }

  /**
   * Check the validated values of a manual start: every value of a parameter
   * with `options_from` and without `allow_custom` must be in the current
   * options (the cache may be used). Lists that cannot be fetched → `unavailable`.
   */
  async check(workflow: WorkflowConfig, values: Readonly<Record<string, ParameterValue>>): Promise<ParameterOptionsCheck> {
    const pending = Object.entries(workflow.parameters).filter(
      ([name, def]) => hasDynamicOptions(def) && def.allowCustom !== true && values[name] !== undefined,
    );
    const results = await Promise.all(pending.map(async ([name]) => ({ name, result: await this.get(workflow, name) })));
    const errors: Array<{ parameter: string; message: string }> = [];
    for (const { name, result } of results) {
      if (result.error) return { ok: false, reason: 'unavailable', parameter: name, error: result.error };
      const value = String(values[name]);
      if (!result.options.some((o) => o.value === value)) {
        errors.push({ parameter: name, message: `"${displayText(value, 100)}" is not one of the current options` });
      }
    }
    return errors.length > 0 ? { ok: false, reason: 'invalid', errors } : { ok: true };
  }

  // ---------------------------------------------------------------------------

  private now(): number {
    return this.clock.now().getTime();
  }

  private async fetch(workflow: WorkflowConfig, name: string, source: GitHubParameterOptions | CommandParameterOptions): Promise<ParameterOptionsResult> {
    const fetchedAt = this.clock.now().toISOString();
    let result: { options: ParameterOption[] } | { error: ParameterOptionsError };
    try {
      result = source.type === 'github' ? await this.fetchGitHub(source) : await this.fetchCommand(workflow, name, source);
    } catch (err) {
      result = { error: { code: 'command_failed', message: errorMessage(err) } };
    }
    if ('error' in result) {
      const error = { code: result.error.code, message: displayText(result.error.message, MAX_ERROR_LENGTH, this.redact) };
      this.logger.warn('parameter options could not be fetched', { workflowId: workflow.id, parameter: name, code: error.code, error: error.message });
      return { options: [], fetchedAt, cached: false, allowCustom: false, error };
    }
    return { options: result.options, fetchedAt, cached: false, allowCustom: false };
  }

  private async fetchGitHub(source: GitHubParameterOptions): Promise<{ options: ParameterOption[] } | { error: ParameterOptionsError }> {
    const adapter = this.options.sources(source.source);
    if (!adapter?.listRefs) {
      return { error: { code: 'source_unavailable', message: `Source "${source.source}" is not available or cannot list ${source.github}` } };
    }
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(source.timeoutMs)]);
    try {
      const names = await adapter.listRefs(source.github, {
        limit: source.limit,
        signal,
        maxRetryWaitMs: Math.min(GITHUB_MAX_RETRY_WAIT_MS, source.timeoutMs),
      });
      return { options: names.map((n) => ({ value: n, label: n })) };
    } catch (err) {
      if (signal.aborted) return { error: { code: 'timeout', message: `GitHub did not answer within ${formatSeconds(source.timeoutMs)}` } };
      if (err instanceof SourceError) {
        return { error: { code: err.kind === 'rate_limited' ? 'rate_limited' : 'source_error', message: `GitHub (${err.kind}): ${err.message}` } };
      }
      return { error: { code: 'source_error', message: `GitHub: ${errorMessage(err)}` } };
    }
  }

  private async fetchCommand(
    workflow: WorkflowConfig,
    name: string,
    source: CommandParameterOptions,
  ): Promise<{ options: ParameterOption[] } | { error: ParameterOptionsError }> {
    const configDir = this.options.configDir();
    const dataDir = path.resolve(this.options.dataDir);
    const values = buildTemplateValues({
      workflow: { id: workflow.id, name: workflow.name },
      ...(this.options.workspaceBaseDir ? { workspace: { baseDir: this.options.workspaceBaseDir() } } : {}),
      now: this.clock.now(),
    });
    const args = source.args.map((a) => renderTemplate(a, values, { mode: 'text', scope: {} }));
    const env: Record<string, string> = {
      [OPTIONS_ENV.workflowId]: workflow.id,
      [OPTIONS_ENV.parameter]: name,
      [OPTIONS_ENV.configDir]: configDir,
      [OPTIONS_ENV.dataDir]: dataDir,
    };
    const signal = this.abort.signal;
    // Secrets (WI-18): `env` = token in the variable, `file` = private token file (`<NAME>_FILE`), removed afterwards.
    const secretValues: string[] = [];
    const fileRequests: TokenFileRequest[] = [];
    const refs = Object.entries(source.secrets);
    if (refs.length > 0 && !this.options.credentials) {
      return { error: { code: 'command_failed', message: 'The options script declares secrets but no credential provider is configured' } };
    }
    for (const [secret, ref] of refs) {
      if (ref.delivery === 'file') {
        fileRequests.push({ name: secret, identity: ref.identity });
        continue;
      }
      try {
        const token = await this.options.credentials!.getToken(ref.identity, { signal });
        env[secret] = token.token;
        secretValues.push(token.token);
      } catch (err) {
        return { error: { code: 'command_failed', message: `Token for "${secret}" (identity "${ref.identity}") unavailable: ${errorMessage(err)}` } };
      }
    }
    const scrub = (text: string): string => {
      let out = text;
      for (const v of secretValues) if (v) out = out.split(v).join('[REDACTED]');
      return this.redact(out);
    };
    let session: TokenFileSession | undefined;
    let sessionRoot: string | undefined;
    try {
      if (fileRequests.length > 0) {
        sessionRoot = path.join(dataDir, OPTIONS_TMP_DIR, randomUUID());
        await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
        session = new TokenFileSession({
          dir: path.join(sessionRoot, TOKEN_DIR_NAME),
          requests: fileRequests,
          credentials: this.options.credentials!,
          clock: this.clock,
          ...(this.options.timers ? { timers: this.options.timers } : {}),
          logger: this.logger,
        });
        Object.assign(env, await session.open(signal));
      }
      const spec: ShellCheckSpec = { command: source.command, args, timeoutMs: source.timeoutMs, cwd: configDir, env };
      const context: OptionsScriptContext = {
        schema_version: 1,
        kind: 'parameter_options',
        workflow: { id: workflow.id },
        parameter: { name },
        config_dir: configDir,
        data_dir: dataDir,
      };
      const result = await this.executor(spec, context, signal);
      if (session) secretValues.push(...session.values());
      if (result.timedOut) return { error: { code: 'timeout', message: `Script timed out after ${formatSeconds(source.timeoutMs)}` } };
      if (result.exitCode !== 0 || result.signal !== null || result.error !== undefined) {
        // Exit codes are reported plainly ("exit code 2"); signals and spawn errors with their detail.
        const plainExit =
          result.exitCode !== null && result.exitCode !== 0 && result.signal === null && (result.error === undefined || result.error.startsWith('check error'));
        const base = plainExit ? `exit code ${String(result.exitCode)}` : (result.error ?? `terminated by signal ${String(result.signal)}`);
        const stderr = firstNonEmptyLine(scrub(result.stderr));
        return { error: { code: 'command_failed', message: scrub(stderr ? `${base}: ${stderr}` : base) } };
      }
      if (result.outputTruncated) return { error: { code: 'invalid_output', message: `Output exceeds ${OPTIONS_MAX_OUTPUT_BYTES / 1024} KiB` } };
      const parsed = parseOptionsOutput(scrub(result.stdout));
      if (!parsed.ok) return { error: { code: 'invalid_output', message: scrub(parsed.error) } };
      return { options: parsed.options };
    } catch (err) {
      return { error: { code: 'command_failed', message: scrub(errorMessage(err)) } };
    } finally {
      await session?.close().catch(() => undefined);
      if (sessionRoot) await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
