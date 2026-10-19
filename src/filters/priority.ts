/**
 * Item priority (`item_priority.rules`) and deterministic candidate ordering (Spec §7).
 */
import type { FilterNode } from '../core/index.js';
import { parseIsoDate } from './iso-date.js';
import { evaluateFilter, notEvaluatedTrace, type FieldSource, type FilterTrace } from './evaluate.js';

/** One `item_priority` rule: first rule whose `when` is true wins. */
export interface ItemPriorityRule {
  when: FilterNode;
  value: number;
}

/** `item_priority` block of a workflow. */
export interface ItemPriorityConfig {
  rules: readonly ItemPriorityRule[];
  default: number;
}

/** Result of {@link resolveItemPriority}. */
export interface ItemPriorityResult {
  priority: number;
  /** Index of the matching rule, or `null` if the default applied. */
  matchedRule: number | null;
  /** One trace per rule; rules after the match are `not_evaluated`. */
  traces: FilterTrace[];
}

/**
 * Determine an item's priority: the first rule evaluating to `true` wins;
 * `false` and `unknown` do not match; otherwise `default` (0 if no config).
 */
export async function resolveItemPriority(
  config: ItemPriorityConfig | undefined | null,
  source: FieldSource,
): Promise<ItemPriorityResult> {
  if (!config) return { priority: 0, matchedRule: null, traces: [] };
  const traces: FilterTrace[] = [];
  let matched: number | null = null;
  for (const [i, rule] of config.rules.entries()) {
    if (matched !== null) {
      traces.push(notEvaluatedTrace(rule.when));
      continue;
    }
    const r = await evaluateFilter(rule.when, source);
    traces.push(r.trace);
    if (r.value === true) matched = i;
  }
  return {
    priority: matched === null ? config.default : (config.rules[matched] as ItemPriorityRule).value,
    matchedRule: matched,
    traces,
  };
}

/** Minimal shape needed for ordering scheduling candidates. */
export interface PrioritizedCandidate {
  workflowId: string;
  workflowPriority: number;
  itemPriority: number;
  /** Item creation time (ISO-8601); missing values sort after present ones. */
  createdAt?: string | undefined;
  /** `sourceItemKey(...)`; absent for item-less (cron/manual) candidates. */
  itemKey?: string | undefined;
  /**
   * Position of the item's source in the workflow's `sources` list (WI-20);
   * lower wins among equal item priorities. Absent = 0 (single source).
   */
  sourceRank?: number | undefined;
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Locale-independent natural compare: digit runs compare numerically
 * (`repo:9` < `repo:10`), everything else by code unit; final fallback is a
 * plain code-unit compare so distinct strings never compare equal.
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ta = a.match(re) ?? [];
  const tb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i] as string;
    const y = tb[i] as string;
    const xd = /^\d/.test(x);
    const yd = /^\d/.test(y);
    let c: number;
    if (xd && yd) {
      const xs = x.replace(/^0+(?=\d)/, '');
      const ys = y.replace(/^0+(?=\d)/, '');
      c = xs.length - ys.length || codeUnitCompare(xs, ys);
    } else {
      c = codeUnitCompare(x, y);
    }
    if (c !== 0) return Math.sign(c);
  }
  return Math.sign(ta.length - tb.length) || codeUnitCompare(a, b);
}

/** Strict ISO-8601 (no offset = UTC); missing or invalid values sort last. */
function createdAtMs(v: string | undefined): number | undefined {
  return parseIsoDate(v);
}

/**
 * Total order for candidates (Spec §7): workflow priority desc → item priority
 * desc → source rank asc (position in `sources`, WI-20) → creation time asc
 * (missing/non-ISO last) → item key asc (natural) → workflow ID asc.
 */
export function compareCandidates(a: PrioritizedCandidate, b: PrioritizedCandidate): number {
  if (a.workflowPriority !== b.workflowPriority) return b.workflowPriority > a.workflowPriority ? 1 : -1;
  if (a.itemPriority !== b.itemPriority) return b.itemPriority > a.itemPriority ? 1 : -1;
  const ra = a.sourceRank ?? 0;
  const rb = b.sourceRank ?? 0;
  if (ra !== rb) return ra - rb;
  const ca = createdAtMs(a.createdAt);
  const cb = createdAtMs(b.createdAt);
  if (ca !== cb) {
    if (ca === undefined) return 1;
    if (cb === undefined) return -1;
    return ca < cb ? -1 : 1;
  }
  const ka = a.itemKey ?? '';
  const kb = b.itemKey ?? '';
  if (ka !== kb) return naturalCompare(ka, kb);
  return codeUnitCompare(a.workflowId, b.workflowId);
}

/** Return a new array sorted by {@link compareCandidates}; input order does not matter. */
export function sortCandidates<T extends PrioritizedCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareCandidates);
}
