/**
 * Audit log of the hub (WI-37): who did what to which workspace and when.
 * A small SQLite database `hub.db` in the hub's data dir (own file, own
 * schema; the workspaces' databases are untouched). Entries contain no
 * secrets and no request bodies. Old entries are trimmed (newest
 * {@link MAX_AUDIT_ENTRIES} stay).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock, type Clock } from '../../core/index.js';

/** File name inside the hub data dir. */
export const HUB_DB_FILE = 'hub.db';
/** Entries kept. */
export const MAX_AUDIT_ENTRIES = 10_000;

/** One entry. */
export interface HubAuditEntry {
  id: number;
  at: string;
  /** User name; `null` when the hub has no login (auth.mode none). */
  actor: string | null;
  role: string | null;
  /** How the caller authenticated (`password`, `trusted_header`, `none`). */
  via: string;
  /** `workspace.start|stop|restart|drain`, `hub.pause|resume|stop-all|drain-all`. */
  action: string;
  /** Workspace ID for workspace actions. */
  workspace: string | null;
  /** `ok` or `failed`. */
  result: 'ok' | 'failed';
  /** Error code of a failed action (never a message with secrets). */
  error: string | null;
}

/** An entry to record. */
export type NewAuditEntry = Omit<HubAuditEntry, 'id' | 'at'>;

/** See module docs. */
export class HubAuditStore {
  private readonly db: DatabaseSync;
  private writes = 0;

  constructor(
    dataDir: string,
    private readonly clock: Clock = systemClock,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, HUB_DB_FILE));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT,
        role TEXT,
        via TEXT NOT NULL,
        action TEXT NOT NULL,
        workspace TEXT,
        result TEXT NOT NULL,
        error TEXT
      );
    `);
  }

  record(entry: NewAuditEntry): HubAuditEntry {
    const at = this.clock.now().toISOString();
    const res = this.db
      .prepare('INSERT INTO hub_audit (at, actor, role, via, action, workspace, result, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(at, entry.actor, entry.role, entry.via, entry.action, entry.workspace, entry.result, entry.error);
    if (++this.writes % 200 === 0) this.trim();
    return { id: Number(res.lastInsertRowid), at, ...entry };
  }

  /** Newest first. */
  list(limit = 100, offset = 0): { entries: HubAuditEntry[]; total: number } {
    const rows = this.db.prepare('SELECT * FROM hub_audit ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as HubAuditEntry[];
    const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM hub_audit').get() as { n: number | bigint }).n);
    return { entries: rows.map((r) => ({ ...r, id: Number(r.id) })), total };
  }

  private trim(): void {
    this.db.prepare('DELETE FROM hub_audit WHERE id <= (SELECT MAX(id) FROM hub_audit) - ?').run(MAX_AUDIT_ENTRIES);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
