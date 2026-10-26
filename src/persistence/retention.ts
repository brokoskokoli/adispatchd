/**
 * Retention data access (Spec §21). Only queries and row deletion; the
 * periodic job and file/workspace deletion belong to WI-10.
 *
 * Protection rules – a run is never a candidate (and never deleted) if
 * - it is not terminal (active runs hold locks / may be recovered),
 * - its lifecycle chain is unfinished: `lifecycle_status` is `pending`,
 *   `running` or `failed`, or any journaled action is `pending`/`running`,
 * - an active (uncleared) retry block exists for its workflow and block scope.
 */
import type { DatabaseSync } from 'node:sqlite';
import { systemClock, type Clock } from '../core/index.js';
import { all, get, iso, run, str, transaction, type Params, type Row } from './sqlite.js';

/**
 * Run retention categories (Spec §5.1, §21): `successful` = `completed` + `success`;
 * `blocked` = technical failures counted into a retry block (the block's
 * counting period, `retention.blocked_runs`); `failed` = every other terminal
 * run (business failure, technical failure, cancelled).
 */
export type RunRetentionCategory = 'successful' | 'failed' | 'blocked';

/** A run eligible for deletion. */
export interface RunRetentionCandidate {
  runId: string;
  workflowId: string;
  finishedAt: string;
  /** Workspace to delete (caller must check it lies within `workspace.base_dir`). */
  workspacePath: string | null;
}

const PROTECTION_SQL = `
  r.status IN ('completed','crashed','start_error','timed_out','cancelled')
  AND (r.lifecycle_status IS NULL OR r.lifecycle_status = 'succeeded')
  AND NOT EXISTS (SELECT 1 FROM run_actions a WHERE a.run_id = r.id AND a.status IN ('pending','running'))
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.cleared_at IS NULL AND b.workflow_id = r.workflow_id
                    AND COALESCE(b.source_item_key, '') = COALESCE(r.source_item_key, ''))
  AND NOT EXISTS (SELECT 1 FROM locks l WHERE l.run_id = r.id)`;

/** Run belongs to the counting period of a (cleared or active) retry block. */
const BLOCKED_SQL = `(r.counted_technical_failure = 1 AND EXISTS (SELECT 1 FROM blocks b2 WHERE b2.workflow_id = r.workflow_id
    AND COALESCE(b2.source_item_key, '') = COALESCE(r.source_item_key, '') AND b2.generation = r.block_generation))`;

const CATEGORY_SQL: Record<RunRetentionCategory, string> = {
  successful: `(r.status = 'completed' AND r.business_result = 'success')`,
  failed: `(NOT (r.status = 'completed' AND r.business_result = 'success') AND NOT ${BLOCKED_SQL})`,
  blocked: BLOCKED_SQL,
};

/** Retention queries and deletions. */
export class RetentionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Runs of a category finished before `olderThan`, oldest first, excluding protected runs. */
  runCandidates(category: RunRetentionCategory, olderThan: Date | string, limit = 500): RunRetentionCandidate[] {
    return all(
      this.db,
      `SELECT r.id, r.workflow_id, r.finished_at, r.workspace_path FROM runs r
       WHERE ${CATEGORY_SQL[category]} AND r.finished_at IS NOT NULL AND r.finished_at < ? AND ${PROTECTION_SQL}
       ORDER BY r.finished_at ASC, r.id ASC LIMIT ?`,
      [iso(olderThan), limit],
    ).map((row: Row) => ({
      runId: String(row.id),
      workflowId: String(row.workflow_id),
      finishedAt: String(row.finished_at),
      workspacePath: str(row.workspace_path),
    }));
  }

  /** True if the run exists and is protected by one of the rules above. */
  isRunProtected(runId: string): boolean {
    const exists = get(this.db, 'SELECT 1 FROM runs WHERE id = ?', [runId]);
    if (!exists) return false;
    return !get(this.db, `SELECT 1 FROM runs r WHERE r.id = ? AND ${PROTECTION_SQL}`, [runId]);
  }

  /**
   * Delete a run row incl. events, actions and attempts (cascade). Re-checks
   * protection in the same transaction; returns `false` if protected or missing.
   */
  deleteRun(runId: string): boolean {
    return transaction(this.db, () => {
      const row = get(this.db, `SELECT r.source_item_key, r.created_at FROM runs r WHERE r.id = ? AND ${PROTECTION_SQL}`, [runId]);
      if (!row) return false;
      const deleted = run(this.db, 'DELETE FROM runs WHERE id = ?', [runId]).changes === 1;
      const itemKey = str(row.source_item_key);
      if (deleted && itemKey !== null) {
        // WI-33: the item history says that older entries were deleted by retention.
        run(
          this.db,
          `INSERT INTO item_history_gaps (item_key, deleted_runs, newest_deleted_at, updated_at) VALUES (?, 1, ?, ?)
           ON CONFLICT (item_key) DO UPDATE SET deleted_runs = deleted_runs + 1,
             newest_deleted_at = MAX(COALESCE(newest_deleted_at, ''), excluded.newest_deleted_at), updated_at = excluded.updated_at`,
          [itemKey, String(row.created_at), this.clock.now().toISOString()],
        );
      }
      return deleted;
    });
  }

  /**
   * Retention gap of an item (WI-33): number of its runs deleted by retention
   * (since 0.9.0) and the creation time of the newest deleted one; `null` if none.
   */
  itemGap(itemKey: string): { deletedRuns: number; newestDeletedAt: string | null } | null {
    const row = get(this.db, 'SELECT deleted_runs, newest_deleted_at FROM item_history_gaps WHERE item_key = ?', [itemKey]);
    return row ? { deletedRuns: Number(row.deleted_runs), newestDeletedAt: str(row.newest_deleted_at) } : null;
  }

  /** Delete cleared blocks cleared before `olderThan`. Active blocks are never deleted. Returns count. */
  deleteClearedBlocks(olderThan: Date | string): number {
    return run(this.db, 'DELETE FROM blocks WHERE cleared_at IS NOT NULL AND cleared_at < ?', [iso(olderThan)]).changes;
  }

  /** Delete delivered/failed notifications created before `olderThan`. Pending ones are kept. Returns count. */
  deleteNotifications(olderThan: Date | string): number {
    return run(this.db, `DELETE FROM notifications WHERE delivery_state <> 'pending' AND created_at < ?`, [iso(olderThan)])
      .changes;
  }

  /** Delete cron firings recorded before `olderThan`, keeping each workflow's latest one. Returns count. */
  deleteCronFirings(olderThan: Date | string): number {
    const params: Params = [iso(olderThan)];
    return run(
      this.db,
      `DELETE FROM cron_firings WHERE recorded_at < ?
         AND scheduled_for < (SELECT MAX(c2.scheduled_for) FROM cron_firings c2 WHERE c2.workflow_id = cron_firings.workflow_id)`,
      params,
    ).changes;
  }
}
