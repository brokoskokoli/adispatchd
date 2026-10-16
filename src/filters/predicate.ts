/**
 * Operator semantics for single filter predicates (Spec §6).
 *
 * Every comparison is three-valued: incompatible types, unparsable dates or
 * malformed operands yield `unknown` (with a reason) instead of guessing.
 */
import type { FieldType, FieldValue, FilterOperator, FilterValue, TriValue } from '../core/index.js';

/** Outcome of applying one operator to a known field value. */
export interface PredicateOutcome {
  value: TriValue;
  /** Why the outcome is `unknown`. */
  reason?: string;
}

type Scalar = string | number | boolean;

const TRUE: PredicateOutcome = { value: true };
const FALSE: PredicateOutcome = { value: false };

function unknown(reason: string): PredicateOutcome {
  return { value: 'unknown', reason };
}

function isScalar(v: unknown): v is Scalar {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function parseDate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Equality of two scalars. Dates (field type `date`) compare as instants.
 * Returns `unknown` for different JS types.
 */
function scalarEquals(actual: Scalar, expected: Scalar, fieldType: FieldType | undefined): PredicateOutcome {
  if (fieldType === 'date') {
    const a = parseDate(actual);
    const b = parseDate(expected);
    if (a === undefined || b === undefined) return unknown('date value not parsable');
    return a === b ? TRUE : FALSE;
  }
  if (typeof actual !== typeof expected) {
    return unknown(`incompatible types: ${typeName(actual)} vs ${typeName(expected)}`);
  }
  if (typeof actual === 'number' && (Number.isNaN(actual) || Number.isNaN(expected as number))) {
    return unknown('NaN is not comparable');
  }
  return actual === expected ? TRUE : FALSE;
}

function equals(actual: FieldValue, expected: FilterValue, fieldType: FieldType | undefined): PredicateOutcome {
  // `null` is a known absent value (e.g. no milestone): it equals only `null`.
  if (actual === null || expected === null) return actual === expected ? TRUE : FALSE;
  const actualIsArray = Array.isArray(actual);
  const expectedIsArray = Array.isArray(expected);
  if (actualIsArray !== expectedIsArray) {
    return unknown(`incompatible types: ${typeName(actual)} vs ${typeName(expected)}`);
  }
  if (actualIsArray) {
    // Arrays (e.g. labels) compare as sets: order and duplicates do not matter.
    const a = actual as readonly unknown[];
    const b = expected as readonly unknown[];
    if (!a.every(isScalar) || !b.every(isScalar)) return unknown('array contains non-scalar values');
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size !== sb.size) return FALSE;
    for (const x of sa) if (!sb.has(x)) return FALSE;
    return TRUE;
  }
  return scalarEquals(actual as Scalar, expected as Scalar, fieldType);
}

function compareOrder(
  actual: FieldValue,
  expected: FilterValue,
  fieldType: FieldType | undefined,
): { cmp: number } | PredicateOutcome {
  if (actual === null || expected === null) return unknown('null is not comparable');
  if (fieldType === 'date') {
    const a = parseDate(actual);
    const b = parseDate(expected);
    if (a === undefined || b === undefined) return unknown('date value not parsable');
    return { cmp: Math.sign(a - b) };
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Number.isNaN(actual) || Number.isNaN(expected)) return unknown('NaN is not comparable');
    return { cmp: Math.sign(actual - expected) };
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    // Plain code-unit order: deterministic, locale-independent (ISO dates sort correctly).
    return { cmp: actual < expected ? -1 : actual > expected ? 1 : 0 };
  }
  return unknown(`not comparable: ${typeName(actual)} vs ${typeName(expected)}`);
}

function contains(actual: FieldValue, expected: FilterValue): PredicateOutcome {
  if (expected === null || Array.isArray(expected)) {
    return unknown(`contains expects a scalar operand, got ${typeName(expected)}`);
  }
  if (actual === null) return FALSE;
  if (Array.isArray(actual)) {
    const arr = actual as readonly unknown[];
    if (arr.length === 0) return FALSE;
    if (!arr.some((x) => typeof x === typeof expected)) {
      return unknown(`incompatible types: array of ${typeName(arr[0])} vs ${typeName(expected)}`);
    }
    return arr.includes(expected) ? TRUE : FALSE;
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.includes(expected) ? TRUE : FALSE;
  }
  return unknown(`contains not applicable: ${typeName(actual)} vs ${typeName(expected)}`);
}

function inList(actual: FieldValue, expected: FilterValue, fieldType: FieldType | undefined): PredicateOutcome {
  if (!Array.isArray(expected)) return unknown(`in expects an array operand, got ${typeName(expected)}`);
  const list = expected as readonly Scalar[];
  if (actual === null) return FALSE;
  if (Array.isArray(actual)) {
    // Array field: true if any element is in the list (non-empty intersection).
    const arr = actual as readonly unknown[];
    if (arr.length === 0 || list.length === 0) return FALSE;
    if (!arr.some((x) => list.some((y) => typeof y === typeof x))) {
      return unknown('incompatible types between field array and list');
    }
    return arr.some((x) => list.includes(x as Scalar)) ? TRUE : FALSE;
  }
  if (list.length === 0) return FALSE;
  let sawUnknown = false;
  let sawComparable = false;
  for (const candidate of list) {
    const r = scalarEquals(actual as Scalar, candidate, fieldType);
    if (r.value === true) return TRUE;
    if (r.value === 'unknown') sawUnknown = true;
    else sawComparable = true;
  }
  if (sawComparable) return FALSE;
  return sawUnknown ? unknown(`incompatible types: ${typeName(actual)} vs list`) : FALSE;
}

/**
 * Apply `operator` to a known field value and the literal `expected`.
 * `fieldType` (from the adapter's field definition) enables date semantics.
 */
export function applyOperator(
  operator: FilterOperator,
  actual: FieldValue,
  expected: FilterValue,
  fieldType?: FieldType,
): PredicateOutcome {
  switch (operator) {
    case 'equals':
      return equals(actual, expected, fieldType);
    case 'not_equals': {
      const r = equals(actual, expected, fieldType);
      return r.value === 'unknown' ? r : r.value ? FALSE : TRUE;
    }
    case 'contains':
      return contains(actual, expected);
    case 'in':
      return inList(actual, expected, fieldType);
    case 'greater_than':
    case 'less_than': {
      if (Array.isArray(actual) || Array.isArray(expected)) return unknown('arrays are not comparable');
      const r = compareOrder(actual, expected, fieldType);
      if (!('cmp' in r)) return r;
      return (operator === 'greater_than' ? r.cmp > 0 : r.cmp < 0) ? TRUE : FALSE;
    }
    default:
      return unknown(`unsupported operator: ${String(operator)}`);
  }
}
