/**
 * Retry blocks and technical-failure counters (Spec §11).
 *
 * Counter design: an explicit `failure_counters` row per
 * `(workflow_id, scope_key)` (scope = source item key, `''` = workflow scope
 * for sourceless runs) holding `consecutive` and the counting-period
 * `generation`. It is updated exclusively in the same transaction as a run's
 * transition into `finalizing` (see `RunRepository.beginFinalization`), which
 * happens at most once per run – so counting is exactly-once also across
 * crashes/recovery. Technical failures (`crashed|start_error|timed_out`)
 * increment, `completed`+`success` resets to 0, business `failure` and
 * `cancelled` leave it unchanged. Clearing a block resets to 0 and increments
 * `generation` (new counting period); old runs and blocks stay untouched.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../core/index.js';
import { BlockExistsError, NotFoundError } from './errors.js';
import { blockScopeKey } from './lock-keys.js';
import { all, get, run, str, transaction, type Row } from './sqlite.js';

/** A persisted retry block. `itemKey === null` = workflow-scoped block. */
export interface BlockRecord {
  id: number;
  workflowId: string;
  itemKey: string | null;
  reason: string;
  /** Run whose failure created the block, if any. */
  runId: string | null;
  /** Consecutive technical failures when the block was created. */
  failureCount: number;
  /** Counting period the block belongs to. */
  generation: number;
  createdAt: string;
  clearedAt: string | null;
  clearedBy: string | null;
}

/** Input for {@link BlockRepository.create}. */
export interface CreateBlockInput {
  workflowId: string;
  itemKey: string | null;
  reason: string;
  runId?: string | null;
  failureCount?: number;
}

/** Current counter state of one workflow/scope. */
export interface FailureCounterState {
  consecutive: number;
  generation: number;
}

/** Repository for `blocks` and `failure_counters`. */
export class BlockRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** Create an active block. Throws if an active block already exists for the key. */
  create(input: CreateBlockInput): BlockRecord {
    return transaction(this.db, () => {
      const existing = this.activeFor(input.workflowId, input.itemKey);
      if (existing) {
        throw new BlockExistsError(existing.id);
      }
      const { generation } = this.counter(input.workflowId, input.itemKey);
      const res = run(
        this.db,
        `INSERT INTO blocks (workflow_id, source_item_key, reason, run_id, failure_count, generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.workflowId,
          input.itemKey,
          input.reason,
          input.runId ?? null,
          input.failureCount ?? 0,
          generation,
          this.clock.now().toISOString(),
        ],
      );
      return this.require(res.lastInsertRowid);
    });
  }

  /**
   * Clear (remove) a block: sets `cleared_at`, resets the counter and starts
   * a new counting period (`generation + 1`). Idempotent for already cleared blocks.
   */
  clear(id: number, clearedBy: string | null = null): BlockRecord {
    return transaction(this.db, () => {
      const block = this.require(id);
      if (block.clearedAt !== null) return block;
      const now = this.clock.now().toISOString();
      run(this.db, 'UPDATE blocks SET cleared_at = ?, cleared_by = ? WHERE id = ?', [now, clearedBy, id]);
      this.ensureCounter(block.workflowId, block.itemKey);
      run(
        this.db,
        `UPDATE failure_counters SET consecutive = 0, generation = generation + 1, updated_at = ?
         WHERE workflow_id = ? AND scope_key = ?`,
        [now, block.workflowId, blockScopeKey(block.itemKey)],
      );
      return this.require(id);
    });
  }

  /** Block by ID or `null`. */
  get(id: number): BlockRecord | null {
    const row = get(this.db, 'SELECT * FROM blocks WHERE id = ?', [id]);
    return row ? toBlock(row) : null;
  }

  /** Active block for `(workflowId, itemKey)` (`itemKey = null` → workflow scope), or `null`. */
  activeFor(workflowId: string, itemKey: string | null): BlockRecord | null {
    const row = get(
      this.db,
      `SELECT * FROM blocks WHERE workflow_id = ? AND COALESCE(source_item_key, '') = ? AND cleared_at IS NULL`,
      [workflowId, blockScopeKey(itemKey)],
    );
    return row ? toBlock(row) : null;
  }

  /** True if an active block exists for `(workflowId, itemKey)`. */
  isBlocked(workflowId: string, itemKey: string | null): boolean {
    return this.activeFor(workflowId, itemKey) !== null;
  }

  /** All active blocks, newest first. */
  listActive(): BlockRecord[] {
    return all(this.db, 'SELECT * FROM blocks WHERE cleared_at IS NULL ORDER BY created_at DESC, id DESC').map(toBlock);
  }

  /** Block history of a workflow (optionally one scope), newest first. */
  listForWorkflow(workflowId: string, options: { itemKey?: string | null; limit?: number } = {}): BlockRecord[] {
    if (options.itemKey !== undefined) {
      return all(
        this.db,
        `SELECT * FROM blocks WHERE workflow_id = ? AND COALESCE(source_item_key, '') = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [workflowId, blockScopeKey(options.itemKey), options.limit ?? 100],
      ).map(toBlock);
    }
    return all(this.db, 'SELECT * FROM blocks WHERE workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [
      workflowId,
      options.limit ?? 100,
    ]).map(toBlock);
  }

  /** IDs of runs whose technical failures were counted in the block's period (for the GUI). */
  affectedRunIds(blockId: number): string[] {
    const block = this.require(blockId);
    return all(
      this.db,
      `SELECT id FROM runs WHERE workflow_id = ? AND COALESCE(source_item_key, '') = ?
         AND block_generation = ? AND counted_technical_failure = 1
       ORDER BY created_at ASC, id ASC`,
      [block.workflowId, blockScopeKey(block.itemKey), block.generation],
    ).map((r) => String(r.id));
  }

  /** Consecutive technical failures in the current counting period. */
  consecutiveTechnicalFailures(workflowId: string, itemKey: string | null): number {
    return this.counter(workflowId, itemKey).consecutive;
  }

  /** Counter state (`{0, 0}` if never touched). */
  counter(workflowId: string, itemKey: string | null): FailureCounterState {
    const row = get(this.db, 'SELECT consecutive, generation FROM failure_counters WHERE workflow_id = ? AND scope_key = ?', [
      workflowId,
      blockScopeKey(itemKey),
    ]);
    return { consecutive: Number(row?.consecutive ?? 0), generation: Number(row?.generation ?? 0) };
  }

  /**
   * Internal: apply a run outcome to the counter. Must be called inside the
   * transaction that moves the run into `finalizing`.
   */
  applyOutcome(workflowId: string, itemKey: string | null, effect: 'increment' | 'reset' | 'none'): FailureCounterState {
    this.ensureCounter(workflowId, itemKey);
    const now = this.clock.now().toISOString();
    if (effect === 'increment') {
      run(
        this.db,
        'UPDATE failure_counters SET consecutive = consecutive + 1, updated_at = ? WHERE workflow_id = ? AND scope_key = ?',
        [now, workflowId, blockScopeKey(itemKey)],
      );
    } else if (effect === 'reset') {
      run(this.db, 'UPDATE failure_counters SET consecutive = 0, updated_at = ? WHERE workflow_id = ? AND scope_key = ?', [
        now,
        workflowId,
        blockScopeKey(itemKey),
      ]);
    }
    return this.counter(workflowId, itemKey);
  }

  private ensureCounter(workflowId: string, itemKey: string | null): void {
    run(
      this.db,
      `INSERT INTO failure_counters (workflow_id, scope_key, consecutive, generation, updated_at)
       VALUES (?, ?, 0, 0, ?) ON CONFLICT (workflow_id, scope_key) DO NOTHING`,
      [workflowId, blockScopeKey(itemKey), this.clock.now().toISOString()],
    );
  }

  private require(id: number): BlockRecord {
    const block = this.get(id);
    if (!block) throw new NotFoundError('block', id);
    return block;
  }
}

function toBlock(row: Row): BlockRecord {
  return {
    id: Number(row.id),
    workflowId: String(row.workflow_id),
    itemKey: str(row.source_item_key),
    reason: String(row.reason),
    runId: str(row.run_id),
    failureCount: Number(row.failure_count),
    generation: Number(row.generation),
    createdAt: String(row.created_at),
    clearedAt: str(row.cleared_at),
    clearedBy: str(row.cleared_by),
  };
}
