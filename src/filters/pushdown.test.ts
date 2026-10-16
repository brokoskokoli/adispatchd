import { describe, expect, it } from 'vitest';
import type { FieldDefinition, FilterNode } from '../core/index.js';
import { splitForPushdown } from './pushdown.js';

const defs: FieldDefinition[] = [
  { name: 'labels', type: 'string[]', operators: ['contains'], pushdown: ['contains'] },
  { name: 'state', type: 'string', operators: ['equals', 'in'], pushdown: ['equals'] },
  { name: 'title', type: 'string', operators: ['contains'] },
  {
    name: 'dependencies.blocked_by_open',
    type: 'number',
    operators: ['equals'],
    pushdown: ['equals'],
    expensive: true,
  },
];

const labels: FilterNode = { field: 'labels', operator: 'contains', value: 'ready' };
const stateEq: FilterNode = { field: 'state', operator: 'equals', value: 'open' };
const stateIn: FilterNode = { field: 'state', operator: 'in', value: ['open'] };
const title: FilterNode = { field: 'title', operator: 'contains', value: 'x' };
const deps: FilterNode = { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 };

describe('splitForPushdown', () => {
  it('pushes supported cheap predicates of a (nested) top-level all', () => {
    expect(splitForPushdown({ all: [labels, { all: [stateEq, title] }, deps, stateIn] }, defs)).toEqual({
      pushdown: { all: [labels, stateEq] },
      local: { all: [title, deps, stateIn] },
    });
  });

  it('never pushes any/not and unknown fields', () => {
    const anyNode: FilterNode = { any: [labels, stateEq] };
    const notNode: FilterNode = { not: labels };
    const unknownField: FilterNode = { field: 'nope', operator: 'equals', value: 1 };
    expect(splitForPushdown({ all: [anyNode, notNode, unknownField] }, defs)).toEqual({
      pushdown: null,
      local: { all: [anyNode, notNode, unknownField] },
    });
    expect(splitForPushdown(anyNode, defs)).toEqual({ pushdown: null, local: anyNode });
  });

  it('keeps malformed nodes local instead of throwing', () => {
    const bad = { all: [labels, null, { all: 'x' }, { not: null }] } as unknown as FilterNode;
    const r = splitForPushdown(bad, defs);
    expect(r.pushdown).toEqual(labels);
    expect(r.local).toEqual({ all: [null, { all: 'x' }, { not: null }] });
    expect(splitForPushdown(5 as unknown as FilterNode, defs)).toEqual({ pushdown: null, local: 5 });
  });

  it('handles single predicates and missing filters', () => {
    expect(splitForPushdown(labels, defs)).toEqual({ pushdown: labels, local: null });
    expect(splitForPushdown(undefined, defs)).toEqual({ pushdown: null, local: null });
  });
});
