/**
 * DOM-free layout helpers of the views page (WI-28): sections with headings,
 * row groups by the first sort key, jump links, configured sort description.
 */

/** Sort key as returned by the API. */
export interface SortKeyLike {
  field: string;
  direction: 'asc' | 'desc';
  order: readonly string[] | null;
}

/** Minimal section shape of `GET /api/v1/views/:id/items`. */
export interface SectionLike<R> {
  title: string;
  rows: readonly R[];
  counts: { rows: number };
}

/** Consecutive rows with the same `group` value. */
export interface RowGroup<R> {
  group: string | null;
  rows: R[];
}

/** Split rows (already sorted by the server) into consecutive groups of equal `group`. */
export function groupRows<R extends { group?: string | null }>(rows: readonly R[]): RowGroup<R>[] {
  const out: RowGroup<R>[] = [];
  for (const row of rows) {
    const group = row.group ?? null;
    const last = out[out.length - 1];
    if (last && last.group === group) last.rows.push(row);
    else out.push({ group, rows: [row] });
  }
  return out;
}

/** Text of a group heading row. */
export function groupLabel(group: string | null, count: number): string {
  return `${group ?? '(empty)'} · ${count}`;
}

/** Heading of a section with its row count. */
export function sectionHeading(title: string, count: number): string {
  return `${title} (${count})`;
}

/** Sections shown on the page (`hideEmpty`: drop sections without rows). */
export function visibleSections<S extends SectionLike<unknown>>(sections: readonly S[], hideEmpty: boolean): S[] {
  return hideEmpty ? sections.filter((s) => s.counts.rows > 0) : [...sections];
}

/** Jump links above the sections only pay off for more than three sections. */
export function needsJumpLinks(count: number): boolean {
  return count > 3;
}

/** Short description of the configured sort, e.g. `project.Status (custom order), created_at ↑`. */
export function describeSort(keys: readonly SortKeyLike[]): string {
  if (keys.length === 0) return 'item key';
  return keys.map((k) => `${k.field}${k.order ? ' (custom order)' : ''} ${k.direction === 'desc' ? '↓' : '↑'}`).join(', ');
}
