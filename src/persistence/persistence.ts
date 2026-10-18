/**
 * Composition root of the persistence component.
 */
import type { DatabaseSync } from 'node:sqlite';
import { systemClock, type Clock } from '../core/index.js';
import { ActionRepository } from './actions.js';
import { BlockRepository } from './blocks.js';
import { CronFiringRepository } from './cron-firings.js';
import { openDatabase, type MigrationResult, type OpenDatabaseOptions } from './database.js';
import { EventRepository } from './events.js';
import { NotificationRepository } from './notifications.js';
import { RetentionRepository } from './retention.js';
import { RunRepository } from './runs.js';
import { afterCommit, transaction } from './sqlite.js';

/** All repositories over one connection. */
export interface Repositories {
  runs: RunRepository;
  events: EventRepository;
  actions: ActionRepository;
  blocks: BlockRepository;
  notifications: NotificationRepository;
  cronFirings: CronFiringRepository;
  retention: RetentionRepository;
  /** Run `fn` in one transaction (nested repository calls join it via savepoints). */
  transaction<T>(fn: () => T): T;
  /**
   * Run `cb` after the outermost open transaction commits (immediately if none);
   * dropped on rollback. Publish to the in-process event bus / SSE only from here.
   */
  afterCommit(cb: () => void): void;
}

/** Create repositories over an already opened and migrated connection. */
export function createRepositories(db: DatabaseSync, options: { clock?: Clock } = {}): Repositories {
  const clock = options.clock ?? systemClock;
  const events = new EventRepository(db, clock);
  const blocks = new BlockRepository(db, clock);
  return {
    runs: new RunRepository(db, clock, events, blocks),
    events,
    actions: new ActionRepository(db, clock),
    blocks,
    notifications: new NotificationRepository(db, clock),
    cronFirings: new CronFiringRepository(db, clock),
    retention: new RetentionRepository(db),
    transaction: (fn) => transaction(db, fn),
    afterCommit: (cb) => afterCommit(db, cb),
  };
}

/** Opened database plus repositories. */
export interface Persistence extends Repositories {
  db: DatabaseSync;
  path: string;
  migration: MigrationResult;
  close(): void;
}

/**
 * Open `<dataDir>/adispatchd.sqlite`, migrate and create all repositories.
 * Acquire the instance lock ({@link acquireInstanceLock}) before calling this.
 */
export function openPersistence(dataDir: string, options: OpenDatabaseOptions = {}): Persistence {
  const opened = openDatabase(dataDir, options);
  return {
    ...createRepositories(opened.db, options.clock ? { clock: options.clock } : {}),
    db: opened.db,
    path: opened.path,
    migration: opened.migration,
    close: opened.close,
  };
}
