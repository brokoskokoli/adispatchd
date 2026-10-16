/**
 * Data-dir instance lock (Spec §21): only one orchestrator per data directory.
 *
 * Approach: an OS-level advisory lock held by SQLite. `orchestrator.lock` is a
 * tiny SQLite database opened with `locking_mode=EXCLUSIVE`; after the first
 * write transaction SQLite keeps the EXCLUSIVE file lock (POSIX `fcntl` on
 * Unix, `LockFileEx` on Windows) until the connection closes. The operating
 * system drops such locks automatically when the process exits – also on
 * SIGKILL/crash – so there is no "stale lock" that needs heuristic detection:
 * a lock left by a dead process is simply free again, and a live holder can
 * never be overridden (no PID/start-time guessing that could admit two
 * instances). SQLite also tracks locks per inode inside one process, so a
 * second acquisition from the same process is refused as well.
 *
 * Holder information (pid, host, start time) is written into the lock
 * database and mirrored to `orchestrator.lock.json` for diagnostics only; it
 * never decides who owns the lock.
 *
 * The connection is kept strongly reachable in a module-level set until
 * `release()`: otherwise dropping the returned handle would let the garbage
 * collector close the connection and silently free the OS lock.
 *
 * Limitations / rules:
 * - Advisory `fcntl` locks are unreliable on some network file systems (NFS
 *   without lock daemon) – the data dir must be on a local file system.
 * - POSIX `fcntl` locks belong to the process and are dropped when the process
 *   closes ANY file descriptor of that file. Therefore the holding process must
 *   never open `orchestrator.lock` otherwise (no `readFileSync`, `fs.cp`,
 *   copying the data dir, ...). Backup/copy/cleanup routines must exclude
 *   `orchestrator.lock` (and `orchestrator.lock.json`); `backupDatabase` only
 *   reads `orchestrator.sqlite` via SQLite. Opening it through `node:sqlite`
 *   in the same process is safe (SQLite shares lock state per inode).
 */
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dataPaths, systemClock, type Clock } from '../core/index.js';
import { InstanceLockedError } from './errors.js';

/** Connections holding a lock; strong references prevent GC from closing them. */
const HELD = new Set<DatabaseSync>();

/** File names inside the data dir that copy/backup/cleanup routines must never open. */
export const INSTANCE_LOCK_FILES = ['orchestrator.lock', 'orchestrator.lock.json'] as const;

/** A held instance lock. */
export interface InstanceLock {
  /** Path of the lock file. */
  readonly path: string;
  /** True until {@link release} was called. */
  readonly held: boolean;
  /** Release the lock (idempotent). Also released automatically on process exit. */
  release(): void;
}

/** Diagnostic holder information. */
export interface InstanceLockHolder {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/**
 * Acquire the exclusive instance lock for `dataDir` (creates the directory if
 * needed). Throws {@link InstanceLockedError} immediately if another live
 * instance – in this or another process – holds it.
 */
export function acquireInstanceLock(dataDir: string, options: { clock?: Clock } = {}): InstanceLock {
  const paths = dataPaths(dataDir);
  mkdirSync(paths.dataDir, { recursive: true });
  const lockPath = paths.instanceLock;
  const infoPath = `${lockPath}.json`;
  const db = new DatabaseSync(lockPath);
  const holder: InstanceLockHolder = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: (options.clock ?? systemClock).now().toISOString(),
  };
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, hostname TEXT NOT NULL, acquired_at TEXT NOT NULL)');
    db.exec('DELETE FROM holder');
    db.prepare('INSERT INTO holder (pid, hostname, acquired_at) VALUES (?, ?, ?)').run(
      holder.pid,
      holder.hostname,
      holder.acquiredAt,
    );
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore
    }
    if (err instanceof Error && /locked|busy/i.test(err.message)) {
      throw new InstanceLockedError(lockPath, readHolderInfo(infoPath), err);
    }
    throw err;
  }
  try {
    writeFileSync(infoPath, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
  } catch {
    // diagnostics only
  }
  HELD.add(db);
  let held = true;
  return {
    path: lockPath,
    get held() {
      return held;
    },
    release() {
      if (!held) return;
      held = false;
      try {
        rmSync(infoPath, { force: true });
      } catch {
        // diagnostics only
      }
      HELD.delete(db);
      db.close();
    },
  };
}

function readHolderInfo(infoPath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(infoPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
