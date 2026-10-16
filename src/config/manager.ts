/**
 * ConfigManager (Spec §19): holds the active configuration, reloads it
 * atomically (all-or-nothing) and manages non-persistent runtime overrides.
 */
import {
  errorMessage,
  noopLogger,
  OrchestratorError,
  systemClock,
  ValidationError,
  type Clock,
  type Logger,
  type Unsubscribe,
} from '../core/index.js';
import { loadConfig, type LoadConfigOptions, type LoadConfigResult } from './loader.js';
import type { ConfigIssue, LoadedConfig, WorkflowConfig } from './model.js';
import { validateWorkflowParameters, type ParameterValidationResult } from './parameters.js';
import { snapshotWorkflow, UnknownWorkflowError, type WorkflowSnapshot } from './snapshot.js';

/** Runtime overrides of one workflow (not persisted, Spec §19). */
export interface WorkflowOverrides {
  enabled?: boolean;
  priority?: number;
  maxConcurrent?: number;
}

/** Runtime overrides of global settings. */
export interface GlobalOverrides {
  maxConcurrent?: number;
}

/** A workflow with its effective (override-applied) scheduling values. */
export interface EffectiveWorkflow {
  config: WorkflowConfig;
  enabled: boolean;
  priority: number;
  maxConcurrent: number;
  /** Currently active overrides (empty object if none). */
  overrides: Readonly<WorkflowOverrides>;
}

/** Changes detected by a successful reload. */
export interface ConfigDiff {
  addedWorkflows: string[];
  removedWorkflows: string[];
  changedWorkflows: string[];
}

/** Result of {@link ConfigManager.reload}. */
export type ReloadResult =
  | {
      ok: true;
      config: LoadedConfig;
      previous: LoadedConfig;
      /** False if the content hash is unchanged (the version still increases). */
      changed: boolean;
      diff: ConfigDiff;
      /** Workflows whose overrides were reset (plus `"*"` if the global override was reset). */
      resetOverrides: string[];
      warnings: ConfigIssue[];
    }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

/** Event delivered to {@link ConfigManager.onChange} listeners. */
export type ConfigChangeEvent =
  | {
      kind: 'reload';
      config: LoadedConfig;
      previous: LoadedConfig;
      diff: ConfigDiff;
      resetOverrides: string[];
    }
  | { kind: 'overrides'; workflowId: string | null };

/** Listener for configuration changes. Must not throw (errors are logged). */
export type ConfigChangeListener = (event: ConfigChangeEvent) => void;

/** Thrown by {@link ConfigManager.create} when the initial configuration is invalid. */
export class ConfigLoadError extends OrchestratorError {
  constructor(
    readonly errors: ConfigIssue[],
    readonly warnings: ConfigIssue[],
  ) {
    super('config_invalid', `Configuration is invalid (${errors.length} error(s))`, {
      details: { errors: errors.length },
    });
  }
}

/** Loader signature (injectable for tests). */
export type ConfigLoader = (configDir: string, options: LoadConfigOptions) => Promise<LoadConfigResult>;

/** Options for {@link ConfigManager}. */
export interface ConfigManagerOptions {
  configDir: string;
  dataDir: string;
  clock?: Clock;
  logger?: Logger;
  loader?: ConfigLoader;
}

/**
 * Holds the active {@link LoadedConfig}. Use {@link ConfigManager.create} to
 * load the initial configuration.
 */
export class ConfigManager {
  private active: LoadedConfig;
  private workflowOverrides = new Map<string, WorkflowOverrides>();
  private globalOverrides: GlobalOverrides = {};
  private readonly listeners = new Set<ConfigChangeListener>();
  private reloadChain: Promise<unknown> = Promise.resolve();
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly loader: ConfigLoader;

  /** Use {@link ConfigManager.create} unless you already have a loaded config. */
  constructor(
    initial: LoadedConfig,
    private readonly options: ConfigManagerOptions,
  ) {
    this.active = initial;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.loader = options.loader ?? loadConfig;
  }

  /**
   * Load the configuration and create a manager.
   * @throws ConfigLoadError if the configuration is invalid.
   */
  static async create(options: ConfigManagerOptions): Promise<ConfigManager> {
    const loader = options.loader ?? loadConfig;
    const result = await loader(options.configDir, {
      dataDir: options.dataDir,
      version: 1,
      clock: options.clock ?? systemClock,
    });
    if (!result.ok) throw new ConfigLoadError(result.errors, result.warnings);
    return new ConfigManager(result.config, options);
  }

  /** The active configuration (immutable). */
  get current(): LoadedConfig {
    return this.active;
  }

  /**
   * Reload the whole configuration. Only if loading and validation succeed
   * completely is the new configuration activated (atomically); otherwise the
   * active configuration stays untouched and the errors are returned.
   * Concurrent calls are serialized.
   */
  reload(): Promise<ReloadResult> {
    const next = this.reloadChain.then(() => this.doReload());
    this.reloadChain = next.catch(() => undefined);
    return next;
  }

  private async doReload(): Promise<ReloadResult> {
    const previous = this.active;
    let result: LoadConfigResult;
    try {
      result = await this.loader(this.options.configDir, {
        dataDir: this.options.dataDir,
        version: previous.version + 1,
        clock: this.clock,
      });
    } catch (err) {
      const message = `Unexpected error while loading configuration: ${errorMessage(err)}`;
      this.logger.error('config reload failed', { error: message });
      return { ok: false, errors: [{ severity: 'error', file: '.', path: '', message }], warnings: [] };
    }
    if (!result.ok) {
      this.logger.warn('config reload rejected, keeping active configuration', {
        errors: result.errors.length,
        version: previous.version,
      });
      return result;
    }
    const config = result.config;
    const diff = diffWorkflows(previous, config);
    const resetOverrides: string[] = [];
    for (const id of [...diff.changedWorkflows, ...diff.removedWorkflows]) {
      if (this.workflowOverrides.delete(id)) resetOverrides.push(id);
    }
    if (
      this.globalOverrides.maxConcurrent !== undefined &&
      previous.global.scheduler.maxConcurrent !== config.global.scheduler.maxConcurrent
    ) {
      this.globalOverrides = {};
      resetOverrides.push('*');
    }
    this.active = config;
    this.logger.info('config reloaded', { version: config.version, hash: config.hash, ...diff, resetOverrides });
    this.emit({ kind: 'reload', config, previous, diff, resetOverrides });
    return {
      ok: true,
      config,
      previous,
      changed: config.hash !== previous.hash,
      diff,
      resetOverrides,
      warnings: result.warnings,
    };
  }

  /** Register a change listener. */
  onChange(listener: ConfigChangeListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ConfigChangeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error('config change listener failed', { error: errorMessage(err) });
      }
    }
  }

  private requireWorkflow(workflowId: string): WorkflowConfig {
    const wf = Object.hasOwn(this.active.workflows, workflowId) ? this.active.workflows[workflowId] : undefined;
    if (!wf) throw new UnknownWorkflowError(workflowId);
    return wf;
  }

  /** Workflow with effective values, or `undefined` if unknown. */
  getWorkflow(workflowId: string): EffectiveWorkflow | undefined {
    const wf = Object.hasOwn(this.active.workflows, workflowId) ? this.active.workflows[workflowId] : undefined;
    return wf ? this.effective(wf) : undefined;
  }

  /** All workflows with effective values, sorted by ID. */
  listWorkflows(): EffectiveWorkflow[] {
    return Object.keys(this.active.workflows)
      .sort()
      .map((id) => this.effective(this.active.workflows[id] as WorkflowConfig));
  }

  private effective(config: WorkflowConfig): EffectiveWorkflow {
    const overrides = this.workflowOverrides.get(config.id) ?? {};
    return {
      config,
      enabled: overrides.enabled ?? config.enabled,
      priority: overrides.priority ?? config.priority,
      maxConcurrent: overrides.maxConcurrent ?? config.maxConcurrent,
      overrides: { ...overrides },
    };
  }

  /** Effective global limit for automatic starts. */
  get maxConcurrent(): number {
    return this.globalOverrides.maxConcurrent ?? this.active.global.scheduler.maxConcurrent;
  }

  /** Current overrides (copies). */
  getOverrides(): { global: GlobalOverrides; workflows: Record<string, WorkflowOverrides> } {
    return {
      global: { ...this.globalOverrides },
      workflows: Object.fromEntries([...this.workflowOverrides].map(([id, o]) => [id, { ...o }])),
    };
  }

  /**
   * Merge runtime overrides into the workflow's existing overrides. A key
   * with value `undefined` removes that override.
   * @throws UnknownWorkflowError, ValidationError
   */
  setWorkflowOverrides(workflowId: string, overrides: WorkflowOverrides): EffectiveWorkflow {
    const wf = this.requireWorkflow(workflowId);
    validateOverrides(overrides);
    const merged: WorkflowOverrides = { ...(this.workflowOverrides.get(workflowId) ?? {}) };
    for (const key of ['enabled', 'priority', 'maxConcurrent'] as const) {
      if (!(key in overrides)) continue;
      const value = overrides[key];
      if (value === undefined) delete merged[key];
      else (merged as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(merged).length === 0) this.workflowOverrides.delete(workflowId);
    else this.workflowOverrides.set(workflowId, merged);
    this.emit({ kind: 'overrides', workflowId });
    return this.effective(wf);
  }

  /** Remove all overrides of a workflow. */
  clearWorkflowOverrides(workflowId: string): void {
    if (this.workflowOverrides.delete(workflowId)) this.emit({ kind: 'overrides', workflowId });
  }

  /**
   * Override (number) or reset (`undefined`) the global `max_concurrent`.
   * @throws ValidationError
   */
  setGlobalMaxConcurrent(value: number | undefined): void {
    if (value === undefined) this.globalOverrides = {};
    else {
      validateOverrides({ maxConcurrent: value });
      this.globalOverrides = { maxConcurrent: value };
    }
    this.emit({ kind: 'overrides', workflowId: null });
  }

  /** Snapshot of a workflow of the active configuration (see {@link snapshotWorkflow}). */
  snapshotWorkflow(workflowId: string): WorkflowSnapshot {
    return snapshotWorkflow(this.active, workflowId);
  }

  /**
   * Validate manual-start parameters against the workflow's parameter schema.
   * @throws UnknownWorkflowError
   */
  validateParameters(workflowId: string, input: Readonly<Record<string, unknown>> | undefined): ParameterValidationResult {
    return validateWorkflowParameters(this.requireWorkflow(workflowId), input);
  }
}

function validateOverrides(o: WorkflowOverrides): void {
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
    throw new ValidationError('Override "enabled" must be a boolean');
  }
  if (o.priority !== undefined && (typeof o.priority !== 'number' || !Number.isFinite(o.priority))) {
    throw new ValidationError('Override "priority" must be a finite number');
  }
  if (o.maxConcurrent !== undefined && (!Number.isSafeInteger(o.maxConcurrent) || o.maxConcurrent < 1)) {
    throw new ValidationError('Override "maxConcurrent" must be an integer ≥ 1');
  }
}

/** Compare the workflows of two configurations by their hashes. */
export function diffWorkflows(previous: LoadedConfig, next: LoadedConfig): ConfigDiff {
  const before = previous.workflowHashes;
  const after = next.workflowHashes;
  return {
    addedWorkflows: Object.keys(after).filter((id) => !(id in before)).sort(),
    removedWorkflows: Object.keys(before).filter((id) => !(id in after)).sort(),
    changedWorkflows: Object.keys(after).filter((id) => id in before && before[id] !== after[id]).sort(),
  };
}
