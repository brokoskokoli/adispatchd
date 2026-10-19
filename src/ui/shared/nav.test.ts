import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isNavActive, NAV_ENTRIES } from './nav.js';
import { RESOURCES_HASH, RESOURCES_ROUTE } from './resource-strip.js';
import { parseHash } from './route.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(here, '..', rel), 'utf8');

describe('main navigation (WI-29)', () => {
  it('has the "Resources" tab after Views and before Configuration', () => {
    const labels = NAV_ENTRIES.map((e) => e.label);
    expect(labels).toEqual(['Dashboard', 'Runs', 'Workflows', 'Blocked', 'Failed Actions', 'Views', 'Resources', 'Configuration']);
    const res = NAV_ENTRIES.find((e) => e.label === 'Resources')!;
    expect(res.href).toBe(RESOURCES_HASH);
    expect(parseHash(res.href).segments).toEqual([RESOURCES_ROUTE]);
    expect(res.key).toBe(RESOURCES_ROUTE);
  });

  it('marks the active entry', () => {
    const r = (hash: string) => parseHash(hash);
    expect(isNavActive('resources', r('#/resources'), true)).toBe(true);
    expect(isNavActive('', r('#/resources'), true)).toBe(false);
    expect(isNavActive('', r('#/'), true)).toBe(true);
    expect(isNavActive('runs', r('#/runs/abc'), true)).toBe(true);
    expect(isNavActive('views', r('#/views/v1'), true)).toBe(false); // "All Views" link
    expect(isNavActive('views', r('#/views/v1'), false)).toBe(true); // submenu summary
    expect(isNavActive('views/v1', r('#/views/v1'), true)).toBe(true);
  });

  it('the router maps #/resources to the Resources page; the dashboard no longer mounts the full section', () => {
    const app = read('client/app.ts');
    expect(app).toMatch(/case RESOURCES_ROUTE:\s*return resourcesPage\(ctx\);/);
    expect(app).toContain('NAV_ENTRIES.map(');
    const dashboard = read('client/pages/dashboard.ts');
    expect(dashboard).not.toContain('serverSection');
    expect(dashboard).toContain('createStripFeed');
    // Order on the dashboard: strip, info tiles, scheduler/capacity/attention grid.
    const iStrip = dashboard.indexOf('el.appendChild(strip)');
    const iInfo = dashboard.indexOf('el.appendChild(info.el)');
    const iBody = dashboard.indexOf('el.appendChild(body)');
    expect(iStrip).toBeGreaterThan(0);
    expect(iStrip).toBeLessThan(iInfo);
    expect(iInfo).toBeLessThan(iBody);
    // Leaving the dashboard ends the strip's live subscription.
    expect(dashboard).toMatch(/dispose: \(\) => \{\s*feed\.dispose\(\);/);
    const server = read('client/pages/server.ts');
    expect(server).toMatch(/export const resourcesPage/);
    expect(server).toMatch(/dispose: \(\) => server\.dispose\(\)/);
  });
});
