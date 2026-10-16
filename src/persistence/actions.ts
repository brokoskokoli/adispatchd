/**
 * Lifecycle action journal (Spec §10, §12): `run_actions` + `action_attempts`.
 * `succeeded` and `skipped` are final – a succeeded action is never executed again.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ActionStatus, Clock, HookName } from '../core/index.js';
import { InvalidTransitionError, NotFoundError } from './errors.js';
import { all, fromJson, get, run, str, toJson, transaction, type Row } from './sqlite.js';

/** Allowed action status changes. */
export const ACTION_STATUS_TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  pending: ['running', 'succeeded', 'failed', 'skipped'],
  // `running → pending`: recovery resets an interrupted attempt before retrying.
  running: ['succeeded', 'failed', 'pending'],
  // `failed → running|pending`: (manual) retry; `failed → skipped`: operator skips it.
  failed: ['running', 'pending', 'skipped'],
  succeeded: [],
  skipped: [],
};

/** Definition of one action when creating a journal. */
export interface ActionJournalEntry {
  /** Action type, e.g. `source.comment`. */
  type: string;
  /** Optional configured name/ID of the action. */
  name?: string | null;
  /** Action configuration from the run's config snapshot (no secrets). */
  config: unknown;
}

/** A journaled action. */
export interface RunActionRecord {
  /** Stable ID (also used for comment markers). */
  id: number;
  runId: string;
  hook: HookName;
  ordinal: number;
  type: string;
  name: string | null;
  config: unknown;
  status: ActionStatus;
  externalKey: string | null;
  /** Number of attempts started. */
  attempts: number;
  lastError: unknown;
  createdAt: string;
  updatedAt: string;
}

/** One execution attempt of an action. */
export interface ActionAttemptRecord {
  id: number;
  actionId: number;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'succeeded' | 'failed' | null;
  error: unknown;
  externalKey: string | null;
}

/** Failed action joined with its run (GUI "Failed Actions"). */
export interface FailedActionRecord extends RunActionRecord {
  workflowId: string;
  sourceItemKey: string | null;
  sourceUrl: string | null;
}

/** Repository for the action journal. */
export class ActionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /**
   * Create the journal for all actions of a hook (`pending`, ordinal 0..n-1).
   * Idempotent: if a journal for `(runId, hook)` already exists it is returned
   * unchanged (resume after restart).
   */
  createJournal(runId: string, hook: HookName, actions: readonly ActionJournalEntry[]): RunActionRecord[] {
    return transaction(this.db, () => {
      const existing = this.listForHook(runId, hook);
      if (existing.length > 0) return existing;
      if (!get(this.db, 'SELECT 1 FROM runs WHERE id = ?', [runId])) throw new NotFoundError('run', runId);
      const now = this.clock.now().toISOString();
      actions.forEach((action, ordinal) => {
        run(
          this.db,
          `INSERT INTO run_actions (run_id, hook, ordinal, action_type, action_name, action_config_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [runId, hook, ordinal, action.type, action.name ?? null, JSON.stringify(action.config ?? null), now, now],
        );
      });
      return this.listForHook(runId, hook);
    });
  }

  /** Action by ID or `null`. */
  get(id: number): RunActionRecord | null {
    const row = get(this.db, 'SELECT * FROM run_actions WHERE id = ?', [id]);
    return row ? toAction(row) : null;
  }

  /** Action by ID; throws {@link NotFoundError}. */
  require(id: number): RunActionRecord {
    const a = this.get(id);
    if (!a) throw new NotFoundError('action', id);
    return a;
  }

  /** All actions of a run, by hook creation then ordinal. */
  listForRun(runId: string): RunActionRecord[] {
    return all(this.db, 'SELECT * FROM run_actions WHERE run_id = ? ORDER BY id ASC', [runId]).map(toAction);
  }

  /** Actions of one hook in ordinal order. */
  listForHook(runId: string, hook: HookName): RunActionRecord[] {
    return all(this.db, 'SELECT * FROM run_actions WHERE run_id = ? AND hook = ? ORDER BY ordinal ASC', [runId, hook]).map(
      toAction,
    );
  }

  /**
   * Change an action's status (validated against {@link ACTION_STATUS_TRANSITIONS}).
   * `externalKey`/`error` are stored when given.
   */
  setStatus(
    id: number,
    status: ActionStatus,
    options: { externalKey?: string | null; error?: unknown; expectedFrom?: ActionStatus } = {},
  ): RunActionRecord {
    return transaction(this.db, () => {
      const current = this.require(id);
      if (options.expectedFrom !== undefined && current.status !== options.expectedFrom) {
        throw new InvalidTransitionError(`Action ${id} is '${current.status}', expected '${options.expectedFrom}'`, {
          actionId: id,
          from: current.status,
          to: status,
        });
      }
      if (current.status !== status && !ACTION_STATUS_TRANSITIONS[current.status].includes(status)) {
        throw new InvalidTransitionError(`Invalid action transition '${current.status}' → '${status}'`, {
          actionId: id,
          from: current.status,
          to: status,
        });
      }
      const sets = ['status = ?', 'updated_at = ?'];
      const params: (string | number | null)[] = [status, this.clock.now().toISOString()];
      if (options.externalKey !== undefined) {
        sets.push('external_key = ?');
        params.push(options.externalKey);
      }
      if (options.error !== undefined) {
        sets.push('last_error_json = ?');
        params.push(toJson(options.error ?? undefined));
      }
      run(this.db, `UPDATE run_actions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
      return this.require(id);
    });
  }

  /**
   * Start a new attempt: inserts `action_attempts` row (attempt = previous + 1),
   * increments `attempts` and sets the action `running`.
   */
  startAttempt(actionId: number): ActionAttemptRecord {
    return transaction(this.db, () => {
      const action = this.require(actionId);
      if (action.status !== 'running') this.setStatus(actionId, 'running');
      const next = Number(
        get(this.db, 'SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM action_attempts WHERE run_action_id = ?', [actionId])?.n ?? 1,
      );
      const now = this.clock.now().toISOString();
      const res = run(this.db, 'INSERT INTO action_attempts (run_action_id, attempt, started_at) VALUES (?, ?, ?)', [
        actionId,
        next,
        now,
      ]);
      run(this.db, 'UPDATE run_actions SET attempts = ?, updated_at = ? WHERE id = ?', [next, now, actionId]);
      return this.requireAttempt(res.lastInsertRowid);
    });
  }

  /**
   * Record the end of an attempt. Does not change the action status – the
   * lifecycle engine decides (retry → stays `running`/`pending`, give up → `failed`).
   */
  finishAttempt(
    attemptId: number,
    outcome: 'succeeded' | 'failed',
    options: { error?: unknown; externalKey?: string | null } = {},
  ): ActionAttemptRecord {
    return transaction(this.db, () => {
      const attempt = this.requireAttempt(attemptId);
      const now = this.clock.now().toISOString();
      run(this.db, 'UPDATE action_attempts SET finished_at = ?, outcome = ?, error_json = ?, external_key = ? WHERE id = ?', [
        now,
        outcome,
        toJson(options.error ?? undefined),
        options.externalKey ?? null,
        attemptId,
      ]);
      if (options.error !== undefined) {
        run(this.db, 'UPDATE run_actions SET last_error_json = ?, updated_at = ? WHERE id = ?', [
          toJson(options.error),
          now,
          attempt.actionId,
        ]);
      }
      return this.requireAttempt(attemptId);
    });
  }

  /** Attempts of an action in order. */
  listAttempts(actionId: number): ActionAttemptRecord[] {
    return all(this.db, 'SELECT * FROM action_attempts WHERE run_action_id = ? ORDER BY attempt ASC', [actionId]).map(toAttempt);
  }

  /** All `failed` actions with run context, newest first (GUI / retry). */
  listFailed(): FailedActionRecord[] {
    return all(
      this.db,
      `SELECT a.*, r.workflow_id AS r_workflow_id, r.source_item_key AS r_item, r.source_url AS r_url
       FROM run_actions a JOIN runs r ON r.id = a.run_id
       WHERE a.status = 'failed' ORDER BY a.updated_at DESC, a.id DESC`,
    ).map((row) => ({
      ...toAction(row),
      workflowId: String(row.r_workflow_id),
      sourceItemKey: str(row.r_item),
      sourceUrl: str(row.r_url),
    }));
  }

  /** IDs of runs with `pending` or `running` actions (recovery: resume chains). */
  runIdsWithIncompleteActions(): string[] {
    return all(
      this.db,
      `SELECT DISTINCT run_id FROM run_actions WHERE status IN ('pending', 'running') ORDER BY run_id ASC`,
    ).map((r) => String(r.run_id));
  }

  private requireAttempt(id: number): ActionAttemptRecord {
    const row = get(this.db, 'SELECT * FROM action_attempts WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('action_attempt', id);
    return toAttempt(row);
  }
}

function toAction(row: Row): RunActionRecord {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    hook: row.hook as HookName,
    ordinal: Number(row.ordinal),
    type: String(row.action_type),
    name: str(row.action_name),
    config: fromJson(row.action_config_json),
    status: row.status as ActionStatus,
    externalKey: str(row.external_key),
    attempts: Number(row.attempts),
    lastError: fromJson(row.last_error_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAttempt(row: Row): ActionAttemptRecord {
  return {
    id: Number(row.id),
    actionId: Number(row.run_action_id),
    attempt: Number(row.attempt),
    startedAt: String(row.started_at),
    finishedAt: str(row.finished_at),
    outcome: (str(row.outcome) as 'succeeded' | 'failed' | null) ?? null,
    error: fromJson(row.error_json),
    externalKey: str(row.external_key),
  };
}
