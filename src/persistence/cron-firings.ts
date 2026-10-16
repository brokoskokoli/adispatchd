/**
 * Cron idempotency and diagnostics (Spec §5.5, §7): at most one firing
 * record per `(workflow_id, scheduled_for)`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../core/index.js';
import { NotFoundError } from './errors.js';
import { all, get, iso, run, str, type Row } from './sqlite.js';

/**
 * Decision for a cron slot, e.g. `started`, `skipped_missed`, `skipped_limit`,
 * `skipped_condition`, `skipped_blocked`, `skipped_lock` (WI-09 owns the vocabulary).
 */
export type CronDecision = string;

/** A persisted cron firing. */
export interface CronFiringRecord {
  workflowId: string;
  /** Cron slot, ISO-8601 UTC. */
  scheduledFor: string;
  runId: string | null;
  decision: CronDecision;
  reason: string | null;
  recordedAt: string;
}

/** Input for {@link CronFiringRepository.record}. */
export interface RecordCronFiringInput {
  workflowId: string;
  scheduledFor: Date | string;
  decision: CronDecision;
  runId?: string | null;
  reason?: string | null;
}

/** Repository for `cron_firings`. */
export class CronFiringRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /**
   * Record a firing if none exists for the slot. Returns `inserted: false`
   * and the existing record if the slot was already handled (no duplicate run).
   */
  record(input: RecordCronFiringInput): { inserted: boolean; firing: CronFiringRecord } {
    const slot = iso(input.scheduledFor);
    const res = run(
      this.db,
      `INSERT INTO cron_firings (workflow_id, scheduled_for, run_id, decision, reason, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workflow_id, scheduled_for) DO NOTHING`,
      [input.workflowId, slot, input.runId ?? null, input.decision, input.reason ?? null, this.clock.now().toISOString()],
    );
    const firing = this.get(input.workflowId, slot);
    if (!firing) throw new NotFoundError('cron_firing', `${input.workflowId}@${slot}`);
    return { inserted: res.changes === 1, firing };
  }

  /** Update decision/run of an existing slot (e.g. `started` + run ID after reservation). */
  update(workflowId: string, scheduledFor: Date | string, change: { decision?: CronDecision; runId?: string | null; reason?: string | null }): CronFiringRecord {
    const slot = iso(scheduledFor);
    const current = this.get(workflowId, slot);
    if (!current) throw new NotFoundError('cron_firing', `${workflowId}@${slot}`);
    run(this.db, 'UPDATE cron_firings SET decision = ?, run_id = ?, reason = ? WHERE workflow_id = ? AND scheduled_for = ?', [
      change.decision ?? current.decision,
      change.runId !== undefined ? change.runId : current.runId,
      change.reason !== undefined ? change.reason : current.reason,
      workflowId,
      slot,
    ]);
    return this.get(workflowId, slot) as CronFiringRecord;
  }

  /** Firing for a slot or `null`. */
  get(workflowId: string, scheduledFor: Date | string): CronFiringRecord | null {
    const row = get(this.db, 'SELECT * FROM cron_firings WHERE workflow_id = ? AND scheduled_for = ?', [
      workflowId,
      iso(scheduledFor),
    ]);
    return row ? toFiring(row) : null;
  }

  /** Latest firing (by slot) of a workflow or `null`. */
  latest(workflowId: string): CronFiringRecord | null {
    const row = get(this.db, 'SELECT * FROM cron_firings WHERE workflow_id = ? ORDER BY scheduled_for DESC LIMIT 1', [workflowId]);
    return row ? toFiring(row) : null;
  }

  /** Firings of a workflow, newest slot first. */
  listForWorkflow(workflowId: string, limit = 100): CronFiringRecord[] {
    return all(this.db, 'SELECT * FROM cron_firings WHERE workflow_id = ? ORDER BY scheduled_for DESC LIMIT ?', [
      workflowId,
      limit,
    ]).map(toFiring);
  }
}

function toFiring(row: Row): CronFiringRecord {
  return {
    workflowId: String(row.workflow_id),
    scheduledFor: String(row.scheduled_for),
    runId: str(row.run_id),
    decision: String(row.decision),
    reason: str(row.reason),
    recordedAt: String(row.recorded_at),
  };
}
