import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager, DEFAULT_DASHBOARD_LAYOUT, formatConfigIssue, loadConfig, tabSlug, type LoadConfigResult } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

const VIEWS: Record<string, string> = {
  'views/board.yaml': [
    'id: board',
    'title: Board',
    'sources: [repo_a]',
    'fields: [{ field: title }]',
    'sections:',
    '  - { title: Review, filter: { field: state, operator: equals, value: open } }',
    '  - { title: In Arbeit, rest: true }',
    '',
  ].join('\n'),
  'views/flat.yaml': 'id: flat\ntitle: Flat\nsources: [repo_a]\nfields: [{ field: title }]\n',
  'workflows/coder.yaml': 'id: coder\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/true }\n',
};

async function tempDir(files: Record<string, string>): Promise<TempConfigDir> {
  const t = await createTempConfigDir({ ...BASE_FILES, ...VIEWS, ...files });
  temps.push(t);
  return t;
}

async function load(dashboard: string, extra: Record<string, string> = {}): Promise<LoadConfigResult> {
  const t = await tempDir({ 'dashboard.yaml': dashboard, ...extra });
  return loadConfig(t.dir, { dataDir: t.dataDir });
}

function errors(r: LoadConfigResult): string[] {
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
}
function warnings(r: LoadConfigResult): string[] {
  return r.warnings.map(formatConfigIssue);
}

const INFO = 'info:\n  - { id: disk, type: number, command: echo }\n  - { id: prs, type: number, command: echo }\n';

describe('dashboard.yaml layout (WI-32)', () => {
  it('is null without "layout"; the default layout matches the 0.7.0 dashboard', async () => {
    const r = await load(INFO);
    if (!r.ok) throw new Error(errors(r).join('\n'));
    expect(r.config.dashboard?.layout).toBeNull();
    expect(DEFAULT_DASHBOARD_LAYOUT.map((row) => row.columns.map((c) => c.widgets.map((w) => w.widget).join('+')).join(' | '))).toEqual([
      'resources',
      'info',
      'scheduler | capacity | attention',
      'active_runs',
      'recent_runs',
    ]);
  });

  it('normalizes rows, columns, widths, titles, options and repeated widgets', async () => {
    const r = await load(
      INFO +
        [
          'layout:',
          '  - row: [resources]',
          '  - title: Arbeit',
          '    row:',
          '      - column: [scheduler, attention]',
          '        width: 1',
          '      - column:',
          '          - { widget: view, view: board, sections: [In Arbeit, Review, Review], limit: 15, title: Pipeline }',
          '        width: 3',
          '  - row:',
          '      - { widget: info, ids: [prs] }',
          '      - { widget: info, width: 2 }',
          '      - { widget: recent_runs, limit: 5, title: Zuletzt fertig, workflows: [coder] }',
          '      - { widget: view, view: flat, refresh: 2m }',
          '      - active_runs',
          '',
        ].join('\n'),
    );
    if (!r.ok) throw new Error(errors(r).join('\n'));
    expect(r.warnings).toEqual([]);
    const layout = r.config.dashboard?.layout ?? [];
    expect(layout).toHaveLength(3);
    expect(layout[0]).toEqual({ title: null, columns: [{ width: 1, widgets: [{ widget: 'resources', title: null }] }] });
    expect(layout[1]?.title).toBe('Arbeit');
    expect(layout[1]?.columns).toEqual([
      { width: 1, widgets: [{ widget: 'scheduler', title: null }, { widget: 'attention', title: null }] },
      { width: 3, widgets: [{ widget: 'view', title: 'Pipeline', view: 'board', sections: ['In Arbeit', 'Review'], limit: 15, refreshMs: 60_000 }] },
    ]);
    expect(layout[2]?.columns).toEqual([
      { width: 1, widgets: [{ widget: 'info', title: null, ids: ['prs'] }] },
      { width: 2, widgets: [{ widget: 'info', title: null, ids: null }] },
      { width: 1, widgets: [{ widget: 'recent_runs', title: 'Zuletzt fertig', limit: 5, workflows: ['coder'] }] },
      { width: 1, widgets: [{ widget: 'view', title: null, view: 'flat', sections: null, limit: 50, refreshMs: 120_000 }] },
      { width: 1, widgets: [{ widget: 'active_runs', title: null, limit: 100, workflows: null }] },
    ]);
  });

  it('reports structural errors with path and "did you mean"', async () => {
    const r = await load(
      INFO +
        [
          'layout:',
          '  - row: [resorces]',
          '  - row: []',
          '  - titel: X\n    row: [info]',
          '  - row: [{ column: [] }, { column: [scheduler], widht: 2 }]',
          '  - row: [{ widget: active_runs, limit: 0, workflow: [coder] }, { widget: recent_runs, limit: 51 }]',
          '  - row: [view, { widget: view }, { widget: view, view: flat, refresh: 5s, limit: 201 }]',
          '  - row: [{ column: [{ widget: info, width: 2 }] }, { widget: capacity, width: 13, title: "" }, 42]',
          '  - row: [a, b, c, d, e, f, g]',
          '',
        ].join('\n'),
    );
    const all = errors(r);
    const has = (prefix: string, text: string): boolean => all.some((e) => e.startsWith(prefix) && e.includes(text));
    expect(has('layout[0].row[0]: Invalid option', '(did you mean "resources"?)')).toBe(true);
    expect(all).toContain('layout[1].row: A row needs at least one widget or column');
    expect(all).toContain('layout[2]: Unknown key(s): "titel" (did you mean "title"?)');
    expect(all).toContain('layout[3].row[0].column: A column needs at least one widget');
    expect(all).toContain('layout[3].row[1]: Unknown key(s): "widht" (did you mean "width"?)');
    expect(all).toContain('layout[4].row[0].limit: Must be at least 1');
    expect(all).toContain('layout[4].row[0]: Unknown key(s): "workflow" (did you mean "workflows"?)');
    expect(all).toContain('layout[4].row[1].limit: Must be at most 50');
    expect(all).toContain('layout[5].row[0]: Widget "view" needs options: { widget: view, view: <view ID> }');
    expect(has('layout[5].row[1].view:', '')).toBe(true);
    expect(all).toContain('layout[5].row[2].limit: Must be at most 200');
    expect(all).toContain('layout[5].row[2].refresh: Duration must be at least 15s');
    expect(all).toContain('layout[6].row[0].column[0].width: "width" is only allowed on columns and on widgets directly in a row');
    expect(all).toContain('layout[6].row[1].width: Must be at most 12');
    expect(all).toContain('layout[6].row[1].title: Must not be empty');
    expect(all).toContain('layout[6].row[2]: Expected a widget name, { widget: <name>, … } or { column: [...] }');
    expect(all).toContain('layout[7].row: At most 6 columns per row');
  });

  it('checks references: views, sections, info IDs, workflows', async () => {
    const r = await load(
      INFO +
        [
          'layout:',
          '  - row:',
          '      - { widget: view, view: bord }',
          '      - { widget: view, view: flat, sections: [Review] }',
          '      - { widget: view, view: board, sections: [Reviw] }',
          '      - { widget: info, ids: [dsk] }',
          '      - { widget: active_runs, workflows: [codr] }',
          '',
        ].join('\n'),
    );
    expect(errors(r)).toEqual([
      'layout[0].row[0].view: Unknown view "bord" (did you mean "board"?)',
      'layout[0].row[1].sections: View "flat" has no sections',
      'layout[0].row[2].sections[0]: View "board" has no section "Reviw" (did you mean "Review"?)',
      'layout[0].row[3].ids[0]: Unknown info tile "dsk" (did you mean "disk"?)',
      'layout[0].row[4].workflows[0]: Unknown workflow "codr" (did you mean "coder"?)',
    ]);
  });

  it('reports wrong references also when the same widget has a schema error', async () => {
    const r = await load(INFO + 'layout:\n  - row: [{ widget: active_runs, limit: 0, workflows: [codr] }, { widget: view, view: bord, limit: 999 }]\n');
    expect(errors(r)).toEqual([
      'layout[0].row[0].limit: Must be at least 1',
      'layout[0].row[0].workflows[0]: Unknown workflow "codr" (did you mean "coder"?)',
      'layout[0].row[1].limit: Must be at most 200',
      'layout[0].row[1].view: Unknown view "bord" (did you mean "board"?)',
    ]);
  });

  it('rejects an empty layout and too many rows', async () => {
    expect(errors(await load('layout: []\n'))).toEqual(['layout: List at least one row (or omit "layout" for the default layout)']);
    const many = `layout:\n${Array.from({ length: 31 }, () => '  - row: [scheduler]').join('\n')}\n`;
    expect(errors(await load(many))).toEqual(['layout: At most 30 rows']);
  });

  it('warns about info without tiles and resources with monitoring disabled', async () => {
    const r = await load('layout:\n  - row: [info, resources, resources_full]\n', { 'config.yaml': 'monitoring:\n  enabled: false\n' });
    expect(r.ok).toBe(true);
    expect(warnings(r)).toEqual([
      'dashboard.yaml:2: warning: layout[0].row[0]: Widget "info" without info tiles (define them under "info")',
      'dashboard.yaml:2: warning: layout[0].row[1].widget: Widget "resources" shows nothing useful: monitoring.enabled is false in config.yaml',
      'dashboard.yaml:2: warning: layout[0].row[2].widget: Widget "resources_full" shows nothing useful: monitoring.enabled is false in config.yaml',
    ]);
  });

  it('is re-read on reload', async () => {
    const t = await tempDir({ 'dashboard.yaml': 'layout:\n  - row: [scheduler]\n' });
    const manager = await ConfigManager.create({ configDir: t.dir, dataDir: t.dataDir });
    expect(manager.current.dashboard?.layout?.[0]?.columns[0]?.widgets[0]?.widget).toBe('scheduler');
    await t.write({ 'dashboard.yaml': 'layout:\n  - row: [attention, capacity]\n' });
    const res = await manager.reload();
    expect(res.ok && res.changed).toBe(true);
    expect(manager.current.dashboard?.layout?.[0]?.columns.map((c) => c.widgets[0]?.widget)).toEqual(['attention', 'capacity']);
    await t.write({ 'dashboard.yaml': 'layout:\n  - row: [atention]\n' });
    expect((await manager.reload()).ok).toBe(false);
    expect(manager.current.dashboard?.layout?.[0]?.columns).toHaveLength(2);
  });
});

describe('tabs widget (WI-32)', () => {
  it('derives tab IDs from titles', () => {
    expect(tabSlug('Projekte')).toBe('projekte');
    expect(tabSlug('Wartet auf Prüfung & Größe')).toBe('wartet-auf-pruefung-groesse');
    expect(tabSlug('Café')).toBe('cafe');
    expect(tabSlug('!!!')).toBeNull();
  });

  it('normalizes nested tabs (row, column, sub-tabs) with IDs and default', async () => {
    const r = await load(
      [
        'layout:',
        '  - row:',
        '      - widget: tabs',
        '        width: 3',
        '        default: runs',
        '        tabs:',
        '          - title: Pipeline',
        '            layout: [{ row: [{ widget: view, view: board }] }]',
        '          - { title: Runs, layout: [{ row: [active_runs, recent_runs] }] }',
        '          - title: Projekte',
        '            layout:',
        '              - row:',
        '                  - widget: tabs',
        '                    tabs:',
        '                      - { title: A, id: alpha, layout: [{ row: [{ widget: view, view: flat }] }] }',
        '                      - { title: B, layout: [{ row: [attention] }] }',
        '      - column: [scheduler, { widget: tabs, tabs: [{ title: Mehr, layout: [{ row: [capacity] }] }] }]',
        '',
      ].join('\n'),
    );
    if (!r.ok) throw new Error(errors(r).join('\n'));
    const [tabsCol, col] = r.config.dashboard?.layout?.[0]?.columns ?? [];
    expect(tabsCol?.width).toBe(3);
    const tabs = tabsCol?.widgets[0];
    if (tabs?.widget !== 'tabs') throw new Error('expected tabs');
    expect(tabs.default).toBe('runs');
    expect(tabs.tabs.map((t) => [t.id, t.title])).toEqual([
      ['pipeline', 'Pipeline'],
      ['runs', 'Runs'],
      ['projekte', 'Projekte'],
    ]);
    const sub = tabs.tabs[2]?.layout[0]?.columns[0]?.widgets[0];
    if (sub?.widget !== 'tabs') throw new Error('expected sub-tabs');
    expect(sub.default).toBe('alpha');
    expect(sub.tabs.map((t) => t.id)).toEqual(['alpha', 'b']);
    expect(col?.widgets.map((w) => w.widget)).toEqual(['scheduler', 'tabs']);
  });

  it('reports tab errors with their path', async () => {
    const r = await load(
      [
        'layout:',
        '  - row:',
        '      - tabs',
        '      - { widget: tabs, tabs: [] }',
        '      - widget: tabs',
        '        default: nope',
        '        tabs:',
        '          - { title: X, layout: [{ row: [scheduler] }] }',
        '          - { title: X, layout: [{ row: [capcity] }] }',
        '          - { title: "!!", layout: [{ row: [scheduler] }] }',
        '          - { title: Lang, id: x, layout: [{ row: [scheduler] }] }',
        '          - { tile: Y, layout: [{ row: [scheduler] }] }',
        '          - { title: "0123456789012345678901234567890123456789x", layout: [{ row: [scheduler] }] }',
        '          - { title: Leer, layout: [] }',
        '',
      ].join('\n'),
    );
    const all = errors(r);
    expect(all).toContain('layout[0].row[0]: Widget "tabs" needs options: { widget: tabs, tabs: [{ title: …, layout: [...] }] }');
    expect(all).toContain('layout[0].row[1].tabs: List at least one tab');
    expect(all).toContain('layout[0].row[2].tabs[1].title: Duplicate tab title "X" (also used by tabs[0])');
    expect(all.some((e) => e.startsWith('layout[0].row[2].tabs[1].layout[0].row[0]: Invalid option') && e.includes('did you mean "capacity"'))).toBe(true);
    expect(all).toContain('layout[0].row[2].tabs[2]: Cannot derive a tab ID from the title "!!"; set "id"');
    expect(all).toContain('layout[0].row[2].tabs[3].id: Duplicate tab ID "x" (also used by layout[0].row[2].tabs[0]); tab IDs must be unique among the tabs of one layout – set a different "id"');
    expect(all).toContain('layout[0].row[2].tabs[6].layout: List at least one row');
    expect(all).toContain('layout[0].row[2].tabs[4]: Unknown key(s): "tile" (did you mean "title"?)');
    expect(all).toContain('layout[0].row[2].tabs[5].title: At most 40 characters');
  });

  it('checks the default tab, unique IDs across tabs widgets of one layout, depth and widget count', async () => {
    const tabsOf = (inner: string): string => `{ widget: tabs, tabs: [{ title: T, layout: [{ row: [${inner}] }] }] }`;
    const r = await load(
      [
        'layout:',
        '  - row:',
        '      - { widget: tabs, default: b, tabs: [{ title: A, layout: [{ row: [scheduler] }] }] }',
        '      - { widget: tabs, tabs: [{ title: A, layout: [{ row: [scheduler] }] }] }',
        `  - row: [${tabsOf(tabsOf(tabsOf(tabsOf('scheduler'))))}]`,
        '',
      ].join('\n'),
    );
    expect(errors(r)).toEqual([
      'layout[0].row[0].default: Unknown tab "b" (tab IDs: a)',
      'layout[0].row[1].tabs[0]: Duplicate tab ID "a" (also used by layout[0].row[0].tabs[0]); tab IDs must be unique among the tabs of one layout – set a different "id"',
      'layout[1].row[0].tabs[0].layout[0].row[0].tabs[0].layout[0].row[0].tabs[0].layout[0].row[0]: Tabs can be nested at most 3 levels deep',
    ]);
    // Same tab IDs in different (nested) layouts are fine.
    const nested = await load(`layout:\n  - row: [{ widget: tabs, tabs: [{ title: A, layout: [{ row: [${tabsOf('scheduler').replace('title: T', 'title: A')}] }] }] }]\n`);
    expect(errors(nested)).toEqual([]);

    const rows = Array.from({ length: 17 }, () => '  - row: [scheduler, scheduler, scheduler, scheduler, scheduler, scheduler]').join('\n');
    const big = await load(`layout:\n${rows}\n`);
    expect(errors(big)).toEqual(['layout[16].row[4]: At most 100 widgets in the whole layout (including tabs)']);
  });
});
