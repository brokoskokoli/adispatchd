/**
 * Shell executor (Spec §8.2, §8.3, §9, §13, §20): spawns the main worker in
 * its own process group with a minimal environment, captures logs and
 * events, enforces timeouts and supervises cancel/termination.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  MAX_RESULT_FILE_BYTES,
  OrchestratorError,
  SecretRedactor,
  errorMessage,
  noopLogger,
  parseWorkerResult,
  redactValue,
  systemClock,
  systemTimers,
  type Clock,
  type ExecutionOutcome,
  type ExecutionSpec,
  type Executor,
  type ExecutorDiagnostic,
  type Logger,
  type OutputChunk,
  type ProcessStartIdentity,
  type ResultFileStatus,
  type RunningProcess,
  type TimerHandle,
  type Timers,
  type Unsubscribe,
  type WorkerEvent,
  type WorkerResult,
} from '../core/index.js';
import { Channel, Dispatcher } from './dispatcher.js';
import { buildOrchEnv, buildWorkerEnv } from './env.js';
import { LogBudget, StreamCapture } from './log-capture.js';
import {
  defaultProcessInspector,
  getStartIdentity,
  processGroupAlive,
  processGroupExists,
  type KillFn,
  type ProcessInspector,
} from './process-identity.js';
import { StreamRedactor } from './stream-redactor.js';
import { ensureWorkspaceWithin } from './workspace.js';

/** Dependencies and tuning of the {@link ShellExecutor}. */
export interface ShellExecutorOptions {
  clock?: Clock;
  /** Timers for timeouts and polling (default: real timers). */
  timers?: Timers;
  logger?: Logger;
  /** Environment the minimal worker env is picked from (default `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Platform adapter for start identities (default: current platform). */
  inspector?: ProcessInspector;
  /** Signal sender for process groups (default `process.kill`; injectable for tests). */
  kill?: KillFn;
  /** How long to wait for the group to vanish after SIGKILL before reporting `kill_failed`. Default 5 s. */
  killConfirmMs?: number;
  /** After the leader exited: max wait for stdout/stderr to close before they are destroyed. Default 2 s. */
  stdioDrainMs?: number;
  /** Poll interval while waiting for a process group to vanish. Default 25 ms. */
  pollIntervalMs?: number;
  /**
   * `workspace.base_dir`: if set, the working directory must lie strictly
   * below it (never the base itself); it is created segment by segment with a
   * real-path check per segment (see `ensureWorkspaceWithin`), so symlinks
   * cannot redirect creation outside. Violations end the run with `start_error`.
   */
  workspaceBaseDir?: string;
}

/**
 * How a supervised process is spawned and stopped. The shell executor spawns
 * `spec.command` directly; the container executor (WI-19) spawns the engine
 * CLI in the foreground and stops the container through the engine first.
 * Internal to the `executors` component.
 */
export interface LaunchStrategy {
  /** Logger component name. */
  readonly component: string;
  /** Extra checks/preparation after the context file was written; a rejection ends the run with `start_error`. */
  prepare?(): Promise<void>;
  /** Process to spawn (env = complete environment of the spawned process). */
  process(orchEnv: Record<string, string>): { command: string; args: string[]; env: Record<string, string> };
  /** Graceful stop (cancel/timeout) before the process group is signalled. Must not reject. */
  stop?(graceMs: number): Promise<void>;
  /** Max wait for the process to end after `stop` before the group is signalled. */
  readonly stopSettleMs?: number;
  /** After the process ended, before the outcome is reported; `abnormal` = stopped or killed by a signal. Must not reject. */
  afterExit?(abnormal: boolean): Promise<void>;
}

/** The plain shell strategy: `spec.command` with the worker environment. */
function shellStrategy(spec: ExecutionSpec, baseEnv: NodeJS.ProcessEnv): LaunchStrategy {
  return {
    component: 'shell-executor',
    process: (orch) => ({
      command: spec.command,
      args: [...spec.args],
      env: buildWorkerEnv({ base: baseEnv, env: spec.env, secrets: spec.secrets, orch }),
    }),
  };
}

/** Executor for local shell workers (V1). */
export class ShellExecutor implements Executor {
  readonly type = 'shell';
  private readonly deps: Required<Omit<ShellExecutorOptions, 'baseEnv' | 'workspaceBaseDir'>> & {
    baseEnv: NodeJS.ProcessEnv;
    workspaceBaseDir: string | undefined;
  };

  constructor(options: ShellExecutorOptions = {}) {
    this.deps = supervisorDeps(options);
  }

  async start(spec: ExecutionSpec): Promise<RunningProcess> {
    return startSupervised(spec, this.deps, shellStrategy(spec, this.deps.baseEnv));
  }
}

/** Resolved dependencies of a supervised process. */
export type SupervisorDeps = ShellExecutor['deps'];

/** Resolve {@link ShellExecutorOptions} to {@link SupervisorDeps} (shared with the container executor). */
export function supervisorDeps(options: ShellExecutorOptions = {}): SupervisorDeps {
  return {
    clock: options.clock ?? systemClock,
    timers: options.timers ?? systemTimers,
    logger: options.logger ?? noopLogger,
    baseEnv: options.baseEnv ?? process.env,
    inspector: options.inspector ?? defaultProcessInspector(),
    kill: options.kill ?? ((pid, signal) => process.kill(pid, signal)),
    killConfirmMs: options.killConfirmMs ?? 5000,
    stdioDrainMs: options.stdioDrainMs ?? 2000,
    pollIntervalMs: options.pollIntervalMs ?? 25,
    workspaceBaseDir: options.workspaceBaseDir,
  };
}

/** Start a supervised process with the given strategy (logs, events, timeouts, cancel, result file). */
export async function startSupervised(spec: ExecutionSpec, deps: SupervisorDeps, strategy: LaunchStrategy): Promise<RunningProcess> {
  const proc = new ShellProcess(spec, deps, strategy);
  await proc.launch();
  // Delivery starts on a later turn, after the caller had the chance to subscribe.
  proc.openDelivery();
  return proc;
}

type StopReason = 'cancel' | 'max_duration' | 'idle';
type Deps = SupervisorDeps;

class ShellProcess implements RunningProcess {
  private readonly log: Logger;
  private readonly dispatcher: Dispatcher;
  private readonly outputs: Channel<OutputChunk>;
  private readonly events: Channel<WorkerEvent>;
  private readonly diagnostics: Channel<ExecutorDiagnostic>;
  private readonly secretRedactor = new SecretRedactor();
  private readonly streamRedactors: StreamRedactor[] = [];
  private readonly unsubscribeSecrets: Unsubscribe | undefined;

  private child: ChildProcess | undefined;
  private _pid: number | undefined;
  private _identity: ProcessStartIdentity | undefined;
  private startedAt: Date;
  private captures: StreamCapture[] = [];
  private stdioClosed: Promise<void> = Promise.resolve();

  private leaderExited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private stopReason: StopReason | undefined;
  private terminating: Promise<void> | undefined;
  private maxTimer: TimerHandle | undefined;
  private idleTimer: TimerHandle | undefined;

  private outcome: ExecutionOutcome | undefined;
  private resolveDone!: (outcome: ExecutionOutcome) => void;
  /** Resolves (via the dispatcher, after all prior notifications) with the outcome. */
  private readonly done: Promise<ExecutionOutcome>;

  constructor(
    private readonly spec: ExecutionSpec,
    private readonly deps: Deps,
    private readonly strategy: LaunchStrategy,
  ) {
    this.log = deps.logger.child({ component: strategy.component, runId: spec.runId });
    this.dispatcher = new Dispatcher(this.log);
    this.outputs = new Channel(this.dispatcher, this.log);
    this.events = new Channel(this.dispatcher, this.log);
    this.diagnostics = new Channel(this.dispatcher, this.log);
    this.startedAt = deps.clock.now();
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    for (const value of Object.values(spec.secrets)) this.secretRedactor.add(value);
    for (const value of spec.redactSecrets?.values() ?? []) this.secretRedactor.add(value);
    // Renewed tokens (token files, WI-18) are registered before the worker can read them.
    this.unsubscribeSecrets = spec.redactSecrets?.onAdd((value) => {
      this.secretRedactor.add(value);
      for (const redactor of this.streamRedactors) redactor.add(value);
    });
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get startIdentity(): ProcessStartIdentity | undefined {
    return this._identity;
  }

  onOutput(listener: (chunk: OutputChunk) => void): Unsubscribe {
    return this.outputs.subscribe(listener);
  }

  onEvent(listener: (event: WorkerEvent) => void): Unsubscribe {
    return this.events.subscribe(listener);
  }

  onDiagnostic(listener: (diagnostic: ExecutorDiagnostic) => void): Unsubscribe {
    return this.diagnostics.subscribe(listener);
  }

  wait(): Promise<ExecutionOutcome> {
    return this.done;
  }

  openDelivery(): void {
    this.dispatcher.open();
  }

  async cancel(graceMs?: number): Promise<void> {
    if (this.outcome || this._pid === undefined) {
      await this.done;
      return;
    }
    if (!this.leaderExited && this.stopReason === undefined) this.stopReason = 'cancel';
    if (!this.leaderExited || processGroupExists(this._pid)) {
      await this.terminate(graceMs ?? this.spec.cancelGraceMs);
    }
    await this.done;
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  async launch(): Promise<void> {
    const spec = this.spec;
    let launch: ReturnType<LaunchStrategy['process']>;
    try {
      await this.prepareFiles();
      await this.strategy.prepare?.();
      launch = this.strategy.process(
        buildOrchEnv({
          runId: spec.runId,
          context: spec.context,
          workflowId: spec.workflowId,
          contextFile: spec.files.contextFile,
          resultFile: spec.files.resultFile,
          workspace: spec.workingDirectory,
        }),
      );
    } catch (err) {
      this.failStart(err);
      return;
    }
    this.captures = await this.openCaptures();
    const env = launch.env;

    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: spec.workingDirectory,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      await this.endCaptures();
      this.failStart(err);
      return;
    }

    const spawned = await new Promise<Error | null>((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (err) => resolve(err));
    });
    if (spawned) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      await this.endCaptures();
      this.failStart(spawned);
      return;
    }

    this.child = child;
    this._pid = child.pid;
    this.startedAt = this.deps.clock.now();
    child.on('error', (err) => this.log.warn('worker process error', { error: err }));
    this.attachStreams(child);
    child.once('exit', (code, signal) => this.onLeaderExit(code, signal));
    this.startTimers();

    const identity = child.pid !== undefined ? await getStartIdentity(child.pid, this.deps.inspector) : undefined;
    // If the leader exited meanwhile, its PID may already be reused: never expose that identity.
    this._identity = this.leaderExited ? undefined : identity;
    if (!this._identity && !this.leaderExited) {
      this.log.warn('could not determine process start identity', { pid: child.pid });
    }
  }

  private async prepareFiles(): Promise<void> {
    const { workingDirectory, files, createDirectory } = this.spec;
    for (const p of [workingDirectory, files.contextFile, files.resultFile, files.stdoutLog, files.stderrLog]) {
      if (!path.isAbsolute(p)) throw new OrchestratorError('invalid_path', `path must be absolute: ${p}`);
    }
    const baseDir = this.deps.workspaceBaseDir;
    if (baseDir !== undefined) {
      await ensureWorkspaceWithin(baseDir, workingDirectory, createDirectory);
    } else if (createDirectory) {
      await mkdir(workingDirectory, { recursive: true });
    } else {
      const st = await stat(workingDirectory);
      if (!st.isDirectory()) {
        throw new OrchestratorError('ENOTDIR', `working directory is not a directory: ${workingDirectory}`);
      }
    }
    await mkdir(path.dirname(files.contextFile), { recursive: true });
    await mkdir(path.dirname(files.resultFile), { recursive: true });
    // A stale result file must never be attributed to this execution.
    await rm(files.resultFile, { force: true });
    const context = this.secretRedactor.redact(JSON.stringify(this.spec.context, null, 2));
    const tmp = `${files.contextFile}.tmp-${process.pid}`;
    await writeFile(tmp, `${context}\n`, { mode: 0o600 });
    await rename(tmp, files.contextFile);
  }

  private async openCaptures(): Promise<StreamCapture[]> {
    const redactorSecrets = [...Object.values(this.spec.secrets), ...(this.spec.redactSecrets?.values() ?? [])];
    const sinks = {
      output: (chunk: OutputChunk) => this.outputs.emit(chunk),
      event: (type: string, data: Record<string, unknown>, stream: 'stdout' | 'stderr') =>
        this.events.emit({ type, data, stream, at: this.deps.clock.now() }),
      diagnostic: (d: ExecutorDiagnostic) => this.emitDiagnostic(d),
    };
    const budget = new LogBudget(this.spec.maxLogBytes);
    const result: StreamCapture[] = [];
    for (const [stream, filePath] of [
      ['stdout', this.spec.files.stdoutLog],
      ['stderr', this.spec.files.stderrLog],
    ] as const) {
      let openError: Error | undefined;
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
      } catch (err) {
        openError = err as Error;
      }
      const redactor = new StreamRedactor(redactorSecrets);
      this.streamRedactors.push(redactor);
      result.push(
        new StreamCapture({
          stream,
          filePath,
          openError,
          budget,
          redactor,
          clock: this.deps.clock,
          sinks,
        }),
      );
    }
    return result;
  }

  private attachStreams(child: ChildProcess): void {
    const closes: Promise<void>[] = [];
    const pairs: [Readable | null, StreamCapture | undefined][] = [
      [child.stdout, this.captures[0]],
      [child.stderr, this.captures[1]],
    ];
    for (const [source, capture] of pairs) {
      if (!source || !capture) continue;
      closes.push(new Promise((resolve) => source.once('close', () => resolve())));
      source.on('error', (err) => this.log.warn('worker stream error', { error: err }));
      source.on('data', (buf: Buffer) => {
        this.touch();
        if (!capture.push(buf, () => source.resume())) source.pause();
      });
    }
    this.stdioClosed = Promise.all(closes).then(() => undefined);
  }

  private failStart(err: unknown): void {
    const code = (err as { code?: unknown }).code;
    const spawnError = {
      ...(typeof code === 'string' ? { code } : {}),
      message: this.secretRedactor.redact(errorMessage(err)),
    };
    this.log.warn('worker could not be started', { error: spawnError });
    this.complete({
      exitCode: null,
      signal: null,
      spawnError,
      timedOut: false,
      cancelled: false,
      resultFile: { state: 'missing' },
      startedAt: this.startedAt,
      finishedAt: this.deps.clock.now(),
      logs: { stdoutBytes: 0, stderrBytes: 0, truncated: false },
    });
  }

  // -------------------------------------------------------------------------
  // Timeouts
  // -------------------------------------------------------------------------

  private startTimers(): void {
    const { maxDurationMs, idleTimeoutMs } = this.spec.timeouts;
    if (maxDurationMs !== undefined) {
      this.maxTimer = this.deps.timers.setTimeout(() => this.onTimeout('max_duration'), maxDurationMs);
    }
    if (idleTimeoutMs !== undefined) this.armIdle();
  }

  private armIdle(): void {
    const ms = this.spec.timeouts.idleTimeoutMs;
    if (ms === undefined || this.leaderExited || this.stopReason) return;
    if (this.idleTimer) this.deps.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.deps.timers.setTimeout(() => this.onTimeout('idle'), ms);
  }

  /** Any output (including event lines) resets the idle timeout. */
  private touch(): void {
    if (this.idleTimer) this.armIdle();
  }

  private clearTimers(): void {
    if (this.maxTimer) this.deps.timers.clearTimeout(this.maxTimer);
    if (this.idleTimer) this.deps.timers.clearTimeout(this.idleTimer);
    this.maxTimer = undefined;
    this.idleTimer = undefined;
  }

  private onTimeout(kind: 'max_duration' | 'idle'): void {
    if (this.leaderExited || this.stopReason) return;
    this.stopReason = kind;
    this.clearTimers();
    this.log.info('worker timed out, terminating process group', { timeout: kind });
    this.terminate(this.spec.cancelGraceMs).catch(() => {
      /* kill_failed diagnostic already emitted */
    });
  }

  // -------------------------------------------------------------------------
  // Termination
  // -------------------------------------------------------------------------

  /**
   * Graceful strategy stop (container: `<engine> stop`) unless `direct`, then
   * SIGTERM to the group, SIGKILL after `graceMs`, then confirm the group is gone.
   */
  private terminate(graceMs: number, direct = false): Promise<void> {
    this.terminating ??= this.doTerminate(graceMs, direct).catch((err: unknown) => {
      // Allow a later cancel() to retry.
      this.terminating = undefined;
      throw err;
    });
    return this.terminating;
  }

  private async doTerminate(graceMs: number, direct: boolean): Promise<void> {
    if (!direct && this.strategy.stop) {
      await this.strategy.stop(graceMs);
      if (await this.waitGone(this.strategy.stopSettleMs ?? this.deps.killConfirmMs)) return;
      this.log.warn('process still running after the graceful stop; signalling its process group', { pgid: this._pid });
    }
    this.signalGroup('SIGTERM');
    if (await this.waitGone(graceMs)) return;
    this.signalGroup('SIGKILL');
    if (await this.waitGone(this.deps.killConfirmMs)) return;
    const message = `process group ${this._pid} could not be terminated (still alive after SIGKILL)`;
    this.emitDiagnostic({ type: 'kill_failed', at: this.deps.clock.now(), message, details: { pgid: this._pid } });
    throw new OrchestratorError('kill_failed', message, { details: { pgid: this._pid } });
  }

  /**
   * Signal our own process group. Safe without identity check: while the
   * leader is not reaped its PID cannot be reused, and while group members
   * exist the PGID cannot be reused by a new process.
   */
  private signalGroup(signal: NodeJS.Signals): void {
    const pgid = this._pid;
    if (pgid === undefined || pgid <= 1) return;
    if (this.leaderExited && !processGroupExists(pgid)) return;
    try {
      this.deps.kill(-pgid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        this.log.warn('failed to signal process group', { pgid, signal, error: err });
      }
    }
  }

  private async isGone(): Promise<boolean> {
    if (!this.leaderExited) return false;
    return this._pid === undefined || !(await processGroupAlive(this._pid, this.deps.inspector));
  }

  private async waitGone(ms: number): Promise<boolean> {
    const step = Math.max(1, this.deps.pollIntervalMs);
    let waited = 0;
    while (!(await this.isGone())) {
      if (waited >= ms) return false;
      await this.delay(Math.min(step, ms - waited));
      waited += step;
    }
    return true;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.timers.setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  private onLeaderExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.leaderExited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    this.clearTimers();
    void this.finish().catch((err: unknown) => {
      this.log.error('finishing execution failed', { error: err });
    });
  }

  private async finish(): Promise<void> {
    const pgid = this._pid as number;
    if (processGroupExists(pgid)) {
      if (!this.stopReason) {
        this.log.warn('worker exited but left processes in its group; terminating them', { pgid });
      }
      try {
        await this.terminate(this.spec.cancelGraceMs, true);
      } catch {
        // Never report the execution as finished while the group is alive (Spec §13).
        while (await processGroupAlive(pgid, this.deps.inspector)) await this.delay(1000);
      }
    }

    // Processes outside the group may still hold stdout/stderr open.
    let drainTimer: TimerHandle | undefined;
    const drained = await Promise.race([
      this.stdioClosed.then(() => true),
      new Promise<boolean>((resolve) => {
        drainTimer = this.deps.timers.setTimeout(() => resolve(false), this.deps.stdioDrainMs);
      }),
    ]);
    if (drainTimer) this.deps.timers.clearTimeout(drainTimer);
    if (!drained) {
      this.log.warn('worker output streams still open after exit; closing them', { pid: pgid });
      this.child?.stdout?.destroy();
      this.child?.stderr?.destroy();
    }

    await this.endCaptures();
    if (this.strategy.afterExit) await this.strategy.afterExit(this.stopReason !== undefined || this.exitSignal !== null);
    const [stdout, stderr] = this.captures;
    const resultFile = await this.inspectResultFile();
    this.complete({
      exitCode: this.exitCode,
      signal: this.exitSignal,
      timedOut: this.stopReason === 'max_duration' || this.stopReason === 'idle' ? this.stopReason : false,
      cancelled: this.stopReason === 'cancel',
      resultFile,
      startedAt: this.startedAt,
      finishedAt: this.deps.clock.now(),
      logs: {
        stdoutBytes: stdout?.bytesWritten ?? 0,
        stderrBytes: stderr?.bytesWritten ?? 0,
        truncated: (stdout?.truncated ?? false) || (stderr?.truncated ?? false),
      },
    });
  }

  private async endCaptures(): Promise<void> {
    await Promise.all(this.captures.map((c) => c.end()));
  }

  private async inspectResultFile(): Promise<ResultFileStatus> {
    const file = this.spec.files.resultFile;
    try {
      const st = await stat(file);
      if (!st.isFile()) return { state: 'invalid', error: 'result file is not a regular file' };
      if (st.size > MAX_RESULT_FILE_BYTES) {
        return { state: 'invalid', error: `result file exceeds ${MAX_RESULT_FILE_BYTES} bytes` };
      }
      const parsed = parseWorkerResult(await readFile(file, 'utf8'));
      if (!parsed.ok) return { state: 'invalid', error: this.secretRedactor.redact(parsed.error) };
      // Spec §9.2: redact sensitive values before the result is persisted anywhere.
      const result = redactValue(parsed.result, this.secretRedactor.asRedactor) as WorkerResult;
      const warnings = parsed.warnings.map((w) => this.secretRedactor.redact(w));
      return { state: 'valid', result, ...(warnings.length > 0 ? { warnings } : {}) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
      return { state: 'invalid', error: `result file could not be read: ${errorMessage(err)}` };
    }
  }

  private emitDiagnostic(diagnostic: ExecutorDiagnostic): void {
    this.log.warn('executor diagnostic', { type: diagnostic.type, message: diagnostic.message });
    this.diagnostics.emit(diagnostic);
  }

  private complete(outcome: ExecutionOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.unsubscribeSecrets?.();
    // Resolve after every notification emitted before has been delivered.
    this.dispatcher.enqueue(() => this.resolveDone(outcome));
  }
}
