/**
 * Offline checks of field references against the static field catalogue of
 * the adapter type (WI-13): field names (with "did you mean" suggestions),
 * operators per field type, value types, view-only `run.last_*` fields and
 * listing-selector fields such as GitHub `state` that only work at the top
 * level of a filter (pushdown).
 *
 * The catalogue is extended per source by the declared GitHub Projects
 * fields `project.<name>` (WI-14): a workflow sees the fields of its trigger
 * source, a view (and a multi-source workflow, WI-20) only the fields that ALL
 * its sources declare with the same kind.
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
import { GITHUB_FIELD_DEFINITIONS, PROJECT_FIELD_PREFIX, projectFieldDefinitions } from '../sources/index.js';
import type { SourceConfig } from './model.js';

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
  /** Per-source fields in addition to the static catalogue (declared `project.*` fields). */
  extra?: readonly FieldDefinition[];
  /** Explanation for an undeclared `project.*` field (e.g. which view sources lack it). */
  projectHint?: (field: string) => string | undefined;
  /**
   * True if some source declares `project.<name>` (only not with the same kind
   * everywhere): then no other field is suggested ("did you mean"), the hint
   * explains what is missing or differs.
   */
  projectDeclared?: (field: string) => boolean;
}

function definitions(ctx: FieldContext): readonly FieldDefinition[] | undefined {
  const base = FIELD_CATALOG[ctx.sourceType];
  if (!base) return undefined;
  return [...base, ...(ctx.extra ?? []), ...(ctx.view ? VIEW_RUN_FIELDS : [])];
}

/** Field context of a workflow triggered by `source`. */
export function sourceFieldContext(source: SourceConfig): FieldContext {
  const extra = source.project ? projectFieldDefinitions(source.project.fields) : [];
  return {
    sourceType: source.type,
    view: false,
    extra,
    projectHint: () =>
      source.project
        ? `it is not declared in "project.fields" of source "${source.id}"`
        : `source "${source.id}" has no "project" configured in sources.yaml`,
  };
}

/**
 * `project.*` field definitions declared by every source with the same kind
 * (rule of views, also used by multi-source workflows, WI-20).
 */
function commonProjectFields(sources: readonly SourceConfig[]): FieldDefinition[] {
  const first = sources[0];
  return (first?.project ? projectFieldDefinitions(first.project.fields) : []).filter((def) => {
    const name = def.name.slice(PROJECT_FIELD_PREFIX.length);
    const kind = first?.project?.fields[name];
    return sources.every((s) => s.project !== null && Object.hasOwn(s.project.fields, name) && s.project.fields[name] === kind);
  });
}

/** Why `project.<name>` is not common to `sources` (`owner`: "the view" / "the workflow"). */
function commonProjectHint(sources: readonly SourceConfig[], field: string, owner: 'view' | 'workflow'): string {
  const name = field.slice(PROJECT_FIELD_PREFIX.length);
  const declaring = sources.filter((s) => s.project && Object.hasOwn(s.project.fields, name));
  if (declaring.length === 0) return `no source of the ${owner} declares it in "project.fields"`;
  const missing = sources.filter((s) => !declaring.includes(s)).map((s) => `"${s.id}"`);
  const who = owner === 'view' ? 'views' : 'workflows with several sources';
  if (missing.length > 0) return `${who} only offer project fields declared by all their sources (missing in ${missing.join(', ')})`;
  const kinds = declaring.map((s) => `"${s.id}": ${s.project?.fields[name] ?? '?'}`);
  return `its kind differs between the sources of the ${owner} (${kinds.join(', ')}); declare it with the same kind everywhere`;
}

function declaredBySome(sources: readonly SourceConfig[], field: string): boolean {
  const name = field.slice(PROJECT_FIELD_PREFIX.length);
  return sources.some((s) => s.project !== null && Object.hasOwn(s.project.fields, name));
}

/**
 * Field context of a view over `sources` (all of the same type): only
 * `project.*` fields declared by every source with the same kind.
 */
export function viewFieldContext(sources: readonly SourceConfig[]): FieldContext {
  return {
    sourceType: sources[0]?.type ?? '',
    view: true,
    extra: commonProjectFields(sources),
    projectHint: (field) => commonProjectHint(sources, field, 'view'),
    projectDeclared: (field) => declaredBySome(sources, field),
  };
}

/**
 * Field context of a source workflow over `sources` (all of the same type,
 * WI-20). One source: exactly {@link sourceFieldContext}; several: like
 * views, only `project.*` fields declared by every source with the same kind.
 */
export function workflowFieldContext(sources: readonly SourceConfig[]): FieldContext {
  const only = sources.length === 1 ? sources[0] : undefined;
  if (only) return sourceFieldContext(only);
  return {
    sourceType: sources[0]?.type ?? '',
    view: false,
    extra: commonProjectFields(sources),
    projectHint: (field) => commonProjectHint(sources, field, 'workflow'),
    projectDeclared: (field) => declaredBySome(sources, field),
  };
}

/** Levenshtein distance of two strings. */
export function editDistance(a: string, b: string): number {
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
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase());
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
  const declared = field.startsWith(PROJECT_FIELD_PREFIX) && (ctx.projectDeclared?.(field) ?? false);
  const suggestion = declared ? undefined : suggestField(field, defs.map((d) => d.name));
  const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
  if (field.startsWith(PROJECT_FIELD_PREFIX) && ctx.projectHint) {
    const why = ctx.projectHint(field);
    if (why) return `Unknown project field "${field}": ${why}${hint}`;
  }
  return `Unknown field "${field}" for source type ${ctx.sourceType}${hint}`;
}

/** Declared type of `field` in `ctx`, if known. */
export function fieldType(field: string, ctx: FieldContext): FieldType | undefined {
  return definitions(ctx)?.find((d) => d.name === field)?.type;
}

/** True if sources of `sourceType` provide `work_branch`/`work_pr` (placeholders `{item.work_branch}`, `{item.work_pr}`, WI-21). */
export function providesLinkedFields(sourceType: string): boolean {
  const defs = FIELD_CATALOG[sourceType] ?? [];
  return defs.some((d) => d.name === 'work_branch') && defs.some((d) => d.name === 'work_pr');
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
  'object[]': 'string', // never reached: object[] fields have no operators
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
    if (def.operators.length === 0) {
      issues.push({
        path: [...at, 'field'],
        message: `Field "${p.field}" (type ${def.type}) cannot be used in filters${def.filterHint ? `; ${def.filterHint}` : ''}`,
      });
      return;
    }
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
