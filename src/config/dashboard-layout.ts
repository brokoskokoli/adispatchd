/**
 * `dashboard.yaml` → `layout` (WI-32): rows of columns of widgets, including
 * the container widget `tabs` (one nested layout per tab).
 *
 * A row element is picked by its shape (widget name, `{ column: … }` or
 * `{ widget: … }`) and then checked with the matching schema of `schemas.ts`,
 * so every problem carries its full path (`layout[1].row[0].tabs[2].layout[0]…`)
 * and unknown keys get "did you mean" hints for the right variant. References
 * (views, sections, workflows, info tile IDs) are checked in the same walk.
 */
import type { z } from 'zod';
import { CONFIG_ID_PATTERN } from '../core/index.js';
import { suggestField } from './field-catalog.js';
import { formatIssuePath, type IssueCollector, type IssuePath } from './issues.js';
import type {
  DashboardColumnConfig,
  DashboardRowConfig,
  DashboardTabConfig,
  DashboardWidgetConfig,
  GlobalConfig,
  ViewConfig,
} from './model.js';
import {
  DASHBOARD_LAYOUT_LIMITS as L,
  dashboardColumnSchema,
  dashboardLayoutSchema,
  dashboardRowSchema,
  dashboardTabSchema,
  dashboardWidgetNameSchema,
  dashboardWidgetSchemas,
  type RawDashboardWidget,
} from './schemas.js';

/** Checks a value at a path of the file against a schema and reports its problems (see `parseValueAt`). */
export type ParseAt = <S extends z.ZodType>(schema: S, data: unknown, at: IssuePath) => z.output<S> | undefined;

/** What the references of a layout are checked against. */
export interface DashboardLayoutContext {
  file: string;
  global: GlobalConfig;
  /** Info tile IDs of the same file, in file order. */
  infoIds: readonly string[];
  /** `null`: some workflow file could not be parsed (references are not checked). */
  workflows: ReadonlySet<string> | null;
  /** `null`: some view file could not be parsed (references are not checked). */
  views: ReadonlyMap<string, ViewConfig> | null;
}

const w = <T extends DashboardWidgetConfig>(widget: T): T => widget;

/** The layout used without `layout` key (or without `dashboard.yaml`): the dashboard of 0.7.0. */
export const DEFAULT_DASHBOARD_LAYOUT: readonly DashboardRowConfig[] = [
  { title: null, columns: [{ width: 1, widgets: [w({ widget: 'resources', title: null })] }] },
  { title: null, columns: [{ width: 1, widgets: [w({ widget: 'info', title: null, ids: null })] }] },
  {
    title: null,
    columns: [
      { width: 1, widgets: [w({ widget: 'scheduler', title: null })] },
      { width: 1, widgets: [w({ widget: 'capacity', title: null })] },
      { width: 1, widgets: [w({ widget: 'attention', title: null })] },
    ],
  },
  {
    title: null,
    columns: [{ width: 1, widgets: [w({ widget: 'active_runs', title: null, limit: L.activeRunsLimit.default, workflows: null })] }],
  },
  {
    title: null,
    columns: [{ width: 1, widgets: [w({ widget: 'recent_runs', title: null, limit: L.recentRunsLimit.default, workflows: null })] }],
  },
];

/**
 * Tab ID derived from a title: lower case, umlauts transliterated, other
 * characters → `-` (max. 64). `null` if nothing usable remains.
 */
export function tabSlug(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '');
  return slug !== '' && CONFIG_ID_PATTERN.test(slug) ? slug : null;
}

/** Widgets that need options (no string form). */
const NEEDS_OPTIONS: Record<string, string> = {
  view: '{ widget: view, view: <view ID> }',
  tabs: '{ widget: tabs, tabs: [{ title: …, layout: [...] }] }',
};

interface Walk {
  ctx: DashboardLayoutContext;
  parse: ParseAt;
  issues: IssueCollector;
  widgets: number;
  tooMany: boolean;
}

/**
 * Parse, normalize and check `layout`. Returns `null` without `layout` (the
 * default layout applies) and `undefined` if an error was reported.
 */
export function parseDashboardLayout(raw: unknown, parse: ParseAt, issues: IssueCollector, ctx: DashboardLayoutContext): DashboardRowConfig[] | null | undefined {
  if (raw === undefined) return null;
  const before = errorCount(issues);
  const walk: Walk = { ctx, parse, issues, widgets: 0, tooMany: false };
  const rows = layoutAt(walk, raw, ['layout'], 0);
  return rows && errorCount(issues) === before ? rows : undefined;
}

function errorCount(issues: IssueCollector): number {
  return issues.items.filter((i) => i.severity === 'error').length;
}

/** A (nested) layout: list of rows. `depth` = number of enclosing tabs widgets. */
function layoutAt(walk: Walk, raw: unknown, at: IssuePath, depth: number): DashboardRowConfig[] | undefined {
  const list = walk.parse(dashboardLayoutSchema, raw, at);
  if (!list) return undefined;
  const rows: DashboardRowConfig[] = [];
  let ok = true;
  // Tab IDs must be unique among the tabs widgets of this layout (the URL addresses a tab by its path of IDs).
  const tabIds = new Map<string, string>();
  list.forEach((rawRow, r) => {
    const rowAt = [...at, r];
    const row = walk.parse(dashboardRowSchema, rawRow, rowAt);
    if (!row) {
      ok = false;
      return;
    }
    const columns: DashboardColumnConfig[] = [];
    row.row.forEach((element, c) => {
      const column = columnAt(walk, element, [...rowAt, 'row', c], depth, tabIds);
      if (column) columns.push(column);
      else ok = false;
    });
    rows.push({ title: row.title ?? null, columns });
  });
  return ok ? rows : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A row element: a column or a single widget (= column with this widget). */
function columnAt(walk: Walk, raw: unknown, at: IssuePath, depth: number, tabIds: Map<string, string>): DashboardColumnConfig | undefined {
  if (isObject(raw) && Object.hasOwn(raw, 'column')) {
    const column = walk.parse(dashboardColumnSchema, raw, at);
    if (!column) return undefined;
    const widgets: DashboardWidgetConfig[] = [];
    let ok = true;
    column.column.forEach((rawWidget, i) => {
      const widget = widgetAt(walk, rawWidget, [...at, 'column', i], depth, tabIds, false);
      if (widget) widgets.push(widget.widget);
      else ok = false;
    });
    return ok ? { width: column.width ?? 1, widgets } : undefined;
  }
  const widget = widgetAt(walk, raw, at, depth, tabIds, true);
  return widget ? { width: widget.width ?? 1, widgets: [widget.widget] } : undefined;
}

/** A widget (string or object form). `inRow`: directly in a row (may carry `width`). */
function widgetAt(
  walk: Walk,
  raw: unknown,
  at: IssuePath,
  depth: number,
  tabIds: Map<string, string>,
  inRow: boolean,
): { widget: DashboardWidgetConfig; width: number | undefined } | undefined {
  const { issues, ctx } = walk;
  walk.widgets++;
  if (walk.widgets > L.widgets && !walk.tooMany) {
    walk.tooMany = true;
    issues.error(ctx.file, at, `At most ${L.widgets} widgets in the whole layout (including tabs)`);
  }
  let parsed: RawDashboardWidget | undefined;
  if (typeof raw === 'string') {
    const name = walk.parse(dashboardWidgetNameSchema, raw, at);
    if (!name) return undefined;
    const usage = NEEDS_OPTIONS[name];
    if (usage) {
      issues.error(ctx.file, at, `Widget "${name}" needs options: ${usage}`);
      return undefined;
    }
    parsed = dashboardWidgetSchemas[name].parse({ widget: name });
  } else if (isObject(raw) && Object.hasOwn(raw, 'widget')) {
    const name = walk.parse(dashboardWidgetNameSchema, raw.widget, [...at, 'widget']);
    if (!name) return undefined;
    parsed = walk.parse(dashboardWidgetSchemas[name], raw, at);
    if (!parsed) return undefined;
  } else {
    issues.error(ctx.file, at, 'Expected a widget name, { widget: <name>, … } or { column: [...] }');
    return undefined;
  }
  if (!inRow && parsed.width !== undefined) {
    issues.error(ctx.file, [...at, 'width'], '"width" is only allowed on columns and on widgets directly in a row');
  }
  const widget = normalizeWidget(walk, parsed, at, depth, tabIds);
  return widget ? { widget, width: parsed.width } : undefined;
}

function normalizeWidget(walk: Walk, raw: RawDashboardWidget, at: IssuePath, depth: number, tabIds: Map<string, string>): DashboardWidgetConfig | undefined {
  const { ctx, issues } = walk;
  const title = raw.title ?? null;
  switch (raw.widget) {
    case 'resources':
    case 'resources_full':
      if (!ctx.global.monitoring.enabled) {
        issues.warning(ctx.file, [...at, 'widget'], `Widget "${raw.widget}" shows nothing useful: monitoring.enabled is false in config.yaml`);
      }
      return { widget: raw.widget, title };
    case 'scheduler':
    case 'capacity':
    case 'attention':
      return { widget: raw.widget, title };
    case 'info': {
      if (ctx.infoIds.length === 0) issues.warning(ctx.file, at, 'Widget "info" without info tiles (define them under "info")');
      raw.ids?.forEach((id, i) => {
        if (!ctx.infoIds.includes(id)) issues.error(ctx.file, [...at, 'ids', i], `Unknown info tile "${id}"${hint(id, ctx.infoIds)}`);
      });
      return { widget: 'info', title, ids: raw.ids ? unique(raw.ids) : null };
    }
    case 'active_runs':
    case 'recent_runs': {
      const known = ctx.workflows;
      if (known) {
        raw.workflows?.forEach((id, i) => {
          if (!known.has(id)) issues.error(ctx.file, [...at, 'workflows', i], `Unknown workflow "${id}"${hint(id, [...known])}`);
        });
      }
      return { widget: raw.widget, title, limit: raw.limit, workflows: raw.workflows ? unique(raw.workflows) : null };
    }
    case 'view': {
      const views = ctx.views;
      if (views) {
        const view = views.get(raw.view);
        if (!view) {
          issues.error(ctx.file, [...at, 'view'], `Unknown view "${raw.view}"${hint(raw.view, [...views.keys()])}`);
        } else if (raw.sections) {
          const titles = view.sections?.map((s) => s.title) ?? null;
          if (!titles) issues.error(ctx.file, [...at, 'sections'], `View "${raw.view}" has no sections`);
          else {
            raw.sections.forEach((s, i) => {
              if (!titles.includes(s)) issues.error(ctx.file, [...at, 'sections', i], `View "${raw.view}" has no section "${s}"${hint(s, titles)}`);
            });
          }
        }
      }
      return { widget: 'view', title, view: raw.view, sections: raw.sections ? unique(raw.sections) : null, limit: raw.limit, refreshMs: raw.refresh };
    }
    case 'tabs':
      return tabsWidget(walk, raw, at, depth, tabIds);
  }
}

function tabsWidget(
  walk: Walk,
  raw: Extract<RawDashboardWidget, { widget: 'tabs' }>,
  at: IssuePath,
  depth: number,
  siblingIds: Map<string, string>,
): DashboardWidgetConfig | undefined {
  const { ctx, issues } = walk;
  if (depth >= L.tabsDepth) {
    issues.error(ctx.file, at, `Tabs can be nested at most ${L.tabsDepth} levels deep`);
    return undefined;
  }
  const tabs: DashboardTabConfig[] = [];
  const titles = new Map<string, number>();
  let ok = true;
  raw.tabs.forEach((rawTab, i) => {
    const tabAt = [...at, 'tabs', i];
    const tab = walk.parse(dashboardTabSchema, rawTab, tabAt);
    if (!tab) {
      ok = false;
      return;
    }
    const firstTitle = titles.get(tab.title);
    const duplicateTitle = firstTitle !== undefined;
    if (duplicateTitle) {
      issues.error(ctx.file, [...tabAt, 'title'], `Duplicate tab title "${tab.title}" (also used by tabs[${firstTitle}])`);
      ok = false;
    } else titles.set(tab.title, i);
    const id = tab.id ?? tabSlug(tab.title);
    if (duplicateTitle && tab.id === undefined) {
      // The derived ID duplicates as well; the title error says it all.
    } else if (id === null) {
      issues.error(ctx.file, tabAt, `Cannot derive a tab ID from the title "${tab.title}"; set "id"`);
      ok = false;
    } else {
      const owner = siblingIds.get(id);
      const self = formatIssuePath(tabAt);
      if (owner !== undefined) {
        issues.error(
          ctx.file,
          tab.id !== undefined ? [...tabAt, 'id'] : tabAt,
          `Duplicate tab ID "${id}" (also used by ${owner}); tab IDs must be unique among the tabs of one layout – set a different "id"`,
        );
        ok = false;
      } else siblingIds.set(id, self);
    }
    const layout = layoutAt(walk, tab.layout, [...tabAt, 'layout'], depth + 1);
    if (!layout || id === null) {
      ok = false;
      return;
    }
    tabs.push({ id, title: tab.title, layout });
  });
  if (!ok) return undefined;
  let initial = tabs[0]?.id ?? '';
  if (raw.default !== undefined) {
    const ids = tabs.map((t) => t.id);
    if (!ids.includes(raw.default)) {
      issues.error(ctx.file, [...at, 'default'], `Unknown tab "${raw.default}" (tab IDs: ${ids.join(', ')})`);
      return undefined;
    }
    initial = raw.default;
  }
  return { widget: 'tabs', title: raw.title ?? null, default: initial, tabs };
}

function hint(value: string, known: readonly string[]): string {
  const s = suggestField(value, known);
  return s ? ` (did you mean "${s}"?)` : '';
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}
