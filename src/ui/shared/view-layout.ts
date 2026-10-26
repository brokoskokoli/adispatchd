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

/**
 * Key of the browser-only column sort of a table: by section title (unique per
 * view), so a sort survives a refresh even if empty sections are hidden or the
 * section list changes; the plain view uses a fixed key.
 */
export function tableSortKey(sectionTitle: string | null): string {
  return sectionTitle === null ? 'view' : `section:${sectionTitle}`;
}

/** Target of a jump link (a section heading with `tabindex="-1"`). */
export interface JumpTarget {
  scrollIntoView(options?: { behavior?: 'smooth' | 'auto'; block?: 'start' }): void;
  focus(options?: { preventScroll?: boolean }): void;
}

/** Scroll to a section heading and move the keyboard focus there. */
export function jumpTo(target: JumpTarget | undefined): void {
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
}

/** Short description of the configured sort, e.g. `project.Status (custom order), created_at ↑`. */
export function describeSort(keys: readonly SortKeyLike[]): string {
  if (keys.length === 0) return 'item key';
  return keys.map((k) => `${k.field}${k.order ? ' (custom order)' : ''} ${k.direction === 'desc' ? '↓' : '↑'}`).join(', ');
}

/** Max. rows of a view table delivered by the server (mirror of `MAX_VIEW_ROWS` in src/views, checked by a test). */
export const MAX_VIEW_ROWS = 2_000;
