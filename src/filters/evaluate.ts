/**
 * Three-valued, lazy evaluator for the declarative filter AST (Spec §6, §7 step 5).
 *
 * - Kleene logic: `all` is false if any child is false, else unknown if any
 *   child is unknown; `any` dually; `not unknown = unknown`.
 * - Fields that cannot be resolved (`known: false`) evaluate to `unknown`,
 *   never to 0/empty (Spec §6, §20.7).
 * - Inside `all`/`any`, children that only need cheap fields are evaluated
 *   first; evaluation short-circuits once the result is fixed, so expensive
 *   fields are only resolved when needed.
 * - Every evaluation returns a diagnostic trace (per rule: true / false /
 *   unknown / not_evaluated) for dry-run and GUI.
 */
import {
  isFilterAll,
  isFilterAny,
  isFilterNot,
  isFilterPredicate,
  type FieldResolution,
  type FieldType,
  type FieldValue,
  type FilterNode,
  type FilterOperator,
  type FilterValue,
  type TriValue,
} from '../core/index.js';
import { applyOperator } from './predicate.js';

/** Value of a rule in a diagnostic trace. `not_evaluated` = skipped (short-circuit / dry-run). */
export type TraceValue = TriValue | 'not_evaluated';

/** Diagnostic trace of one AST node; mirrors the AST structure (children in original order). */
export type FilterTrace =
  | {
      kind: 'all' | 'any';
      /** Location in the AST, e.g. `$.all[1].any[0]` (root: {@link ROOT_PATH}). */
      path: string;
      value: TraceValue;
      children: FilterTrace[];
    }
  | { kind: 'not'; path: string; value: TraceValue; child: FilterTrace }
  | {
      kind: 'predicate';
      path: string;
      value: TraceValue;
      field: string;
      operator: FilterOperator;
      expected: FilterValue;
      /** Resolved field value (only when known). */
      actual?: FieldValue;
      /** Why the value is `unknown` (unknown field, missing permission, incompatible types, ...). */
      reason?: string;
    }
  | { kind: 'invalid'; path: string; value: TraceValue; reason: string };

/** Result of {@link evaluateFilter}. */
export interface FilterEvaluation {
  value: TriValue;
  trace: FilterTrace;
}

/**
 * Lazy access to an item's fields. Implementations should memoize; the
 * evaluator additionally memoizes per evaluation.
 */
export interface FieldSource {
  /** Resolve a field. Must not throw; failures are `{ known: false }`. */
  resolve(field: string): Promise<FieldResolution> | FieldResolution;
  /** True if resolving `field` is expensive (evaluated last, only on demand). */
  isExpensive?(field: string): boolean;
  /** Declared type of `field` (enables date semantics). */
  fieldType?(field: string): FieldType | undefined;
}

/** Root path used in traces. */
export const ROOT_PATH = '$';

function childPath(parent: string, kind: string, index?: number): string {
  return index === undefined ? `${parent}.${kind}` : `${parent}.${kind}[${index}]`;
}

/** All field names referenced by `node` (deduplicated, in first-occurrence order). */
export function collectFields(node: FilterNode | undefined | null): string[] {
  const out = new Set<string>();
  const walk = (n: FilterNode): void => {
    if (!isValidNode(n)) return; // malformed subtrees are skipped (they evaluate to unknown)
    if (isFilterAll(n)) n.all.forEach(walk);
    else if (isFilterAny(n)) n.any.forEach(walk);
    else if (isFilterNot(n)) walk(n.not);
    else if (isFilterPredicate(n)) out.add(n.field);
  };
  if (node) walk(node);
  return [...out];
}

/** True if `node` is structurally a filter node (children are not checked). */
export function isValidNode(node: unknown): node is FilterNode {
  if (node === null || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if ('all' in n) return Array.isArray(n.all);
  if ('any' in n) return Array.isArray(n.any);
  if ('not' in n) return n.not !== null && typeof n.not === 'object';
  return typeof n.field === 'string' && typeof n.operator === 'string';
}

/** Trace of `node` with every rule marked `not_evaluated` (short-circuit, dry-run). */
export function notEvaluatedTrace(node: FilterNode, path: string = ROOT_PATH): FilterTrace {
  if (!isValidNode(node)) return { kind: 'invalid', path, value: 'not_evaluated', reason: 'malformed filter node' };
  if (isFilterAll(node) || isFilterAny(node)) {
    const kind = isFilterAll(node) ? 'all' : 'any';
    const children = isFilterAll(node) ? node.all : (node as { any: FilterNode[] }).any;
    return {
      kind,
      path,
      value: 'not_evaluated',
      children: children.map((c, i) => notEvaluatedTrace(c, childPath(path, kind, i))),
    };
  }
  if (isFilterNot(node)) {
    return { kind: 'not', path, value: 'not_evaluated', child: notEvaluatedTrace(node.not, childPath(path, 'not')) };
  }
  return {
    kind: 'predicate',
    path,
    value: 'not_evaluated',
    field: node.field,
    operator: node.operator,
    expected: node.value,
  };
}

class Evaluation {
  private readonly cache = new Map<string, Promise<FieldResolution>>();
  private readonly costs = new WeakMap<object, number>();

  constructor(private readonly source: FieldSource) {}

  private resolve(field: string): Promise<FieldResolution> {
    let p = this.cache.get(field);
    if (!p) {
      p = Promise.resolve()
        .then(() => this.source.resolve(field))
        .catch((err: unknown): FieldResolution => ({
          known: false,
          reason: `field resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        }));
      this.cache.set(field, p);
    }
    return p;
  }

  /** 0 = only cheap fields, 1 = needs at least one expensive field. Memoized per subtree. */
  private cost(node: FilterNode): number {
    if (!this.source.isExpensive || !isValidNode(node)) return 0;
    const known = this.costs.get(node);
    if (known !== undefined) return known;
    let cost: number;
    if (isFilterAll(node)) cost = node.all.some((c) => this.cost(c) > 0) ? 1 : 0;
    else if (isFilterAny(node)) cost = node.any.some((c) => this.cost(c) > 0) ? 1 : 0;
    else if (isFilterNot(node)) cost = this.cost(node.not);
    else cost = this.source.isExpensive((node as { field: string }).field) ? 1 : 0;
    this.costs.set(node, cost);
    return cost;
  }

  async node(node: FilterNode, path: string): Promise<FilterTrace> {
    if (!isValidNode(node)) return { kind: 'invalid', path, value: 'unknown', reason: 'malformed filter node' };
    if (isFilterAll(node)) return this.junction('all', node.all, path);
    if (isFilterAny(node)) return this.junction('any', node.any, path);
    if (isFilterNot(node)) {
      const child = await this.node(node.not, childPath(path, 'not'));
      const v = child.value;
      const value: TraceValue = v === 'unknown' || v === 'not_evaluated' ? 'unknown' : !v;
      return { kind: 'not', path, value, child };
    }
    return this.predicate(node, path);
  }

  private async junction(kind: 'all' | 'any', children: FilterNode[], path: string): Promise<FilterTrace> {
    // `all`: false dominates; `any`: true dominates.
    const dominant = kind === 'any';
    const traces: (FilterTrace | undefined)[] = new Array(children.length);
    const order = children
      .map((child, index) => ({ index, cost: this.cost(child) }))
      .sort((a, b) => a.cost - b.cost || a.index - b.index);
    let sawUnknown = false;
    let decided = false;
    for (const { index } of order) {
      const child = children[index] as FilterNode;
      const p = childPath(path, kind, index);
      if (decided) {
        traces[index] = notEvaluatedTrace(child, p);
        continue;
      }
      const t = await this.node(child, p);
      traces[index] = t;
      if (t.value === dominant) decided = true;
      else if (t.value !== !dominant) sawUnknown = true;
    }
    const value: TriValue = decided ? dominant : sawUnknown ? 'unknown' : !dominant;
    return { kind, path, value, children: traces as FilterTrace[] };
  }

  private async predicate(
    node: { field: string; operator: FilterOperator; value: FilterValue },
    path: string,
  ): Promise<FilterTrace> {
    const base = { kind: 'predicate' as const, path, field: node.field, operator: node.operator, expected: node.value };
    const resolution = await this.resolve(node.field);
    if (!resolution.known) return { ...base, value: 'unknown', reason: resolution.reason };
    const fieldType = this.source.fieldType?.(node.field);
    const outcome = applyOperator(node.operator, resolution.value, node.value, fieldType);
    return {
      ...base,
      value: outcome.value,
      actual: resolution.value,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  }
}

/**
 * Evaluate `filter` against an item's fields. A missing filter (`undefined`/`null`)
 * matches everything. Never throws: malformed nodes and resolver errors yield `unknown`.
 */
export async function evaluateFilter(
  filter: FilterNode | undefined | null,
  source: FieldSource,
): Promise<FilterEvaluation> {
  if (filter === undefined || filter === null) {
    return { value: true, trace: { kind: 'all', path: ROOT_PATH, value: true, children: [] } };
  }
  const trace = await new Evaluation(source).node(filter, ROOT_PATH);
  const value: TriValue = trace.value === 'not_evaluated' ? 'unknown' : trace.value;
  return { value, trace };
}
