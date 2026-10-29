/**
 * Artifact metadata (WI-35, schema v7). The contents live below
 * `data-dir/artifacts/<id>/`; this table only holds what lists, filters and
 * the source adapter need. Artifacts are immutable: only `consumed_by`
 * changes (a workflow processed the artifact successfully). `run_id` and
 * `parent_id` are plain text: they stay when the run or the parent artifact
 * is deleted.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ACTIVE_STATUSES, type ArtifactCatalog, type ArtifactKind, type ArtifactRecord, type Clock } from '../core/index.js';
import { all, fromJson, get, iso, placeholders, run, str, toJson, transaction, type Params, type Row } from './sqlite.js';

/** Input of {@link ArtifactRepository.insert}. */
export type NewArtifact = Omit<ArtifactRecord, 'createdAt' | 'consumedBy'> & { createdAt?: string };

/** Query of {@link ArtifactRepository.query}. */
export interface ArtifactQuery {
  type?: string;
  workflowId?: string;
  kind?: ArtifactKind;
  runId?: string;
  parentId?: string;
  /** Case-insensitive substring of the name or ID. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** A page of artifacts (newest first). */
export interface ArtifactPage {
  artifacts: ArtifactRecord[];
  total: number;
}

function toRecord(row: Row): ArtifactRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.type),
    kind: String(row.kind) as ArtifactKind,
    fileName: String(row.file_name),
    size: Number(row.size),
    fileCount: Number(row.file_count),
    workflowId: String(row.workflow_id),
    runId: String(row.run_id),
    ordinal: Number(row.ordinal),
    parentId: str(row.parent_id),
    consumedBy: fromJson<string[]>(row.consumed_by_json) ?? [],
    createdAt: String(row.created_at),
  };
}

/** Escape `%`, `_` and the escape character itself for a `LIKE ... ESCAPE '\'`. */
function likePattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Repository for `artifacts`. */
export class ArtifactRepository implements ArtifactCatalog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** Insert an artifact; returns the stored record. */
  insert(input: NewArtifact): ArtifactRecord {
    run(
      this.db,
      `INSERT INTO artifacts (id, name, type, kind, file_name, size, file_count, workflow_id, run_id, ordinal, parent_id, consumed_by_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
      [
        input.id,
        input.name,
        input.type,
        input.kind,
        input.fileName,
        input.size,
        input.fileCount,
        input.workflowId,
        input.runId,
        input.ordinal,
        input.parentId,
        input.createdAt ?? this.clock.now().toISOString(),
      ],
    );
    return this.get(input.id) as ArtifactRecord;
  }

  get(id: string): ArtifactRecord | null {
    const row = get(this.db, 'SELECT * FROM artifacts WHERE id = ?', [id]);
    return row ? toRecord(row) : null;
  }

  /** The artifact a run produced at `ordinal` (makes collection idempotent after a crash), or `null`. */
  getByRun(runId: string, ordinal: number): ArtifactRecord | null {
    const row = get(this.db, 'SELECT * FROM artifacts WHERE run_id = ? AND ordinal = ?', [runId, ordinal]);
    return row ? toRecord(row) : null;
  }

  /** All artifacts, newest first. */
  list(): ArtifactRecord[] {
    return all(this.db, 'SELECT * FROM artifacts ORDER BY created_at DESC, id DESC').map(toRecord);
  }

  /** Filtered page, newest first. */
  query(query: ArtifactQuery = {}): ArtifactPage {
    const where: string[] = [];
    const params: Params = [];
    if (query.type !== undefined) {
      where.push('type = ?');
      params.push(query.type);
    }
    if (query.workflowId !== undefined) {
      where.push('workflow_id = ?');
      params.push(query.workflowId);
    }
    if (query.kind !== undefined) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (query.runId !== undefined) {
      where.push('run_id = ?');
      params.push(query.runId);
    }
    if (query.parentId !== undefined) {
      where.push('parent_id = ?');
      params.push(query.parentId);
    }
    if (query.q !== undefined && query.q !== '') {
      where.push(`(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(id) LIKE ? ESCAPE '\\')`);
      params.push(likePattern(query.q), likePattern(query.q));
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(get(this.db, `SELECT COUNT(*) AS n FROM artifacts ${clause}`, params)?.n ?? 0);
    const artifacts = all(this.db, `SELECT * FROM artifacts ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
      ...params,
      query.limit ?? 50,
      query.offset ?? 0,
    ]).map(toRecord);
    return { artifacts, total };
  }

  /** Distinct `type` and `workflow_id` values (filter choices of the UI). */
  facets(): { types: string[]; workflows: string[] } {
    const column = (name: 'type' | 'workflow_id'): string[] => all(this.db, `SELECT DISTINCT ${name} AS v FROM artifacts ORDER BY v`).map((r) => String(r.v));
    return { types: column('type'), workflows: column('workflow_id') };
  }

  /** Artifacts that have `id` as parent, newest first. */
  children(id: string): ArtifactRecord[] {
    return all(this.db, 'SELECT * FROM artifacts WHERE parent_id = ? ORDER BY created_at DESC, id DESC', [id]).map(toRecord);
  }

  /**
   * Record that `workflowId` processed the artifact successfully. Idempotent;
   * returns the updated record, or `null` if the artifact no longer exists.
   */
  markConsumed(id: string, workflowId: string): ArtifactRecord | null {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return null;
      if (current.consumedBy.includes(workflowId)) return current;
      run(this.db, 'UPDATE artifacts SET consumed_by_json = ? WHERE id = ?', [toJson([...current.consumedBy, workflowId]), id]);
      return this.get(id);
    });
  }

  /**
   * Active (not yet terminal) runs that use the artifact as their item (item
   * key `<artifact source id>:<artifact id>`; matched by the ID, so a renamed
   * source does not hide a run).
   */
  activeRunsUsing(artifactId: string): string[] {
    return all(
      this.db,
      `SELECT id FROM runs WHERE source_item_key LIKE ? ESCAPE '\\' AND status IN (${placeholders(ACTIVE_STATUSES.length)}) ORDER BY created_at`,
      [`%:${artifactId.replace(/[\\%_]/g, (c) => `\\${c}`)}`, ...ACTIVE_STATUSES],
    ).map((r) => String(r.id));
  }

  /** Delete the row. Returns false if it did not exist. */
  delete(id: string): boolean {
    return run(this.db, 'DELETE FROM artifacts WHERE id = ?', [id]).changes === 1;
  }

  /** Artifacts created before `before`, oldest first (retention candidates). */
  olderThan(before: Date | string, limit = 200): ArtifactRecord[] {
    return all(this.db, 'SELECT * FROM artifacts WHERE created_at < ? ORDER BY created_at, id LIMIT ?', [iso(before), limit]).map(toRecord);
  }
}
