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
 * - Sorting (WI-28): up to 5 keys, each optionally with a custom value order;
 *   ties by the item key (natural order).
 * - Sections (WI-28): the sources are listed once; every section filters the
 *   view's items locally (`exclusive`: first matching section only), with its
 *   own sort and columns.
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
  type FilterNode,
  type Logger,
  type Redactor,
  type SourceAdapter,
  type SourceItem,
} from '../core/index.js';
import type { ConfigManager, ViewConfig, ViewFieldConfig, ViewSortKey } from '../config/index.js';
import { collectFields, createItemFieldSource, evaluateFilter, naturalCompare, splitForPushdown } from '../filters/index.js';
import type { RunRecord, RunRepository } from '../persistence/index.js';

/** Default cache lifetime of view results. */
export const DEFAULT_VIEW_CACHE_TTL_MS = 30_000;
/** Max rows returned per view (more are cut off, `truncated: true`); with sections per section. */
export const MAX_VIEW_ROWS = 2_000;

/** Prefix of declared GitHub Projects fields (kept local: views import config/core only). */
const PROJECT_PREFIX = 'project.';

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
  /** Value of the first sort key as text (only when the table is grouped, WI-28); `null` = empty/unknown. */
  group?: string | null;
}

/** Grouping of a table by its first sort key (WI-28, `group_by_first`). */
export interface ViewGrouping {
  field: string;
  /** Column label of the field if it is shown, else the field name. */
  label: string;
}

/** One section of a view result (WI-28). */
export interface ViewSectionResult {
  title: string;
  rest: boolean;
  /** Columns of this section (own `fields` or the view's). */
  fields: ViewColumn[];
  /** Effective sort keys of this section. */
  sort: ViewSortKey[];
  rows: ViewRow[];
  counts: {
    /** Rows in this section (before truncation). */
    rows: number;
    /** View items whose section filter evaluated to `unknown` (not shown in this section). */
    filterUnknown: number;
    truncated: boolean;
  };
  /** Set when rows carry `group`. */
  groupBy: ViewGrouping | null;
}

/** Result of {@link ViewService.items}. */
export interface ViewItemsResult {
  view: { id: string; title: string; sources: string[] };
  columns: ViewColumn[];
  /** Rows of a view without sections; `[]` with sections (rows are in `sections`). */
  rows: ViewRow[];
  /** Per-source problems (other sources still contribute rows). */
  errors: Array<{ sourceId: string; message: string }>;
  /** Items whose view filter evaluated to `unknown` (not shown). */
  filterUnknown: number;
  truncated: boolean;
  fetchedAt: string;
  /** True if served from the cache. */
  cached: boolean;
  /** Non-fatal hints (WI-28: `order` values a project does not offer as options). */
  warnings: string[];
  /** Only for views with sections (WI-28). */
  sections?: ViewSectionResult[];
  /** Only for a grouped view without sections (WI-28). */
  groupBy?: ViewGrouping;
  /** Only for views with sections (WI-28): the UI hides sections without rows. */
  hideEmptySections?: boolean;
}

/** Section definition as exposed by the API (WI-28). */
export interface ViewSectionSummary {
  title: string;
  rest: boolean;
  filter: FilterNode | null;
  fields: ViewColumn[];
  sort: ViewSortKey[];
}

/** View definition as exposed by the API. */
export interface ViewSummary {
  id: string;
  title: string;
  file: string;
  sources: string[];
  columns: ViewColumn[];
  /** Always a list (WI-28); `[]` = unsorted (item key order). */
  sort: ViewSortKey[];
  filter: ViewConfig['filter'];
  groupByFirst: boolean;
  /** `null` without sections. */
  sections: ViewSectionSummary[] | null;
  exclusive: boolean;
  hideEmptySections: boolean;
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

/** One table of a view (the view itself, or one section). */
interface Table {
  title: string;
  rest: boolean;
  filter: FilterNode | null;
  columns: ViewColumn[];
  sort: readonly ViewSortKey[];
  groupBy: ViewGrouping | null;
}

interface PendingRow {
  row: ViewRow;
  sortValues: Array<FieldValue | null>;
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
    const defs = this.definitionsFor(view);
    return {
      id: view.id,
      title: view.title,
      file: view.file,
      sources: [...view.sources],
      columns: this.columns(view.fields, defs),
      sort: view.sort.map(copyKey),
      filter: view.filter,
      groupByFirst: view.groupByFirst,
      sections:
        view.sections?.map((s) => ({
          title: s.title,
          rest: s.rest,
          filter: s.filter,
          fields: this.columns(s.fields ?? view.fields, defs),
          sort: (s.sort ?? view.sort).map(copyKey),
        })) ?? null,
      exclusive: view.exclusive,
      hideEmptySections: view.hideEmptySections,
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

  private columns(fields: readonly ViewFieldConfig[], defs: Map<string, FieldDefinition>): ViewColumn[] {
    return fields.map((f) => {
      const def = defs.get(f.field);
      return { field: f.field, label: f.label, link: f.link ?? def?.link ?? null, type: def?.type ?? null };
    });
  }

  /** The tables of a view: one per section, or the view itself. */
  private tables(view: ViewConfig, defs: Map<string, FieldDefinition>): Table[] {
    const table = (title: string, rest: boolean, filter: FilterNode | null, fields: readonly ViewFieldConfig[], sort: readonly ViewSortKey[]): Table => {
      const columns = this.columns(fields, defs);
      const first = sort[0];
      const groupBy =
        view.groupByFirst && first?.order
          ? { field: first.field, label: columns.find((c) => c.field === first.field)?.label ?? first.field }
          : null;
      return { title, rest, filter, columns, sort, groupBy };
    };
    if (!view.sections) return [table(view.title, false, null, view.fields, view.sort)];
    return view.sections.map((s) => table(s.title, s.rest, s.filter, s.fields ?? view.fields, s.sort ?? view.sort));
  }

  private async load(view: ViewConfig): Promise<ViewItemsResult> {
    const fetchedAt = this.clock.now().toISOString();
    const defs = this.definitionsFor(view);
    const columns = this.columns(view.fields, defs);
    const tables = this.tables(view, defs);
    const errors: ViewItemsResult['errors'] = [];
    const loaded: Array<{ item: SourceItem; adapter: SourceAdapter }> = [];

    // Every source is listed exactly once, also with sections (they filter locally).
    const [, warnings] = await Promise.all([
      Promise.all(
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
      ),
      this.orderWarnings(view, tables),
    ]);

    // Run enrichment (one query for all items).
    const lastRuns = this.options.runs.lastRunsForItems(loaded.map((l) => l.item.key));
    // Column links include the defaults of the field definitions (e.g. `work_pr` → `work_pr_url`), so that
    // expensive link targets are fetched in the same batch as the column itself.
    const wanted = new Set<string>(collectFields(view.filter));
    for (const t of tables) {
      if (t.filter) for (const f of collectFields(t.filter)) wanted.add(f);
      for (const c of t.columns) {
        wanted.add(c.field);
        if (c.link) wanted.add(c.link);
      }
      for (const k of t.sort) wanted.add(k.field);
    }

    let filterUnknown = 0;
    const sectionUnknown = tables.map(() => 0);
    const tableRows: PendingRow[][] = tables.map(() => []);
    const seen = new Set<string>();
    await Promise.all(
      loaded.map(async ({ item, adapter }) => {
        if (seen.has(item.key)) return;
        seen.add(item.key);
        const run = lastRuns.get(item.key) ?? null;
        const fields = createItemFieldSource(item, {
          // Run fields are declared too, so that their types apply (dates compare as instants).
          definitions: [...adapter.fieldDefinitions(), ...VIEW_RUN_FIELDS],
          resolveFields: (i, f) => adapter.resolveFields(i, f),
          wantedFields: [...wanted],
          extraFields: runFields(run),
        });
        const verdict = (await evaluateFilter(view.filter, fields)).value;
        if (verdict !== true) {
          if (verdict === 'unknown') filterUnknown++;
          return;
        }
        const placed = view.sections ? await placeInSections(view, tables, (f) => evaluateFilter(f, fields), sectionUnknown) : [0];
        const resolve = async (field: string): Promise<FieldResolution> => {
          try {
            return await fields.resolve(field);
          } catch (err) {
            return { known: false, reason: errorMessage(err) };
          }
        };
        for (const index of placed) {
          const t = tables[index] as Table;
          const cells: ViewCell[] = [];
          for (const column of t.columns) {
            const res = await resolve(column.field);
            const linkRes = column.link ? await resolve(column.link) : null;
            cells.push({
              value: res.known ? (res.value ?? null) : null,
              known: res.known,
              link: linkRes?.known ? safeLink(linkRes.value) : null,
            });
          }
          const sortValues: Array<FieldValue | null> = [];
          for (const key of t.sort) {
            const res = await resolve(key.field);
            sortValues.push(res.known ? (res.value ?? null) : null);
          }
          const row: ViewRow = { key: item.key, sourceId: item.sourceId, itemId: item.itemId, url: safeLink(item.url), lastRunId: run?.id ?? null, cells };
          if (t.groupBy) row.group = groupText(sortValues[0] ?? null);
          (tableRows[index] as PendingRow[]).push({ row, sortValues });
        }
      }),
    );

    const finished = tables.map((t, i) => {
      const pending = tableRows[i] as PendingRow[];
      sortPending(pending, t.sort, defs);
      return { rows: pending.slice(0, MAX_VIEW_ROWS).map((r) => r.row), total: pending.length };
    });
    errors.sort((a, b) => naturalCompare(a.sourceId, b.sourceId));
    const base = {
      view: { id: view.id, title: view.title, sources: [...view.sources] },
      columns,
      errors,
      filterUnknown,
      fetchedAt,
      cached: false,
      warnings,
    };
    if (!view.sections) {
      const only = finished[0] as { rows: ViewRow[]; total: number };
      const groupBy = (tables[0] as Table).groupBy;
      return { ...base, rows: only.rows, truncated: only.total > MAX_VIEW_ROWS, ...(groupBy ? { groupBy } : {}) };
    }
    const sections: ViewSectionResult[] = tables.map((t, i) => {
      const f = finished[i] as { rows: ViewRow[]; total: number };
      return {
        title: t.title,
        rest: t.rest,
        fields: t.columns,
        sort: t.sort.map(copyKey),
        rows: f.rows,
        counts: { rows: f.total, filterUnknown: sectionUnknown[i] ?? 0, truncated: f.total > MAX_VIEW_ROWS },
        groupBy: t.groupBy,
      };
    });
    return { ...base, rows: [], truncated: sections.some((s) => s.counts.truncated), sections, hideEmptySections: view.hideEmptySections };
  }

  /**
   * Warnings for `order` values of `single_select` project fields that a
   * source's project does not offer as options (read from the project
   * metadata; problems reading it are not reported here).
   */
  private async orderWarnings(view: ViewConfig, tables: readonly Table[]): Promise<string[]> {
    const orders = new Map<string, Set<string>>();
    for (const t of tables) {
      for (const key of t.sort) {
        if (!key.order || !key.field.startsWith(PROJECT_PREFIX)) continue;
        const values = orders.get(key.field) ?? new Set<string>();
        for (const v of key.order) values.add(v);
        orders.set(key.field, values);
      }
    }
    if (orders.size === 0) return [];
    const perSource = await Promise.all(
      view.sources.map(async (sourceId) => {
        const adapter = this.options.sources(sourceId);
        if (!adapter?.projectFieldOptions) return [];
        try {
          const options = await adapter.projectFieldOptions();
          const out: string[] = [];
          for (const [field, values] of orders) {
            const name = field.slice(PROJECT_PREFIX.length);
            const declared = options.find((o) => o.name === name);
            if (!declared || declared.kind !== 'single_select' || declared.problem !== null) continue;
            const missing = [...values].filter((v) => !declared.choices.includes(v));
            if (missing.length > 0) {
              out.push(
                `Sort "order" of "${field}" lists ${missing.map((v) => `"${v}"`).join(', ')}, which the project of source "${sourceId}" does not offer as option(s)`,
              );
            }
          }
          return out;
        } catch (err) {
          this.logger.debug('view order check skipped', { view: view.id, sourceId, error: this.redact(errorMessage(err)) });
          return [];
        }
      }),
    );
    return perSource.flat();
  }
}

/**
 * Sections an item of the view belongs to (indexes into `tables`). Exclusive:
 * the first section whose filter is `true`; otherwise every such section. The
 * rest section takes items placed nowhere else. An `unknown` verdict is
 * counted for that section and never moves the item elsewhere: exclusive
 * stops there (the item is not shown at all – it might belong to that
 * section), non-exclusive keeps it out of the rest section.
 */
async function placeInSections(
  view: ViewConfig,
  tables: readonly Table[],
  evaluate: (filter: FilterNode) => Promise<{ value: boolean | 'unknown' }>,
  unknownCounts: number[],
): Promise<number[]> {
  const placed: number[] = [];
  let unknown = false;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i] as Table;
    if (t.rest || !t.filter) continue;
    const verdict = (await evaluate(t.filter)).value;
    if (verdict === true) {
      placed.push(i);
      if (view.exclusive) break;
    } else if (verdict === 'unknown') {
      unknownCounts[i] = (unknownCounts[i] ?? 0) + 1;
      unknown = true;
      if (view.exclusive) return [];
    }
  }
  if (placed.length === 0 && !unknown) {
    const rest = tables.findIndex((t) => t.rest);
    if (rest >= 0) placed.push(rest);
  }
  return placed;
}

function copyKey(key: ViewSortKey): ViewSortKey {
  return { field: key.field, direction: key.direction, order: key.order ? [...key.order] : null };
}

/** Sort rows by `keys` in place; ties by item key (natural order). */
function sortPending(rows: PendingRow[], keys: readonly ViewSortKey[], defs: Map<string, FieldDefinition>): void {
  const types = keys.map((k) => defs.get(k.field)?.type ?? null);
  const orders = keys.map((k) => (k.order ? new Map(k.order.map((v, i) => [v, i])) : null));
  rows.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as ViewSortKey;
      const direction = key.direction === 'desc' ? -1 : 1;
      const order = orders[i];
      const va = a.sortValues[i] ?? null;
      const vb = b.sortValues[i] ?? null;
      const c = order ? compareOrdered(va, vb, order, direction) : compareValues(va, vb, types[i] ?? null, direction);
      if (c !== 0) return c;
    }
    return naturalCompare(a.row.key, b.row.key);
  });
}

/** Group label of a value (`null` for empty). */
function groupText(value: FieldValue | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  return Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value);
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
    'run.last_outcome': run?.outcome ?? null,
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

function isEmptyValue(v: FieldValue | null): boolean {
  return v === null || v === undefined;
}

/**
 * Compare by a custom value order (WI-28): listed values by their position
 * (`direction` reverses it), then unlisted values alphabetically, empty values
 * last – unlisted and empty values stay behind the listed ones in both
 * directions. Comparison is case-sensitive.
 */
export function compareOrdered(a: FieldValue | null, b: FieldValue | null, order: ReadonlyMap<string, number>, direction: 1 | -1): number {
  // `''` counts as empty here, like in the group label (an empty text/single-select value).
  const emptyA = isEmptyValue(a) || a === '';
  const emptyB = isEmptyValue(b) || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const sa = String(a);
  const sb = String(b);
  const ia = order.get(sa);
  const ib = order.get(sb);
  if (ia !== undefined && ib !== undefined) return direction * Math.sign(ia - ib);
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  return naturalCompare(sa, sb);
}

/** Compare two cell values; empty values always last, independent of the direction. */
function compareValues(a: FieldValue | null, b: FieldValue | null, type: FieldType | null, direction: 1 | -1): number {
  const emptyA = isEmptyValue(a);
  const emptyB = isEmptyValue(b);
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
