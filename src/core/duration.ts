/**
 * Parsers for human-friendly durations and sizes used in YAML config
 * (e.g. `polling_interval: 30s`, `max_log_size_per_run: 100MB`).
 */
import { ValidationError } from './errors.js';

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/**
 * Parse a duration string into milliseconds.
 *
 * Grammar: `<number><unit>` with unit `ms | s | m | h | d`, e.g. `100ms`, `30s`,
 * `45m`, `6h`, `30d`, `1.5h`. Surrounding whitespace is ignored. Compound forms
 * (`1h30m`), negative values, missing units and non-integer millisecond
 * results are rejected with {@link ValidationError}.
 */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') throw new ValidationError(`Duration must be a string, got ${typeof input}`);
  const match = DURATION_PATTERN.exec(input.trim());
  if (!match) {
    throw new ValidationError(`Invalid duration "${input}" (expected e.g. 100ms, 30s, 45m, 6h, 30d)`, { input });
  }
  const value = Number(match[1]);
  const unit = DURATION_UNITS[match[2] as string] as number;
  const ms = value * unit;
  if (!Number.isFinite(ms) || !Number.isSafeInteger(Math.round(ms)) || Math.abs(ms - Math.round(ms)) > 1e-9) {
    throw new ValidationError(`Duration "${input}" does not resolve to whole milliseconds`, { input });
  }
  return Math.round(ms);
}

/** Like {@link parseDuration}, but returns `undefined` instead of throwing. */
export function tryParseDuration(input: string): number | undefined {
  try {
    return parseDuration(input);
  } catch {
    return undefined;
  }
}

/** Format milliseconds with the largest unit that divides it exactly (e.g. `90000` → `90s`). */
export function formatDuration(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new ValidationError(`Cannot format duration ${ms}`);
  if (ms === 0) return '0s';
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const factor = DURATION_UNITS[unit] as number;
    if (ms % factor === 0) return `${ms / factor}${unit}`;
  }
  return `${ms}ms`;
}

/**
 * Size units. Decimal-looking units (`KB`, `MB`, `GB`) are interpreted as
 * binary multiples (1 KB = 1024 B), matching common log-size conventions;
 * `KiB`, `MiB`, `GiB` are accepted as explicit aliases.
 */
const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i;

/**
 * Parse a size string into bytes: `<number><unit>` with unit
 * `B | KB | MB | GB | KiB | MiB | GiB` (case-insensitive), e.g. `100MB` →
 * 104857600. Throws {@link ValidationError} on missing/unknown units.
 */
export function parseSize(input: string): number {
  if (typeof input !== 'string') throw new ValidationError(`Size must be a string, got ${typeof input}`);
  const match = SIZE_PATTERN.exec(input.trim());
  const unit = match ? SIZE_UNITS[(match[2] as string).toLowerCase()] : undefined;
  if (!match || unit === undefined) {
    throw new ValidationError(`Invalid size "${input}" (expected e.g. 512KB, 100MB, 1GB)`, { input });
  }
  const bytes = Number(match[1]) * unit;
  if (!Number.isFinite(bytes) || !Number.isSafeInteger(Math.floor(bytes))) {
    throw new ValidationError(`Size "${input}" is out of range`, { input });
  }
  return Math.floor(bytes);
}
