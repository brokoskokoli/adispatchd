/**
 * Output format of an `options_from.command` script (WI-31): stdout (UTF-8)
 * is either one option per line (trimmed, empty lines ignored) or – when it
 * starts with `[` – a JSON list of strings or `{ "value": "…", "label": "…" }`.
 */
import { MAX_OPTION_VALUE_LENGTH, MAX_PARAMETER_OPTIONS, optionValueProblem } from '../config/index.js';

/** One selectable value of a parameter. `label` is display text only (defaults to the value). */
export interface ParameterOption {
  value: string;
  label: string;
}

/** Max. length of an option label. */
export const MAX_OPTION_LABEL_LENGTH = MAX_OPTION_VALUE_LENGTH;

/** Result of {@link parseOptionsOutput}. */
export type ParsedOptions = { ok: true; options: ParameterOption[] } | { ok: false; error: string };

/**
 * Parse the stdout of an options script. Duplicate values keep their first
 * occurrence. Errors: invalid JSON or entries, more than
 * {@link MAX_PARAMETER_OPTIONS} options, empty values, values/labels longer
 * than 200 characters or with control characters.
 */
export function parseOptionsOutput(stdout: string): ParsedOptions {
  const text = stdout.replace(/^﻿/, '');
  const raw: Array<{ value: unknown; label: unknown }> = [];
  if (text.trimStart().startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: 'output starts with "[" but is not valid JSON' };
    }
    if (!Array.isArray(data)) return { ok: false, error: 'JSON output must be a list' };
    for (const [i, entry] of data.entries()) {
      if (typeof entry === 'string') raw.push({ value: entry, label: undefined });
      else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as { value?: unknown; label?: unknown };
        raw.push({ value: e.value, label: e.label });
      } else return { ok: false, error: `option ${i + 1}: expected a string or { "value", "label" }` };
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (value !== '') raw.push({ value, label: undefined });
    }
  }
  if (raw.length > MAX_PARAMETER_OPTIONS) return { ok: false, error: `more than ${MAX_PARAMETER_OPTIONS} options (${raw.length})` };

  const options: ParameterOption[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (typeof entry.value !== 'string') return { ok: false, error: `option ${i + 1}: "value" must be a string` };
    const value = entry.value;
    const problem = optionValueProblem(value);
    if (problem) return { ok: false, error: `option ${i + 1}: ${problem}` };
    let label = value;
    if (entry.label !== undefined && entry.label !== null) {
      if (typeof entry.label !== 'string') return { ok: false, error: `option ${i + 1}: "label" must be a string` };
      const labelProblem = optionValueProblem(entry.label);
      if (labelProblem) return { ok: false, error: `option ${i + 1}: label: ${labelProblem}` };
      label = entry.label;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label });
  }
  return { ok: true, options };
}
