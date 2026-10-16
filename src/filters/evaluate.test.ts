import { describe, expect, it, vi } from 'vitest';
import type { FieldDefinition, FieldResolution, FilterNode, SourceItem, TriValue } from '../core/index.js';
import { collectFields, evaluateFilter, notEvaluatedTrace, type FieldSource, type FilterTrace } from './evaluate.js';
import { createItemFieldSource } from './fields.js';

/** Predicate whose value is exactly `v` (field `f_<v>` resolved by {@link triSource}). */
function lit(v: TriValue): FilterNode {
  return { field: `f_${String(v)}`, operator: 'equals', value: true };
}

const triSource: FieldSource = {
  resolve(field) {
    if (field === 'f_true') return { known: true, value: true };
    if (field === 'f_false') return { known: true, value: false };
    return { known: false, reason: 'no access' };
  },
};

const VALUES: TriValue[] = [true, false, 'unknown'];

function kleeneAnd(a: TriValue, b: TriValue): TriValue {
  if (a === false || b === false) return false;
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return true;
}
function kleeneOr(a: TriValue, b: TriValue): TriValue {
  if (a === true || b === true) return true;
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return false;
}

describe('evaluateFilter – Kleene truth tables', () => {
  for (const a of VALUES) {
    for (const b of VALUES) {
      it(`all(${String(a)}, ${String(b)}) = ${String(kleeneAnd(a, b))}`, async () => {
        expect((await evaluateFilter({ all: [lit(a), lit(b)] }, triSource)).value).toBe(kleeneAnd(a, b));
      });
      it(`any(${String(a)}, ${String(b)}) = ${String(kleeneOr(a, b))}`, async () => {
        expect((await evaluateFilter({ any: [lit(a), lit(b)] }, triSource)).value).toBe(kleeneOr(a, b));
      });
    }
  }

  it('not', async () => {
    expect((await evaluateFilter({ not: lit(true) }, triSource)).value).toBe(false);
    expect((await evaluateFilter({ not: lit(false) }, triSource)).value).toBe(true);
    expect((await evaluateFilter({ not: lit('unknown') }, triSource)).value).toBe('unknown');
  });

  it('empty junctions and missing filter', async () => {
    expect((await evaluateFilter({ all: [] }, triSource)).value).toBe(true);
    expect((await evaluateFilter({ any: [] }, triSource)).value).toBe(false);
    expect((await evaluateFilter(undefined, triSource)).value).toBe(true);
  });

  it('nested combination', async () => {
    const f: FilterNode = { all: [lit(true), { any: [lit('unknown'), { not: lit(false) }] }] };
    expect((await evaluateFilter(f, triSource)).value).toBe(true);
  });

  it('malformed nodes evaluate to unknown, never throw', async () => {
    const r = await evaluateFilter({ bogus: 1 } as unknown as FilterNode, triSource);
    expect(r.value).toBe('unknown');
    expect(r.trace.kind).toBe('invalid');
  });

  it('resolver exceptions become unknown', async () => {
    const r = await evaluateFilter(
      { field: 'x', operator: 'equals', value: 1 },
      {
        resolve() {
          throw new Error('boom');
        },
      },
    );
    expect(r.value).toBe('unknown');
    expect(r.trace).toMatchObject({ kind: 'predicate', reason: expect.stringContaining('boom') });
  });
});

describe('evaluateFilter – unknown fields are never 0/empty', () => {
  it('known:false on dependencies.blocked_by_open is unknown, also for equals 0 and not', async () => {
    const source: FieldSource = { resolve: () => ({ known: false, reason: 'missing permission' }) };
    const eq0: FilterNode = { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 };
    expect((await evaluateFilter(eq0, source)).value).toBe('unknown');
    expect((await evaluateFilter({ not: eq0 }, source)).value).toBe('unknown');
    expect(
      (await evaluateFilter({ field: 'labels', operator: 'contains', value: 'x' }, source)).trace,
    ).toMatchObject({ value: 'unknown', reason: 'missing permission' });
  });

  it('type-incompatible comparison is unknown', async () => {
    const source: FieldSource = { resolve: () => ({ known: true, value: 'abc' }) };
    expect((await evaluateFilter({ field: 'title', operator: 'greater_than', value: 3 }, source)).value).toBe('unknown');
    expect((await evaluateFilter({ field: 'title', operator: 'equals', value: 3 }, source)).value).toBe('unknown');
  });
});

describe('evaluateFilter – lazy evaluation', () => {
  function spySource(values: Record<string, FieldResolution>, expensive: string[]) {
    const resolve = vi.fn((field: string): FieldResolution => values[field] ?? { known: false, reason: 'unknown' });
    return { resolve, isExpensive: (f: string) => expensive.includes(f) } satisfies FieldSource;
  }

  it('does not resolve an expensive field when the cheap part is already false', async () => {
    const src = spySource(
      { labels: { known: true, value: ['bug'] }, 'dependencies.blocked_by_open': { known: true, value: 0 } },
      ['dependencies.blocked_by_open'],
    );
    // Expensive predicate listed FIRST: cheap ones must still be evaluated first.
    const filter: FilterNode = {
      all: [
        { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 },
        { field: 'labels', operator: 'contains', value: 'ready-for-coding' },
      ],
    };
    const r = await evaluateFilter(filter, src);
    expect(r.value).toBe(false);
    expect(src.resolve).toHaveBeenCalledTimes(1);
    expect(src.resolve).toHaveBeenCalledWith('labels');
    expect(src.resolve).not.toHaveBeenCalledWith('dependencies.blocked_by_open');
    expect(r.trace).toMatchObject({
      kind: 'all',
      value: false,
      children: [
        { field: 'dependencies.blocked_by_open', value: 'not_evaluated' },
        { field: 'labels', value: false, actual: ['bug'] },
      ],
    });
  });

  it('resolves the expensive field when the cheap part is true', async () => {
    const src = spySource(
      { labels: { known: true, value: ['ready-for-coding'] }, 'dependencies.blocked_by_open': { known: true, value: 2 } },
      ['dependencies.blocked_by_open'],
    );
    const filter: FilterNode = {
      all: [
        { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 },
        { field: 'labels', operator: 'contains', value: 'ready-for-coding' },
      ],
    };
    expect((await evaluateFilter(filter, src)).value).toBe(false);
    expect(src.resolve).toHaveBeenCalledWith('dependencies.blocked_by_open');
  });

  it('cheap unknown does not short-circuit an all (false may still follow)', async () => {
    const src = spySource({ 'dependencies.blocked_by_open': { known: true, value: 1 } }, ['dependencies.blocked_by_open']);
    const filter: FilterNode = {
      all: [
        { field: 'missing', operator: 'equals', value: 1 },
        { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 },
      ],
    };
    expect((await evaluateFilter(filter, src)).value).toBe(false);
  });

  it('any short-circuits on true; each field is resolved at most once per evaluation', async () => {
    const src = spySource({ a: { known: true, value: 1 }, b: { known: true, value: 2 } }, ['b']);
    const filter: FilterNode = {
      any: [
        { field: 'b', operator: 'equals', value: 2 },
        { field: 'a', operator: 'equals', value: 1 },
        { field: 'a', operator: 'greater_than', value: 0 },
      ],
    };
    const r = await evaluateFilter(filter, src);
    expect(r.value).toBe(true);
    expect(src.resolve.mock.calls.map((c) => c[0])).toEqual(['a']);
  });
});

describe('evaluateFilter – diagnostic trace', () => {
  it('contains a value per rule including not_evaluated, with paths', async () => {
    const filter: FilterNode = {
      all: [
        { field: 'f_true', operator: 'equals', value: true },
        { not: { field: 'f_unknown', operator: 'equals', value: true } },
        { field: 'f_false', operator: 'equals', value: true },
        { any: [{ field: 'f_true', operator: 'equals', value: true }] },
      ],
    };
    const { value, trace } = await evaluateFilter(filter, triSource);
    expect(value).toBe(false);
    expect(trace).toEqual({
      kind: 'all',
      path: '$',
      value: false,
      children: [
        { kind: 'predicate', path: '$.all[0]', value: true, field: 'f_true', operator: 'equals', expected: true, actual: true },
        {
          kind: 'not',
          path: '$.all[1]',
          value: 'unknown',
          child: {
            kind: 'predicate',
            path: '$.all[1].not',
            value: 'unknown',
            field: 'f_unknown',
            operator: 'equals',
            expected: true,
            reason: 'no access',
          },
        },
        { kind: 'predicate', path: '$.all[2]', value: false, field: 'f_false', operator: 'equals', expected: true, actual: false },
        {
          kind: 'any',
          path: '$.all[3]',
          value: 'not_evaluated',
          children: [
            { kind: 'predicate', path: '$.all[3].any[0]', value: 'not_evaluated', field: 'f_true', operator: 'equals', expected: true },
          ],
        },
      ],
    } satisfies FilterTrace);
  });

  it('notEvaluatedTrace marks every rule (dry-run of shell rules / skipped rules)', () => {
    const t = notEvaluatedTrace({ any: [lit(true), { not: lit(false) }] });
    const values: string[] = [];
    const walk = (n: FilterTrace): void => {
      values.push(String(n.value));
      if (n.kind === 'all' || n.kind === 'any') n.children.forEach(walk);
      if (n.kind === 'not') walk(n.child);
    };
    walk(t);
    expect(values).toEqual(['not_evaluated', 'not_evaluated', 'not_evaluated', 'not_evaluated']);
  });

  it('collectFields lists referenced fields once', () => {
    expect(collectFields({ all: [lit(true), { any: [lit(true), { not: lit(false) }] }] })).toEqual(['f_true', 'f_false']);
  });
});

describe('createItemFieldSource', () => {
  const definitions: FieldDefinition[] = [
    { name: 'labels', type: 'string[]', operators: ['contains'] },
    { name: 'title', type: 'string', operators: ['equals', 'contains'] },
    { name: 'updated_at', type: 'date', operators: ['greater_than', 'less_than'] },
    { name: 'dependencies.blocked_by_open', type: 'number', operators: ['equals'], expensive: true },
    { name: 'dependencies.blocked_by_total', type: 'number', operators: ['equals'], expensive: true },
    { name: 'dependencies.status', type: 'string', operators: ['equals'], expensive: true },
  ];
  const item: SourceItem = {
    sourceId: 'project_a',
    itemId: '7',
    key: 'project_a:7',
    url: 'https://github.com/o/r/issues/7',
    type: 'issue',
    fields: { labels: ['ready-for-coding'], title: 'Hello', updated_at: '2026-10-01T10:00:00Z' },
  };
  const filter: FilterNode = {
    all: [
      { field: 'labels', operator: 'contains', value: 'ready-for-coding' },
      { field: 'dependencies.blocked_by_open', operator: 'equals', value: 0 },
      { field: 'dependencies.blocked_by_total', operator: 'less_than', value: 5 },
    ],
  };

  it('fetches all wanted expensive fields in ONE batch, only once', async () => {
    const resolveFields = vi.fn(async (_item: SourceItem, fields: readonly string[]) =>
      Object.fromEntries(fields.map((f) => [f, { known: true, value: 0 } as FieldResolution])),
    );
    const src = createItemFieldSource(item, { definitions, resolveFields, wantedFields: collectFields(filter) });
    expect((await evaluateFilter(filter, src)).value).toBe(true);
    expect((await evaluateFilter(filter, src)).value).toBe(true);
    expect(resolveFields).toHaveBeenCalledTimes(1);
    expect([...(resolveFields.mock.calls[0]?.[1] ?? [])].sort()).toEqual([
      'dependencies.blocked_by_open',
      'dependencies.blocked_by_total',
    ]);
    expect(item.fields).not.toHaveProperty('dependencies.blocked_by_open');
  });

  it('does not call the adapter when cheap fields already decide', async () => {
    const resolveFields = vi.fn(async () => ({}));
    const src = createItemFieldSource(
      { ...item, fields: { labels: [] } },
      { definitions, resolveFields, wantedFields: collectFields(filter) },
    );
    expect((await evaluateFilter(filter, src)).value).toBe(false);
    expect(resolveFields).not.toHaveBeenCalled();
  });

  it('missing permission / missing entries / adapter errors are unknown', async () => {
    const denied = createItemFieldSource(item, {
      definitions,
      resolveFields: async (_i, fields) =>
        Object.fromEntries(fields.map((f) => [f, { known: false, reason: 'cross-repo access denied' } as FieldResolution])),
    });
    expect((await evaluateFilter(filter, denied)).value).toBe('unknown');

    const empty = createItemFieldSource(item, { definitions, resolveFields: async () => ({}) });
    expect(await empty.resolve('dependencies.status')).toMatchObject({ known: false });

    const throwing = createItemFieldSource(item, {
      definitions,
      resolveFields: async () => {
        throw new Error('rate limited');
      },
    });
    expect(await throwing.resolve('dependencies.status')).toEqual({
      known: false,
      reason: 'field resolution failed: rate limited',
    });

    const noResolver = createItemFieldSource(item, { definitions });
    expect(await noResolver.resolve('dependencies.status')).toMatchObject({ known: false });
  });

  it('unknown and unprovided fields are unknown; extra fields and date type work', async () => {
    const src = createItemFieldSource(item, {
      definitions,
      extraFields: { 'run.last_result.message': 'done', 'run.last_workflow': { known: false, reason: 'no runs' } },
    });
    expect(await src.resolve('nope')).toEqual({ known: false, reason: "unknown field 'nope'" });
    expect(await src.resolve('run.last_result.message')).toEqual({ known: true, value: 'done' });
    expect(
      (await evaluateFilter({ field: 'run.last_result.message', operator: 'contains', value: 'don' }, src)).value,
    ).toBe(true);
    expect((await evaluateFilter({ field: 'run.last_workflow', operator: 'equals', value: 'x' }, src)).value).toBe('unknown');
    expect(
      (await evaluateFilter({ field: 'updated_at', operator: 'greater_than', value: '2026-10-01T11:00:00+02:00' }, src))
        .value,
    ).toBe(true);
    expect(src.fieldType?.('updated_at')).toBe('date');
  });
});
