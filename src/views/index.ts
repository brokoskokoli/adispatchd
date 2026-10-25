/**
 * Component `views` – public API (WI-10): read-only views over one or more
 * sources with run enrichment (Spec §17). Other components import from this
 * module only.
 */
export {
  ViewService,
  UnknownViewError,
  DEFAULT_VIEW_CACHE_TTL_MS,
  MAX_VIEW_ROWS,
  VIEW_RUN_FIELDS,
  runFields,
  safeLink,
  compareOrdered,
  narrowViewItems,
  type ViewItemsOptions,
  type ViewCell,
  type ViewColumn,
  type ViewGrouping,
  type ViewItemsResult,
  type ViewRow,
  type ViewSectionResult,
  type ViewSectionSummary,
  type ViewServiceOptions,
  type ViewSummary,
} from './service.js';
