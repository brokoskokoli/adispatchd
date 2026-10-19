/**
 * WI-15: named, reusable filters (`filters/*.yaml`) – short form and `use`
 * nodes, expansion at load time, reference errors, field checks at the place
 * of use, unused warnings, pushdown and reload.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../core/index.js';
import { splitForPushdown } from '../filters/index.js';
import { GITHUB_FIELD_DEFINITIONS } from '../sources/index.js';
import {
  ConfigManager,
  formatConfigIssue,
  loadConfig,
  MAX_EXPANDED_FILTER_NODES,
  MAX_FILTER_USE_DEPTH,
  type ConfigIssue,
  type LoadConfigResult,
} from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

function workflow(body: string, id = 'w'): string {
  return `id: ${id}\ntrigger: { type: source, source: repo_a }\nexecute: { type: shell, command: /bin/true }\n${body}`;
}

function view(body: string): string {
  return `id: v\nsources: [repo_a, repo_b]\nfields: [ { field: title } ]\n${body}`;
}

function named(id: string, filter: string, extra = ''): string {
  return `id: ${id}\n${extra}filter:\n${filter
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')}\n`;
}

const READY = named(
  'ready',
  [
    'all:',
    '  - { field: is_pull_request, operator: equals, value: false }',
    '  - { field: labels, operator: contains, value: ready }',
  ].join('\n'),
  'description: Ready issues\n',
);

describe('named filters (WI-15)', () => {
  const temps: TempConfigDir[] = [];
  afterEach(async () => {
    while (temps.length) await temps.pop()?.cleanup();
  });

  async function load(files: Record<string, string>): Promise<LoadConfigResult> {
    const t = await createTempConfigDir({ ...BASE_FILES, ...files });
    temps.push(t);
    return loadConfig(t.dir, { dataDir: t.dataDir });
  }

  async function errors(files: Record<string, string>): Promise<string[]> {
    const res = await load(files);
    return res.ok ? [] : res.errors.map(text);
  }

  it('expands the short form and use nodes in workflow filter, item_priority and view', async () => {
    const res = await load({
      'filters/ready.yaml': READY,
      'filters/high.yaml': named('high', '{ field: labels, operator: contains, value: "priority:high" }'),
      'workflows/w.yaml': workflow(
        [
          'filter: ready',
          'item_priority:',
          '  rules:',
          '    - when: { use: high }',
          '      value: 10',
          '    - when: { all: [ { use: high }, { field: number, operator: less_than, value: 100 } ] }',
          '      value: 20',
        ].join('\n'),
      ),
      'workflows/w2.yaml': workflow(
        'filter:\n  all:\n    - { use: ready }\n    - { field: author, operator: equals, value: ada }\n',
        'w2',
      ),
      'views/v.yaml': view('filter: { any: [ { use: ready }, { use: high } ] }\n'),
    });
    expect(res.ok, res.ok ? '' : res.errors.map(formatConfigIssue).join('\n')).toBe(true);
    if (!res.ok) return;
    expect(res.warnings).toEqual([]);
    const ready = {
      all: [
        { field: 'is_pull_request', operator: 'equals', value: false },
        { field: 'labels', operator: 'contains', value: 'ready' },
      ],
    };
    const high = { field: 'labels', operator: 'contains', value: 'priority:high' };
    const { w, w2 } = res.config.workflows;
    expect(w?.filter).toEqual(ready);
    expect(w?.itemPriority?.rules.map((r) => r.when)).toEqual([high, { all: [high, { field: 'number', operator: 'less_than', value: 100 }] }]);
    expect(w2?.filter).toEqual({ all: [ready, { field: 'author', operator: 'equals', value: 'ada' }] });
    expect(res.config.views.v?.filter).toEqual({ any: [ready, high] });
    expect(res.config.filters).toEqual({
      ready: { id: 'ready', file: 'filters/ready.yaml', description: 'Ready issues', filter: ready },
      high: { id: 'high', file: 'filters/high.yaml', description: null, filter: high },
    });
    expect(JSON.stringify(res.config)).not.toContain('"use"');
  });

  it('expands named filters inside other named filters', async () => {
    const res = await load({
      'filters/ready.yaml': READY,
      'filters/ready-backend.yaml': named(
        'ready-backend',
        'all:\n  - { use: ready }\n  - { field: labels, operator: contains, value: backend }',
      ),
      'filters/urgent-backend.yaml': named('urgent-backend', 'all: [ { use: ready-backend }, { field: number, operator: less_than, value: 5 } ]'),
      'workflows/w.yaml': workflow('filter: urgent-backend\n'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.workflows.w?.filter).toEqual({
      all: [
        {
          all: [
            {
              all: [
                { field: 'is_pull_request', operator: 'equals', value: false },
                { field: 'labels', operator: 'contains', value: 'ready' },
              ],
            },
            { field: 'labels', operator: 'contains', value: 'backend' },
          ],
        },
        { field: 'number', operator: 'less_than', value: 5 },
      ],
    });
    // Used indirectly → no "unused" warning for ready / ready-backend.
    expect(res.warnings).toEqual([]);
  });

  it('reports unknown filter IDs with a suggestion', async () => {
    expect(
      await errors({
        'filters/ready.yaml': READY,
        'filters/other.yaml': named('other', '{ use: redy }'),
        'workflows/w.yaml': workflow('filter: { all: [ { use: raedy } ] }\n'),
        'views/v.yaml': view('filter: nothing-like-it\n'),
      }),
    ).toEqual([
      'filters/other.yaml: filter: Unknown named filter "redy" (did you mean "ready"?)',
      'views/v.yaml: filter: Unknown named filter "nothing-like-it"',
      'workflows/w.yaml: filter.all[0]: Unknown named filter "raedy" (did you mean "ready"?)',
    ]);
  });

  it('reports cycles with the chain, and the places using a filter of the cycle', async () => {
    const found = await errors({
      'filters/a.yaml': named('a', 'all: [ { use: b } ]'),
      'filters/b.yaml': named('b', 'any: [ { field: number, operator: equals, value: 1 }, { use: a } ]'),
      'filters/self.yaml': named('self', 'not: { use: self }'),
      'workflows/w.yaml': workflow('filter: a\n'),
    });
    expect(found).toEqual([
      'filters/a.yaml: filter.all[0]: Named filter "b" is invalid (see filters/b.yaml)',
      'filters/b.yaml: filter.any[1]: Cycle in named filters: a → b → a',
      'filters/self.yaml: filter.not: Cycle in named filters: self → self',
      'workflows/w.yaml: filter: Named filter "a" is invalid (see filters/a.yaml)',
    ]);
  });

  it(`rejects references nested deeper than ${MAX_FILTER_USE_DEPTH} levels`, async () => {
    const files: Record<string, string> = {
      'filters/f0.yaml': named('f0', '{ field: number, operator: equals, value: 1 }'),
    };
    // f1 → f0, …, f16 → f15 … f0: f16 has 16 levels and is still fine on its own.
    for (let i = 1; i <= MAX_FILTER_USE_DEPTH + 1; i++) files[`filters/f${i}.yaml`] = named(`f${i}`, `{ use: f${i - 1} }`);
    const found = await errors({ ...files, 'workflows/w.yaml': workflow('filter: f15\n'), 'views/v.yaml': view('filter: f16\n') });
    expect(found).toEqual([
      expect.stringMatching(/^filters\/f17\.yaml: filter: Named filters are nested more than 16 levels deep: f16 → f15 → .* → f0$/),
      expect.stringMatching(/^views\/v\.yaml: filter: Named filters are nested more than 16 levels deep: f16 → .* → f0$/),
    ]);
    // 16 levels from the workflow (w → f15 → … → f0) are allowed.
    expect(found.some((e) => e.startsWith('workflows/'))).toBe(false);
  });

  it(`stops expanding past ${MAX_EXPANDED_FILTER_NODES} nodes per root (fan-out, review M1)`, async () => {
    // f<i> references f<i-1> ten times: f<i> expands to ~10^i nodes; f8 would be ~10^8.
    const files: Record<string, string> = { 'filters/f0.yaml': named('f0', '{ field: number, operator: equals, value: 1 }') };
    for (let i = 1; i <= 8; i++) {
      files[`filters/f${i}.yaml`] = named(`f${i}`, `any: [ ${Array.from({ length: 10 }, () => `{ use: f${i - 1} }`).join(', ')} ]`);
    }
    const started = Date.now();
    const found = await errors({
      ...files,
      'workflows/w.yaml': workflow('filter: f8\nitem_priority: { rules: [ { when: { all: [ { use: f3 }, { use: f3 }, { use: f2 } ] }, value: 1 } ] }\n'),
      'workflows/w2.yaml': workflow(`filter:\n  all: [ ${Array.from({ length: 10 }, () => '{ use: f3 }').join(', ')} ]\n`, 'w2'),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(found).toEqual([
      'filters/f4.yaml: filter.any[9]: Expanded filter would exceed 10000 nodes ("f3" alone has 1111; named filters are copied at every place of use)',
      'filters/f5.yaml: filter.any[0]: Named filter "f4" is invalid (see filters/f4.yaml)',
      'filters/f6.yaml: filter.any[0]: Named filter "f5" is invalid (see filters/f5.yaml)',
      'filters/f7.yaml: filter.any[0]: Named filter "f6" is invalid (see filters/f6.yaml)',
      'filters/f8.yaml: filter.any[0]: Named filter "f7" is invalid (see filters/f7.yaml)',
      'workflows/w.yaml: filter: Named filter "f8" is invalid (see filters/f8.yaml)',
      // 1111 + 1111 + 111 + 1 nodes: below the cap.
      'workflows/w2.yaml: filter.all[9]: Expanded filter would exceed 10000 nodes ("f3" alone has 1111; named filters are copied at every place of use)',
    ]);
    // Reported once per root, also for later references beyond the cap.
    expect(found.filter((e) => e.startsWith('workflows/w2.yaml'))).toHaveLength(1);
  });

  it('reports "invalid" for filter files that cannot be parsed or lack an ID (review N1)', async () => {
    const found = await errors({
      'filters/syntax.yaml': 'id: syntax\nfilter: { all: [\n',
      'filters/no-id.yaml': 'filter: { field: number, operator: equals, value: 1 }\n',
      'workflows/w.yaml': workflow('filter: { all: [ { use: syntax }, { use: no-id } ] }\n'),
    });
    expect(found).toContain('filters/no-id.yaml: id: Invalid input: expected string, received undefined');
    expect(found.some((e) => e.startsWith('filters/syntax.yaml: : YAML syntax error'))).toBe(true);
    expect(found.filter((e) => e.startsWith('workflows/'))).toEqual([
      'workflows/w.yaml: filter.all[0]: Named filter "syntax" is invalid (see filters/syntax.yaml)',
      'workflows/w.yaml: filter.all[1]: Named filter "no-id" is invalid (see filters/no-id.yaml)',
    ]);
  });

  it('hints at { use: … } for a bare filter ID inside the tree (review N5)', async () => {
    expect(await errors({ 'filters/ready.yaml': READY, 'workflows/w.yaml': workflow('filter: { not: ready }\n') })).toEqual([
      'workflows/w.yaml: filter.not: Filter node must be a mapping (all / any / not / use / {field, operator, value}); to reference a named filter write { use: ready }',
    ]);
  });

  it('rejects malformed use nodes and named filter files', async () => {
    expect(
      await errors({
        'filters/bad.yaml': 'id: bad\nfilter: { use: ready, field: labels }\n',
        'filters/bad2.yaml': 'id: bad2\nfilter: { all: [ { use: 3 }, { use: "not an id" } ] }\nextra: 1\n',
        'filters/empty.yaml': 'id: empty\n',
        'workflows/w.yaml': workflow('filter: { not: { use: [ready] } }\n'),
        'views/v.yaml': view('filter: bad\n'),
      }),
    ).toEqual([
      'filters/bad.yaml: filter: "use" must be the only key of its filter node ({ use: <filter-id> } references a named filter)',
      'filters/bad2.yaml: : Unknown key(s): "extra"',
      'filters/bad2.yaml: filter.all[0].use: "use" requires the ID of a named filter (filters/<id>.yaml)',
      'filters/bad2.yaml: filter.all[1].use: "use" requires the ID of a named filter (filters/<id>.yaml)',
      'filters/empty.yaml: filter: Required: a filter mapping or the ID of a named filter',
      'views/v.yaml: filter: Named filter "bad" is invalid (see filters/bad.yaml)',
      'workflows/w.yaml: filter.not.use: "use" requires the ID of a named filter (filters/<id>.yaml)',
    ]);
  });

  it('rejects duplicate filter IDs and warns about a file name differing from the ID', async () => {
    const res = await load({
      'filters/a.yaml': named('ready', '{ field: number, operator: equals, value: 1 }'),
      'filters/ready.yaml': READY,
      'workflows/w.yaml': workflow('filter: ready\n'),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map(text)).toEqual(['filters/ready.yaml: id: Duplicate filter ID "ready" (already defined in filters/a.yaml)']);
    expect(res.warnings.map(text)).toEqual(['filters/a.yaml: id: Filter ID "ready" differs from file name "a.yaml"']);
  });

  it('applies the state rule to the position after expansion', async () => {
    const closed = named('closed', '{ field: state, operator: equals, value: closed }');
    const closedAll = named('closed-all', 'all: [ { field: state, operator: in, value: [open, closed] } ]');
    expect(
      await errors({
        'filters/closed.yaml': closed,
        'filters/closed-all.yaml': closedAll,
        'workflows/top.yaml': workflow('filter: closed\n', 'top'),
        'workflows/nested.yaml': workflow('filter: { all: [ { use: closed-all }, { field: number, operator: equals, value: 1 } ] }\n', 'nested'),
      }),
    ).toEqual([]);
    const found = await errors({
      'filters/closed.yaml': closed,
      'workflows/w.yaml': workflow('filter: { any: [ { use: closed }, { field: number, operator: equals, value: 1 } ] }\n'),
    });
    expect(found).toEqual([
      expect.stringMatching(
        /^workflows\/w\.yaml: filter\.any\[0\] \(use "closed" → filters\/closed\.yaml: filter\.field\): "state" only works at the top level/,
      ),
    ]);
  });

  it('checks fields of a named filter at every place of use and names the path inside the named filter', async () => {
    const found = await errors({
      'filters/ready.yaml': named('ready', 'all:\n  - { field: is_pull_request, operator: equals, value: false }\n  - { field: labls, operator: contains, value: x }'),
      'filters/outer.yaml': named('outer', 'all: [ { field: number, operator: equals, value: 1 }, { use: ready } ]'),
      'workflows/w.yaml': workflow('filter: { all: [ { use: ready } ] }\nitem_priority: { rules: [ { when: outer, value: 1 } ] }\n'),
      'views/v.yaml': view('filter: ready\n'),
    });
    const unknown = 'Unknown field "labls" for source type github (did you mean "labels"?)';
    expect(found).toEqual([
      `views/v.yaml: filter (use "ready" → filters/ready.yaml: filter.all[1].field): ${unknown}`,
      `workflows/w.yaml: filter.all[0] (use "ready" → filters/ready.yaml: filter.all[1].field): ${unknown}`,
      `workflows/w.yaml: item_priority.rules[0].when (use "outer" → filters/outer.yaml: filter.all[1] → use "ready" → filters/ready.yaml: filter.all[1].field): ${unknown}`,
    ]);
  });

  it('accepts run.last_* in a named filter only where a view uses it', async () => {
    const files = {
      'filters/last-failed.yaml': named('last-failed', '{ field: run.last_status, operator: equals, value: failed }'),
      'views/v.yaml': view('filter: { all: [ { use: last-failed } ] }\n'),
    };
    expect(await errors(files)).toEqual([]);
    expect(await errors({ ...files, 'workflows/w.yaml': workflow('filter: last-failed\n') })).toEqual([
      'workflows/w.yaml: filter (use "last-failed" → filters/last-failed.yaml: filter.field): Field "run.last_status" is only available in views, not in workflows',
    ]);
  });

  it('warns about unused named filters (but not when a workflow could not be parsed)', async () => {
    const res = await load({ 'filters/ready.yaml': READY, 'filters/unused.yaml': named('unused', '{ use: ready }') });
    expect(res.ok).toBe(true);
    expect(res.warnings.map(text)).toEqual([
      'filters/ready.yaml: id: Named filter "ready" is not used by any workflow or view',
      'filters/unused.yaml: id: Named filter "unused" is not used by any workflow or view',
    ]);
    const broken = await load({ 'filters/ready.yaml': READY, 'workflows/w.yaml': 'id: w\n' });
    expect(broken.warnings).toEqual([]);
  });

  it('works without a filters directory', async () => {
    const res = await load({ 'workflows/w.yaml': workflow('filter: { field: number, operator: equals, value: 1 }\n') });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.filters).toEqual({});
  });

  it('flattens referenced top-level conjunctions for the pushdown', async () => {
    const res = await load({
      'filters/ready.yaml': READY,
      'workflows/w.yaml': workflow(
        'filter:\n  all:\n    - { use: ready }\n    - { field: state, operator: equals, value: closed }\n    - any: [ { use: ready } ]\n',
      ),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const split = splitForPushdown(res.config.workflows.w?.filter, GITHUB_FIELD_DEFINITIONS);
    expect(split.pushdown).toEqual({
      all: [
        { field: 'labels', operator: 'contains', value: 'ready' },
        { field: 'state', operator: 'equals', value: 'closed' },
      ],
    });
    expect(split.local).toEqual({
      all: [
        { field: 'is_pull_request', operator: 'equals', value: false },
        { any: [res.config.filters.ready?.filter] },
      ],
    });
  });

  it('applies a changed named filter to all using workflows and views on reload', async () => {
    const t = await createTempConfigDir({
      ...BASE_FILES,
      'filters/ready.yaml': READY,
      'workflows/a.yaml': workflow('filter: ready\n', 'a'),
      'workflows/b.yaml': workflow('filter: { not: { use: ready } }\n', 'b'),
      'workflows/c.yaml': workflow('filter: { field: number, operator: equals, value: 1 }\n', 'c'),
      'views/v.yaml': view('filter: ready\n'),
    });
    temps.push(t);
    const manager = await ConfigManager.create({ configDir: t.dir, dataDir: t.dataDir, logger: new MemoryLogger() });
    const changed = { field: 'labels', operator: 'contains', value: 'go' };
    await t.write({ 'filters/ready.yaml': named('ready', '{ field: labels, operator: contains, value: go }') });
    const res = await manager.reload();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diff.changedWorkflows.sort()).toEqual(['a', 'b']);
    expect(manager.current.workflows.a?.filter).toEqual(changed);
    expect(manager.current.workflows.b?.filter).toEqual({ not: changed });
    expect(manager.current.views.v?.filter).toEqual(changed);
    expect(manager.current.filters.ready?.filter).toEqual(changed);

    // An invalid named filter makes the reload fail as a whole; the active configuration stays.
    await t.write({ 'filters/ready.yaml': named('ready', '{ field: labls, operator: contains, value: go }') });
    const failed = await manager.reload();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors.map((e) => e.file).sort()).toEqual(['views/v.yaml', 'workflows/a.yaml', 'workflows/b.yaml']);
    expect(manager.current.workflows.a?.filter).toEqual(changed);
  });
});
