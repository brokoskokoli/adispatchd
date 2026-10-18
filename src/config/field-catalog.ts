/**
 * Offline checks of field references against the static field catalogue of
 * the adapter type (WI-13): field names (with "did you mean" suggestions),
 * operators per field type, value types, view-only `run.last_*` fields and
 * listing-selector fields such as GitHub `state` that only work at the top
 * level of a filter (pushdown).
 */
import {
  VIEW_RUN_FIELDS,
  isFilterAll,
  isFilterAny,
  isFilterNot,
  type FieldDefinition,
  type FieldType,
  type FilterNode,
  type FilterPredicate,
} from '../core/index.js';
import { parseIsoDate } from '../filters/index.js';
import { GITHUB_FIELD_DEFINITIONS } from '../sources/index.js';

/** Static field catalogue per source adapter type. */
export const FIELD_CATALOG: Readonly<Record<string, readonly FieldDefinition[]>> = {
  github: GITHUB_FIELD_DEFINITIONS,
};

/**
 * Field that selects which items the adapter lists at all (pushdown into the
 * listing query). It is only effective as a top-level conjunct with one of
 * `operators`; anywhere else the listing silently keeps its default.
 */
interface ListingField {
  field: string;
  operators: readonly string[];
  values: readonly string[];
  /** What the adapter lists without a top-level selector. */
  defaultDescription: string;
}

const LISTING_FIELDS: Readonly<Record<string, ListingField>> = {
  github: { field: 'state', operators: ['equals', 'in'], values: ['open', 'closed'], defaultDescription: 'only open issues/PRs' },
};

/** Problem with a field reference; `path` is relative to the checked node. */
export interface FieldIssue {
  path: (string | number)[];
  message: string;
}

/** Field catalogue for a context, or `undefined` if the adapter type has none (no checks). */
export interface FieldContext {
  sourceType: string;
  /** View context: `run.last_*` fields are available. */
  view: boolean;
}

function definitions(ctx: FieldContext): readonly FieldDefinition[] | undefined {
  const base = FIELD_CATALOG[ctx.sourceType];
  if (!base) return undefined;
  return ctx.view ? [...base, ...VIEW_RUN_FIELDS] : base;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min((prev[j] as number) + 1, (prev[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** Closest known name, if reasonably close. */
export function suggestField(name: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of names) {
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

/** Message for an unknown field, or `undefined` if the field exists. */
function unknownFieldMessage(field: string, ctx: FieldContext, defs: readonly FieldDefinition[]): string | undefined {
  if (defs.some((d) => d.name === field)) return undefined;
  if (!ctx.view && VIEW_RUN_FIELDS.some((d) => d.name === field)) {
    return `Field "${field}" is only available in views, not in workflows`;
  }
  const suggestion = suggestField(field, defs.map((d) => d.name));
  const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
  return `Unknown field "${field}" for source type ${ctx.sourceType}${hint}`;
}

/** Check a single field name (view columns, links, sort). */
export function checkFieldName(field: string, ctx: FieldContext): string | undefined {
  const defs = definitions(ctx);
  return defs ? unknownFieldMessage(field, ctx, defs) : undefined;
}

const SCALAR_TYPE: Record<FieldType, 'string' | 'number' | 'boolean'> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  date: 'string',
  'string[]': 'string',
};

function describeValue(v: unknown): string {
  return typeof v === 'string' ? `string "${v}"` : v === null ? 'null' : `${typeof v} ${String(v)}`;
}

function checkValue(p: FilterPredicate, def: FieldDefinition, at: (string | number)[], issues: FieldIssue[]): void {
  const values = Array.isArray(p.value) ? (p.value as readonly unknown[]) : [p.value];
  if (p.value === null) {
    if (p.operator !== 'equals' && p.operator !== 'not_equals') {
      issues.push({ path: [...at, 'value'], message: `Operator "${p.operator}" cannot compare with null` });
    }
    return;
  }
  const expected = SCALAR_TYPE[def.type];
  for (const v of values) {
    if (typeof v !== expected) {
      issues.push({
        path: [...at, 'value'],
        message: `Value for field "${def.name}" (type ${def.type}) must be a ${expected}, got ${describeValue(v)}`,
      });
      return;
    }
    if (def.type === 'date' && parseIsoDate(v) === undefined) {
      issues.push({
        path: [...at, 'value'],
        message: `Value "${String(v)}" for date field "${def.name}" is not an ISO-8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM])`,
      });
      return;
    }
  }
}

function checkListing(
  p: FilterPredicate,
  listing: ListingField,
  topLevel: boolean,
  at: (string | number)[],
  issues: FieldIssue[],
): void {
  const selector = `${listing.field} ${listing.operators.join('/')} ${listing.values.join('|')}`;
  if (!topLevel) {
    issues.push({
      path: [...at, 'field'],
      message:
        `"${listing.field}" only works at the top level of the filter (directly or inside top-level "all"): ` +
        `the source lists ${listing.defaultDescription} unless the top-level filter selects others (${selector}), ` +
        `so under "any"/"not" it would silently never see them`,
    });
    return;
  }
  if (!listing.operators.includes(p.operator)) {
    issues.push({
      path: [...at, 'operator'],
      message: `"${listing.field}" must use ${listing.operators.map((o) => `"${o}"`).join(' or ')}: only these select which items are listed (otherwise ${listing.defaultDescription} are seen)`,
    });
    return;
  }
  const values = Array.isArray(p.value) ? (p.value as readonly unknown[]) : [p.value];
  const bad = values.find((v) => typeof v !== 'string' || !listing.values.includes(v));
  if (bad !== undefined) {
    issues.push({
      path: [...at, 'value'],
      message: `"${listing.field}" values must be ${listing.values.map((v) => `"${v}"`).join(' or ')}, got ${describeValue(bad)}`,
    });
  }
}

/**
 * Check every predicate of `node` against the catalogue of `ctx`.
 * `listing: true` for the main `filter` of a workflow/view (applies the
 * listing-selector rule); `false` for e.g. `item_priority` rules.
 */
export function checkFilterFields(node: FilterNode, ctx: FieldContext, options: { listing: boolean }): FieldIssue[] {
  const defs = definitions(ctx);
  if (!defs) return [];
  const listing = options.listing ? LISTING_FIELDS[ctx.sourceType] : undefined;
  const issues: FieldIssue[] = [];
  const visit = (n: FilterNode, at: (string | number)[], topLevel: boolean): void => {
    if (isFilterAll(n)) return n.all.forEach((c, i) => visit(c, [...at, 'all', i], topLevel));
    if (isFilterAny(n)) return n.any.forEach((c, i) => visit(c, [...at, 'any', i], false));
    if (isFilterNot(n)) return visit(n.not, [...at, 'not'], false);
    const p = n as FilterPredicate;
    const unknown = unknownFieldMessage(p.field, ctx, defs);
    if (unknown) {
      issues.push({ path: [...at, 'field'], message: unknown });
      return;
    }
    const def = defs.find((d) => d.name === p.field) as FieldDefinition;
    if (!def.operators.includes(p.operator)) {
      issues.push({
        path: [...at, 'operator'],
        message: `Operator "${p.operator}" is not supported for field "${p.field}" (type ${def.type}); allowed: ${def.operators.join(', ')}`,
      });
      return;
    }
    if (listing && p.field === listing.field) {
      const before = issues.length;
      checkListing(p, listing, topLevel, at, issues);
      if (issues.length > before) return;
    }
    checkValue(p, def, at, issues);
  };
  visit(node, [], true);
  return issues;
}
