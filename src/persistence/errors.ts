/**
 * Persistence-specific errors. All extend {@link OrchestratorError} so callers
 * (API: 409/404 mapping) can react on the stable `code`.
 */
import { OrchestratorError } from '../core/index.js';

/** An active lock for `(workflowId, lockKey)` already exists (HTTP 409). */
export class LockConflictError extends OrchestratorError {
  readonly workflowId: string;
  readonly lockKey: string;
  /** Run currently holding the lock. */
  readonly holderRunId: string;

  constructor(workflowId: string, lockKey: string, holderRunId: string) {
    super('lock_conflict', `Workflow '${workflowId}' already has an active run for '${lockKey}' (${holderRunId})`, {
      details: { workflowId, lockKey, holderRunId },
    });
    this.workflowId = workflowId;
    this.lockKey = lockKey;
    this.holderRunId = holderRunId;
  }
}

/** Reservation refused because an active retry block exists (only with `failIfBlocked`). */
export class BlockedError extends OrchestratorError {
  readonly blockId: number;

  constructor(workflowId: string, itemKey: string | null, blockId: number) {
    super('blocked', `Workflow '${workflowId}' is blocked for '${itemKey ?? '<workflow>'}' (block ${blockId})`, {
      details: { workflowId, itemKey, blockId },
    });
    this.blockId = blockId;
  }
}

/** An active block already exists for the workflow/scope. */
export class BlockExistsError extends OrchestratorError {
  readonly blockId: number;

  constructor(blockId: number) {
    super('block_exists', `An active block already exists (block ${blockId})`, { details: { blockId } });
    this.blockId = blockId;
  }
}

/** A run status transition that the state machine (core `canTransition`) does not allow. */
export class InvalidTransitionError extends OrchestratorError {
  constructor(message: string, details: Record<string, unknown>) {
    super('invalid_transition', message, { details });
  }
}

/** A referenced row does not exist. */
export class NotFoundError extends OrchestratorError {
  constructor(entity: string, id: string | number) {
    super('not_found', `${entity} '${String(id)}' not found`, { details: { entity, id } });
  }
}

/** Another orchestrator instance holds the data-dir instance lock (Spec §21). */
export class InstanceLockedError extends OrchestratorError {
  constructor(lockPath: string, holder: Record<string, unknown> | null, cause?: unknown) {
    const who = holder && typeof holder.pid === 'number' ? ` (pid ${holder.pid})` : '';
    super('instance_locked', `Another orchestrator instance is running on this data directory${who}: ${lockPath}`, {
      details: { lockPath, holder },
      cause,
    });
  }
}

/** Schema migration failed or the database schema is newer than this build. */
export class MigrationError extends OrchestratorError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super('migration_error', message, { ...(details ? { details } : {}), cause });
  }
}
