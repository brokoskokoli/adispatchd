/**
 * Dashboard layout (WI-32), DOM-free parts: the layout shape served by
 * `GET /api/v1/dashboard`, column templates, default widget titles, merging
 * the requests of several view widgets of one view into one query, narrowing
 * a view result for one widget, and the selected tabs in the URL hash.
 */

/** Widgets of the layout (normalized by the server). */
export type DashboardWidget =
  | { widget: 'resources' | 'resources_full' | 'scheduler' | 'capacity' | 'attention'; title: string | null }
  | { widget: 'info'; title: string | null; ids: string[] | null }
  | { widget: 'active_runs' | 'recent_runs'; title: string | null; limit: number; workflows: string[] | null }
  | { widget: 'view'; title: string | null; view: string; sections: string[] | null; limit: number; refreshMs: number }
  | { widget: 'tabs'; title: string | null; default: string; tabs: DashboardTab[] };

export interface DashboardTab {
  id: string;
  title: string;
  layout: DashboardRow[];
}

export interface DashboardColumn {
  width: number;
  widgets: DashboardWidget[];
}

export interface DashboardRow {
  title: string | null;
  columns: DashboardColumn[];
}

/** Body of `GET /api/v1/dashboard`. */
export interface DashboardLayoutResponse {
  configured: boolean;
  layout: DashboardRow[];
}

/** `grid-template-columns` of a row: relative widths, columns may shrink below their content. */
export function columnTemplate(columns: readonly { width: number }[]): string {
  return columns.map((c) => `minmax(0, ${Math.max(1, Math.round(c.width))}fr)`).join(' ');
}

const DEFAULT_TITLES: Partial<Record<DashboardWidget['widget'], string>> = {
  scheduler: 'Scheduler',
  capacity: 'Capacity',
  attention: 'Attention',
  active_runs: 'Active runs',
  recent_runs: 'Recently finished',
  info: 'Information',
  resources_full: 'Server',
};

/** Heading of a widget: its `title`, else the 0.7.0 heading (`null`: none / taken from the data, e.g. the view name). */
export function widgetTitle(widget: DashboardWidget): string | null {
  return widget.title ?? DEFAULT_TITLES[widget.widget] ?? null;
}

/** What one view widget needs from the view. */
export interface ViewRequest {
  /** `null` = all sections. */
  sections: readonly string[] | null;
  limit: number;
}

/** One query covering several widgets of the same view (union of the sections, the largest limit). */
export function mergeViewRequests(requests: readonly ViewRequest[]): ViewRequest {
  let sections: string[] | null = [];
  let limit = 1;
  for (const r of requests) {
    limit = Math.max(limit, r.limit);
    if (r.sections === null || sections === null) sections = null;
    else for (const s of r.sections) if (!sections.includes(s)) sections.push(s);
  }
  return { sections: sections && sections.length > 0 ? sections : null, limit };
}

/** True if data fetched for `have` contains everything `want` needs. */
export function coversRequest(have: ViewRequest, want: ViewRequest): boolean {
  if (have.limit < want.limit) return false;
  if (have.sections === null) return true;
  if (want.sections === null) return false;
  return want.sections.every((s) => have.sections?.includes(s));
}

/** Minimal shape of a view result needed for narrowing. */
export interface NarrowableView<R, S extends { title: string; rows: R[] }> {
  rows: R[];
  totalRows?: number;
  sections?: S[];
}

/** The part of a (merged) view result one widget shows: its sections, at most `limit` rows per table. */
export function narrowForWidget<R, S extends { title: string; rows: R[] }, V extends NarrowableView<R, S>>(data: V, request: ViewRequest): V {
  if (!data.sections) {
    return { ...data, rows: data.rows.slice(0, request.limit), totalRows: data.totalRows ?? data.rows.length };
  }
  const wanted = request.sections;
  const sections = data.sections.filter((s) => wanted === null || wanted.includes(s.title)).map((s) => ({ ...s, rows: s.rows.slice(0, request.limit) }));
  return { ...data, sections };
}

/** Smallest refresh interval of the subscribed widgets (`null` without any). */
export function pollInterval(intervals: readonly number[]): number | null {
  return intervals.length > 0 ? Math.min(...intervals) : null;
}

// --- selected tabs in the URL (`#/?tab=projects/a,runs`) ---------------------

/** Query parameter holding the selected tabs. */
export const TAB_QUERY = 'tab';

/** Paths of selected tab IDs from the query value (`a/b,c` → `[[a, b], [c]]`). */
export function parseTabParam(value: string | undefined): string[][] {
  if (!value) return [];
  return value
    .split(',')
    .map((p) => p.split('/').map((s) => s.trim()).filter((s) => s !== ''))
    .filter((p) => p.length > 0);
}

/**
 * Selected tab of a tabs widget from the URL: the entry that continues the
 * selected tabs of the enclosing tabs widgets (`ancestor`) with one of the
 * widget's own tab IDs; `null` if there is none.
 */
export function tabFromPaths(paths: readonly string[][], ancestor: readonly string[], ids: readonly string[]): string | null {
  for (const p of paths) {
    if (p.length <= ancestor.length) continue;
    if (!ancestor.every((a, i) => p[i] === a)) continue;
    const id = p[ancestor.length];
    if (id !== undefined && ids.includes(id)) return id;
  }
  return null;
}

/** Query value for the selected paths (paths that are a prefix of another are dropped; `''` = none). */
export function formatTabParam(paths: readonly string[][]): string {
  const key = (p: readonly string[]): string => p.join('/');
  const keep = paths.filter((p, i) => p.length > 0 && !paths.some((q, j) => j !== i && q.length > p.length && p.every((s, k) => q[k] === s)));
  return [...new Set(keep.map(key))].join(',');
}

/** localStorage key of a tabs widget (its place: selected ancestor tabs + own tab IDs). */
export function tabStorageKey(ancestor: readonly string[], ids: readonly string[]): string {
  return `adispatchd.dashboard.tab:${[...ancestor, ids.join('|')].join('/')}`;
}

/** Index of the tab a key moves to in a horizontal tablist (←/→ wrap around, Home/End); `null` for other keys. */
export function tabKeyTarget(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
