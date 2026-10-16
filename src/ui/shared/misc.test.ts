import { describe, expect, it } from 'vitest';
import { cellText, compareCells, nextSort, sortRows } from './sort.js';
import { buildHash, parseHash } from './route.js';
import { buildRuntimeBody, buildStartBody } from './params.js';

describe('view sorting (browser only, Spec §17)', () => {
  const row = (...vals: unknown[]) => ({ cells: vals.map((v) => (v === undefined ? { value: null, known: false } : { value: v, known: true })) });
  it('sorts numbers numerically and puts unknown/empty last in both directions', () => {
    const rows = [row(10), row(undefined), row(2), row(''), row(33)];
    expect(sortRows(rows, 0, 'number', 'asc').map((r) => r.cells[0]!.value)).toEqual([2, 10, 33, null, '']);
    expect(sortRows(rows, 0, 'number', 'desc').map((r) => r.cells[0]!.value)).toEqual([33, 10, 2, null, '']);
  });
  it('sorts dates and strings (natural order), stable for ties', () => {
    const rows = [row('2026-10-02T00:00:00Z', 'a'), row('2026-01-01T00:00:00Z', 'b'), row('2026-10-02T00:00:00Z', 'c')];
    expect(sortRows(rows, 0, 'date', 'asc').map((r) => r.cells[1]!.value)).toEqual(['b', 'a', 'c']);
    expect(sortRows([row('item 10'), row('item 9')], 0, 'string', 'asc').map((r) => r.cells[0]!.value)).toEqual(['item 9', 'item 10']);
  });
  it('compareCells / nextSort / cellText', () => {
    expect(compareCells({ value: true, known: true }, { value: false, known: true }, 'boolean', 'asc')).toBeGreaterThan(0);
    expect(nextSort(null, 2)).toEqual({ column: 2, direction: 'asc' });
    expect(nextSort({ column: 2, direction: 'asc' }, 2)).toEqual({ column: 2, direction: 'desc' });
    expect(nextSort({ column: 2, direction: 'desc' }, 1)).toEqual({ column: 1, direction: 'asc' });
    expect(cellText({ value: ['a', 'b'], known: true })).toBe('a, b');
    expect(cellText({ value: { x: 1 }, known: true })).toBe('{"x":1}');
    expect(cellText({ value: 'x', known: false })).toBe('');
  });
});

describe('hash routes', () => {
  it('parses and builds', () => {
    expect(parseHash('')).toEqual({ segments: [], query: {} });
    expect(parseHash('#/')).toEqual({ segments: [], query: {} });
    expect(parseHash('#/runs/run-1?tab=logs&stream=stderr')).toEqual({ segments: ['runs', 'run-1'], query: { tab: 'logs', stream: 'stderr' } });
    expect(parseHash('#/views/a%2Fb')).toEqual({ segments: ['views', 'a/b'], query: {} });
    expect(parseHash('#/x/%E0%A4%A')).toEqual({ segments: ['x', '%E0%A4%A'], query: {} });
    expect(buildHash(['runs'], { scope: 'active', workflow: '', offset: 0 })).toBe('#/runs?scope=active&offset=0');
    expect(buildHash(['views', 'a/b'])).toBe('#/views/a%2Fb');
    const h = buildHash(['runs', 'r 1'], { tab: 'logs' });
    expect(parseHash(h)).toEqual({ segments: ['runs', 'r 1'], query: { tab: 'logs' } });
  });
});

describe('manual start form', () => {
  const defs = {
    environment: { type: 'enum', values: ['staging', 'production'], required: true, default: null },
    version: { type: 'string', required: true, default: null },
    dryRun: { type: 'boolean', required: false, default: false },
    count: { type: 'number', required: false, default: 3 },
  };
  it('builds the body with typed values; empty optional values use the server default', () => {
    expect(buildStartBody('manual', '', defs, { environment: 'staging', version: ' 1.2 ', dryRun: 'true', count: '' })).toEqual({
      ok: true,
      body: { parameters: { environment: 'staging', version: ' 1.2 ', dryRun: true } },
    });
    expect(buildStartBody('schedule', '', {}, {})).toEqual({ ok: true, body: {} });
  });
  it('reports missing / invalid values', () => {
    const r = buildStartBody('manual', '', defs, { environment: 'prod', count: 'abc', dryRun: 'yes' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(['count', 'dryRun', 'environment', 'version']);
  });
  it('requires a source item for source workflows only', () => {
    expect(buildStartBody('source', ' #7 ', {}, {})).toEqual({ ok: true, body: { item: '#7' } });
    expect(buildStartBody('source', '', {}, {}).ok).toBe(false);
    expect(buildStartBody('manual', '#7', {}, {}).ok).toBe(false);
  });
  it('runtime overrides: empty = YAML value (null)', () => {
    expect(buildRuntimeBody({ enabled: '', priority: '', maxConcurrent: '' })).toEqual({ ok: true, body: { enabled: null, priority: null, maxConcurrent: null } });
    expect(buildRuntimeBody({ enabled: 'false', priority: '-5.5', maxConcurrent: '2' })).toEqual({ ok: true, body: { enabled: false, priority: -5.5, maxConcurrent: 2 } });
    const bad = buildRuntimeBody({ enabled: 'maybe', priority: 'x', maxConcurrent: '0' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(3);
  });
});
