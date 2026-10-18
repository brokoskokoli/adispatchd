/**
 * Periodic retention (Spec §5.1, §21): deletes old runs (DB rows incl.
 * events/actions, `runs/<id>/`, `logs/<id>/`, the workspace below
 * `workspace.base_dir`), cleared blocks, finished notifications and old cron
 * firings according to `retention.*`.
 *
 * Protection rules are enforced by the persistence layer and re-checked in
 * the deleting transaction: active runs / lock holders, unfinished or failed
 * lifecycle chains and runs of an active retry block are never deleted.
 * Files are deleted only after their row was deleted; the instance lock files
 * (`adispatchd.lock*`) are never touched – only the `runs/`, `logs/`
 * sub-directories and workspaces strictly below the base directory are.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  dataPaths,
  errorMessage,
  isValidRunId,
  noopLogger,
  resolveStrictlyWithin,
  systemClock,
  systemTimers,
  type Clock,
  type Logger,
  type TimerHandle,
  type Timers,
} from '../core/index.js';
import type { RetentionConfig } from '../config/index.js';
import { INSTANCE_LOCK_FILES, type Repositories, type RunRetentionCategory } from '../persistence/index.js';
import { removeWorkspace } from './workspace.js';

/** Fallback age of cron firings when `completed_runs` is `never`. */
const CRON_FIRINGS_FALLBACK_MS = 30 * 24 * 60 * 60_000;
/** Directories in `runs/`/`logs/` without a DB row are removed only after this age. */
const DEFAULT_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

/** Result of one retention pass. */
export interface RetentionReport {
  startedAt: string;
  finishedAt: string;
  deletedRuns: Record<RunRetentionCategory, number>;
  deletedRunIds: string[];
  deletedBlocks: number;
  deletedNotifications: number;
  deletedCronFirings: number;
  orphanDirsRemoved: number;
  /** File/workspace deletion problems (rows are already gone). */
  errors: Array<{ runId?: string; path?: string; message: string }>;
}

/** Options of {@link RetentionService}. */
export interface RetentionServiceOptions {
  repositories: Pick<Repositories, 'runs' | 'retention'>;
  dataDir: string;
  /** Live retention settings (`config.global.retention`). */
  settings: () => RetentionConfig;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** Runs per query batch (default 200). */
  batchSize?: number;
  /** Min. age of orphaned run directories before they are removed (default 24 h). */
  orphanMinAgeMs?: number;
  /** Called after each pass (diagnostics/SSE). */
  onReport?: (report: RetentionReport) => void;
}

/** See module docs. */
export class RetentionService {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly batchSize: number;
  private timer: TimerHandle | undefined;
  private running: Promise<RetentionReport> | undefined;
  private stopped = false;
  private last: RetentionReport | null = null;

  constructor(private readonly options: RetentionServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'retention' });
    this.batchSize = options.batchSize ?? 200;
  }

  /** Report of the last pass, if any. */
  get lastReport(): RetentionReport | null {
    return this.last;
  }

  /** Schedule periodic passes: first after `initialDelayMs` (default 60 s), then every `cleanup_interval`. */
  start(initialDelayMs = 60_000): void {
    if (this.stopped) return;
    this.arm(initialDelayMs);
  }

  /** Stop the timer and wait for a running pass. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.runOnce()
        .catch((err: unknown) => this.logger.error('retention pass failed', { error: errorMessage(err) }))
        .finally(() => this.arm(this.options.settings().cleanupIntervalMs));
    }, Math.max(0, delayMs));
  }

  /** Run one pass now (a call during a running pass returns that pass). */
  runOnce(): Promise<RetentionReport> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<RetentionReport> {
    const settings = this.options.settings();
    const now = this.clock.now();
    const report: RetentionReport = {
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      deletedRuns: { successful: 0, failed: 0, blocked: 0 },
      deletedRunIds: [],
      deletedBlocks: 0,
      deletedNotifications: 0,
      deletedCronFirings: 0,
      orphanDirsRemoved: 0,
      errors: [],
    };
    const cutoff = (ms: number | null): Date | null => (ms === null ? null : new Date(now.getTime() - ms));
    const categories: Array<[RunRetentionCategory, Date | null]> = [
      ['successful', cutoff(settings.completedRunsMs)],
      ['failed', cutoff(settings.failedRunsMs)],
      ['blocked', cutoff(settings.blockedRunsMs)],
    ];
    for (const [category, before] of categories) {
      if (before === null || this.stopped) continue;
      await this.deleteRuns(category, before, report);
    }
    const { retention } = this.options.repositories;
    const blocksBefore = cutoff(settings.blockedRunsMs);
    if (blocksBefore) report.deletedBlocks = retention.deleteClearedBlocks(blocksBefore);
    const notificationsBefore = cutoff(settings.failedRunsMs);
    if (notificationsBefore) report.deletedNotifications = retention.deleteNotifications(notificationsBefore);
    const firingsBefore = cutoff(settings.completedRunsMs ?? CRON_FIRINGS_FALLBACK_MS);
    if (firingsBefore) report.deletedCronFirings = retention.deleteCronFirings(firingsBefore);
    if (!this.stopped) await this.removeOrphans(report);
    report.finishedAt = this.clock.now().toISOString();
    this.last = report;
    const total = report.deletedRuns.successful + report.deletedRuns.failed + report.deletedRuns.blocked;
    this.logger.info('retention pass finished', {
      deletedRuns: report.deletedRuns,
      deletedBlocks: report.deletedBlocks,
      deletedNotifications: report.deletedNotifications,
      deletedCronFirings: report.deletedCronFirings,
      orphanDirsRemoved: report.orphanDirsRemoved,
      errors: report.errors.length,
      total,
    });
    try {
      this.options.onReport?.(report);
    } catch (err) {
      this.logger.warn('retention report listener failed', { error: errorMessage(err) });
    }
    return report;
  }

  private async deleteRuns(category: RunRetentionCategory, before: Date, report: RetentionReport): Promise<void> {
    const { runs, retention } = this.options.repositories;
    const seen = new Set<string>();
    for (;;) {
      if (this.stopped) return;
      const batch = retention.runCandidates(category, before, this.batchSize).filter((c) => !seen.has(c.runId));
      if (batch.length === 0) return;
      for (const candidate of batch) {
        seen.add(candidate.runId);
        const run = runs.get(candidate.runId);
        const baseDir = snapshotBaseDir(run?.configSnapshot);
        // Re-checks the protection rules in the deleting transaction.
        if (!retention.deleteRun(candidate.runId)) continue;
        report.deletedRuns[category]++;
        report.deletedRunIds.push(candidate.runId);
        await this.removeRunFiles(candidate.runId, candidate.workspacePath, baseDir, report);
      }
      // Yield between batches so HTTP/SSE stay responsive.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async removeRunFiles(runId: string, workspacePath: string | null, baseDir: string | null, report: RetentionReport): Promise<void> {
    let paths;
    try {
      paths = dataPaths(this.options.dataDir).run(runId);
    } catch (err) {
      report.errors.push({ runId, message: errorMessage(err) });
      return;
    }
    for (const dir of [paths.runDir, paths.logDir]) await this.removeDir(dir, report, runId);
    if (workspacePath && baseDir) {
      const removal = await removeWorkspace(baseDir, workspacePath);
      if (!removal.removed && removal.reason === 'error') {
        report.errors.push({ runId, path: removal.path, message: removal.message ?? 'workspace removal failed' });
      } else if (!removal.removed && removal.reason !== 'missing') {
        this.logger.debug('workspace not removed by retention', { runId, reason: removal.reason });
      }
    }
  }

  private async removeDir(dir: string, report: RetentionReport, runId?: string): Promise<boolean> {
    if ((INSTANCE_LOCK_FILES as readonly string[]).includes(path.basename(dir))) return false;
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      report.errors.push({ ...(runId ? { runId } : {}), path: dir, message: errorMessage(err) });
      return false;
    }
  }

  /** Remove `runs/<id>` / `logs/<id>` directories whose run row no longer exists (e.g. after a failed delete). */
  private async removeOrphans(report: RetentionReport): Promise<void> {
    const paths = dataPaths(this.options.dataDir);
    const minAge = this.options.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;
    const now = this.clock.now().getTime();
    for (const parent of [paths.runsDir, paths.logsDir]) {
      let names: string[];
      try {
        names = await readdir(parent);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!isValidRunId(name) || this.options.repositories.runs.get(name)) continue;
        let dir: string;
        try {
          dir = resolveStrictlyWithin(parent, name);
          const st = await stat(dir);
          if (!st.isDirectory() || now - st.mtimeMs < minAge) continue;
        } catch {
          continue;
        }
        // Re-check right before deleting (a run could have been created meanwhile – IDs are unique, so only a stale dir matches).
        if (this.options.repositories.runs.get(name)) continue;
        if (await this.removeDir(dir, report)) report.orphanDirsRemoved++;
      }
    }
  }
}

/** `workspace.baseDir` from a run's config snapshot, if present. */
function snapshotBaseDir(snapshot: unknown): string | null {
  const ws = (snapshot as { workspace?: { baseDir?: unknown } } | null | undefined)?.workspace;
  return typeof ws?.baseDir === 'string' ? ws.baseDir : null;
}
