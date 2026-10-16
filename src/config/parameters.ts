/**
 * Validation of manual-start parameters against a workflow's declared
 * parameter schema (Spec §5.5): checked before the start, defaults applied,
 * unknown parameters rejected.
 */
import type { ParameterDefinition, ParameterValue, WorkflowConfig } from './model.js';

/** One problem with a supplied parameter. */
export interface ParameterIssue {
  parameter: string;
  message: string;
}

/** Result of {@link validateParameters}. */
export type ParameterValidationResult =
  | { ok: true; values: Record<string, ParameterValue> }
  | { ok: false; errors: ParameterIssue[] };

/**
 * Validate `input` against `definitions`.
 *
 * Accepted input: values of the declared type; additionally numeric strings
 * for `number` and `"true"`/`"false"` for `boolean` (HTML form input).
 * Missing optional parameters get their default (or are omitted); missing
 * required parameters without default are errors.
 */
export function validateParameters(
  definitions: Readonly<Record<string, ParameterDefinition>>,
  input: Readonly<Record<string, unknown>> | undefined,
): ParameterValidationResult {
  const errors: ParameterIssue[] = [];
  const values: Record<string, ParameterValue> = {};
  const supplied = input ?? {};

  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(definitions, name)) errors.push({ parameter: name, message: 'Unknown parameter' });
  }
  for (const [name, def] of Object.entries(definitions)) {
    const raw = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    if (raw === undefined || raw === null || raw === '') {
      if (def.default !== null) values[name] = def.default;
      else if (def.required) errors.push({ parameter: name, message: 'Required parameter is missing' });
      continue;
    }
    const coerced = coerce(def, raw);
    if (coerced.ok) values[name] = coerced.value;
    else errors.push({ parameter: name, message: coerced.message });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** Shorthand for {@link validateParameters} with a workflow. */
export function validateWorkflowParameters(
  workflow: Pick<WorkflowConfig, 'parameters'>,
  input: Readonly<Record<string, unknown>> | undefined,
): ParameterValidationResult {
  return validateParameters(workflow.parameters, input);
}

function coerce(
  def: ParameterDefinition,
  raw: unknown,
): { ok: true; value: ParameterValue } | { ok: false; message: string } {
  switch (def.type) {
    case 'string':
      return typeof raw === 'string' ? { ok: true, value: raw } : { ok: false, message: 'Expected a string' };
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: 'Expected a number' };
    }
    case 'boolean':
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, message: 'Expected a boolean' };
    case 'enum':
      return typeof raw === 'string' && def.values.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, message: `Expected one of: ${def.values.join(', ')}` };
  }
}
