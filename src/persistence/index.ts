/**
 * Component `persistence` – public API (WI-03).
 * Other components import from this module only.
 */
export { openPersistence, createRepositories, type Persistence, type Repositories } from './persistence.js';
export {
  openDatabase,
  migrate,
  schemaVersion,
  backupDatabase,
  configureConnection,
  DEFAULT_BUSY_TIMEOUT_MS,
  type OpenDatabaseOptions,
  type OpenedDatabase,
  type MigrationResult,
  type MigrateOptions,
} from './database.js';
export { MIGRATIONS, type Migration } from './schema.js';
export { acquireInstanceLock, INSTANCE_LOCK_FILES, type InstanceLock, type InstanceLockHolder } from './instance-lock.js';
export { lockKeyFor, blockScopeKey, type LockKeyInput } from './lock-keys.js';
export {
  RunRepository,
  finalizationTarget,
  type RunRecord,
  type ReserveRunInput,
  type RunUpdate,
  type BlockPolicy,
  type BeginFinalizationOptions,
  type FinalizationResult,
  type RunListQuery,
  type RunPage,
  type LockRecord,
} from './runs.js';
export {
  EventRepository,
  RUN_STATUS_EVENT,
  DIAGNOSTIC_EVENT_PREFIX,
  type EventOrigin,
  type RunEventRecord,
  type RunStatusEventPayload,
  type AppendEventOptions,
} from './events.js';
export {
  ActionRepository,
  ACTION_STATUS_TRANSITIONS,
  type ActionJournalEntry,
  type RunActionRecord,
  type ActionAttemptRecord,
  type FailedActionRecord,
} from './actions.js';
export {
  BlockRepository,
  type BlockRecord,
  type CreateBlockInput,
  type FailureCounterState,
} from './blocks.js';
export {
  NotificationRepository,
  type NotificationRecord,
  type NotificationDeliveryRecord,
  type DeliveryAttemptOutcome,
  type DeliveryState,
} from './notifications.js';
export {
  CronFiringRepository,
  type CronFiringRecord,
  type CronDecision,
  type RecordCronFiringInput,
} from './cron-firings.js';
export { RetentionRepository, type RunRetentionCategory, type RunRetentionCandidate } from './retention.js';
export {
  LockConflictError,
  BlockedError,
  BlockExistsError,
  InvalidTransitionError,
  NotFoundError,
  InstanceLockedError,
  MigrationError,
} from './errors.js';
export { transaction, afterCommit } from './sqlite.js';
