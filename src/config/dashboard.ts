/**
 * `dashboard.yaml` (WI-24): info tiles shown on the dashboard. Each tile is a
 * trusted script (like conditions) whose first output line is the value.
 * This module normalizes and validates the parsed file; the schema lives in
 * `schemas.ts`, the execution in `src/dashboard/`.
 */
import { statSync } from 'node:fs';
import type { IssueCollector, IssuePath } from './issues.js';
import type { DashboardConfig, DashboardInfoConfig } from './model.js';
import { resolveCommand } from './normalize.js';
import type { RawDashboardFile } from './schemas.js';
import { checkEnvNames, checkLiteralSecrets } from './validate.js';

/** File name of the dashboard configuration in the config dir. */
export const DASHBOARD_FILE = 'dashboard.yaml';

/** Normalize the parsed `dashboard.yaml`. */
export function normalizeDashboard(raw: RawDashboardFile, configDir: string): DashboardConfig {
  return {
    file: DASHBOARD_FILE,
    info: raw.info.map(
      (t): DashboardInfoConfig => ({
        id: t.id,
        title: t.title ?? t.id,
        type: t.type,
        command: resolveCommand(configDir, t.command),
        args: [...t.args],
        env: { ...t.env },
        timeoutMs: t.timeout,
        cacheMs: t.cache,
        unit: t.unit === undefined || t.unit === '' ? null : t.unit,
        thresholds: {
          warnAbove: t.warn_above ?? null,
          criticalAbove: t.critical_above ?? null,
          warnBelow: t.warn_below ?? null,
          criticalBelow: t.critical_below ?? null,
        },
      }),
    ),
  };
}

/**
 * Semantic checks: unique IDs, thresholds only for number/percent and in a
 * sensible order, `unit` only for number tiles, env names, and that a script
 * given as path (absolute or containing `/`) exists. Bare command names are
 * looked up in PATH at run time and not checked.
 */
export function validateDashboard(dashboard: DashboardConfig, issues: IssueCollector): void {
  const file = dashboard.file;
  const seen = new Map<string, number>();
  dashboard.info.forEach((tile, i) => {
    const at: IssuePath = ['info', i];
    const first = seen.get(tile.id);
    if (first !== undefined) issues.error(file, [...at, 'id'], `Duplicate info tile ID "${tile.id}" (also used by info[${first}])`);
    else seen.set(tile.id, i);

    const t = tile.thresholds;
    if (tile.type === 'text') {
      const keys: Array<[string, number | null]> = [
        ['warn_above', t.warnAbove],
        ['critical_above', t.criticalAbove],
        ['warn_below', t.warnBelow],
        ['critical_below', t.criticalBelow],
      ];
      for (const [key, value] of keys) {
        if (value !== null) issues.error(file, [...at, key], 'Thresholds are only supported for "number" and "percent" tiles (type is "text")');
      }
    } else {
      if (t.warnAbove !== null && t.criticalAbove !== null && t.criticalAbove < t.warnAbove) {
        issues.error(file, [...at, 'critical_above'], `"critical_above" (${t.criticalAbove}) must not be lower than "warn_above" (${t.warnAbove})`);
      }
      if (t.warnBelow !== null && t.criticalBelow !== null && t.criticalBelow > t.warnBelow) {
        issues.error(file, [...at, 'critical_below'], `"critical_below" (${t.criticalBelow}) must not be higher than "warn_below" (${t.warnBelow})`);
      }
    }
    if (tile.unit !== null && tile.type !== 'number') {
      issues.error(file, [...at, 'unit'], `"unit" is only supported for "number" tiles${tile.type === 'percent' ? ' (percent tiles always show %)' : ''}`);
    }
    checkEnvNames(Object.keys(tile.env), issues, file, [...at, 'env']);
    checkLiteralSecrets(tile.env, issues, file, [...at, 'env']);
    if (tile.command.includes('/')) {
      let problem: string | null = null;
      try {
        if (!statSync(tile.command).isFile()) problem = 'is not a regular file';
      } catch {
        problem = 'does not exist';
      }
      if (problem) issues.error(file, [...at, 'command'], `Script ${problem}: ${tile.command} (relative paths are resolved against the config dir)`);
    }
  });
}
