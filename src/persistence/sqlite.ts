/**
 * Small helpers around `node:sqlite` (`DatabaseSync`): transactions with
 * nesting via savepoints, typed row access and JSON (de)serialisation.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** A row as returned by `StatementSync#get/all`. */
export type Row = Record<string, unknown>;

/** Positional SQL parameters. */
export type Params = SQLInputValue[];

/** Per-connection transaction state: one callback list per nesting level. */
const state = new WeakMap<DatabaseSync, { levels: Array<Array<() => void>> }>();
let savepointCounter = 0;

/**
 * Run `fn` atomically. The outermost call uses `BEGIN IMMEDIATE` (takes the
 * write lock up front, so check-then-insert sequences are atomic also across
 * connections); nested calls use savepoints. Any thrown error rolls back
 * (the original error is always re-thrown, also if the rollback itself fails).
 *
 * Callbacks registered via {@link afterCommit} run only after the outermost
 * transaction committed; they are discarded on rollback (also of a nested savepoint).
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  let st = state.get(db);
  if (!st) {
    st = { levels: [] };
    state.set(db, st);
  }
  const levels = st.levels;
  if (levels.length === 0) {
    db.exec('BEGIN IMMEDIATE');
    levels.push([]);
    let callbacks: Array<() => void> = [];
    try {
      const result = fn();
      db.exec('COMMIT');
      callbacks = levels[0] ?? [];
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // transaction may already be rolled back by SQLite
      }
      throw err;
    } finally {
      levels.length = 0;
      runCallbacks(callbacks);
    }
  }
  const name = `sp_${++savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  levels.push([]);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    const own = levels.pop() ?? [];
    levels[levels.length - 1]?.push(...own);
    return result;
  } catch (err) {
    levels.pop();
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      // outer transaction may already be aborted; the outer level rolls back
    }
    throw err;
  }
}

/**
 * Run `callback` after the current outermost transaction commits (immediately
 * if no transaction is open); dropped if the transaction rolls back. Use this
 * for side effects outside SQLite, e.g. publishing on the in-process event bus,
 * so that subscribers never see IDs of rolled-back rows (SQLite may reuse
 * AUTOINCREMENT values of rolled-back inserts). Callbacks must not throw;
 * errors are reported via `process.emitWarning` and do not affect other callbacks.
 */
export function afterCommit(db: DatabaseSync, callback: () => void): void {
  const levels = state.get(db)?.levels;
  const current = levels?.[levels.length - 1];
  if (current) current.push(callback);
  else runCallbacks([callback]);
}

function runCallbacks(callbacks: Array<() => void>): void {
  for (const cb of callbacks) {
    try {
      cb();
    } catch (err) {
      process.emitWarning(`afterCommit callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Execute a statement; returns number of changed rows and last insert rowid. */
export function run(db: DatabaseSync, sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
  const res = db.prepare(sql).run(...params);
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

/** First row or `undefined`. */
export function get(db: DatabaseSync, sql: string, params: Params = []): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

/** All rows. */
export function all(db: DatabaseSync, sql: string, params: Params = []): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

/** Serialise a value to JSON for storage (`undefined` → SQL NULL). */
export function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Parse a stored JSON column (NULL → `null`). */
export function fromJson<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return JSON.parse(String(value)) as T;
}

/** Column as string or null. */
export function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Column as number or null. */
export function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** `?, ?, ?` placeholder list for `n` parameters (n ≥ 1). */
export function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** ISO-8601 string of a Date or ISO string input. */
export function iso(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}
