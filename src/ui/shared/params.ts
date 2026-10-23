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
  /** WI-31: options fetched at run time (`null`/absent = static `values`). */
  optionsFrom?: { type: 'github' | 'command' | string; github?: string; source?: string; command?: string } | null;
  /** WI-31: values outside the list are accepted. */
  allowCustom?: boolean;
}

/** One option of `GET /api/v1/workflows/:id/parameters/:name/options` (WI-31). */
export interface ParameterOptionView {
  value: string;
  label: string;
}

/** Response of the options endpoint (WI-31). */
export interface ParameterOptionsView {
  options: ParameterOptionView[];
  fetchedAt: string | null;
  cached: boolean;
  allowCustom: boolean;
  error?: { code: string; message: string };
}

/** From this many options on, the start form offers a search field (WI-31). */
export const OPTION_SEARCH_THRESHOLD = 15;

/** Options whose value or label contains `query` (case-insensitive); `keep` stays in the list (current selection). */
export function filterOptions(options: readonly ParameterOptionView[], query: string, keep = ''): ParameterOptionView[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...options];
  return options.filter((o) => o.value === keep || o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
}

/** Short description of where the options come from (start form). */
export function optionsSourceText(def: ParameterDef): string {
  const o = def.optionsFrom;
  if (!o) return '';
  if (o.type === 'github') return `${o.github ?? 'refs'} of ${o.source ?? 'the source'}`;
  return `script ${o.command ?? ''}`.trim();
}

/** Hint when the default is missing from the current options (`null` = fine). */
export function defaultOptionHint(def: ParameterDef, options: readonly ParameterOptionView[]): string | null {
  if (def.default === null || def.default === undefined || def.default === '') return null;
  const value = String(def.default);
  if (options.some((o) => o.value === value)) return null;
  return def.allowCustom ? null : `Default "${value}" is not in the current list – the start will be rejected unless you choose another value.`;
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
        // Dynamic options / custom values (WI-31): the server checks against the current list.
        if (def.optionsFrom || def.allowCustom) params[name] = raw;
        else if (!(def.values ?? []).includes(raw)) errors.push({ field: name, message: `Expected one of: ${(def.values ?? []).join(', ')}` });
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
