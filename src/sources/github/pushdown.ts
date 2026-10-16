/**
 * Conservative filter pushdown into `GET /repos/{o}/{r}/issues` query
 * parameters. Only top-level conjunctions are considered; everything else is
 * evaluated locally by the caller (the result may be a superset).
 */
import { isFilterAll, isFilterPredicate, type FilterNode, type FilterPredicate } from '../../core/index.js';

/** Query parameters derived from a filter. */
export interface IssueListQuery {
  state: 'open' | 'closed' | 'all';
  /** Labels that must all be present (GitHub `labels=a,b` is a conjunction). */
  labels: string[];
}

/** Derive list query parameters from `filter`; default `state=open`. */
export function pushdownQuery(filter: FilterNode | undefined): IssueListQuery {
  const query: IssueListQuery = { state: 'open', labels: [] };
  if (!filter) return query;
  const conjuncts: FilterPredicate[] = isFilterPredicate(filter)
    ? [filter]
    : isFilterAll(filter)
      ? filter.all.filter(isFilterPredicate)
      : [];
  for (const p of conjuncts) {
    if (p.field === 'labels' && p.operator === 'contains' && typeof p.value === 'string') {
      // Commas cannot be expressed in the comma-separated `labels` parameter.
      if (p.value !== '' && !p.value.includes(',') && !query.labels.includes(p.value)) query.labels.push(p.value);
    } else if (p.field === 'state') {
      const states = stateSet(p);
      if (states) query.state = states;
    }
  }
  return query;
}

function stateSet(p: FilterPredicate): IssueListQuery['state'] | undefined {
  if (p.operator === 'equals' && (p.value === 'open' || p.value === 'closed')) return p.value;
  if (p.operator === 'in' && Array.isArray(p.value)) {
    const values = new Set(p.value);
    const open = values.has('open');
    const closed = values.has('closed');
    if (open && closed) return 'all';
    if (open) return 'open';
    if (closed) return 'closed';
  }
  return undefined;
}
