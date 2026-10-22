/**
 * Runs and active locks (Spec §7, §8, §11, §12).
 *
 * The state machine from core (`canTransition`, `RUN_STATUS_TRANSITIONS`) is
 * enforced here. Every terminal status is reached only through `finalizing`:
 * {@link RunRepository.beginFinalization} persists the
 * {@link FinalizationTarget}, updates the technical-failure counter and (if
 * the limit is reached) creates the retry block – all in one transaction;
 * {@link RunRepository.finish} then moves to exactly the persisted target and
 * releases the lock in the same transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  ACTIVE_STATUSES,
  canTransition,
  createRunId,
  isHookName,
  isTechnicalFailure,
  isTerminalStatus,
  type BusinessResult,
  type Clock,
  type FinalizationTarget,
  type HookName,
  type LifecycleStatus,
  type ProcessStartIdentity,
  type TechnicalStatus,
  type TerminalStatus,
  type TriggerType,
} from '../core/index.js';
import type { BlockRecord, BlockRepository } from './blocks.js';
import { BlockedError, InvalidTransitionError, LockConflictError, NotFoundError } from './errors.js';
import { RUN_STATUS_EVENT, type EventRepository } from './events.js';
import { lockKeyFor } from './lock-keys.js';
import { all, fromJson, get, iso, num, placeholders, run, str, toJson, transaction, type Params, type Row } from './sqlite.js';

/** A persisted run. JSON columns are parsed. */
export interface RunRecord {
  id: string;
  workflowId: string;
  triggerType: TriggerType;
  sourceId: string | null;
  sourceItemKey: string | null;
  sourceUrl: string | null;
  /** See `lockKeyFor` for semantics. */
  lockKey: string;
  /** Cron slot (ISO) for scheduled runs. */
  scheduledFor: string | null;
  /** Workflow configuration snapshot taken at reservation (Spec §12, §19). */
  configSnapshot: unknown;
  parameters: Record<string, unknown> | null;
  /** Identity ID used by the run, if any. */
  identity: string | null;
  /** Executed command (as JSON, e.g. `{command, args}`), for diagnostics. */
  command: unknown;
  status: TechnicalStatus;
  /** Persisted finalization target (set when entering `finalizing`). */
  finalStatus: TerminalStatus | null;
  businessResult: BusinessResult;
  finalReason: string | null;
  exitCode: number | null;
  pid: number | null;
  processStartIdentity: ProcessStartIdentity | null;
  workspacePath: string | null;
  /** Last worker `status` event message. */
  statusMessage: string | null;
  /** Parsed worker result file (if valid). */
  result: unknown;
  /**
   * Named business outcome from the result file (WI-17, `result.outcome`);
   * set with `→ finalizing` for `completed` runs only.
   */
  outcome: string | null;
  /**
   * Completion hook selected at `→ finalizing` (WI-17, e.g. `on_result.approved`,
   * `on_error`); recovery resumes exactly this hook. `null` if no hook runs
   * (run never reached `starting`) or for runs finalized before 0.3.0.
   */
  completionHook: HookName | null;
  /**
   * WI-30: this run created a retry block and `on_retry_block` is appended to
   * its finalization (after the completion hook); set with `→ finalizing`.
   */
  retryBlockHook: boolean;
  /** Technical error diagnostics (no secrets). */
  error: unknown;
  lifecycleStatus: LifecycleStatus | null;
  /** Failure-counting period at finalization. */
  blockGeneration: number | null;
  /** True if this run's outcome incremented the technical-failure counter. */
  countedTechnicalFailure: boolean;
  createdAt: string;
  startedAt: string | null;
  finalizingAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Input for {@link RunRepository.reserve}. */
export interface ReserveRunInput {
  /** Run ID; generated via `createRunId` if omitted. */
  id?: string;
  workflowId: string;
  triggerType: TriggerType;
  sourceId?: string | null;
  /** `sourceItemKey(sourceId, itemId)`; required for `source` runs, optional for manual runs. */
  sourceItemKey?: string | null;
  sourceUrl?: string | null;
  /** Cron slot; required for `schedule` runs without item. */
  scheduledFor?: Date | string | null;
  configSnapshot: unknown;
  parameters?: Record<string, unknown> | null;
  identity?: string | null;
  command?: unknown;
  workspacePath?: string | null;
  /**
   * Also refuse (atomically) if an active retry block exists for the run's
   * block scope. Scheduler: `true`; manual starts: `false` (Spec §7, §11).
   */
  failIfBlocked?: boolean;
}

/** Mutable non-status fields. `undefined` = unchanged. */
export interface RunUpdate {
  pid?: number | null;
  processStartIdentity?: ProcessStartIdentity | null;
  workspacePath?: string | null;
  statusMessage?: string | null;
  lifecycleStatus?: LifecycleStatus | null;
  exitCode?: number | null;
  result?: unknown;
  outcome?: string | null;
  completionHook?: HookName | null;
  error?: unknown;
  configSnapshot?: unknown;
  identity?: string | null;
  command?: unknown;
  startedAt?: Date | string | null;
}

/** Retry-block policy applied in {@link RunRepository.beginFinalization}. */
export interface BlockPolicy {
  /** Block when the consecutive technical failures reach this number (≥ 1). */
  maxTechnicalFailures: number;
  /** Block reason; default describes the count and the final reason. */
  reason?: string;
  /** Mark the run for `on_retry_block` (WI-30) if this finalization creates the block. */
  retryBlockHook?: boolean;
}

/** Options for {@link RunRepository.beginFinalization}. */
export interface BeginFinalizationOptions {
  update?: RunUpdate;
  blockPolicy?: BlockPolicy;
  /**
   * Apply the outcome to the technical-failure counter (default `true`).
   * `false` for lifecycle runs (trigger `unblock`, WI-30): neither counted nor reset.
   */
  countOutcome?: boolean;
}

/** Outcome of {@link RunRepository.beginFinalization}. */
export interface FinalizationResult {
  run: RunRecord;
  /** True if the target is a technical failure (counted). */
  technicalFailure: boolean;
  /** Counter value after applying this outcome. */
  consecutiveTechnicalFailures: number;
  /** Block created in this transaction (caller emits `retry_block_created`). */
  blockCreated: BlockRecord | null;
}

/** Query for {@link RunRepository.list}. */
export interface RunListQuery {
  workflowId?: string;
  statuses?: readonly TechnicalStatus[];
  triggerType?: TriggerType;
  sourceItemKey?: string;
  businessResult?: 'success' | 'failure';
  /** Only runs created before this time (exclusive). */
  createdBefore?: Date | string;
  /** Default 50, max 500. */
  limit?: number;
  offset?: number;
}

/** A page of runs, newest first. */
export interface RunPage {
  runs: RunRecord[];
  total: number;
}

/** An active reservation. */
export interface LockRecord {
  workflowId: string;
  lockKey: string;
  runId: string;
  sourceItemKey: string | null;
  acquiredAt: string;
}

const ACTIVE_SQL = `(${ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')})`;

/** Repository for `runs` and `locks`. */
export class RunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
    private readonly events: EventRepository,
    private readonly blocks: BlockRepository,
  ) {}

  /**
   * Atomically reserve a run: check + create the lock `(workflowId, lockKey)`
   * and insert the run in status `reserved`. Throws {@link LockConflictError}
   * if an active run holds the lock, {@link BlockedError} with `failIfBlocked`.
   */
  reserve(input: ReserveRunInput): RunRecord {
    if (input.triggerType === 'source' && !input.sourceItemKey) {
      throw new TypeError('Source-triggered runs require sourceItemKey');
    }
    const id = input.id ?? createRunId({ clock: this.clock });
    const lockKey = lockKeyFor({
      triggerType: input.triggerType,
      runId: id,
      sourceItemKey: input.sourceItemKey ?? null,
      scheduledFor: input.scheduledFor ?? null,
    });
    const itemKey = input.sourceItemKey ?? null;
    return transaction(this.db, () => {
      const holder = this.activeLock(input.workflowId, lockKey);
      if (holder) throw new LockConflictError(input.workflowId, lockKey, holder.runId);
      if (input.failIfBlocked) {
        const block = this.blocks.activeFor(input.workflowId, itemKey);
        if (block) throw new BlockedError(input.workflowId, itemKey, block.id);
        // WI-30: while the `on_retry_unblock` chain of a removed block runs, no automatic start
        // (item scope: also the lock; workflow scope, e.g. cron: only this check).
        const unblock = this.activeUnblockRun(input.workflowId, itemKey);
        if (unblock) throw new BlockedError(input.workflowId, itemKey, this.blocks.clearedByRun(unblock.id)?.id ?? 0);
      }
      const now = this.clock.now().toISOString();
      try {
        run(
          this.db,
          `INSERT INTO runs (id, workflow_id, trigger_type, source_id, source_item_key, source_url, lock_key, scheduled_for,
             config_snapshot, parameters_json, identity, command, status, workspace_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
          [
            id,
            input.workflowId,
            input.triggerType,
            input.sourceId ?? null,
            itemKey,
            input.sourceUrl ?? null,
            lockKey,
            input.scheduledFor ? iso(input.scheduledFor) : null,
            JSON.stringify(input.configSnapshot ?? null),
            toJson(input.parameters ?? undefined),
            input.identity ?? null,
            toJson(input.command),
            input.workspacePath ?? null,
            now,
            now,
          ],
        );
        run(this.db, 'INSERT INTO locks (workflow_id, lock_key, run_id, source_item_key, acquired_at) VALUES (?, ?, ?, ?, ?)', [
          input.workflowId,
          lockKey,
          id,
          itemKey,
          now,
        ]);
      } catch (err) {
        // Defensive: unique constraints are the final arbiter.
        if (err instanceof Error && /UNIQUE constraint failed: (locks|runs)\.(workflow_id|lock_key)/.test(err.message)) {
          const h = this.activeLock(input.workflowId, lockKey);
          throw new LockConflictError(input.workflowId, lockKey, h?.runId ?? 'unknown');
        }
        throw err;
      }
      this.events.append(id, RUN_STATUS_EVENT, { from: null, to: 'reserved' });
      return this.require(id);
    });
  }

  /**
   * Non-final transition (e.g. `reserved → starting`, `starting → running`,
   * `→ cancelling`, `→ recovery_pending`). `finalizing` and terminal statuses
   * must go through {@link beginFinalization} / {@link finish}.
   */
  transition(runId: string, to: TechnicalStatus, options: { expectedFrom?: TechnicalStatus; update?: RunUpdate } = {}): RunRecord {
    if (to === 'finalizing' || isTerminalStatus(to)) {
      throw new InvalidTransitionError(`Use beginFinalization()/finish() to move to '${to}'`, { runId, to });
    }
    return transaction(this.db, () => {
      const current = this.require(runId);
      this.assertTransition(current, to, options.expectedFrom);
      const extra = options.update ? { ...options.update } : {};
      if (to === 'running' && extra.startedAt === undefined && current.startedAt === null) {
        extra.startedAt = this.clock.now();
      }
      this.applyUpdate(runId, extra, { status: to });
      this.events.append(runId, RUN_STATUS_EVENT, { from: current.status, to });
      return this.require(runId);
    });
  }

  /**
   * `X → finalizing`: persist the {@link FinalizationTarget}, apply the
   * outcome to the technical-failure counter and – if `blockPolicy` is given
   * and the limit is reached and no block is active – create the retry block,
   * all in one transaction (Spec §11 "important order").
   */
  beginFinalization(runId: string, target: FinalizationTarget, options: BeginFinalizationOptions = {}): FinalizationResult {
    validateTarget(target);
    if (options.blockPolicy && !(Number.isInteger(options.blockPolicy.maxTechnicalFailures) && options.blockPolicy.maxTechnicalFailures >= 1)) {
      throw new TypeError('blockPolicy.maxTechnicalFailures must be an integer ≥ 1');
    }
    return transaction(this.db, () => {
      const current = this.require(runId);
      this.assertTransition(current, 'finalizing');
      const counted = options.countOutcome !== false;
      const technicalFailure = counted && isTechnicalFailure(target.status);
      const effect = !counted
        ? 'none'
        : technicalFailure
          ? 'increment'
          : target.status === 'completed' && target.businessResult === 'success'
            ? 'reset'
            : 'none';
      const counter = this.blocks.applyOutcome(current.workflowId, current.sourceItemKey, effect);
      const now = this.clock.now().toISOString();
      this.applyUpdate(runId, options.update ?? {}, {
        status: 'finalizing',
        final_status: target.status,
        business_result: target.businessResult,
        final_reason: target.reason,
        finalizing_at: now,
        block_generation: counter.generation,
        counted_technical_failure: technicalFailure ? 1 : 0,
      });
      let blockCreated: BlockRecord | null = null;
      const policy = options.blockPolicy;
      if (
        technicalFailure &&
        policy &&
        counter.consecutive >= policy.maxTechnicalFailures &&
        !this.blocks.isBlocked(current.workflowId, current.sourceItemKey)
      ) {
        blockCreated = this.blocks.create({
          workflowId: current.workflowId,
          itemKey: current.sourceItemKey,
          reason:
            policy.reason ??
            `${counter.consecutive} consecutive technical failures (last: ${target.status}: ${target.reason})`,
          runId,
          failureCount: counter.consecutive,
          lastStatus: target.status,
        });
        if (policy.retryBlockHook) run(this.db, 'UPDATE runs SET retry_block_hook = 1 WHERE id = ?', [runId]);
      }
      this.events.append(runId, RUN_STATUS_EVENT, {
        from: current.status,
        to: 'finalizing',
        target: { status: target.status, businessResult: target.businessResult, reason: target.reason },
        ...(options.update?.outcome ? { outcome: options.update.outcome } : {}),
        ...(options.update?.completionHook ? { hook: options.update.completionHook } : {}),
        ...(blockCreated ? { blockId: blockCreated.id } : {}),
        ...(blockCreated && policy?.retryBlockHook ? { retryBlockHook: true } : {}),
      });
      return {
        run: this.require(runId),
        technicalFailure,
        consecutiveTechnicalFailures: counter.consecutive,
        blockCreated,
      };
    });
  }

  /**
   * `finalizing → <persisted target status>`: sets `finished_at` and releases
   * the lock in the same transaction.
   */
  finish(runId: string, options: { update?: RunUpdate } = {}): RunRecord {
    return transaction(this.db, () => {
      const current = this.require(runId);
      const target = finalizationTarget(current);
      if (current.status !== 'finalizing' || !target) {
        throw new InvalidTransitionError(`Run '${runId}' is not finalizing (status '${current.status}')`, {
          runId,
          from: current.status,
        });
      }
      if (!canTransition('finalizing', target.status, target)) {
        throw new InvalidTransitionError(`Invalid final status '${target.status}'`, { runId, to: target.status });
      }
      this.applyUpdate(runId, options.update ?? {}, { status: target.status, finished_at: this.clock.now().toISOString() });
      run(this.db, 'DELETE FROM locks WHERE run_id = ?', [runId]);
      this.events.append(runId, RUN_STATUS_EVENT, { from: 'finalizing', to: target.status });
      return this.require(runId);
    });
  }

  /** Update non-status fields (pid, start identity, lifecycle status, ...). */
  update(runId: string, update: RunUpdate): RunRecord {
    return transaction(this.db, () => {
      this.require(runId);
      this.applyUpdate(runId, update, {});
      return this.require(runId);
    });
  }

  /** Run by ID or `null`. */
  get(runId: string): RunRecord | null {
    const row = get(this.db, 'SELECT * FROM runs WHERE id = ?', [runId]);
    return row ? toRun(row) : null;
  }

  /** Run by ID; throws {@link NotFoundError}. */
  require(runId: string): RunRecord {
    const r = this.get(runId);
    if (!r) throw new NotFoundError('run', runId);
    return r;
  }

  /** All runs in active (non-terminal) states, oldest first (recovery, dashboard). */
  listActive(workflowId?: string): RunRecord[] {
    const params: Params = [];
    let sql = `SELECT * FROM runs WHERE status IN ${ACTIVE_SQL}`;
    if (workflowId !== undefined) {
      sql += ' AND workflow_id = ?';
      params.push(workflowId);
    }
    return all(this.db, `${sql} ORDER BY created_at ASC, id ASC`, params).map(toRun);
  }

  /**
   * Number of active runs (all triggers incl. manual), optionally per workflow (Spec §7 concurrency).
   * Lifecycle runs of removed blocks (trigger `unblock`, WI-30) start no worker and do not count.
   */
  countActive(workflowId?: string, sourceId?: string): number {
    const base = `SELECT COUNT(*) AS n FROM runs WHERE status IN ${ACTIVE_SQL} AND trigger_type <> 'unblock'`;
    const row =
      workflowId === undefined
        ? get(this.db, base)
        : sourceId === undefined
          ? get(this.db, `${base} AND workflow_id = ?`, [workflowId])
          : get(this.db, `${base} AND workflow_id = ? AND source_id = ?`, [workflowId, sourceId]);
    return Number(row?.n ?? 0);
  }

  /**
   * Active runs in the block scope of `(workflowId, itemKey)` (WI-30): the
   * run holding the item lock, or for `itemKey = null` every active run of
   * the workflow without item.
   */
  activeRunsInBlockScope(workflowId: string, itemKey: string | null): RunRecord[] {
    if (itemKey !== null) {
      const run = this.activeRunForItem(workflowId, itemKey);
      return run ? [run] : [];
    }
    return all(this.db, `SELECT * FROM runs WHERE status IN ${ACTIVE_SQL} AND workflow_id = ? AND source_item_key IS NULL ORDER BY created_at ASC`, [
      workflowId,
    ]).map(toRun);
  }

  /** Active lifecycle run (trigger `unblock`, WI-30) in the block scope of `(workflowId, itemKey)`, or `null`. */
  activeUnblockRun(workflowId: string, itemKey: string | null): RunRecord | null {
    const row = get(
      this.db,
      `SELECT * FROM runs WHERE status IN ${ACTIVE_SQL} AND trigger_type = 'unblock' AND workflow_id = ?
         AND COALESCE(source_item_key, '') = ? LIMIT 1`,
      [workflowId, itemKey ?? ''],
    );
    return row ? toRun(row) : null;
  }

  /** Run history with filter and paging, newest first. */
  list(query: RunListQuery = {}): RunPage {
    const where: string[] = [];
    const params: Params = [];
    if (query.workflowId !== undefined) {
      where.push('workflow_id = ?');
      params.push(query.workflowId);
    }
    if (query.statuses && query.statuses.length > 0) {
      where.push(`status IN (${placeholders(query.statuses.length)})`);
      params.push(...query.statuses);
    }
    if (query.triggerType !== undefined) {
      where.push('trigger_type = ?');
      params.push(query.triggerType);
    }
    if (query.sourceItemKey !== undefined) {
      where.push('source_item_key = ?');
      params.push(query.sourceItemKey);
    }
    if (query.businessResult !== undefined) {
      where.push('business_result = ?');
      params.push(query.businessResult);
    }
    if (query.createdBefore !== undefined) {
      where.push('created_at < ?');
      params.push(iso(query.createdBefore));
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, query.limit ?? 50), 500);
    const offset = Math.max(0, query.offset ?? 0);
    const total = Number(get(this.db, `SELECT COUNT(*) AS n FROM runs ${clause}`, params)?.n ?? 0);
    const runs = all(this.db, `SELECT * FROM runs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]).map(toRun);
    return { runs, total };
  }

  /** Latest run (by creation) for an item key, across workflows unless `workflowId` is given. */
  lastRunForItem(itemKey: string, options: { workflowId?: string; finishedOnly?: boolean } = {}): RunRecord | null {
    return this.lastRunsForItems([itemKey], options).get(itemKey) ?? null;
  }

  /**
   * Latest run per item key (views: `run.last_*`, Spec §17). Keys without runs are absent.
   * Lifecycle runs of removed blocks (trigger `unblock`, WI-30) are not considered.
   */
  lastRunsForItems(
    itemKeys: readonly string[],
    options: { workflowId?: string; finishedOnly?: boolean } = {},
  ): Map<string, RunRecord> {
    const result = new Map<string, RunRecord>();
    const unique = [...new Set(itemKeys)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const params: Params = [...chunk];
      let filter = '';
      if (options.workflowId !== undefined) {
        filter += ' AND workflow_id = ?';
        params.push(options.workflowId);
      }
      if (options.finishedOnly) filter += ' AND finished_at IS NOT NULL';
      const order = options.finishedOnly ? 'finished_at DESC, id DESC' : 'created_at DESC, id DESC';
      const rows = all(
        this.db,
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY source_item_key ORDER BY ${order}) AS rn
           FROM runs WHERE source_item_key IN (${placeholders(chunk.length)}) AND trigger_type <> 'unblock'${filter}
         ) WHERE rn = 1`,
        params,
      );
      for (const row of rows) result.set(String(row.source_item_key), toRun(row));
    }
    return result;
  }

  /** Active lock for `(workflowId, lockKey)` or `null`. */
  activeLock(workflowId: string, lockKey: string): LockRecord | null {
    const row = get(this.db, 'SELECT * FROM locks WHERE workflow_id = ? AND lock_key = ?', [workflowId, lockKey]);
    return row ? toLock(row) : null;
  }

  /** Active run of a workflow for a source item (scheduler step 4), or `null`. */
  activeRunForItem(workflowId: string, itemKey: string): RunRecord | null {
    const lock = this.activeLock(workflowId, lockKeyFor({ triggerType: 'source', runId: '', sourceItemKey: itemKey }));
    return lock ? this.get(lock.runId) : null;
  }

  /** All active locks. */
  listLocks(): LockRecord[] {
    return all(this.db, 'SELECT * FROM locks ORDER BY acquired_at ASC').map(toLock);
  }

  private assertTransition(current: RunRecord, to: TechnicalStatus, expectedFrom?: TechnicalStatus): void {
    if (expectedFrom !== undefined && current.status !== expectedFrom) {
      throw new InvalidTransitionError(
        `Run '${current.id}' is in status '${current.status}', expected '${expectedFrom}'`,
        { runId: current.id, from: current.status, expectedFrom, to },
      );
    }
    if (!canTransition(current.status, to)) {
      throw new InvalidTransitionError(`Invalid run transition '${current.status}' → '${to}'`, {
        runId: current.id,
        from: current.status,
        to,
      });
    }
  }

  private applyUpdate(runId: string, update: RunUpdate, columns: Record<string, string | number | null>): void {
    const set: Record<string, string | number | null> = { ...columns };
    if (update.pid !== undefined) set.pid = update.pid;
    if (update.processStartIdentity !== undefined) set.process_start_identity = toJson(update.processStartIdentity ?? undefined);
    if (update.workspacePath !== undefined) set.workspace_path = update.workspacePath;
    if (update.statusMessage !== undefined) set.status_message = update.statusMessage;
    if (update.lifecycleStatus !== undefined) set.lifecycle_status = update.lifecycleStatus;
    if (update.exitCode !== undefined) set.exit_code = update.exitCode;
    if (update.result !== undefined) set.result_json = toJson(update.result ?? undefined);
    if (update.outcome !== undefined) set.outcome = update.outcome;
    if (update.completionHook !== undefined) set.completion_hook = update.completionHook;
    if (update.error !== undefined) set.error_json = toJson(update.error ?? undefined);
    if (update.configSnapshot !== undefined) set.config_snapshot = JSON.stringify(update.configSnapshot);
    if (update.identity !== undefined) set.identity = update.identity;
    if (update.command !== undefined) set.command = toJson(update.command ?? undefined);
    if (update.startedAt !== undefined) set.started_at = update.startedAt === null ? null : iso(update.startedAt);
    set.updated_at = this.clock.now().toISOString();
    const keys = Object.keys(set);
    run(this.db, `UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [
      ...keys.map((k) => set[k] ?? null),
      runId,
    ]);
  }
}

/** The persisted finalization target of a run, or `null` before `finalizing`. */
export function finalizationTarget(run: RunRecord): FinalizationTarget | null {
  if (run.finalStatus === null) return null;
  return { status: run.finalStatus, businessResult: run.businessResult, reason: run.finalReason ?? '' };
}

function validateTarget(target: FinalizationTarget): void {
  if (!isTerminalStatus(target.status)) {
    throw new InvalidTransitionError(`Finalization target '${String(target.status)}' is not terminal`, { target });
  }
  if (target.status === 'completed') {
    if (target.businessResult !== 'success' && target.businessResult !== 'failure') {
      throw new InvalidTransitionError('Target `completed` requires businessResult success|failure', { target });
    }
  } else if (target.businessResult !== null) {
    throw new InvalidTransitionError(`Target '${target.status}' requires businessResult null`, { target });
  }
}

function toRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    triggerType: row.trigger_type as TriggerType,
    sourceId: str(row.source_id),
    sourceItemKey: str(row.source_item_key),
    sourceUrl: str(row.source_url),
    lockKey: String(row.lock_key),
    scheduledFor: str(row.scheduled_for),
    configSnapshot: fromJson(row.config_snapshot),
    parameters: fromJson<Record<string, unknown>>(row.parameters_json),
    identity: str(row.identity),
    command: fromJson(row.command),
    status: row.status as TechnicalStatus,
    finalStatus: (str(row.final_status) as TerminalStatus | null) ?? null,
    businessResult: (str(row.business_result) as BusinessResult) ?? null,
    finalReason: str(row.final_reason),
    exitCode: num(row.exit_code),
    pid: num(row.pid),
    processStartIdentity: fromJson<ProcessStartIdentity>(row.process_start_identity),
    workspacePath: str(row.workspace_path),
    statusMessage: str(row.status_message),
    result: fromJson(row.result_json),
    outcome: str(row.outcome),
    completionHook: completionHookOf(row.completion_hook),
    retryBlockHook: Number(row.retry_block_hook ?? 0) === 1,
    error: fromJson(row.error_json),
    lifecycleStatus: (str(row.lifecycle_status) as LifecycleStatus | null) ?? null,
    blockGeneration: num(row.block_generation),
    countedTechnicalFailure: Number(row.counted_technical_failure) === 1,
    createdAt: String(row.created_at),
    startedAt: str(row.started_at),
    finalizingAt: str(row.finalizing_at),
    finishedAt: str(row.finished_at),
    updatedAt: String(row.updated_at),
  };
}

/** Persisted completion hook; a value that is no valid hook name (should not happen) reads as `null`. */
function completionHookOf(value: unknown): HookName | null {
  const hook = str(value);
  return hook !== null && isHookName(hook) ? hook : null;
}

function toLock(row: Row): LockRecord {
  return {
    workflowId: String(row.workflow_id),
    lockKey: String(row.lock_key),
    runId: String(row.run_id),
    sourceItemKey: str(row.source_item_key),
    acquiredAt: String(row.acquired_at),
  };
}
