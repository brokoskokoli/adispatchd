/**
 * Output parsing and thresholds of dashboard info tiles (WI-24).
 *
 * The value is the first non-empty stdout line, trimmed:
 * - `text`: any text, cut to {@link MAX_INFO_TEXT_LENGTH} characters;
 * - `number`: a decimal number with `.` as separator (e.g. `42`, `-1.5`),
 *   optionally followed by the configured unit (`42 GB`);
 * - `percent`: a number from 0 to 100, optionally followed by `%`.
 */
import { sanitizeDisplayText, shortenText, type Redactor } from '../core/index.js';
import type { DashboardInfoThresholds, DashboardInfoType } from '../config/index.js';

/** Max. length of a `text` value. */
export const MAX_INFO_TEXT_LENGTH = 200;

/** Status of a tile value. */
export type InfoValueStatus = 'ok' | 'warn' | 'critical';

/** Result of {@link parseInfoOutput}. */
export type ParsedInfo = { ok: true; value: string | number } | { ok: false; error: string };

const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * First non-empty line of `text` with ANSI escapes, control and bidi
 * characters removed (`null` if there is none). Not shortened: callers redact
 * first, then shorten.
 */
export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const t = sanitizeDisplayText(line);
    if (t !== '') return t;
  }
  return null;
}

/**
 * Parse the stdout of an info script. Never throws. Text values and quoted
 * output in errors are sanitized and redacted (`redact`) before they are shortened.
 */
export function parseInfoOutput(type: DashboardInfoType, stdout: string, unit: string | null = null, redact: Redactor = (s) => s): ParsedInfo {
  const line = firstNonEmptyLine(stdout);
  if (line === null) return { ok: false, error: 'no output (expected the value on the first non-empty stdout line)' };
  if (type === 'text') return { ok: true, value: shortenText(redact(line), MAX_INFO_TEXT_LENGTH) };
  const quoted = (): string => shortenText(redact(line), 40);
  let raw = line;
  if (type === 'percent' && raw.endsWith('%')) raw = raw.slice(0, -1).trimEnd();
  if (type === 'number' && unit !== null && raw.endsWith(unit)) raw = raw.slice(0, -unit.length).trimEnd();
  if (!NUMBER.test(raw)) {
    const what = type === 'percent' ? 'a number from 0 to 100 (optionally with %)' : `a number such as 42 or 1.5${unit !== null ? ` (optionally followed by "${unit}")` : ''}`;
    return { ok: false, error: `unparsable output "${quoted()}": expected ${what}` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, error: `unparsable output "${quoted()}": not a finite number` };
  if (type === 'percent' && (value < 0 || value > 100)) return { ok: false, error: `percent value ${value} is outside 0–100` };
  return { ok: true, value };
}

/** Status of a value by its thresholds (critical before warn; `above` = value ≥ threshold, `below` = value ≤ threshold). */
export function infoValueStatus(value: string | number, thresholds: DashboardInfoThresholds): InfoValueStatus {
  if (typeof value !== 'number') return 'ok';
  const t = thresholds;
  if ((t.criticalAbove !== null && value >= t.criticalAbove) || (t.criticalBelow !== null && value <= t.criticalBelow)) return 'critical';
  if ((t.warnAbove !== null && value >= t.warnAbove) || (t.warnBelow !== null && value <= t.warnBelow)) return 'warn';
  return 'ok';
}
