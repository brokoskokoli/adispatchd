/**
 * Application bootstrap (WI-10): wires all components of one orchestrator
 * instance and owns its lifecycle.
 *
 * Start order: instance lock → SQLite (+ migrations) → configuration →
 * credentials/source adapters → executor/lifecycle → run controller →
 * notifications → views → retention → HTTP API (listening; `/health` works,
 * `/ready` is false) → recovery → scheduler + retention timer (`/ready` true).
 *
 * Stop order (`shutdown`): scheduler stopped → controller drain / cancel-all
 * (with timeouts, escalatable) → background API operations aborted →
 * retention / notifications stopped → SSE closed → HTTP closed → DB closed →
 * instance lock released. SIGTERM/SIGINT: drain with timeout, a second signal
 * escalates to cancel-all (see {@link installSignalHandlers}).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  ConsoleLogger,
  OrchestratorError,
  SecretRedactor,
  noopLogger,
  errorMessage,
  systemClock,
  systemTimers,
  type AccessToken,
  type Clock,
  type ContainerEngine,
  type CredentialProvider,
  type FetchLike,
  type IdentityDescription,
  type IdentityRef,
  type TokenRequestOptions,
  type Logger,
  type LogLevel,
  type SourceAdapter,
  type Timers,
} from './core/index.js';
import { ConfigManager, isIdentityForgeableLocally, type IdentityConfig, type LoadedConfig, type ReloadResult } from './config/index.js';
import {
  CompositeCredentialProvider,
  GitHubAppCredentialProvider,
  GitHubTokenCredentialProvider,
  type GitHubAppIdentityConfig,
  type GitHubTokenIdentityConfig,
} from './identities/index.js';
import { ContainerEngineClient } from './executors/index.js';
import { LifecycleEngine } from './lifecycle/index.js';
import { NotificationService } from './notifications/index.js';
import { acquireInstanceLock, openPersistence, type InstanceLock, type Persistence } from './persistence/index.js';
import {
  PersistedEventPublisher,
  RetentionService,
  RunController,
  RunEventBus,
  type RunControllerOptions,
  type ShutdownMode,
  type ShutdownResult,
} from './runs/index.js';
import { Scheduler } from './scheduler/index.js';
import { DashboardInfoService, type DashboardInfoServiceOptions } from './dashboard/index.js';
import { createGitHubSourceFactory } from './sources/index.js';
import { ViewService } from './views/index.js';
import { AuthService, createApiServer, type UiActionLimits, EventHub, removeControlToken, writeControlToken, type AuthServiceOptions, type ReadinessReport } from './api/index.js';
import { createSystemProbe, ResourceMonitor, type SystemProbe } from './monitoring/index.js';
import type { FastifyInstance } from 'fastify';

/** Package version reported by `/api/v1/status`. */
export const APP_VERSION = '0.6.0';
/** Default drain timeout on SIGTERM before cancel-all (see docs/handoff/WI-08.md). */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Default time for cancelled runs (incl. `on_cancel`) before hooks are interrupted. */
export const DEFAULT_CANCEL_TIMEOUT_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Source adapters and credentials (shared with `workflow dry-run`)

/** Dependencies for {@link SourceRegistry}. */
export interface SourceRegistryDeps {
  clock?: Clock;
  /** HTTP client for GitHub (tests: Fake-GitHub). */
  fetch?: FetchLike;
  /** Environment holding the private keys and tokens (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Shared redactor: keys and tokens are registered here (Logger uses the same instance). */
  redactor?: SecretRedactor;
  logger?: Logger;
}

/**
 * Source adapters per configured source plus the credential providers (one
 * per identity kind: `github_app`, `github_token`, routed by a
 * {@link CompositeCredentialProvider}). Also a {@link CredentialProvider} itself that
 * delegates to the current provider, so components keep a stable reference
 * across reloads. On reload adapters/credentials are rebuilt only if sources
 * or identities changed; adapters/identities that disappeared stay available
 * for runs that still reference them in their snapshot.
 */
export class SourceRegistry implements CredentialProvider {
  private adapters = new Map<string, SourceAdapter>();
  private identities: Record<string, IdentityConfig> = {};
  private provider: CompositeCredentialProvider;
  private signature = '';
  private readonly clock: Clock;
  private readonly redactor: SecretRedactor;

  constructor(
    config: LoadedConfig,
    private readonly deps: SourceRegistryDeps = {},
  ) {
    this.clock = deps.clock ?? systemClock;
    this.redactor = deps.redactor ?? new SecretRedactor();
    this.provider = this.createProvider();
    this.rebuild(config);
  }

  /** Adapter for a source ID. */
  get(sourceId: string): SourceAdapter | undefined {
    return this.adapters.get(sourceId);
  }

  /** IDs of all known adapters. */
  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** Apply a (re)loaded configuration. */
  rebuild(config: LoadedConfig): void {
    const signature = JSON.stringify({ sources: config.sources, identities: config.identities });
    if (signature === this.signature) return;
    this.signature = signature;
    this.identities = { ...this.identities, ...config.identities };
    this.provider = this.createProvider();
    const factory = createGitHubSourceFactory();
    const next = new Map(this.adapters);
    for (const source of Object.values(config.sources)) {
      next.set(
        source.id,
        factory.create(
          source.id,
          {
            owner: source.owner,
            repository: source.repository,
            identity: source.identity,
            ...(source.project
              ? {
                  project: {
                    owner: source.project.owner,
                    number: source.project.number,
                    identity: source.project.identity,
                    ...(source.project.writeIdentity ? { writeIdentity: source.project.writeIdentity } : {}),
                    fields: source.project.fields,
                  },
                }
              : {}),
          },
          {
            credentials: this,
            logger: this.deps.logger?.child({ component: 'source', sourceId: source.id }) ?? noopLogger,
            clock: this.clock,
            ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
          },
        ),
      );
    }
    this.adapters = next;
  }

  getToken(identity: IdentityRef, options?: TokenRequestOptions): Promise<AccessToken> {
    return this.provider.getToken(identity, options);
  }

  invalidate(identity: IdentityRef): void {
    this.provider.invalidate(identity);
  }

  describe(identity: IdentityRef): IdentityDescription | undefined {
    return this.provider.describe(identity);
  }

  private createProvider(): CompositeCredentialProvider {
    const apps: Record<string, GitHubAppIdentityConfig> = {};
    const tokens: Record<string, GitHubTokenIdentityConfig> = {};
    for (const identity of Object.values(this.identities)) {
      if (identity.type === 'github_app') {
        apps[identity.id] = { appId: identity.appId, installationId: identity.installationId, privateKeyEnv: identity.privateKeyEnv };
      } else {
        tokens[identity.id] = { tokenEnv: identity.tokenEnv };
      }
    }
    const appProvider = new GitHubAppCredentialProvider(apps, {
      clock: this.clock,
      redactor: this.redactor,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.env ? { env: this.deps.env } : {}),
    });
    const tokenProvider = new GitHubTokenCredentialProvider(tokens, {
      redactor: this.redactor,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      ...(this.deps.env ? { env: this.deps.env } : {}),
    });
    return new CompositeCredentialProvider({
      ...Object.fromEntries(Object.keys(apps).map((id) => [id, appProvider])),
      ...Object.fromEntries(Object.keys(tokens).map((id) => [id, tokenProvider])),
    });
  }
}

// ---------------------------------------------------------------------------
// Container engines (WI-19)

/** Engines used by container workflows of a configuration. */
export function containerEngines(config: LoadedConfig): ContainerEngine[] {
  const engines = new Set<ContainerEngine>();
  for (const workflow of Object.values(config.workflows)) {
    if (workflow.execute.type === 'container') engines.add(workflow.execute.engine);
  }
  return [...engines].sort();
}

/**
 * Check at startup that the engine binaries of container workflows can be run
 * (`<engine> --version`). Only warns: runs of a missing engine end with `start_error`.
 */
export async function checkContainerEngines(client: ContainerEngineClient, engines: readonly ContainerEngine[], log: Logger): Promise<void> {
  for (const engine of engines) {
    const result = await client.check(engine);
    if (result.ok) log.info('container engine available', { engine, version: result.version });
    else log.warn('container engine not available: container runs will end with start_error', { engine, error: result.error });
  }
}

// ---------------------------------------------------------------------------
// Application

/** Options of {@link createApp}. */
export interface AppOptions {
  configDir: string;
  dataDir: string;
  /** Override `server.host` / `server.port` (tests: port 0). */
  host?: string;
  port?: number;
  clock?: Clock;
  timers?: Timers;
  /** Logger (default: JSON lines on stderr, redacted with the shared redactor). */
  logger?: Logger;
  logLevel?: LogLevel;
  /** Environment for private keys and webhook URLs/headers (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** HTTP client for GitHub (tests: Fake-GitHub). */
  fetch?: FetchLike;
  /** HTTP client for notification webhooks (default global `fetch`). */
  notificationFetch?: FetchLike;
  /**
   * Drain timeout before cancel-all. Used for API/GUI drain only when set
   * (unbounded otherwise); the signal handlers get it from the CLI and
   * default to 10 min there.
   */
  drainTimeoutMs?: number;
  /** Time for cancelled runs before hooks are interrupted (default 2 min). */
  cancelTimeoutMs?: number;
  /** Delay of the first retention pass after readiness (default 60 s). */
  retentionInitialDelayMs?: number;
  notifications?: { retryDelaysMs?: readonly number[]; timeoutMs?: number };
  sse?: { heartbeatMs?: number; maxBufferBytes?: number; maxReplay?: number };
  viewCacheTtlMs?: number;
  /** Extra run controller options (tests: recovery tuning, injected probes). */
  controller?: Partial<Omit<RunControllerOptions, 'repositories' | 'lifecycle' | 'sources' | 'dataDir' | 'publisher' | 'notifier' | 'onStop'>>;
  /** Additional allowed `Origin`s for mutating API requests. */
  allowedOrigins?: readonly string[];
  /** Static web UI directory (WI-11). */
  uiDir?: string;
  /** Authentication tuning (WI-26; tests: fake scrypt, no failure delay, fixed control token). */
  auth?: Partial<Pick<AuthServiceOptions, 'scrypt' | 'sleep' | 'controlToken'>>;
  /** Per-user limits of UI actions (WI-27; tests). */
  uiActionLimits?: Partial<UiActionLimits>;
  /** Resource monitor (WI-23); tests inject a fake OS probe. */
  monitoring?: { probe?: SystemProbe; primeDelayMs?: number };
  /** Tuning of the dashboard info tiles (WI-24; tests). */
  dashboardInfo?: Partial<Pick<DashboardInfoServiceOptions, 'maxParallel' | 'manualMinIntervalMs' | 'manualPerMinute'>>;
}

/** Options of {@link App.shutdown}. */
export interface AppShutdownOptions {
  mode?: ShutdownMode;
  drainTimeoutMs?: number;
  cancelTimeoutMs?: number;
  reason?: string;
}

/** Result of a completed shutdown. */
export interface AppStopResult {
  /** Process exit code: 0 after an orderly shutdown, 1 after a fatal error. */
  exitCode: number;
  shutdown: ShutdownResult | null;
  error?: string;
}

/** A running (or startable) orchestrator instance. */
export interface App {
  readonly config: ConfigManager;
  readonly persistence: Persistence;
  readonly sources: SourceRegistry;
  readonly bus: RunEventBus;
  readonly controller: RunController;
  readonly scheduler: Scheduler;
  readonly lifecycle: LifecycleEngine;
  readonly notifications: NotificationService;
  readonly views: ViewService;
  readonly retention: RetentionService;
  /** Dashboard info tiles (WI-24). */
  readonly dashboard: DashboardInfoService;
  readonly events: EventHub;
  /** Authentication (WI-26). */
  readonly auth: AuthService;
  /** Server resource monitor (WI-23). */
  readonly monitor: ResourceMonitor;
  readonly http: FastifyInstance;
  readonly redactor: SecretRedactor;
  readonly logger: Logger;
  /** Base URL once listening (e.g. `http://127.0.0.1:8787`). */
  readonly url: string | null;
  /** Resolves when the instance is ready (recovery done, scheduler started). */
  readonly ready: Promise<void>;
  /** Resolves when the instance has fully stopped (DB closed, lock released). */
  readonly stopped: Promise<AppStopResult>;
  /** Listen on HTTP, run recovery, start the scheduler. Returns the URL. */
  start(): Promise<string>;
  /** Shut down (drain by default). Repeated calls escalate (e.g. drain → cancel). */
  shutdown(options?: AppShutdownOptions): Promise<AppStopResult>;
  /** `/ready` report. */
  readiness(): ReadinessReport;
  /** Reload the configuration (as `POST /api/v1/config/reload`). */
  reloadConfig(): Promise<ReloadResult>;
}

/** True for loopback bind addresses. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/**
 * Create the application. Acquires the instance lock immediately
 * (`InstanceLockedError` if another instance uses the data dir) and loads
 * the configuration (`ConfigLoadError` if invalid); nothing listens until
 * {@link App.start}.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const configDir = path.resolve(options.configDir);
  const dataDir = path.resolve(options.dataDir);
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? systemTimers;
  const redactor = new SecretRedactor();
  const logger = options.logger ?? new ConsoleLogger({ level: options.logLevel ?? 'info', clock, redact: redactor.asRedactor });
  const log = logger.child({ component: 'app' });

  mkdirSync(dataDir, { recursive: true });
  const lock: InstanceLock = acquireInstanceLock(dataDir, { clock });
  let persistence: Persistence | undefined;
  let config: ConfigManager;
  try {
    persistence = openPersistence(dataDir, { clock, logger });
    if (persistence.migration.applied.length > 0) {
      log.info('database migrated', { ...persistence.migration });
    }
    config = await ConfigManager.create({ configDir, dataDir, clock, logger });
  } catch (err) {
    persistence?.close();
    lock.release();
    throw err;
  }
  const repos = persistence;

  const sources = new SourceRegistry(config.current, {
    clock,
    redactor,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const sourceLookup = (id: string): SourceAdapter | undefined => sources.get(id);

  const bus = new RunEventBus(logger);
  const publisher = new PersistedEventPublisher(repos, bus);
  const events = new EventHub({
    bus,
    events: repos.events,
    lastPublishedId: () => publisher.lastPublishedId,
    clock,
    logger,
    ...(options.sse ?? {}),
  });
  const notifications = new NotificationService({
    repositories: repos,
    settings: () => config.current.global.notifications,
    clock,
    timers,
    logger,
    redactor,
    ...(options.env ? { env: options.env } : {}),
    ...(options.notificationFetch ? { fetch: options.notificationFetch } : {}),
    ...(options.notifications ?? {}),
    onChange: (n) => events.publish('notification', n),
  });
  const lifecycle = new LifecycleEngine({
    repositories: repos,
    sources: sourceLookup,
    dataDir,
    notifier: notifications,
    onActionChange: publisher.actionListener(),
    clock,
    timers,
    logger,
    redact: redactor.asRedactor,
    credentials: sources,
  });
  const containers = options.controller?.containers ?? new ContainerEngineClient({ logger });
  /** Engines whose binary was checked (startup, reloads). */
  const checkedEngines = new Set<ContainerEngine>();
  const controller = new RunController({
    clock,
    timers,
    logger,
    ...(options.controller ?? {}),
    containers,
    containerEngines: () => containerEngines(config.current),
    repositories: repos,
    lifecycle,
    sources: sourceLookup,
    dataDir,
    publisher,
    credentials: sources,
    notifier: notifications,
    maxLogBytesPerRun: () => config.current.global.retention.maxLogSizePerRunBytes,
    secretValues: () => redactor.values(),
  });
  const scheduler = new Scheduler({
    config,
    repositories: repos,
    controller,
    sources: sourceLookup,
    clock,
    timers,
    logger,
    // WI-24: live update of the condition status in the workflow views (the UI reloads via REST).
    onConditionStatusChange: (workflowId) => events.publish('workflow.conditions', { workflowId }),
    redact: redactor.asRedactor,
  });
  // WI-24: info tiles of dashboard.yaml (background scripts; started with the scheduler).
  const dashboard = new DashboardInfoService({
    dashboard: () => config.current.dashboard,
    configDir: () => config.current.configDir,
    dataDir,
    clock,
    timers,
    logger,
    redact: redactor.asRedactor,
    onChange: (tile) => events.publish('dashboard.info', tile),
    ...options.dashboardInfo,
  });
  const views = new ViewService({ config, sources: sourceLookup, runs: repos.runs, clock, logger, redact: redactor.asRedactor, ...(options.viewCacheTtlMs !== undefined ? { cacheTtlMs: options.viewCacheTtlMs } : {}) });
  const retention = new RetentionService({
    repositories: repos,
    dataDir,
    settings: () => config.current.global.retention,
    clock,
    timers,
    logger,
    isBusy: (runId) => lifecycle.isBusy(runId) || controller.activeRunIds().includes(runId),
    onReport: (r) =>
      events.publish('retention.finished', { finishedAt: r.finishedAt, deletedRuns: r.deletedRuns, errors: r.errors.length }),
  });

  const monitor = new ResourceMonitor({
    probe: options.monitoring?.probe ?? createSystemProbe({ engines: containers }),
    settings: () => {
      const g = config.current.global;
      return { ...g.monitoring, diskPaths: [dataDir, g.workspace.baseDir] };
    },
    targets: () => ({ daemonPid: process.pid, runs: controller.supervisedProcesses() }),
    clock,
    timers,
    logger,
    onSample: (sample) => events.publish('system.metrics', sample),
    ...(options.monitoring?.primeDelayMs !== undefined ? { primeDelayMs: options.monitoring.primeDelayMs } : {}),
  });

  // --- State ----------------------------------------------------------------
  const host = options.host ?? config.current.global.server.host;
  const port = options.port ?? config.current.global.server.port;
  let url: string | null = null;
  let listening = false;
  let schedulerStarted = false;
  let shuttingDown = false;
  let started = false;
  let stopPromise: Promise<AppStopResult> | undefined;
  let resolveStopped!: (r: AppStopResult) => void;
  const stopped = new Promise<AppStopResult>((resolve) => {
    resolveStopped = resolve;
  });
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const backgroundAbort = new AbortController();
  const backgroundOps = new Set<Promise<unknown>>();
  const startedAt = clock.now().toISOString();

  const readiness = (): ReadinessReport => {
    let database = false;
    try {
      repos.db.prepare('SELECT 1').get();
      database = true;
    } catch {
      database = false;
    }
    const checks = {
      database,
      recovery: controller.isReady(),
      scheduler: schedulerStarted,
      shuttingDown,
    };
    return { ready: database && checks.recovery && checks.scheduler && !shuttingDown, checks };
  };

  const reloadConfig = async (): Promise<ReloadResult> => {
    const res = await config.reload();
    if (res.ok) {
      sources.rebuild(res.config);
      // A reload may add a container workflow on an engine not checked yet (warning only).
      const newEngines = containerEngines(res.config).filter((e) => !checkedEngines.has(e));
      if (newEngines.length > 0) {
        for (const e of newEngines) checkedEngines.add(e);
        void checkContainerEngines(containers, newEngines, log);
      }
      views.invalidate();
      dashboard.sync();
      auth.sweep();
      warnAuthUsers();
      notifications.refreshSecrets();
      events.publish('config.reloaded', {
        version: res.config.version,
        hash: res.config.hash,
        changed: res.changed,
        diff: res.diff,
        resetOverrides: res.resetOverrides,
      });
      if (schedulerStarted && !shuttingDown) {
        void scheduler.planOnce().catch((err: unknown) => log.warn('planning after reload failed', { error: errorMessage(err) }));
      }
    }
    return res;
  };

  const background = (what: string, startOp: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> => {
    if (shuttingDown) {
      return Promise.reject(new OrchestratorError('run_controller_not_accepting', 'Server is shutting down'));
    }
    let op: Promise<unknown>;
    try {
      op = startOp(backgroundAbort.signal);
    } catch (err) {
      op = Promise.reject(err);
    }
    backgroundOps.add(op);
    op.then(
      () => backgroundOps.delete(op),
      (err: unknown) => {
        backgroundOps.delete(op);
        log.warn('background operation failed', { what, error: errorMessage(err) });
      },
    );
    return op;
  };

  let shutdown: (opts?: AppShutdownOptions) => Promise<AppStopResult>;

  // WI-26: authentication (mode read per request from the active configuration).
  const auth = new AuthService({
    config: () => config.current.global.auth,
    clock,
    timers,
    logger,
    ...(options.env ? { env: options.env } : {}),
    ...(options.auth ?? {}),
  });
  const warnAuthUsers = (): void => {
    for (const name of auth.checkUsers()) {
      log.warn('auth: user cannot log in – password hash variable missing or malformed (adispatch auth hash-password)', { user: name });
    }
    const cfg = config.current.global.auth;
    if (auth.proxySecretMissing()) {
      log.warn('auth: proxy_secret_env is set but the variable is missing or empty – every identity header is rejected', {
        variable: cfg.trustedHeader.proxySecretEnv,
      });
    }
    if (isIdentityForgeableLocally(cfg)) {
      log.warn(
        'auth: trusted_header without proxy_secret_env and a trusted loopback proxy – any local process (including workers) can claim any configured login; set auth.trusted_header.proxy_secret_env where the proxy supports it',
      );
    }
  };

  const http = await createApiServer({
    config,
    repositories: repos,
    controller,
    scheduler,
    lifecycle,
    views,
    notifications,
    retention,
    dashboard,
    events,
    monitor,
    dataDir,
    clock,
    logger,
    redact: redactor.asRedactor,
    readiness,
    shutdown: (mode, reason) => {
      // API/GUI drain waits for active runs without a deadline unless one was
      // configured; the cancel phase is always bounded so a kill_failed run or
      // a hanging on_cancel hook cannot block the service forever.
      void shutdown({
        mode,
        ...(mode === 'drain' && options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
        cancelTimeoutMs: options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
        ...(reason ? { reason } : {}),
      });
    },
    reloadConfig,
    background,
    info: { version: APP_VERSION, startedAt, host, port: () => (listening ? actualPort() : null) },
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    ...(options.uiActionLimits ? { uiActionLimits: options.uiActionLimits } : {}),
    ...(options.uiDir ? { uiDir: options.uiDir } : {}),
    auth,
    sources: sourceLookup,
  });

  const actualPort = (): number | null => {
    const addr = http.server.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  };

  const teardown = async (result: ShutdownResult | null, error?: string): Promise<AppStopResult> => {
    // Background API operations (manual action retries, recovery retries).
    backgroundAbort.abort(new Error('application stopping'));
    if (backgroundOps.size > 0) {
      await Promise.race([
        Promise.allSettled([...backgroundOps]),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 10_000);
          t.unref?.();
        }),
      ]);
    }
    await retention.stop().catch(() => undefined);
    await notifications.stop().catch(() => undefined);
    await monitor.stop().catch(() => undefined);
    events.close();
    auth.stop();
    removeControlToken(dataDir, auth.controlToken);
    if (listening) {
      await http.close().catch((err: unknown) => log.warn('closing HTTP server failed', { error: errorMessage(err) }));
    } else {
      await http.close().catch(() => undefined);
    }
    try {
      repos.close();
    } catch (err) {
      log.warn('closing database failed', { error: errorMessage(err) });
    }
    lock.release();
    const exitCode = error ? 1 : 0;
    log.info('orchestrator stopped', { exitCode, outcome: result?.outcome ?? null, leftActive: result?.leftActive ?? [] });
    const r: AppStopResult = { exitCode, shutdown: result, ...(error ? { error } : {}) };
    resolveStopped(r);
    return r;
  };

  let fatalError: string | undefined;
  shutdown = (opts: AppShutdownOptions = {}): Promise<AppStopResult> => {
    const controllerOpts = {
      mode: opts.mode ?? 'drain',
      ...(opts.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : {}),
      ...(opts.cancelTimeoutMs !== undefined ? { cancelTimeoutMs: opts.cancelTimeoutMs } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    };
    if (stopPromise) {
      // Escalate a running shutdown (mode cancel / stricter timeouts).
      void controller.shutdown(controllerOpts).catch(() => undefined);
      return stopPromise;
    }
    shuttingDown = true;
    log.info('shutting down', { mode: controllerOpts.mode, drainTimeoutMs: opts.drainTimeoutMs ?? null, cancelTimeoutMs: opts.cancelTimeoutMs ?? null });
    stopPromise = (async () => {
      let result: ShutdownResult | null = null;
      try {
        await scheduler.stop();
        await dashboard.stop();
        result = await controller.shutdown(controllerOpts);
      } catch (err) {
        fatalError ??= errorMessage(err);
        log.error('shutdown failed', { error: fatalError });
      }
      return teardown(result, fatalError);
    })();
    return stopPromise;
  };

  const start = async (): Promise<string> => {
    if (started) throw new Error('application already started');
    started = true;
    const authMode = config.current.global.auth.mode;
    if (!isLoopback(host) && authMode === 'none') {
      log.warn('HTTP API bound to a non-loopback address without authentication – protect it with a reverse proxy/VPN (Spec §20)', {
        host,
      });
    }
    if (!isLoopback(host) && authMode === 'trusted_header') {
      log.warn('auth.mode trusted_header while bound to a non-loopback address: bind to 127.0.0.1 and reach adispatchd only through the proxy', { host });
    }
    if (!isLoopback(host) && authMode === 'password') {
      log.warn(
        'auth.mode password while bound to a non-loopback address: adispatchd speaks plain HTTP – passwords and session cookies travel unencrypted unless a TLS proxy terminates in front (bind to 127.0.0.1 behind the proxy)',
        { host },
      );
    }
    warnAuthUsers();
    auth.start();
    await http.listen({ host, port });
    listening = true;
    const p = actualPort();
    // Local control token for the CLI (WI-26): new random value per start, 0600, written atomically, with port and pid.
    writeControlToken(dataDir, { token: auth.controlToken, port: p ?? port, pid: process.pid });
    url = `http://${host.includes(':') ? `[${host}]` : host}:${p ?? port}`;
    log.info('HTTP API listening', { url });
    notifications.start();
    monitor.start();
    void (async () => {
      try {
        const engines = containerEngines(config.current);
        for (const e of engines) checkedEngines.add(e);
        await checkContainerEngines(containers, engines, log);
        const report = await controller.recover();
        log.info('recovery finished', {
          finalized: report.finalized.length,
          pending: report.pending.length,
          resumedActions: report.resumedActions.length,
          errors: report.errors.length,
        });
        if (shuttingDown) return;
        scheduler.start();
        schedulerStarted = true;
        dashboard.start();
        retention.start(options.retentionInitialDelayMs ?? 60_000);
        events.publish('system.ready', { ready: true });
        resolveReady();
      } catch (err) {
        fatalError = `recovery failed: ${errorMessage(err)}`;
        log.error('recovery failed, shutting down', { error: fatalError });
        void shutdown({ mode: 'cancel', cancelTimeoutMs: options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS });
      }
    })();
    return url;
  };

  return {
    config,
    persistence: repos,
    sources,
    bus,
    controller,
    scheduler,
    lifecycle,
    notifications,
    views,
    retention,
    dashboard,
    events,
    auth,
    monitor,
    http,
    redactor,
    logger,
    get url() {
      return url;
    },
    ready,
    stopped,
    start,
    shutdown: (opts) => shutdown(opts),
    readiness,
    reloadConfig,
  };
}

/** Minimal process surface for {@link installSignalHandlers} (injectable for tests). */
export interface SignalTarget {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/**
 * SIGTERM/SIGINT handling (Spec §14, WI-08 handoff): the first signal drains
 * with `drainTimeoutMs`, then cancels all remaining runs and interrupts hooks
 * after `cancelTimeoutMs`; a second signal escalates immediately to
 * cancel-all; a third one calls `forceExit(1)`. Returns an uninstall function.
 */
export function installSignalHandlers(
  app: Pick<App, 'shutdown' | 'logger'>,
  options: {
    target?: SignalTarget;
    drainTimeoutMs?: number;
    cancelTimeoutMs?: number;
    forceExit?: (code: number) => void;
  } = {},
): () => void {
  const target: SignalTarget = options.target ?? process;
  const log = app.logger.child({ component: 'signals' });
  let count = 0;
  const handler = (signal: 'SIGTERM' | 'SIGINT') => (): void => {
    count++;
    if (count === 1) {
      log.info('signal received: draining', { signal, drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS });
      void app.shutdown({
        mode: 'drain',
        drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
        cancelTimeoutMs: options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
      });
    } else if (count === 2) {
      log.warn('second signal received: cancelling all runs', { signal });
      void app.shutdown({ mode: 'cancel', cancelTimeoutMs: options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS, reason: `cancelled by ${signal}` });
    } else {
      log.error('third signal received: exiting immediately (recovery will clean up on next start)', { signal });
      (options.forceExit ?? ((code: number) => process.exit(code)))(1);
    }
  };
  const onTerm = handler('SIGTERM');
  const onInt = handler('SIGINT');
  target.on('SIGTERM', onTerm);
  target.on('SIGINT', onInt);
  return () => {
    target.off('SIGTERM', onTerm);
    target.off('SIGINT', onInt);
  };
}
