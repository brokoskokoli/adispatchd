/**
 * Identifier helpers: run IDs (Spec §9), global source item keys (Spec §17),
 * config IDs and idempotency markers for comments (Spec §10).
 */
import { randomBytes } from 'node:crypto';
import { systemClock, type Clock } from './clock.js';
import { ValidationError } from './errors.js';

/**
 * Allowed pattern for IDs declared in YAML (workflow, source, identity, view
 * IDs): starts with a letter or digit, then letters, digits, `_`, `-`; max 64
 * characters. Such IDs are safe as path segments and as key prefixes.
 */
export const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** True if `id` matches {@link CONFIG_ID_PATTERN}. */
export function isValidConfigId(id: string): boolean {
  return CONFIG_ID_PATTERN.test(id);
}

/**
 * Format a timestamp as compact, lexicographically sortable, path-safe UTC
 * string: `YYYYMMDDTHHMMSSZ` (or with milliseconds `YYYYMMDDTHHMMSSmmmZ`).
 * Used for `{timestamp}` and in run IDs.
 */
export function formatCompactTimestamp(date: Date, withMillis = false): string {
  const iso = date.toISOString(); // 2026-10-16T19:00:00.123Z
  const base = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return withMillis ? `${base}${iso.slice(20, 23)}Z` : `${base}Z`;
}

/** Pattern of run IDs produced by {@link createRunId}. */
export const RUN_ID_PATTERN = /^run-\d{8}T\d{9}Z-[0-9a-f]{8}$/;

/** Options for {@link createRunId}. */
export interface RunIdOptions {
  clock?: Clock;
  /** Source of random bytes (injectable for deterministic tests). */
  randomBytes?: (size: number) => Uint8Array;
}

/**
 * Create a new run ID: `run-<YYYYMMDDTHHMMSSmmmZ>-<8 hex>`, e.g.
 * `run-20261016T190000123Z-3fa2c91b`. IDs are unique (32 random bits per
 * millisecond), sort chronologically as strings, and are safe as path segments
 * and in URLs.
 */
export function createRunId(options: RunIdOptions = {}): string {
  const clock = options.clock ?? systemClock;
  const rnd = (options.randomBytes ?? randomBytes)(4);
  const hex = Buffer.from(rnd).toString('hex').padStart(8, '0').slice(0, 8);
  return `run-${formatCompactTimestamp(clock.now(), true)}-${hex}`;
}

/** True if `id` has the run ID format (see {@link createRunId}). */
export function isValidRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

/** Separator between source ID and item ID in a {@link sourceItemKey}. */
export const SOURCE_ITEM_KEY_SEPARATOR = ':';

/**
 * Globally unique key of an external item across all sources (Spec §12, §17):
 * `<sourceId>:<itemId>`, e.g. `project_a:123`. `sourceId` must be a valid
 * config ID (therefore contains no `:`); `itemId` is adapter-defined, stable,
 * non-empty and must not contain NUL or newlines.
 *
 * This key is used for locks, blocks, run history and view enrichment.
 */
export function sourceItemKey(sourceId: string, itemId: string): string {
  if (!isValidConfigId(sourceId)) throw new ValidationError(`Invalid source id "${sourceId}"`, { sourceId });
  if (itemId === '' || /[\0\r\n]/.test(itemId)) throw new ValidationError(`Invalid item id "${itemId}"`, { itemId });
  return `${sourceId}${SOURCE_ITEM_KEY_SEPARATOR}${itemId}`;
}

/** Inverse of {@link sourceItemKey}. Throws {@link ValidationError} for malformed keys. */
export function parseSourceItemKey(key: string): { sourceId: string; itemId: string } {
  const idx = key.indexOf(SOURCE_ITEM_KEY_SEPARATOR);
  if (idx <= 0 || idx === key.length - 1) throw new ValidationError(`Invalid source item key "${key}"`, { key });
  const sourceId = key.slice(0, idx);
  const itemId = key.slice(idx + 1);
  sourceItemKey(sourceId, itemId); // validates both parts
  return { sourceId, itemId };
}

/** Prefix of comment idempotency markers. */
export const COMMENT_MARKER_PREFIX = 'orch';

/**
 * Stable, unobtrusive idempotency marker for a lifecycle action, e.g.
 * `orch:run-20261016T190000123Z-3fa2c91b:a12`. The source adapter decides how
 * to embed it (GitHub: HTML comment) and finds it again via
 * `SourceAdapter.findCommentByMarker` (Spec §10).
 */
export function commentMarker(runId: string, actionId: string | number): string {
  const action = String(actionId);
  if (!/^[A-Za-z0-9_.-]+$/.test(runId) || !/^[A-Za-z0-9_.-]+$/.test(action)) {
    throw new ValidationError('Marker parts must match [A-Za-z0-9_.-]+', { runId, actionId: action });
  }
  return `${COMMENT_MARKER_PREFIX}:${runId}:${action}`;
}
