/**
 * Test-only helpers for persistence tests (excluded from the build via
 * the `testing` directory exclude; not exported from the component index).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClock, type FinalizationTarget } from '../../core/index.js';
import { openPersistence, type Persistence } from '../persistence.js';
import type { BlockPolicy, ReserveRunInput, RunRecord } from '../runs.js';

/** Fresh temporary data dir. */
export function tempDataDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-persist-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Open a persistence instance on a fresh temp dir with a fake clock. */
export function openTestPersistence(): { p: Persistence; clock: FakeClock; dir: string; cleanup(): void } {
  const tmp = tempDataDir();
  const clock = new FakeClock('2026-10-16T19:00:00.000Z');
  const p = openPersistence(tmp.dir, { clock });
  return {
    p,
    clock,
    dir: tmp.dir,
    cleanup: () => {
      try {
        p.close();
      } finally {
        tmp.cleanup();
      }
    },
  };
}

/** Reserve a source run with sensible defaults. */
export function reserveSource(p: Persistence, workflowId: string, itemKey: string, extra: Partial<ReserveRunInput> = {}): RunRecord {
  return p.runs.reserve({
    workflowId,
    triggerType: 'source',
    sourceId: itemKey.split(':')[0] ?? null,
    sourceItemKey: itemKey,
    configSnapshot: { id: workflowId },
    ...extra,
  });
}

/** Drive a reserved run through starting/running/finalizing to its terminal status. */
export function completeRun(p: Persistence, runId: string, target: FinalizationTarget, blockPolicy?: BlockPolicy): RunRecord {
  p.runs.transition(runId, 'starting');
  p.runs.transition(runId, 'running', { update: { pid: 4242 } });
  p.runs.beginFinalization(runId, target, blockPolicy ? { blockPolicy } : {});
  return p.runs.finish(runId);
}

export const SUCCESS: FinalizationTarget = { status: 'completed', businessResult: 'success', reason: 'exit code 0' };
export const FAILURE: FinalizationTarget = { status: 'completed', businessResult: 'failure', reason: 'result failure' };
export const CRASH: FinalizationTarget = { status: 'crashed', businessResult: null, reason: 'exit code 1' };
export const TIMEOUT: FinalizationTarget = { status: 'timed_out', businessResult: null, reason: 'max_duration' };
export const CANCELLED: FinalizationTarget = { status: 'cancelled', businessResult: null, reason: 'cancelled by user' };
