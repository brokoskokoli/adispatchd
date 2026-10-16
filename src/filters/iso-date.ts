/**
 * Strict ISO-8601 parsing for filter comparisons and candidate ordering.
 * Unlike `Date.parse`, this is independent of the host time zone and rejects
 * non-ISO formats. Values without an offset are interpreted as UTC.
 */

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Parse `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]` to epoch ms.
 * Returns `undefined` for anything else or for out-of-range components.
 */
export function parseIsoDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = ISO_RE.exec(value);
  if (!m) return undefined;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', offset = 'Z'] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  // Reject day overflow (e.g. 2026-02-30).
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return undefined;
  }
  if (offset === 'Z') return utc;
  const sign = offset.startsWith('-') ? -1 : 1;
  const oh = Number(offset.slice(1, 3));
  const om = Number(offset.slice(4, 6));
  if (oh > 23 || om > 59) return undefined;
  return utc - sign * (oh * 60 + om) * 60_000;
}
