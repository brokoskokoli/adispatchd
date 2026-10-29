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
    settings = { completedRunsMs: 30 * DAY, failedRunsMs: 90 * DAY, blockedRunsMs: null, maxLogSizePerRunBytes: 1024, cleanupIntervalMs: DAY, uiActionsMs: 365 * DAY, artifactsMs: null };
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

  it('deletes UI action audit entries after retention.ui_actions, whatever their result (WI-27)', async () => {
    const entry = { actor: 'alice', actorVia: 'password', identity: 'maintainer', sourceId: 'a', itemId: '1', itemKey: 'a:1', kind: 'comment' } as const;
    p.uiActions.record({ ...entry, result: 'succeeded' });
    p.uiActions.record({ ...entry, result: 'failed' });
    clock.advance(366 * DAY);
    p.uiActions.record({ ...entry, result: 'unknown' });
    const svc = new RetentionService({ repositories: p, dataDir: dir, settings: () => settings, clock, timers: clock });
    expect((await svc.runOnce()).deletedUiActions).toBe(2);
    expect(p.uiActions.list().actions.map((a) => a.result)).toEqual(['unknown']);
    settings = { ...settings, uiActionsMs: null };
    clock.advance(1000 * DAY);
    expect((await svc.runOnce()).deletedUiActions).toBe(0);
  });

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
    expect(existsSync(path.join(dir, 'adispatchd.sqlite'))).toBe(true);

    clock.advance(60 * DAY);
    const later = await svc.runOnce();
    expect(later.deletedRunIds.sort()).toEqual([recent.id, oldFailure.id].sort());
    expect(svc.lastReport).toBe(later);
  });

  it('deletes kept files (runs/<id>/kept, WI-22) together with the run', async () => {
    const old = completeRun(p, withFiles('coder', 'a:1').id, SUCCESS);
    const recentReserved = withFiles('coder', 'a:2');
    for (const id of [old.id, recentReserved.id]) {
      const keptDir = dataPaths(dir).run(id).keptDir;
      mkdirSync(path.join(keptDir, '.agent'), { recursive: true });
      writeFileSync(path.join(keptDir, '.agent', 'transcript.jsonl'), '{}');
    }
    clock.advance(31 * DAY);
    const recent = completeRun(p, recentReserved.id, SUCCESS);
    const svc = new RetentionService({ repositories: p, dataDir: dir, settings: () => settings, clock, timers: clock });
    const report = await svc.runOnce();
    expect(report.deletedRunIds).toEqual([old.id]);
    expect(existsSync(dataPaths(dir).run(old.id).keptDir)).toBe(false);
    expect(existsSync(path.join(dataPaths(dir).run(recent.id).keptDir, '.agent', 'transcript.jsonl'))).toBe(true);
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

  it('removes left-over token files of finished runs, keeps those of active or busy runs (WI-18)', async () => {
    const finished = completeRun(p, withFiles('coder', 'a:1').id, SUCCESS);
    const busy = completeRun(p, withFiles('coder', 'a:2').id, SUCCESS);
    const active = withFiles('coder', 'a:3');
    p.runs.transition(active.id, 'starting');
    const tokenDirs = (id: string) => {
      const runDir = dataPaths(dir).run(id).runDir;
      return [path.join(runDir, 'secrets'), path.join(runDir, 'actions', '1', 'attempt-1', 'secrets')];
    };
    for (const id of [finished.id, busy.id, active.id]) {
      for (const d of tokenDirs(id)) {
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, 'GH_TOKEN'), 'ghs_leftover');
      }
    }
    const svc = new RetentionService({
      repositories: p,
      dataDir: dir,
      settings: () => ({ ...settings, completedRunsMs: null }),
      clock,
      timers: clock,
      isBusy: (id) => id === busy.id,
    });
    // Token dirs younger than 60 s are kept (an attempt may just have started).
    clock.set(Date.now() + 30_000);
    expect((await svc.runOnce()).tokenDirsRemoved).toBe(0);
    clock.set(Date.now() + 120_000);
    const report = await svc.runOnce();
    expect(report.tokenDirsRemoved).toBe(2);
    expect(report.deletedRunIds).toEqual([]);
    for (const d of tokenDirs(finished.id)) expect(existsSync(d)).toBe(false);
    for (const d of [...tokenDirs(busy.id), ...tokenDirs(active.id)]) expect(existsSync(d)).toBe(true);
    // The rest of the run directory is untouched.
    expect(existsSync(dataPaths(dir).run(finished.id).contextFile)).toBe(true);
  });

  it('re-checks busy/terminal right before each token dir removal (WI-18)', async () => {
    const run = completeRun(p, withFiles('coder', 'a:1').id, SUCCESS);
    const runDir = dataPaths(dir).run(run.id).runDir;
    const dirs = [path.join(runDir, 'secrets'), path.join(runDir, 'actions', '1', 'attempt-1', 'secrets')];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, 'GH_TOKEN'), 'ghs_leftover');
    }
    let calls = 0;
    const svc = new RetentionService({
      repositories: p,
      dataDir: dir,
      settings: () => ({ ...settings, completedRunsMs: null }),
      clock,
      timers: clock,
      // Idle at the first check, busy from the second on (a manual retry started meanwhile).
      isBusy: () => ++calls > 1,
    });
    clock.set(Date.now() + 120_000);
    const report = await svc.runOnce();
    expect(report.tokenDirsRemoved).toBe(0);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
  });
});
