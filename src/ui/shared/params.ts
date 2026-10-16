/**
 * Manual start form (Spec §5.5, §16): builds the request body of
 * `POST /api/v1/workflows/:id/start` from form values and the workflow's
 * parameter schema. The server validates again; this only gives early,
 * readable feedback.
 */

/** Parameter definition as returned by `GET /api/v1/workflows`. */
export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'enum' | string;
  required: boolean;
  default: unknown;
  description?: string | null;
  values?: readonly string[];
}

/** Result of {@link buildStartBody}. */
export type StartBodyResult =
  | { ok: true; body: { item?: string; parameters?: Record<string, string | number | boolean> } }
  | { ok: false; errors: Array<{ field: string; message: string }> };

/**
 * @param triggerType workflow trigger (`source` requires an item reference)
 * @param item raw item input (URL, `#7`, `7`)
 * @param defs parameter schema
 * @param values raw form values (strings; booleans as `'true'|'false'|''`)
 */
export function buildStartBody(
  triggerType: string,
  item: string,
  defs: Readonly<Record<string, ParameterDef>>,
  values: Readonly<Record<string, string>>,
): StartBodyResult {
  const errors: Array<{ field: string; message: string }> = [];
  const body: { item?: string; parameters?: Record<string, string | number | boolean> } = {};
  const ref = item.trim();
  if (triggerType === 'source') {
    if (!ref) errors.push({ field: 'item', message: 'Source item (URL or number) is required for source workflows' });
    else body.item = ref;
  } else if (ref) {
    errors.push({ field: 'item', message: 'This workflow has no source; leave the item empty' });
  }
  const params: Record<string, string | number | boolean> = {};
  for (const [name, def] of Object.entries(defs)) {
    const raw = (values[name] ?? '').trim();
    if (raw === '') {
      if (def.required && (def.default === null || def.default === undefined)) errors.push({ field: name, message: 'Required parameter is missing' });
      continue; // server applies the default
    }
    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) errors.push({ field: name, message: 'Expected a number' });
        else params[name] = n;
        break;
      }
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') errors.push({ field: name, message: 'Expected true or false' });
        else params[name] = raw === 'true';
        break;
      case 'enum':
        if (!(def.values ?? []).includes(raw)) errors.push({ field: name, message: `Expected one of: ${(def.values ?? []).join(', ')}` });
        else params[name] = raw;
        break;
      default:
        params[name] = values[name] ?? '';
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(params).length > 0) body.parameters = params;
  return { ok: true, body };
}

/** Runtime override form → `PATCH /workflows/:id/runtime` body (`''` = keep YAML value → `null`). */
export function buildRuntimeBody(values: { enabled: string; priority: string; maxConcurrent: string }):
  | { ok: true; body: { enabled: boolean | null; priority: number | null; maxConcurrent: number | null } }
  | { ok: false; errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = [];
  let enabled: boolean | null = null;
  if (values.enabled === 'true' || values.enabled === 'false') enabled = values.enabled === 'true';
  else if (values.enabled !== '') errors.push({ field: 'enabled', message: 'Expected true, false or empty' });
  let priority: number | null = null;
  if (values.priority.trim() !== '') {
    const n = Number(values.priority);
    if (!Number.isFinite(n)) errors.push({ field: 'priority', message: 'Expected a number' });
    else priority = n;
  }
  let maxConcurrent: number | null = null;
  if (values.maxConcurrent.trim() !== '') {
    const n = Number(values.maxConcurrent);
    if (!Number.isInteger(n) || n < 1) errors.push({ field: 'maxConcurrent', message: 'Expected an integer ≥ 1' });
    else maxConcurrent = n;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: { enabled, priority, maxConcurrent } };
}
