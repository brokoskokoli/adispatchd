/**
 * Conservative pushdown split (Spec §6): which part of a filter the adapter may
 * evaluate in its external query, and which part stays local.
 *
 * Only predicates of a top-level conjunction (`all`, nested `all`s are
 * flattened) are pushed, and only if the field is declared, cheap, and lists
 * the operator in `FieldDefinition.pushdown`. `any`/`not` are never pushed.
 * Since `pushdown AND local ≡ filter`, callers may evaluate just `local` on the
 * adapter's result — but because adapters may ignore pushed parts, the safe
 * default (and the `SourceAdapter` contract) is to re-evaluate the full filter.
 */
import { isValidNode } from './evaluate.js';
import { isFilterAll, isFilterPredicate, type FieldDefinition, type FilterNode, type FilterPredicate } from '../core/index.js';

/** Result of {@link splitForPushdown}. `null` = nothing in that part. */
export interface PushdownSplit {
  /** Conjunction the adapter may push into its query (pass as `listCandidates({ filter })`). */
  pushdown: FilterNode | null;
  /** Remaining conjunction that must be evaluated locally. */
  local: FilterNode | null;
}

function flattenConjunction(node: FilterNode, out: FilterNode[]): void {
  // Malformed nodes stay local (where they evaluate to unknown).
  if (isValidNode(node) && isFilterAll(node)) for (const c of node.all) flattenConjunction(c, out);
  else out.push(node);
}

function conjunction(parts: FilterNode[]): FilterNode | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] as FilterNode;
  return { all: parts };
}

/** True if the adapter declares pushdown support for this predicate. */
export function canPushDown(predicate: FilterPredicate, definitions: readonly FieldDefinition[]): boolean {
  const def = definitions.find((d) => d.name === predicate.field);
  if (!def || def.expensive) return false;
  return (def.pushdown ?? []).includes(predicate.operator) && def.operators.includes(predicate.operator);
}

/** Split `filter` into a pushable and a local conjunction. */
export function splitForPushdown(
  filter: FilterNode | undefined | null,
  definitions: readonly FieldDefinition[],
): PushdownSplit {
  if (!filter) return { pushdown: null, local: null };
  const parts: FilterNode[] = [];
  flattenConjunction(filter, parts);
  const pushed: FilterNode[] = [];
  const local: FilterNode[] = [];
  for (const part of parts) {
    if (isValidNode(part) && isFilterPredicate(part) && canPushDown(part, definitions)) pushed.push(part);
    else local.push(part);
  }
  return { pushdown: conjunction(pushed), local: conjunction(local) };
}
