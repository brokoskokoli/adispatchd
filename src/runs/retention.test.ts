import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths, type FakeClock } from '../core/index.js';
import type { RetentionConfig } from '../config/index.js';
import type { Persistence, RunRecord } from '../persistence/index.js';
import { CRASH, FAILURE, SUCCESS, completeRun, openTestPersistence, reserveSource } from '../persistence/testing/helpers.js';
import { RetentionService } from './retention.js';

const DAY = 24 * 60 * 60_000;

describe('RetentionService', () => {
  let p: Persistence;
  let clock: FakeClock;
  let dir: string;
  let cleanup: () => void;
  let settings: RetentionConfig;
  let baseDir: string;

  beforeEach(() => {
    ({ p, clock, dir, cleanup } = openTestPersistence());
    baseDir = path.join(dir, 'workspaces');
    settings = { completedRunsMs: 30 * DAY, failedRunsMs: 90 * DAY, blockedRunsMs: null, maxLogSizePerRunBytes: 1024, cleanupIntervalMs: DAY };
  });
  afterEach(() => cleanup());

  /** Run with files: runs/<id>, logs/<id>, workspace. */
  const withFiles = (workflowId: string, itemKey: string): RunRecord => {
    const reserved = reserveSource(p, workflowId, itemKey, { configSnapshot: { workspace: { baseDir } } });
    const ws = path.join(baseDir, workflowId, reserved.id);
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'work.txt'), 'x');
    p.runs.update(reserved.id, { workspacePath: ws });
    const paths = dataPaths(dir).run(reserved.id);
    mkdirSync(path.join(paths.runDir, 'actions', '1'), { recursive: true });
    writeFileSync(paths.contextFile, '{}');
    mkdirSync(paths.logDir, { recursive: true });
    writeFileSync(paths.stdoutLog, 'log');
    return reserved;
  };
  const exists = (id: string) => {
    const paths = dataPaths(dir).run(id);
    return { run: existsSync(paths.runDir), log: existsSync(paths.logDir) };
  };

  it('deletes old successful runs incl. files and workspace, keeps active runs, open blocks and failed chains', async () => {
    const oldSuccess = completeRun(p, withFiles('coder', 'a:1').id, SUCCESS);
    const oldFailure = completeRun(p, withFiles('coder', 'a:2').id, FAILURE); // 90 days for failures
    const active = withFiles('coder', 'a:3');
    p.runs.transition(active.id, 'starting');
    const blocked = completeRun(p, withFiles('coder', 'a:4').id, CRASH, { maxTechnicalFailures: 1 });
    const lifecycleFailed = completeRun(p, withFiles('coder', 'a:5').id, SUCCESS);
    p.runs.update(lifecycleFailed.id, { lifecycleStatus: 'failed' });
    clock.advance(31 * DAY);
    const recent = completeRun(p, withFiles('coder', 'a:6').id, SUCCESS);

    const svc = new RetentionService({ repositories: p, dataDir: dir, settings: () => settings, clock, timers: clock });
    const report = await svc.runOnce();

    expect(report.deletedRunIds).toEqual([oldSuccess.id]);
    expect(report.deletedRuns).toEqual({ successful: 1, failed: 0, blocked: 0 });
    expect(p.runs.get(oldSuccess.id)).toBeNull();
    expect(exists(oldSuccess.id)).toEqual({ run: false, log: false });
    expect(existsSync(path.join(baseDir, 'coder', oldSuccess.id))).toBe(false);
    for (const kept of [oldFailure, active, blocked, lifecycleFailed, recent]) {
      expect(p.runs.get(kept.id)).not.toBeNull();
      expect(exists(kept.id)).toEqual({ run: true, log: true });
    }
    // Instance lock files are never touched.
    expect(existsSync(path.join(dir, 'orchestrator.sqlite'))).toBe(true);

    clock.advance(60 * DAY);
    const later = await svc.runOnce();
    expect(later.deletedRunIds.sort()).toEqual([recent.id, oldFailure.id].sort());
    expect(svc.lastReport).toBe(later);
  });

  it('applies blocked_runs to runs of a cleared block and removes old orphan directories', async () => {
    settings = { ...settings, blockedRunsMs: 10 * DAY };
    const crash = completeRun(p, withFiles('coder', 'a:1').id, CRASH, { maxTechnicalFailures: 1 });
    const block = p.blocks.activeFor('coder', 'a:1')!;
    // Orphan run directory without DB row.
    const orphan = 'run-20260101T000000000Z-deadbeef';
    const orphanDir = path.join(dataPaths(dir).runsDir, orphan);
    mkdirSync(orphanDir, { recursive: true });
    const old = new Date(Date.now() - 2 * DAY);
    utimesSync(orphanDir, old, old);
    clock.set(Date.now() + 1000); // FakeClock in real time for the mtime comparison
    clock.advance(11 * DAY);
    const svc = new RetentionService({ repositories: p, dataDir: dir, settings: () => settings, clock, timers: clock });
    let report = await svc.runOnce();
    expect(report.deletedRunIds).toEqual([]); // block still active
    expect(report.orphanDirsRemoved).toBe(1);
    expect(existsSync(orphanDir)).toBe(false);

    p.blocks.clear(block.id, 'test');
    clock.advance(11 * DAY);
    report = await svc.runOnce();
    expect(report.deletedRuns.blocked).toBe(1);
    expect(report.deletedRunIds).toEqual([crash.id]);
    expect(report.deletedBlocks).toBe(1);
  });

  it('runs periodically with the configured interval', async () => {
    completeRun(p, withFiles('coder', 'a:1').id, SUCCESS);
    clock.advance(31 * DAY);
    const reports: number[] = [];
    let notify: () => void = () => undefined;
    const nextReport = () => new Promise<void>((r) => (notify = r));
    const svc = new RetentionService({
      repositories: p,
      dataDir: dir,
      settings: () => settings,
      clock,
      timers: clock,
      onReport: (r) => {
        reports.push(r.deletedRunIds.length);
        notify();
      },
    });
    svc.start(1000);
    let report = nextReport();
    await clock.advanceAsync(1000);
    await report;
    expect(reports).toEqual([1]);
    // The next pass is armed after the first one finished.
    for (let i = 0; i < 100 && clock.pendingTimers() === 0; i++) await new Promise((r) => setImmediate(r));
    report = nextReport();
    await clock.advanceAsync(DAY);
    await report;
    expect(reports).toEqual([1, 0]);
    await svc.stop();
    expect(clock.pendingTimers()).toBe(0);
  });
});
