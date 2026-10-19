/**
 * Main navigation of the UI (WI-11, WI-29), DOM-free so it is unit-testable:
 * the fixed menu entries in their order and the rule which entry is active
 * for a route. Views (submenu), "UI Actions" (admins) and external tools are
 * added by the app at runtime.
 */
import type { Route } from './route.js';
import { RESOURCES_ROUTE } from './resource-strip.js';

/** A fixed menu entry; `key` = `data-nav` (first route segment, `''` = dashboard). */
export interface NavEntry {
  key: string;
  href: string;
  label: string;
  /** Counter badge slot (blocks / failed actions). */
  counter?: 'blocks' | 'actions';
  /** Rendered as the "Views" submenu instead of a link. */
  submenu?: true;
}

/** Fixed entries in menu order. "UI Actions" is inserted before "Configuration" for admins. */
export const NAV_ENTRIES: readonly NavEntry[] = [
  { key: '', href: '#/', label: 'Dashboard' },
  { key: 'runs', href: '#/runs', label: 'Runs' },
  { key: 'workflows', href: '#/workflows', label: 'Workflows' },
  { key: 'blocked', href: '#/blocked', label: 'Blocked', counter: 'blocks' },
  { key: 'actions', href: '#/actions', label: 'Failed Actions', counter: 'actions' },
  { key: 'views', href: '#/views', label: 'Views', submenu: true },
  { key: RESOURCES_ROUTE, href: `#/${RESOURCES_ROUTE}`, label: 'Resources' },
  { key: 'config', href: '#/config', label: 'Configuration' },
];

/**
 * Whether the menu element with `data-nav` = `key` is active for `route`:
 * exact match of the first two segments, or of the first segment – except
 * that the "All Views" link is not active on a single view page.
 */
export function isNavActive(key: string, route: Route, isLink: boolean): boolean {
  const top = route.segments[0] ?? '';
  const full = route.segments.slice(0, 2).join('/');
  return key === full || (key === top && !(top === 'views' && route.segments.length > 1 && isLink));
}
