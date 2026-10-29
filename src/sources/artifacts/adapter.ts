/**
 * Source adapter `artifacts` (WI-35): every stored artifact is an item. The
 * adapter only reads the artifact catalogue; there is nothing to write back
 * (no labels, no comments), so workflows on this source cannot use
 * `source.update` / `source.comment` (config validation).
 */
import {
  ARTIFACT_ID_PATTERN,
  ARTIFACT_SOURCE_TYPE,
  SourceError,
  artifactRoute,
  sourceItemKey,
  type ArtifactCatalog,
  type ArtifactRecord,
  type CommentRef,
  type FieldDefinition,
  type FieldResolution,
  type FieldValue,
  type ListCandidatesOptions,
  type SourceAdapter,
  type SourceAdapterFactory,
  type SourceItem,
  type SourceUpdateResult,
} from '../../core/index.js';
import { ARTIFACT_FIELD_DEFINITIONS } from './fields.js';

/** Item kind reported as {@link SourceItem.type}. */
export const ARTIFACT_ITEM_TYPE = 'artifact';

/** Field values of an artifact (filters, views, worker context attributes). */
export function artifactFields(record: ArtifactRecord): Record<string, FieldValue> {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    kind: record.kind,
    file_name: record.fileName,
    size: record.size,
    file_count: record.fileCount,
    created_at: record.createdAt,
    workflow: record.workflowId,
    run_id: record.runId,
    parent: record.parentId,
    consumed_by: [...record.consumedBy],
    attempted_by: [...record.attemptedBy],
    url: artifactRoute(record.id),
  };
}

/** The {@link SourceItem} of an artifact. */
export function artifactItem(sourceId: string, record: ArtifactRecord): SourceItem {
  return {
    sourceId,
    itemId: record.id,
    key: sourceItemKey(sourceId, record.id),
    url: artifactRoute(record.id),
    type: ARTIFACT_ITEM_TYPE,
    createdAt: record.createdAt,
    fields: artifactFields(record),
  };
}

/** Adapter of one artifacts source. */
export class ArtifactSourceAdapter implements SourceAdapter {
  readonly type = ARTIFACT_SOURCE_TYPE;
  readonly repository = ARTIFACT_SOURCE_TYPE;

  constructor(
    readonly sourceId: string,
    private readonly catalog: ArtifactCatalog,
  ) {}

  fieldDefinitions(): readonly FieldDefinition[] {
    return ARTIFACT_FIELD_DEFINITIONS;
  }

  async listCandidates(_options: ListCandidatesOptions = {}): Promise<SourceItem[]> {
    return this.catalog.list().map((record) => artifactItem(this.sourceId, record));
  }

  async getItem(itemId: string): Promise<SourceItem | null> {
    const record = ARTIFACT_ID_PATTERN.test(itemId) ? this.catalog.get(itemId) : null;
    return record ? artifactItem(this.sourceId, record) : null;
  }

  /** A bare artifact ID or a UI link (`…#/artifacts/<id>`). */
  parseItemRef(ref: string): string | null {
    const trimmed = ref.trim();
    const id = /#\/artifacts\/([^/?#\s]+)\/?$/.exec(trimmed)?.[1];
    const candidate = id !== undefined ? safeDecode(id) : trimmed;
    return candidate !== null && ARTIFACT_ID_PATTERN.test(candidate) ? candidate : null;
  }

  async resolveFields(item: SourceItem, fields: readonly string[]): Promise<Record<string, FieldResolution>> {
    const out: Record<string, FieldResolution> = {};
    for (const name of fields) {
      out[name] = Object.hasOwn(item.fields, name)
        ? { known: true, value: item.fields[name] as FieldValue }
        : { known: false, reason: `unknown field "${name}" for source type ${ARTIFACT_SOURCE_TYPE}` };
    }
    return out;
  }

  async applyUpdate(): Promise<SourceUpdateResult> {
    throw unsupported('source.update');
  }

  async postComment(): Promise<CommentRef> {
    throw unsupported('source.comment');
  }

  async findCommentByMarker(): Promise<CommentRef | null> {
    throw unsupported('source.comment');
  }
}

function unsupported(what: string): SourceError {
  return new SourceError('invalid', `"${what}" is not supported by the artifacts source`);
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Factory (the catalogue is injected, not part of the YAML config). */
export function createArtifactSourceFactory(catalog: ArtifactCatalog): SourceAdapterFactory<Record<string, never>> {
  return {
    type: ARTIFACT_SOURCE_TYPE,
    create: (sourceId) => new ArtifactSourceAdapter(sourceId, catalog),
  };
}
