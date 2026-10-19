/**
 * Display helpers for conditions (WI-24, workflow pages) and dashboard info
 * tiles. Pure functions, shared by the browser code and the unit tests.
 */
import type { Tone } from './format.js';

/** Label and tone of the last status of a workflow condition (`null` = never checked). */
export function conditionStatusInfo(status: string | null | undefined): { label: string; tone: Tone } {
  switch (status) {
    case 'ok':
      return { label: 'ok', tone: 'ok' };
    case 'not_now':
      return { label: 'not now', tone: 'error' };
    case 'error':
      return { label: 'check error', tone: 'warn' };
    case 'skipped':
      return { label: 'not evaluated', tone: 'muted' };
    default:
      return { label: 'never checked', tone: 'muted' };
  }
}

/** Name of a check in a dry-run/diagnosis line: the configured name, else the command. */
export function checkTitle(c: { name?: string | null; command: string }): string {
  return c.name ? c.name : c.command;
}

/** Counts of an item-bound check over the items of a planning step. */
export interface CheckCountsLike {
  items: number;
  ok: number;
  notNow: number;
  error: number;
  notEvaluated?: number;
}

/** "3 item(s): 1 ok · 1 not now · 1 error" (zero counts omitted). */
export function checkCountsText(c: CheckCountsLike): string {
  if (c.items === 0) return 'no items checked';
  const parts: string[] = [];
  if (c.ok) parts.push(`${c.ok} ok`);
  if (c.notNow) parts.push(`${c.notNow} not now`);
  if (c.error) parts.push(`${c.error} error`);
  if (c.notEvaluated) parts.push(`${c.notEvaluated} not evaluated`);
  return `${c.items} item(s): ${parts.join(' · ') || '—'}`;
}

/** Worst tone of item-check counts (error → red, check error → yellow, else green). */
export function checkCountsTone(c: CheckCountsLike): Tone {
  if (c.items === 0) return 'muted';
  if (c.notNow > 0) return 'error';
  if (c.error > 0) return 'warn';
  return c.ok > 0 ? 'ok' : 'muted';
}

/** Tone of an info tile status. */
export function infoStatusTone(status: string): Tone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'critical':
    case 'error':
      return 'error';
    default:
      return 'muted';
  }
}

/** Human label of an info tile status. */
export function infoStatusLabel(status: string, stale = false): string {
  if (status === 'error') return stale ? 'error (stale value)' : 'error';
  if (status === 'pending') return 'pending';
  return status;
}

/** Displayed value of an info tile (number with up to 2 decimals; unit appended). */
export function formatInfoValue(value: string | number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    const text = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
    if (!unit) return text;
    return unit === '%' ? `${text}%` : `${text} ${unit}`;
  }
  return value;
}
