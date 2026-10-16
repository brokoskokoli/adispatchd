/**
 * Structured run events (Spec §9.3, §12, §15 SSE). Every event has a
 * globally monotonic `id` (SQLite AUTOINCREMENT: never reused after deletion
 * of committed rows – usable as SSE `Last-Event-ID`) and a per-run `sequence`.
 *
 * Caveat: the ID of an insert that is rolled back may be handed out again.
 * Therefore an event (and its ID) must only be published to live consumers
 * (event bus / SSE) after the surrounding transaction committed – use
 * `Repositories.afterCommit` / `afterCommit(db, cb)`. Persisted IDs are then
 * strictly increasing in commit order (single writer connection).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Clock, ExecutorDiagnostic, WorkerEvent } from '../core/index.js';
import { NotFoundError } from './errors.js';
import { all, get, iso, run, transaction, type Params, type Row } from './sqlite.js';

/**
 * Who produced the event: `worker` = `@@ORCH_EVENT` line (untrusted, informative),
 * `orchestrator` = status transitions and executor diagnostics.
 */
export type EventOrigin = 'worker' | 'orchestrator';

/** Event type of orchestrator-side run status transitions. Payload: {@link RunStatusEventPayload}. */
export const RUN_STATUS_EVENT = 'run.status';

/** Prefix of executor diagnostic event types, e.g. `diagnostic.log_truncated` (Spec §12 note on log/DB inconsistencies). */
export const DIAGNOSTIC_EVENT_PREFIX = 'diagnostic.';

/** Payload of a {@link RUN_STATUS_EVENT}. */
export interface RunStatusEventPayload {
  from: string | null;
  to: string;
  [key: string]: unknown;
}

/** A persisted run event. */
export interface RunEventRecord {
  /** Global, strictly increasing event ID. */
  id: number;
  runId: string;
  /** 1-based, strictly increasing per run. */
  sequence: number;
  timestamp: string;
  origin: EventOrigin;
  type: string;
  payload: Record<string, unknown>;
}

/** Options for {@link EventRepository.append}. */
export interface AppendEventOptions {
  origin?: EventOrigin;
  at?: Date;
}

/** Repository for `run_events`. */
export class EventRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /**
   * Append an event. Worker `status` events with a string `message` also
   * update `runs.status_message` (same transaction).
   */
  append(runId: string, type: string, payload: Record<string, unknown>, options: AppendEventOptions = {}): RunEventRecord {
    const origin = options.origin ?? 'orchestrator';
    const at = iso(options.at ?? this.clock.now());
    return transaction(this.db, () => {
      if (!get(this.db, 'SELECT 1 FROM runs WHERE id = ?', [runId])) throw new NotFoundError('run', runId);
      const seqRow = get(this.db, 'SELECT COALESCE(MAX(sequence), 0) + 1 AS s FROM run_events WHERE run_id = ?', [runId]);
      const sequence = Number(seqRow?.s ?? 1);
      const res = run(
        this.db,
        'INSERT INTO run_events (run_id, sequence, timestamp, origin, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        [runId, sequence, at, origin, type, JSON.stringify(payload)],
      );
      if (origin === 'worker' && type === 'status' && typeof payload.message === 'string') {
        run(this.db, 'UPDATE runs SET status_message = ?, updated_at = ? WHERE id = ?', [payload.message, at, runId]);
      }
      return { id: res.lastInsertRowid, runId, sequence, timestamp: at, origin, type, payload };
    });
  }

  /** Persist a structured worker event (origin `worker`). */
  appendWorkerEvent(runId: string, event: WorkerEvent): RunEventRecord {
    return this.append(runId, event.type, event.data, { origin: 'worker', at: event.at });
  }

  /** Persist an executor diagnostic as `diagnostic.<type>` (origin `orchestrator`). */
  appendDiagnostic(runId: string, diagnostic: ExecutorDiagnostic): RunEventRecord {
    const payload: Record<string, unknown> = { message: diagnostic.message };
    if (diagnostic.stream) payload.stream = diagnostic.stream;
    if (diagnostic.details) payload.details = diagnostic.details;
    return this.append(runId, `${DIAGNOSTIC_EVENT_PREFIX}${diagnostic.type}`, payload, { at: diagnostic.at });
  }

  /** Events with `id > afterId` in ID order (SSE replay). Optionally restricted to one run. */
  listSince(afterId: number, options: { runId?: string; limit?: number } = {}): RunEventRecord[] {
    const params: Params = [afterId];
    let sql = 'SELECT * FROM run_events WHERE id > ?';
    if (options.runId !== undefined) {
      sql += ' AND run_id = ?';
      params.push(options.runId);
    }
    sql += ' ORDER BY id ASC LIMIT ?';
    params.push(options.limit ?? 1000);
    return all(this.db, sql, params).map(toEvent);
  }

  /** Events of one run in sequence order. */
  listForRun(runId: string, options: { afterSequence?: number; limit?: number } = {}): RunEventRecord[] {
    return all(this.db, 'SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?', [
      runId,
      options.afterSequence ?? 0,
      options.limit ?? 10_000,
    ]).map(toEvent);
  }

  /** Highest event ID ever assigned (0 if none); does not decrease when events are deleted. */
  latestId(): number {
    return Number(get(this.db, `SELECT seq FROM sqlite_sequence WHERE name = 'run_events'`)?.seq ?? 0);
  }
}

function toEvent(row: Row): RunEventRecord {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    timestamp: String(row.timestamp),
    origin: row.origin as EventOrigin,
    type: String(row.type),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
  };
}
