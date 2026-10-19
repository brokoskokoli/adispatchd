/**
 * Read-only views (Spec §17): items from one or more sources of the same
 * adapter type, filtered declaratively (no shell), enriched with internal run
 * metadata (`run.last_*`) by the global item key, sorted, with link columns.
 *
 * - Data is loaded on open/refresh; results are cached briefly (default 30 s).
 * - The view filter is evaluated locally on every item (adapters may receive
 *   the pushable part but are allowed to ignore it); only `true` matches –
 *   `unknown` items are not shown (counted in `filterUnknown`).
 * - Unavailable columns stay recognizably empty (`value: null`, `known: false`).
 * - A failing source does not hide the other sources' rows (`errors`).
 */
import {
  errorMessage,
  noopLogger,
  OrchestratorError,
  systemClock,
  VIEW_RUN_FIELDS,
  type Clock,
  type FieldDefinition,
  type FieldResolution,
  type FieldType,
  type FieldValue,
  type Logger,
  type Redactor,
  type SourceAdapter,
  type SourceItem,
} from '../core/index.js';
import type { ConfigManager, ViewConfig } from '../config/index.js';
import { collectFields, createItemFieldSource, evaluateFilter, naturalCompare, splitForPushdown } from '../filters/index.js';
import type { RunRecord, RunRepository } from '../persistence/index.js';

/** Default cache lifetime of view results. */
export const DEFAULT_VIEW_CACHE_TTL_MS = 30_000;
/** Max rows returned per view (more are cut off, `truncated: true`). */
export const MAX_VIEW_ROWS = 2_000;

/** Internal run fields available to views (defined in core so config validation can use them). */
export { VIEW_RUN_FIELDS };

/** A view column. */
export interface ViewColumn {
  field: string;
  label: string;
  /** Field providing the link target (http(s) only). */
  link: string | null;
  /** Declared type, if known. */
  type: FieldType | null;
}

/** One cell (same order as the columns). */
export interface ViewCell {
  /** `null` when empty or unavailable. */
  value: FieldValue | null;
  /** False if the field could not be resolved (unknown field, missing permission, ...). */
  known: boolean;
  /** http(s) URL of the link column, if any. */
  link: string | null;
}

/** One row (= one external item). */
export interface ViewRow {
  /** Global item key `<sourceId>:<itemId>`. */
  key: string;
  sourceId: string;
  itemId: string;
  url: string | null;
  /** Latest run of this item (for linking into the run detail), if any. */
  lastRunId: string | null;
  cells: ViewCell[];
}

/** Result of {@link ViewService.items}. */
export interface ViewItemsResult {
  view: { id: string; title: string; sources: string[] };
  columns: ViewColumn[];
  rows: ViewRow[];
  /** Per-source problems (other sources still contribute rows). */
  errors: Array<{ sourceId: string; message: string }>;
  /** Items whose filter evaluated to `unknown` (not shown). */
  filterUnknown: number;
  truncated: boolean;
  fetchedAt: string;
  /** True if served from the cache. */
  cached: boolean;
}

/** View definition as exposed by the API. */
export interface ViewSummary {
  id: string;
  title: string;
  file: string;
  sources: string[];
  columns: ViewColumn[];
  sort: ViewConfig['sort'];
  filter: ViewConfig['filter'];
}

/** Options of {@link ViewService}. */
export interface ViewServiceOptions {
  config: Pick<ConfigManager, 'current'>;
  sources: (sourceId: string) => SourceAdapter | undefined;
  runs: Pick<RunRepository, 'lastRunsForItems'>;
  clock?: Clock;
  logger?: Logger;
  cacheTtlMs?: number;
  /** Redaction of error texts (shared `SecretRedactor`). */
  redact?: Redactor;
}

/** Error for unknown views. */
export class UnknownViewError extends OrchestratorError {
  constructor(readonly viewId: string) {
    super('view_not_found', `Unknown view "${viewId}"`, { details: { viewId } });
  }
}

interface CacheEntry {
  at: number;
  configVersion: number;
  result: ViewItemsResult;
}

/** See module docs. */
export class ViewService {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly ttl: number;
  private readonly redact: Redactor;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ViewItemsResult>>();

  constructor(private readonly options: ViewServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = (options.logger ?? noopLogger).child({ component: 'views' });
    this.ttl = options.cacheTtlMs ?? DEFAULT_VIEW_CACHE_TTL_MS;
    this.redact = options.redact ?? ((t) => t);
  }

  /** All view definitions, sorted by title. */
  list(): ViewSummary[] {
    return Object.values(this.options.config.current.views)
      .map((v) => this.summary(v))
      .sort((a, b) => naturalCompare(a.title, b.title) || naturalCompare(a.id, b.id));
  }

  /** One view definition or `undefined`. */
  get(viewId: string): ViewSummary | undefined {
    const view = this.view(viewId);
    return view ? this.summary(view) : undefined;
  }

  /** Drop cached results (config reload). */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Current items of a view. Cached for the TTL unless `refresh`; concurrent
   * requests for the same view share one load.
   * @throws UnknownViewError
   */
  async items(viewId: string, options: { refresh?: boolean } = {}): Promise<ViewItemsResult> {
    const view = this.view(viewId);
    if (!view) throw new UnknownViewError(viewId);
    const version = this.options.config.current.version;
    const now = this.clock.now().getTime();
    const hit = this.cache.get(viewId);
    if (!options.refresh && hit && hit.configVersion === version && now - hit.at < this.ttl) {
      return { ...hit.result, cached: true };
    }
    const running = this.inflight.get(viewId);
    if (running) return running;
    const load = this.load(view)
      .then((result) => {
        if (this.options.config.current.version === version) this.cache.set(viewId, { at: now, configVersion: version, result });
        return result;
      })
      .finally(() => this.inflight.delete(viewId));
    this.inflight.set(viewId, load);
    return load;
  }

  private view(viewId: string): ViewConfig | undefined {
    const views = this.options.config.current.views;
    return Object.hasOwn(views, viewId) ? views[viewId] : undefined;
  }

  private summary(view: ViewConfig): ViewSummary {
    return {
      id: view.id,
      title: view.title,
      file: view.file,
      sources: [...view.sources],
      columns: this.columns(view, this.definitionsFor(view)),
      sort: view.sort,
      filter: view.filter,
    };
  }

  private definitionsFor(view: ViewConfig): Map<string, FieldDefinition> {
    const defs = new Map<string, FieldDefinition>();
    for (const sourceId of view.sources) {
      const adapter = this.options.sources(sourceId);
      for (const d of adapter?.fieldDefinitions() ?? []) if (!defs.has(d.name)) defs.set(d.name, d);
    }
    for (const d of VIEW_RUN_FIELDS) defs.set(d.name, d);
    return defs;
  }

  private columns(view: ViewConfig, defs: Map<string, FieldDefinition>): ViewColumn[] {
    return view.fields.map((f) => {
      const def = defs.get(f.field);
      return { field: f.field, label: f.label, link: f.link ?? def?.link ?? null, type: def?.type ?? null };
    });
  }

  private async load(view: ViewConfig): Promise<ViewItemsResult> {
    const fetchedAt = this.clock.now().toISOString();
    const defs = this.definitionsFor(view);
    const columns = this.columns(view, defs);
    const errors: ViewItemsResult['errors'] = [];
    const loaded: Array<{ item: SourceItem; adapter: SourceAdapter }> = [];

    await Promise.all(
      view.sources.map(async (sourceId) => {
        const adapter = this.options.sources(sourceId);
        if (!adapter) {
          errors.push({ sourceId, message: `source '${sourceId}' is not available` });
          return;
        }
        try {
          const { pushdown } = splitForPushdown(view.filter, adapter.fieldDefinitions());
          const items = await adapter.listCandidates(pushdown ? { filter: pushdown } : {});
          for (const item of items) loaded.push({ item, adapter });
        } catch (err) {
          const message = this.redact(errorMessage(err));
          this.logger.warn('view source failed', { view: view.id, sourceId, error: message });
          errors.push({ sourceId, message });
        }
      }),
    );

    // Run enrichment (one query for all items).
    const lastRuns = this.options.runs.lastRunsForItems(loaded.map((l) => l.item.key));
    // Column links include the defaults of the field definitions (e.g. `work_pr` → `work_pr_url`), so that
    // expensive link targets are fetched in the same batch as the column itself.
    const wanted = [...new Set([...collectFields(view.filter), ...columns.flatMap((c) => [c.field, ...(c.link ? [c.link] : [])])])];
    if (view.sort) wanted.push(view.sort.field);

    let filterUnknown = 0;
    const seen = new Set<string>();
    const rows: Array<{ row: ViewRow; sortValue: FieldValue | null }> = [];
    await Promise.all(
      loaded.map(async ({ item, adapter }) => {
        if (seen.has(item.key)) return;
        seen.add(item.key);
        const run = lastRuns.get(item.key) ?? null;
        const fields = createItemFieldSource(item, {
          // Run fields are declared too, so that their types apply (dates compare as instants).
          definitions: [...adapter.fieldDefinitions(), ...VIEW_RUN_FIELDS],
          resolveFields: (i, f) => adapter.resolveFields(i, f),
          wantedFields: wanted,
          extraFields: runFields(run),
        });
        const verdict = (await evaluateFilter(view.filter, fields)).value;
        if (verdict !== true) {
          if (verdict === 'unknown') filterUnknown++;
          return;
        }
        const resolve = async (field: string): Promise<FieldResolution> => {
          try {
            return await fields.resolve(field);
          } catch (err) {
            return { known: false, reason: errorMessage(err) };
          }
        };
        const cells: ViewCell[] = [];
        for (const column of columns) {
          const res = await resolve(column.field);
          const linkRes = column.link ? await resolve(column.link) : null;
          cells.push({
            value: res.known ? (res.value ?? null) : null,
            known: res.known,
            link: linkRes?.known ? safeLink(linkRes.value) : null,
          });
        }
        const sortRes = view.sort ? await resolve(view.sort.field) : null;
        rows.push({
          row: { key: item.key, sourceId: item.sourceId, itemId: item.itemId, url: safeLink(item.url), lastRunId: run?.id ?? null, cells },
          sortValue: sortRes?.known ? (sortRes.value ?? null) : null,
        });
      }),
    );

    const sortType = view.sort ? (defs.get(view.sort.field)?.type ?? null) : null;
    const direction = view.sort?.direction === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      if (view.sort) {
        const c = compareValues(a.sortValue, b.sortValue, sortType, direction);
        if (c !== 0) return c;
      }
      return naturalCompare(a.row.key, b.row.key);
    });
    errors.sort((a, b) => naturalCompare(a.sourceId, b.sourceId));
    return {
      view: { id: view.id, title: view.title, sources: [...view.sources] },
      columns,
      rows: rows.slice(0, MAX_VIEW_ROWS).map((r) => r.row),
      errors,
      filterUnknown,
      truncated: rows.length > MAX_VIEW_ROWS,
      fetchedAt,
      cached: false,
    };
  }
}

/** `run.last_*` values for an item (known empty if the item has no run). */
export function runFields(run: RunRecord | null): Record<string, FieldValue> {
  const result = run?.result as { message?: unknown } | null | undefined;
  return {
    'run.last_id': run?.id ?? null,
    'run.last_workflow': run?.workflowId ?? null,
    'run.last_status': run?.status ?? null,
    'run.last_result': run?.businessResult ?? null,
    'run.last_result.message': typeof result?.message === 'string' ? result.message : null,
    'run.last_status_message': run?.statusMessage ?? null,
    'run.last_started_at': run?.startedAt ?? null,
    'run.last_finished_at': run?.finishedAt ?? null,
  };
}

/** Only absolute http(s) URLs are used as links (XSS, Spec §20.5). */
export function safeLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Compare two cell values; empty values always last, independent of the direction. */
function compareValues(a: FieldValue | null, b: FieldValue | null, type: FieldType | null, direction: 1 | -1): number {
  const emptyA = a === null || a === undefined;
  const emptyB = b === null || b === undefined;
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (type === 'date' && typeof a === 'string' && typeof b === 'string') {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return direction * Math.sign(ta - tb);
  }
  if (typeof a === 'number' && typeof b === 'number') return direction * Math.sign(a - b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return direction * (Number(a) - Number(b));
  const sa = Array.isArray(a) ? a.join(', ') : String(a);
  const sb = Array.isArray(b) ? b.join(', ') : String(b);
  return direction * naturalCompare(sa, sb);
}
