/**
 * {@link FieldSource} for a {@link SourceItem}, implementing the batch contract
 * of `SourceAdapter.resolveFields` (see docs/handoff/WI-01.md):
 *
 * - cheap fields come from `item.fields`;
 * - on the first expensive field that is actually needed, ALL wanted expensive
 *   fields of the item are requested in one `resolveFields` call;
 * - results live only as long as this field source (one planning step / view
 *   request) and are never written back into `item.fields`;
 * - unknown fields, missing batch entries and resolver errors are `known: false`.
 */
import {
  errorMessage,
  type FieldDefinition,
  type FieldResolution,
  type FieldType,
  type FieldValue,
  type SourceItem,
} from '../core/index.js';
import type { FieldSource } from './evaluate.js';

/** Batch resolver with the signature of `SourceAdapter.resolveFields`. */
export type ResolveFieldsFn = (
  item: SourceItem,
  fields: readonly string[],
) => Promise<Record<string, FieldResolution>>;

/** Options for {@link createItemFieldSource}. */
export interface ItemFieldSourceOptions {
  /** Field definitions of the item's adapter (`adapter.fieldDefinitions()`). */
  definitions: readonly FieldDefinition[];
  /** Usually `(item, fields) => adapter.resolveFields(item, fields)`. Without it expensive fields are unknown. */
  resolveFields?: ResolveFieldsFn;
  /**
   * Fields the caller will possibly need (e.g. `collectFields(filter)` plus
   * item-priority rule fields). All expensive ones among them are fetched in
   * the first batch. Expensive fields not listed here are fetched on demand.
   */
  wantedFields?: readonly string[];
  /**
   * Additional values not provided by the adapter, e.g. `run.last_workflow`
   * from the database for views. Take precedence over `item.fields`.
   */
  extraFields?: Record<string, FieldValue | FieldResolution>;
}

function isResolution(v: unknown): v is FieldResolution {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && 'known' in v;
}

/** Create a memoizing {@link FieldSource} for one item. */
export function createItemFieldSource(item: SourceItem, options: ItemFieldSourceOptions): FieldSource {
  const defs = new Map(options.definitions.map((d) => [d.name, d]));
  const extra = options.extraFields ?? {};
  const fetched = new Map<string, Promise<FieldResolution>>();

  const isExpensive = (field: string): boolean =>
    !Object.hasOwn(extra, field) && defs.get(field)?.expensive === true;

  const fetchBatch = (field: string): void => {
    const batch = new Set<string>([field]);
    for (const f of options.wantedFields ?? []) if (isExpensive(f) && !fetched.has(f)) batch.add(f);
    const names = [...batch];
    const resolveFields = options.resolveFields;
    const request: Promise<Record<string, FieldResolution>> = resolveFields
      ? Promise.resolve()
          .then(() => resolveFields(item, names))
          .catch((err: unknown) => {
            const reason = `field resolution failed: ${errorMessage(err)}`;
            return Object.fromEntries(names.map((n) => [n, { known: false, reason } as FieldResolution]));
          })
      : Promise.resolve({});
    for (const name of names) {
      fetched.set(
        name,
        request.then((res) => {
          const r = Object.hasOwn(res, name) ? res[name] : undefined;
          if (r && isResolution(r)) return r;
          return {
            known: false,
            reason: resolveFields ? `adapter returned no value for '${name}'` : `no resolver for expensive field '${name}'`,
          };
        }),
      );
    }
  };

  return {
    isExpensive,
    fieldType(field: string): FieldType | undefined {
      return defs.get(field)?.type;
    },
    isCaseInsensitive(field: string): boolean {
      return !Object.hasOwn(extra, field) && defs.get(field)?.caseInsensitive === true;
    },
    resolve(field: string): Promise<FieldResolution> | FieldResolution {
      if (Object.hasOwn(extra, field)) {
        const v = extra[field] as FieldValue | FieldResolution;
        return isResolution(v) ? v : { known: true, value: v };
      }
      const def = defs.get(field);
      if (def?.expensive) {
        if (!fetched.has(field)) fetchBatch(field);
        return fetched.get(field) as Promise<FieldResolution>;
      }
      if (Object.hasOwn(item.fields, field)) {
        return { known: true, value: item.fields[field] as FieldValue };
      }
      return { known: false, reason: def ? `field '${field}' not provided by source` : `unknown field '${field}'` };
    },
  };
}
