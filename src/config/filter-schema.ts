/**
 * Structural validation of the declarative filter AST (Spec §6) as it appears
 * in YAML. Hand-written instead of a zod union so that errors point at the
 * exact offending node (`filter.all[1].operator`) with a precise message.
 *
 * Besides the core nodes, YAML filters may reference named filters
 * (`filters/*.yaml`, WI-15): `{ use: <filter-id> }` anywhere in the tree, and
 * the short form `filter: <filter-id>` (a string instead of a mapping) at the
 * root. The result is a {@link RawFilterNode}; the loader replaces every
 * reference by the referenced tree (`named-filters.ts`).
 */
import { z } from 'zod';
import {
  CONFIG_ID_PATTERN,
  FILTER_OPERATORS,
  type FilterOperator,
  type FilterPredicate,
  type FilterValue,
} from '../core/index.js';

/** Reference to a named filter (`{ use: <filter-id> }`); replaced by the referenced tree when loading. */
export interface FilterUse {
  use: string;
}

/** Filter tree as written in YAML: the core filter AST plus references to named filters. */
export type RawFilterNode =
  | { all: RawFilterNode[] }
  | { any: RawFilterNode[] }
  | { not: RawFilterNode }
  | FilterPredicate
  | FilterUse;

/** Type guard for {@link FilterUse}. */
export function isFilterUse(node: unknown): node is FilterUse {
  return isPlainObject(node) && typeof node.use === 'string' && Object.keys(node).length === 1;
}

/** Problem found in a filter node. `path` is relative to the filter root. */
export interface FilterIssue {
  path: (string | number)[];
  message: string;
}

const OPERATOR_SET: ReadonlySet<string> = new Set(FILTER_OPERATORS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function checkValue(operator: FilterOperator, value: unknown, path: (string | number)[], issues: FilterIssue[]): void {
  if (operator === 'in') {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) {
      issues.push({ path, message: 'Operator "in" requires a non-empty list of strings, numbers or booleans' });
    }
    return;
  }
  if (operator === 'greater_than' || operator === 'less_than') {
    if (typeof value !== 'number' && typeof value !== 'string') {
      issues.push({ path, message: `Operator "${operator}" requires a number or string (date) value` });
    }
    return;
  }
  if (value !== null && !isScalar(value)) {
    issues.push({ path, message: `Operator "${operator}" requires a scalar value (string, number, boolean or null)` });
  }
}

/** Validate a filter node; returns all problems (empty = valid). */
export function validateFilterNode(node: unknown, path: (string | number)[] = []): FilterIssue[] {
  const issues: FilterIssue[] = [];
  visit(node, path, issues);
  return issues;
}

function visit(node: unknown, path: (string | number)[], issues: FilterIssue[]): void {
  if (!isPlainObject(node)) {
    // The short form `filter: <id>` only exists at the root; inside the tree a reference needs `use`.
    const hint = typeof node === 'string' && CONFIG_ID_PATTERN.test(node) ? `; to reference a named filter write { use: ${node} }` : '';
    issues.push({ path, message: `Filter node must be a mapping (all / any / not / use / {field, operator, value})${hint}` });
    return;
  }
  const keys = Object.keys(node);
  if ('use' in node) {
    if (keys.length !== 1) {
      issues.push({ path, message: '"use" must be the only key of its filter node ({ use: <filter-id> } references a named filter)' });
      return;
    }
    if (typeof node.use !== 'string' || !CONFIG_ID_PATTERN.test(node.use)) {
      issues.push({ path: [...path, 'use'], message: '"use" requires the ID of a named filter (filters/<id>.yaml)' });
    }
    return;
  }
  for (const combinator of ['all', 'any'] as const) {
    if (combinator in node) {
      if (keys.length !== 1) {
        issues.push({ path, message: `"${combinator}" must be the only key of its filter node` });
        return;
      }
      const children = node[combinator];
      if (!Array.isArray(children)) {
        issues.push({ path: [...path, combinator], message: `"${combinator}" must be a list of filter nodes` });
        return;
      }
      children.forEach((child, i) => visit(child, [...path, combinator, i], issues));
      return;
    }
  }
  if ('not' in node) {
    if (keys.length !== 1) {
      issues.push({ path, message: '"not" must be the only key of its filter node' });
      return;
    }
    visit(node.not, [...path, 'not'], issues);
    return;
  }
  const unknown = keys.filter((k) => k !== 'field' && k !== 'operator' && k !== 'value');
  if (unknown.length > 0) {
    issues.push({ path, message: `Unknown filter key(s): ${unknown.map((k) => `"${k}"`).join(', ')}` });
  }
  if (typeof node.field !== 'string' || node.field.trim() === '') {
    issues.push({ path: [...path, 'field'], message: 'Predicate requires a non-empty "field"' });
  }
  if (typeof node.operator !== 'string' || !OPERATOR_SET.has(node.operator)) {
    issues.push({
      path: [...path, 'operator'],
      message: `Predicate requires "operator", one of: ${FILTER_OPERATORS.join(', ')}`,
    });
    return;
  }
  if (!('value' in node)) {
    issues.push({ path: [...path, 'value'], message: 'Predicate requires a "value" (use null explicitly if intended)' });
    return;
  }
  checkValue(node.operator as FilterOperator, node.value, [...path, 'value'], issues);
}

function toFilterNode(node: Record<string, unknown>): RawFilterNode {
  if ('use' in node) return { use: node.use as string };
  if ('all' in node) return { all: (node.all as Record<string, unknown>[]).map(toFilterNode) };
  if ('any' in node) return { any: (node.any as Record<string, unknown>[]).map(toFilterNode) };
  if ('not' in node) return { not: toFilterNode(node.not as Record<string, unknown>) };
  const value = node.value as FilterValue;
  return {
    field: (node.field as string).trim(),
    operator: node.operator as FilterOperator,
    value: Array.isArray(value) ? [...value] : value,
  };
}

/**
 * zod schema accepting a YAML filter (a filter mapping, or the ID of a named
 * filter as short form for `{ use: <id> }`) and producing a clean {@link RawFilterNode}.
 */
export const filterNodeSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Required: a filter mapping or the ID of a named filter' });
      return;
    }
    if (typeof value === 'string') {
      if (!CONFIG_ID_PATTERN.test(value)) {
        ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid named filter ID (a filter is a mapping or the ID of a named filter)` });
      }
      return;
    }
    for (const issue of validateFilterNode(value)) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  })
  .transform((value): RawFilterNode => (typeof value === 'string' ? { use: value } : toFilterNode(value as Record<string, unknown>)));
