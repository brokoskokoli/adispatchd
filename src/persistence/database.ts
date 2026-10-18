/**
 * Opening the orchestrator database and applying versioned migrations with a
 * pre-migration backup (Spec §4, §12, §21).
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPaths, formatCompactTimestamp, noopLogger, systemClock, type Clock, type Logger } from '../core/index.js';
import { MigrationError } from './errors.js';
import { MIGRATIONS, type Migration } from './schema.js';
import { all, get, run, transaction } from './sqlite.js';

/** Default SQLite busy timeout (ms). */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Options for {@link openDatabase}. */
export interface OpenDatabaseOptions {
  clock?: Clock;
  logger?: Logger;
  /** Migrations to apply (default: built-in {@link MIGRATIONS}; tests may append artificial ones). */
  migrations?: readonly Migration[];
  busyTimeoutMs?: number;
}

/** Outcome of applying migrations. */
export interface MigrationResult {
  /** Schema version before opening (0 = empty database). */
  fromVersion: number;
  /** Schema version after migrating. */
  toVersion: number;
  /** Versions applied during this open. */
  applied: number[];
  /** Backup written before migrating, if any. */
  backupPath: string | null;
}

/** An opened, migrated database. */
export interface OpenedDatabase {
  db: DatabaseSync;
  /** Absolute path of the database file. */
  path: string;
  migration: MigrationResult;
  close(): void;
}

/**
 * Open (creating if needed) `<dataDir>/adispatchd.sqlite`, configure it
 * (foreign keys, WAL, busy timeout) and apply pending migrations. If the
 * database already existed and migrations are pending, it is first backed up
 * to `<dataDir>/backups/adispatchd-<version>-<ts>.sqlite`.
 *
 * The caller should hold the data-dir instance lock ({@link acquireInstanceLock}) first.
 */
export function openDatabase(dataDir: string, options: OpenDatabaseOptions = {}): OpenedDatabase {
  const paths = dataPaths(dataDir);
  mkdirSync(paths.dataDir, { recursive: true });
  const existed = existsSync(paths.database) && statSync(paths.database).size > 0;
  const db = new DatabaseSync(paths.database);
  try {
    configureConnection(db, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
    const migration = migrate(db, {
      migrations: options.migrations ?? MIGRATIONS,
      backupDir: existed ? paths.backupsDir : null,
      clock: options.clock ?? systemClock,
      logger: options.logger ?? noopLogger,
    });
    return { db, path: paths.database, migration, close: () => db.close() };
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Apply connection pragmas. */
export function configureConnection(db: DatabaseSync, busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
}

/** Options for {@link migrate}. */
export interface MigrateOptions {
  migrations: readonly Migration[];
  /** Directory for the pre-migration backup; `null` = no backup (fresh database). */
  backupDir: string | null;
  clock: Clock;
  logger: Logger;
}

/** Current schema version (0 if `schema_migrations` does not exist yet). */
export function schemaVersion(db: DatabaseSync): number {
  const table = get(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`);
  if (!table) return 0;
  const row = get(db, 'SELECT MAX(version) AS v FROM schema_migrations');
  return Number(row?.v ?? 0);
}

/** Apply all pending migrations, each in its own transaction. Idempotent. */
export function migrate(db: DatabaseSync, options: MigrateOptions): MigrationResult {
  validateMigrations(options.migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(all(db, 'SELECT version FROM schema_migrations').map((r) => Number(r.version)));
  const fromVersion = applied.size === 0 ? 0 : Math.max(...applied);
  const known = options.migrations.length === 0 ? 0 : Math.max(...options.migrations.map((m) => m.version));
  if (fromVersion > known) {
    throw new MigrationError(
      `Database schema version ${fromVersion} is newer than this build supports (${known}); refusing to start`,
      { fromVersion, known },
    );
  }
  const pending = options.migrations.filter((m) => !applied.has(m.version));
  let backupPath: string | null = null;
  if (pending.length > 0 && options.backupDir !== null) {
    backupPath = backupDatabase(db, options.backupDir, fromVersion, options.clock);
    options.logger.info('database backup written before migration', { backupPath, fromVersion });
  }
  for (const migration of pending) {
    try {
      transaction(db, () => {
        migration.up(db);
        run(db, 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          migration.version,
          migration.name,
          options.clock.now().toISOString(),
        ]);
      });
    } catch (err) {
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed`,
        { version: migration.version, backupPath },
        err,
      );
    }
    options.logger.info('database migration applied', { version: migration.version, name: migration.name });
  }
  return {
    fromVersion,
    toVersion: schemaVersion(db),
    applied: pending.map((m) => m.version),
    backupPath,
  };
}

/**
 * Write a consistent copy of the database (`VACUUM INTO`, safe in WAL mode)
 * to `<backupDir>/adispatchd-<version>-<ts>.sqlite`. Returns its path.
 */
export function backupDatabase(db: DatabaseSync, backupDir: string, version: number, clock: Clock): string {
  mkdirSync(backupDir, { recursive: true });
  const base = `adispatchd-${version}-${formatCompactTimestamp(clock.now(), true)}`;
  let target = path.join(backupDir, `${base}.sqlite`);
  for (let i = 1; existsSync(target); i++) target = path.join(backupDir, `${base}-${i}.sqlite`);
  db.prepare('VACUUM INTO ?').run(target);
  return target;
}

function validateMigrations(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= previous) {
      throw new MigrationError('Migrations must have strictly increasing positive integer versions', {
        version: m.version,
      });
    }
    previous = m.version;
  }
}
