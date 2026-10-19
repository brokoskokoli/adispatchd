/**
 * Named, reusable filters (`filters/*.yaml`, WI-15).
 *
 * A named filter is referenced with `{ use: <id> }` anywhere in a filter tree
 * (or with the short form `filter: <id>`). References are expanded when the
 * configuration is loaded: the normalized workflows/views only contain the
 * expanded tree, so scheduler, planner, views, pushdown and dry-run never see
 * a reference. A reference stands for its content at exactly that position
 * (a referenced top-level `all` is flattened like a nested `all`).
 *
 * Named filters are checked structurally and for their own references
 * (unknown ID, cycle, depth) when loaded, whether used or not; errors are
 * reported in the file of the named filter. Field checks depend on the
 * context (source type, project fields, view-only fields) and therefore run at
 * every place of use on the expanded tree; {@link NamedFilters.locate} maps a
 * path in the expanded tree back to the place of use and the path inside the
 * named filter(s).
 */
import path from 'node:path';
import type { FilterNode } from '../core/index.js';
import { suggestField } from './field-catalog.js';
import { isFilterUse, type RawFilterNode } from './filter-schema.js';
import { formatIssuePath, type IssueCollector, type IssuePath } from './issues.js';
import type { NamedFilterConfig } from './model.js';

/** Maximum number of nested references (`use` → `use` → …) starting at any filter. */
export const MAX_FILTER_USE_DEPTH = 16;

/** A parsed named filter file. */
export interface NamedFilterEntry {
  id: string;
  /** File relative to the config dir (`filters/<id>.yaml`). */
  file: string;
  description: string | null;
  filter: RawFilterNode;
}

/** Location of a filter problem: path in the file of use plus the hops through named filters. */
export interface FilterLocation {
  /** Path relative to the root of the checked (raw) tree, up to the first reference. */
  path: IssuePath;
  /** `use "x" → filters/x.yaml: filter.all[1].field` (one hop per reference), or `undefined` without references. */
  via?: string;
}

interface Resolved {
  ok: boolean;
  /** Expanded tree (a placeholder if not ok). */
  filter: FilterNode;
  /** Longest reference chain inside this filter (IDs, without the filter itself). */
  chain: string[];
  /** IDs of all named filters referenced directly or indirectly. */
  refs: ReadonlySet<string>;
}

/** Placeholder for a reference that cannot be expanded (the configuration is invalid anyway). */
const PLACEHOLDER: FilterNode = { all: [] };

interface ExpandResult {
  ok: boolean;
  filter: FilterNode;
  chain: string[];
  refs: Set<string>;
}

/**
 * The named filters of one load. Construct once per load with all parsed
 * entries; then expand every workflow/view filter with {@link expandAt}.
 */
export class NamedFilters {
  private readonly byId = new Map<string, NamedFilterEntry>();
  /** Files whose schema check failed, by the ID they declare (to report "invalid" instead of "unknown"). */
  private readonly broken = new Map<string, string>();
  private readonly resolved = new Map<string, Resolved>();
  private readonly used = new Set<string>();

  /**
   * @param entries parsed named filters in file order (duplicates are reported)
   * @param broken  `id → file` of named filter files that failed the schema check
   */
  constructor(
    entries: readonly NamedFilterEntry[],
    broken: ReadonlyMap<string, string>,
    private readonly issues: IssueCollector,
  ) {
    for (const entry of entries) {
      const previous = this.byId.get(entry.id);
      if (previous) {
        issues.error(entry.file, ['id'], `Duplicate filter ID "${entry.id}" (already defined in ${previous.file})`);
        continue;
      }
      this.byId.set(entry.id, entry);
      const stem = path.basename(entry.file, path.extname(entry.file));
      if (stem !== entry.id) {
        issues.warning(entry.file, ['id'], `Filter ID "${entry.id}" differs from file name "${path.basename(entry.file)}"`);
      }
    }
    for (const [id, file] of broken) if (!this.byId.has(id)) this.broken.set(id, file);
    for (const id of this.byId.keys()) this.resolve(id, []);
  }

  /**
   * Expand `node` used in `file` at `at` (e.g. `['filter']`): reports unknown,
   * invalid and too deeply nested references at the place of use and marks the
   * referenced filters as used. Never throws; on errors the result contains a
   * placeholder at the failed reference.
   */
  expandAt(node: RawFilterNode, file: string, at: IssuePath): FilterNode {
    const result = this.expand(node, file, at, []);
    for (const id of result.refs) this.used.add(id);
    return result.filter;
  }

  /**
   * Map `expandedPath` (relative to the expanded tree of `raw`) to the place of
   * use and the path inside the referenced named filter(s).
   */
  locate(raw: RawFilterNode, expandedPath: readonly (string | number)[]): FilterLocation {
    const outer: (string | number)[] = [];
    const hops: Array<{ id: string; file: string; path: (string | number)[] }> = [];
    let current = outer;
    let node: unknown = raw;
    const follow = (): void => {
      // A reference stands for the root of the referenced filter (its `filter` key).
      for (let guard = 0; isFilterUse(node) && guard <= MAX_FILTER_USE_DEPTH; guard++) {
        const entry = this.byId.get(node.use);
        if (!entry) return;
        current = ['filter'];
        hops.push({ id: entry.id, file: entry.file, path: current });
        node = entry.filter;
      }
    };
    follow();
    for (const segment of expandedPath) {
      current.push(segment);
      node = typeof node === 'object' && node !== null ? (node as Record<string | number, unknown>)[segment] : undefined;
      follow();
    }
    if (hops.length === 0) return { path: outer };
    const via = hops.map((h) => `use "${h.id}" → ${h.file}: ${formatIssuePath(h.path)}`).join(' → ');
    return { path: outer, via };
  }

  /** Warn about named filters that no workflow or view uses (directly or through other named filters). */
  reportUnused(): void {
    for (const entry of this.byId.values()) {
      if (!this.used.has(entry.id)) {
        this.issues.warning(entry.file, ['id'], `Named filter "${entry.id}" is not used by any workflow or view`);
      }
    }
  }

  /** Valid named filters with their expanded trees (for the loaded configuration). */
  list(): Record<string, NamedFilterConfig> {
    const out: Record<string, NamedFilterConfig> = {};
    for (const entry of this.byId.values()) {
      const resolved = this.resolved.get(entry.id);
      if (!resolved?.ok) continue;
      out[entry.id] = { id: entry.id, file: entry.file, description: entry.description, filter: resolved.filter };
    }
    return out;
  }

  /** Resolve a named filter once (memoized); `stack` holds the IDs currently being resolved. */
  private resolve(id: string, stack: readonly string[]): Resolved {
    const done = this.resolved.get(id);
    if (done) return done;
    const entry = this.byId.get(id) as NamedFilterEntry;
    const result = this.expand(entry.filter, entry.file, ['filter'], [...stack, id]);
    const resolved: Resolved = { ok: result.ok, filter: result.ok ? result.filter : PLACEHOLDER, chain: result.chain, refs: result.refs };
    this.resolved.set(id, resolved);
    return resolved;
  }

  private expand(node: RawFilterNode, file: string, at: IssuePath, stack: readonly string[]): ExpandResult {
    if (isFilterUse(node)) return this.expandUse(node.use, file, at, stack);
    const combine = (children: ExpandResult[], build: (nodes: FilterNode[]) => FilterNode): ExpandResult => {
      let chain: string[] = [];
      const refs = new Set<string>();
      for (const child of children) {
        if (child.chain.length > chain.length) chain = child.chain;
        for (const ref of child.refs) refs.add(ref);
      }
      return { ok: children.every((c) => c.ok), filter: build(children.map((c) => c.filter)), chain, refs };
    };
    if ('all' in node) {
      return combine(node.all.map((c, i) => this.expand(c, file, [...at, 'all', i], stack)), (all) => ({ all }));
    }
    if ('any' in node) {
      return combine(node.any.map((c, i) => this.expand(c, file, [...at, 'any', i], stack)), (any) => ({ any }));
    }
    if ('not' in node) {
      return combine([this.expand(node.not, file, [...at, 'not'], stack)], ([not]) => ({ not: not as FilterNode }));
    }
    const value = node.value;
    return {
      ok: true,
      filter: { field: node.field, operator: node.operator, value: Array.isArray(value) ? [...value] : value },
      chain: [],
      refs: new Set(),
    };
  }

  private expandUse(id: string, file: string, at: IssuePath, stack: readonly string[]): ExpandResult {
    const fail = (message: string): ExpandResult => {
      this.issues.error(file, at, message);
      return { ok: false, filter: PLACEHOLDER, chain: [id], refs: new Set(this.byId.has(id) ? [id] : []) };
    };
    if (stack.includes(id)) {
      return fail(`Cycle in named filters: ${[...stack.slice(stack.indexOf(id)), id].join(' → ')}`);
    }
    if (!this.byId.has(id)) {
      const brokenFile = this.broken.get(id);
      if (brokenFile) return fail(`Named filter "${id}" is invalid (see ${brokenFile})`);
      const suggestion = suggestField(id, [...this.byId.keys(), ...this.broken.keys()]);
      return fail(`Unknown named filter "${id}"${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`);
    }
    const target = this.resolve(id, stack);
    const entry = this.byId.get(id) as NamedFilterEntry;
    const refs = new Set([id, ...target.refs]);
    if (!target.ok) {
      this.issues.error(file, at, `Named filter "${id}" is invalid (see ${entry.file})`);
      return { ok: false, filter: PLACEHOLDER, chain: [id, ...target.chain], refs };
    }
    const chain = [id, ...target.chain];
    if (chain.length > MAX_FILTER_USE_DEPTH) {
      this.issues.error(file, at, `Named filters are nested more than ${MAX_FILTER_USE_DEPTH} levels deep: ${chain.join(' → ')}`);
      return { ok: false, filter: PLACEHOLDER, chain, refs };
    }
    // Fresh copy per place of use: the loaded configuration is frozen and hashed per workflow.
    return { ok: true, filter: structuredClone(target.filter), chain, refs };
  }
}
