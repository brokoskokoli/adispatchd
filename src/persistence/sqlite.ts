/**
 * Small helpers around `node:sqlite` (`DatabaseSync`): transactions with
 * nesting via savepoints, typed row access and JSON (de)serialisation.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** A row as returned by `StatementSync#get/all`. */
export type Row = Record<string, unknown>;

/** Positional SQL parameters. */
export type Params = SQLInputValue[];

const depth = new WeakMap<DatabaseSync, number>();
let savepointCounter = 0;

/**
 * Run `fn` atomically. The outermost call uses `BEGIN IMMEDIATE` (takes the
 * write lock up front, so check-then-insert sequences are atomic also across
 * connections); nested calls use savepoints. Any thrown error rolls back.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level === 0) {
    db.exec('BEGIN IMMEDIATE');
    depth.set(db, 1);
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // transaction may already be rolled back by SQLite
      }
      throw err;
    } finally {
      depth.set(db, 0);
    }
  }
  const name = `sp_${++savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  } finally {
    depth.set(db, level);
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
