/**
 * Audit of UI actions (WI-27, schema v4): every comment, label change and
 * project field change a logged-in user sent from the web UI as a configured
 * identity, including failed attempts. Comment texts are never stored (only
 * the URL of the created comment); `details` holds what was changed (label
 * names, project field values) or what was requested when it failed.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../core/index.js';
import { all, fromJson, get, iso, run, str, toJson, type Params, type Row } from './sqlite.js';

/** Kind of UI action. */
export type UiActionKind = 'comment' | 'labels' | 'project';
/** Outcome: `unknown` = the request may have taken effect (e.g. timeout after sending a comment). */
export type UiActionResult = 'succeeded' | 'failed' | 'unknown';

/** A persisted UI action. */
export interface UiActionRecord {
  id: number;
  createdAt: string;
  /** Logged-in user name. */
  actor: string;
  /** How the user was authenticated (`password`, `trusted_header`). */
  actorVia: string;
  /** Identity the action was performed as. */
  identity: string;
  sourceId: string;
  itemId: string;
  /** `<sourceId>:<itemId>`. */
  itemKey: string;
  itemUrl: string | null;
  kind: UiActionKind;
  result: UiActionResult;
  errorCode: string | null;
  /** Redacted error text. */
  errorMessage: string | null;
  commentId: string | null;
  commentUrl: string | null;
  details: Record<string, unknown> | null;
}

/** Input of {@link UiActionRepository.record}. */
export type RecordUiActionInput = Omit<UiActionRecord, 'id' | 'createdAt' | 'itemUrl' | 'errorCode' | 'errorMessage' | 'commentId' | 'commentUrl' | 'details'> &
  Partial<Pick<UiActionRecord, 'itemUrl' | 'errorCode' | 'errorMessage' | 'commentId' | 'commentUrl' | 'details'>>;

/** Query of {@link UiActionRepository.list}. */
export interface UiActionQuery {
  sourceId?: string;
  itemKey?: string;
  limit?: number;
  offset?: number;
}

/** Repository for `ui_actions`. */
export class UiActionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** Append an entry; returns it. */
  record(input: RecordUiActionInput): UiActionRecord {
    const res = run(
      this.db,
      `INSERT INTO ui_actions (created_at, actor, actor_via, identity, source_id, item_id, item_key, item_url, kind, result,
                               error_code, error_message, comment_id, comment_url, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.clock.now().toISOString(),
        input.actor,
        input.actorVia,
        input.identity,
        input.sourceId,
        input.itemId,
        input.itemKey,
        input.itemUrl ?? null,
        input.kind,
        input.result,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.commentId ?? null,
        input.commentUrl ?? null,
        input.details ? toJson(input.details) : null,
      ],
    );
    return this.get(res.lastInsertRowid) as UiActionRecord;
  }

  get(id: number): UiActionRecord | null {
    const row = get(this.db, 'SELECT * FROM ui_actions WHERE id = ?', [id]);
    return row ? toRecord(row) : null;
  }

  /** Newest first. */
  list(query: UiActionQuery = {}): { actions: UiActionRecord[]; total: number } {
    const where: string[] = [];
    const params: Params = [];
    if (query.sourceId !== undefined) {
      where.push('source_id = ?');
      params.push(query.sourceId);
    }
    if (query.itemKey !== undefined) {
      where.push('item_key = ?');
      params.push(query.itemKey);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(get(this.db, `SELECT COUNT(*) AS n FROM ui_actions ${clause}`, params)?.n ?? 0);
    const actions = all(this.db, `SELECT * FROM ui_actions ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [
      ...params,
      query.limit ?? 100,
      query.offset ?? 0,
    ]).map(toRecord);
    return { actions, total };
  }

  /**
   * Retention (like runs): succeeded entries older than `succeededBefore`,
   * failed/unknown ones older than `failedBefore` (`null` = keep). Returns count.
   */
  deleteOlderThan(succeededBefore: Date | string | null, failedBefore: Date | string | null): number {
    let deleted = 0;
    if (succeededBefore !== null) {
      deleted += run(this.db, `DELETE FROM ui_actions WHERE result = 'succeeded' AND created_at < ?`, [iso(succeededBefore)]).changes;
    }
    if (failedBefore !== null) {
      deleted += run(this.db, `DELETE FROM ui_actions WHERE result <> 'succeeded' AND created_at < ?`, [iso(failedBefore)]).changes;
    }
    return deleted;
  }
}

function toRecord(row: Row): UiActionRecord {
  return {
    id: Number(row.id),
    createdAt: String(row.created_at),
    actor: String(row.actor),
    actorVia: String(row.actor_via),
    identity: String(row.identity),
    sourceId: String(row.source_id),
    itemId: String(row.item_id),
    itemKey: String(row.item_key),
    itemUrl: str(row.item_url),
    kind: String(row.kind) as UiActionKind,
    result: String(row.result) as UiActionResult,
    errorCode: str(row.error_code),
    errorMessage: str(row.error_message),
    commentId: str(row.comment_id),
    commentUrl: str(row.comment_url),
    details: fromJson<Record<string, unknown>>(row.details_json),
  };
}
