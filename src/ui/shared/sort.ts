/**
 * Client-side column sorting of views (Spec §17: sorting in the browser is
 * allowed, no further filters). Unknown/empty values always sort last.
 */

/** Cell as returned by `GET /api/v1/views/:id/items`. */
export interface CellLike {
  value: unknown;
  known: boolean;
}

/** Sort direction. */
export type SortDirection = 'asc' | 'desc';

function isEmpty(c: CellLike | undefined): boolean {
  if (!c || !c.known) return true;
  const v = c.value;
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

/** Comparable primitive of a value of column type `type`. */
function key(value: unknown, type: string): number | string {
  if (type === 'number' || typeof value === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (type === 'date' || type === 'datetime') {
    const t = Date.parse(String(value));
    if (!Number.isNaN(t)) return t;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Compare two cells (empty last regardless of direction). */
export function compareCells(a: CellLike | undefined, b: CellLike | undefined, type: string, direction: SortDirection): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const ka = key(a!.value, type);
  const kb = key(b!.value, type);
  let r: number;
  if (typeof ka === 'number' && typeof kb === 'number') r = ka - kb;
  else r = collator ? collator.compare(String(ka), String(kb)) : String(ka) < String(kb) ? -1 : String(ka) > String(kb) ? 1 : 0;
  return direction === 'asc' ? r : -r;
}

/** Stable sort of rows by the cell at `column`. Returns a new array. */
export function sortRows<R extends { cells: readonly CellLike[] }>(rows: readonly R[], column: number, type: string, direction: SortDirection): R[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => compareCells(x.row.cells[column], y.row.cells[column], type, direction) || x.index - y.index)
    .map((x) => x.row);
}

/** Next sort state when a column header is clicked. */
export function nextSort(current: { column: number; direction: SortDirection } | null, column: number): { column: number; direction: SortDirection } {
  if (!current || current.column !== column) return { column, direction: 'asc' };
  return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

/** Display text of a cell value (arrays joined, objects as JSON); `''` for empty. */
export function cellText(c: CellLike | undefined): string {
  if (isEmpty(c)) return '';
  const v = c!.value;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}
