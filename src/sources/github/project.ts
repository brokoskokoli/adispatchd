/**
 * GitHub Projects (v2) field values for the GitHub source adapter (WI-14).
 *
 * Two read-only GraphQL queries, both cheap and part of the listing:
 * 1. Metadata (once per listing, cached up to {@link PROJECT_METADATA_TTL_MS}
 *    for single-item reads): project ID and the `name`/`dataType` of its
 *    fields. Declared fields are matched case-insensitively and must have the
 *    expected data type.
 * 2. Values via `nodes(ids: …)` with the REST `node_id`s, in chunks of at most
 *    {@link PROJECT_NODES_CHUNK} items: `projectItems` of each issue/PR and
 *    `fieldValueByName` per declared field.
 *
 * Field names are passed ONLY as GraphQL variables (`$f0`, `$f1`, …) – never
 * interpolated into the query text – and aliases are generated (`f0`, `f1`, …).
 *
 * Fail closed: every lookup problem makes the affected `project.*` fields
 * unknown (with a reason) instead of empty; the listing itself never fails
 * because of the project (only an aborted signal propagates).
 */
import { SourceError, type Clock, type FieldValue, type IdentityRef, type Logger } from '../../core/index.js';
import { PROJECT_FIELD_DATA_TYPES, PROJECT_FIELD_PREFIX, type ProjectFieldKind } from './fields.js';
import type { GitHubHttpClient, GraphQLErrorJson, GraphQLResponse } from './http.js';

/** Metadata may be reused this long by single-item reads (`getItem`). */
export const PROJECT_METADATA_TTL_MS = 5 * 60_000;
/** Max node IDs per values query. */
export const PROJECT_NODES_CHUNK = 50;
/** Project items read per issue/PR; with more memberships an absent match is unknown. */
export const PROJECT_ITEMS_PER_NODE = 20;

/** Resolved project configuration of one source. */
export interface GitHubProjectSettings {
  /** User or organisation login owning the project. */
  owner: string;
  /** Project number (from `…/projects/<number>`). */
  number: number;
  /** Identity used for the GraphQL reads. */
  identity: IdentityRef;
  /** Declared field name (as written in `sources.yaml`) → kind. */
  fields: Readonly<Record<string, ProjectFieldKind>>;
}

/** Item whose `fields` / `unknownFields` receive the project values (a `SourceItem`). */
export interface ProjectTarget {
  fields: Record<string, FieldValue>;
  unknownFields?: Record<string, string>;
}

/** Item to annotate; the REST `node_id` is the GraphQL ID of the issue/PR. */
export interface ProjectLookupItem {
  nodeId: string | undefined;
  item: ProjectTarget;
}

/** Runs `fn` with a token of `identity` (adapter: invalidate + one retry on 401). */
export type WithToken = <T>(identity: IdentityRef, signal: AbortSignal | undefined, fn: (token: string) => Promise<T>) => Promise<T>;

interface ResolvedField {
  name: string;
  kind: ProjectFieldKind;
  /** Exact field name in the project (used as `fieldValueByName` argument). */
  githubName: string;
}

interface ProjectMetadata {
  projectId: string;
  /** Usable declared fields. */
  fields: ResolvedField[];
  /** Declared fields that are unknown for every item, with reason. */
  unavailable: Record<string, string>;
}

interface MetadataJson {
  repositoryOwner?: {
    __typename?: string;
    projectV2?: {
      id?: unknown;
      title?: unknown;
      fields?: { nodes?: Array<{ name?: unknown; dataType?: unknown } | null> | null } | null;
    } | null;
  } | null;
}

interface ProjectItemJson {
  project?: { id?: unknown } | null;
  [alias: string]: unknown;
}

interface NodeJson {
  __typename?: string;
  projectItems?: { totalCount?: unknown; nodes?: Array<ProjectItemJson | null> | null } | null;
}

const METADATA_QUERY = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    __typename
    ... on User { projectV2(number: $number) { ...ProjectMeta } }
    ... on Organization { projectV2(number: $number) { ...ProjectMeta } }
  }
}
fragment ProjectMeta on ProjectV2 {
  id
  title
  fields(first: 100) { nodes { ... on ProjectV2FieldCommon { name dataType } } }
}`;

/**
 * Values query for `count` fields. Only generated identifiers (`$f<i>`,
 * `f<i>`) appear in the text; the field names travel in the variables.
 */
export function projectValuesQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `, $f${i}: String!`).join('');
  const values = Array.from({ length: count }, (_, i) => `f${i}: fieldValueByName(name: $f${i}) { ...FieldValue }`).join(' ');
  const items = `projectItems(first: ${PROJECT_ITEMS_PER_NODE}, includeArchived: false) { totalCount nodes { project { id } ${values} } }`;
  return `query($ids: [ID!]!${vars}) {
  nodes(ids: $ids) {
    __typename
    ... on Issue { ${items} }
    ... on PullRequest { ${items} }
  }
}
fragment FieldValue on ProjectV2ItemFieldValue {
  __typename
  ... on ProjectV2ItemFieldSingleSelectValue { name }
  ... on ProjectV2ItemFieldTextValue { text }
  ... on ProjectV2ItemFieldNumberValue { number }
  ... on ProjectV2ItemFieldDateValue { date }
  ... on ProjectV2ItemFieldIterationValue { title }
}`;
}

/** Reads `project.*` values for the items of one source. */
export class GitHubProjectReader {
  private cached: { at: number; metadata: ProjectMetadata } | undefined;
  /** Last logged reason per declared field ('' = project level), to warn only on changes. */
  private readonly lastReasons = new Map<string, string | undefined>();
  private readonly label: string;

  constructor(
    private readonly settings: GitHubProjectSettings,
    private readonly deps: { http: GitHubHttpClient; clock: Clock; logger: Logger; withToken: WithToken },
  ) {
    this.label = `${settings.owner}/${settings.number}`;
  }

  /** Full names (`project.<name>`) of all declared fields. */
  fieldNames(): string[] {
    return Object.keys(this.settings.fields).map((n) => `${PROJECT_FIELD_PREFIX}${n}`);
  }

  /**
   * Add `project.*` values (or unknown reasons) to `items` in place.
   * `freshMetadata: false` allows a cached metadata lookup (single-item reads).
   * Never throws except when `signal` is aborted.
   */
  async annotate(items: readonly ProjectLookupItem[], options: { signal?: AbortSignal; freshMetadata: boolean }): Promise<void> {
    if (items.length === 0) return;
    const { signal } = options;
    let metadata: ProjectMetadata;
    try {
      metadata = await this.metadata(options.freshMetadata, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = `GitHub project ${this.label} unavailable: ${describeError(err)}`;
      this.note('', reason);
      for (const { item } of items) this.markAll(item, reason);
      return;
    }
    this.note('', undefined);

    for (const { item } of items) {
      for (const [name, reason] of Object.entries(metadata.unavailable)) setUnknown(item, name, reason);
    }
    if (metadata.fields.length === 0) return;

    const pending = items.filter((entry) => {
      if (entry.nodeId) return true;
      for (const f of metadata.fields) setUnknown(entry.item, f.name, 'item has no GraphQL node ID');
      return false;
    });
    let failure: string | undefined;
    for (let start = 0; start < pending.length; start += PROJECT_NODES_CHUNK) {
      const chunk = pending.slice(start, start + PROJECT_NODES_CHUNK);
      if (failure === undefined) {
        try {
          await this.readChunk(chunk, metadata, signal);
          continue;
        } catch (err) {
          if (signal?.aborted) throw err;
          failure = `reading GitHub project ${this.label} failed: ${describeError(err)}`;
          this.deps.logger.warn('Could not read project field values', { project: this.label, reason: failure });
        }
      }
      // After a failed chunk (e.g. rate limit) the remaining chunks are not attempted.
      for (const { item } of chunk) for (const f of metadata.fields) setUnknown(item, f.name, failure);
    }
  }

  private async metadata(fresh: boolean, signal: AbortSignal | undefined): Promise<ProjectMetadata> {
    const now = this.deps.clock.now().getTime();
    if (!fresh && this.cached && now - this.cached.at < PROJECT_METADATA_TTL_MS) return this.cached.metadata;
    const res = await this.deps.withToken(this.settings.identity, signal, (token) =>
      this.deps.http.graphql<MetadataJson>(
        METADATA_QUERY,
        { owner: this.settings.owner, number: this.settings.number },
        { token, ...(signal ? { signal } : {}) },
      ),
    );
    const metadata = this.parseMetadata(res);
    this.cached = { at: now, metadata };
    return metadata;
  }

  private parseMetadata(res: GraphQLResponse<MetadataJson>): ProjectMetadata {
    const owner = res.data?.repositoryOwner;
    const project = owner?.projectV2;
    if (!project || typeof project.id !== 'string') {
      const detail =
        res.errors.length > 0
          ? errorsText(res.errors)
          : owner
            ? 'project not found or not accessible to the identity'
            : 'project owner not found or not accessible';
      throw new SourceError('not_found', detail, { retryable: false });
    }
    const available = (project.fields?.nodes ?? [])
      .filter((n): n is { name: string; dataType: unknown } => n !== null && typeof n.name === 'string')
      .map((n) => ({ name: n.name, dataType: typeof n.dataType === 'string' ? n.dataType : '' }));
    const fields: ResolvedField[] = [];
    const unavailable: Record<string, string> = {};
    for (const [name, kind] of Object.entries(this.settings.fields)) {
      const full = `${PROJECT_FIELD_PREFIX}${name}`;
      const match =
        available.find((f) => f.name === name) ?? available.find((f) => f.name.toLowerCase() === name.toLowerCase());
      let reason: string | undefined;
      if (!match) {
        reason = `project field "${name}" not found in GitHub project ${this.label}`;
      } else if (match.dataType !== PROJECT_FIELD_DATA_TYPES[kind]) {
        reason =
          `project field "${match.name}" in GitHub project ${this.label} has type ${match.dataType || 'unknown'}, ` +
          `but is declared as ${kind} (expects ${PROJECT_FIELD_DATA_TYPES[kind]})`;
      } else {
        fields.push({ name: full, kind, githubName: match.name });
      }
      if (reason) unavailable[full] = reason;
      this.note(full, reason);
    }
    return { projectId: project.id, fields, unavailable };
  }

  private async readChunk(chunk: readonly ProjectLookupItem[], metadata: ProjectMetadata, signal: AbortSignal | undefined): Promise<void> {
    const variables: Record<string, unknown> = { ids: chunk.map((i) => i.nodeId) };
    metadata.fields.forEach((f, i) => {
      variables[`f${i}`] = f.githubName;
    });
    const res = await this.deps.withToken(this.settings.identity, signal, (token) =>
      this.deps.http.graphql<{ nodes?: Array<NodeJson | null> | null }>(projectValuesQuery(metadata.fields.length), variables, {
        token,
        ...(signal ? { signal } : {}),
      }),
    );
    const nodes = res.data?.nodes;
    if (!Array.isArray(nodes)) {
      throw new SourceError('invalid', res.errors.length > 0 ? errorsText(res.errors) : 'response without nodes', { retryable: false });
    }
    chunk.forEach(({ item }, index) => {
      const node = nodes[index];
      const values = node ? this.nodeValues(node, metadata) : undefined;
      if (!values || 'reason' in values) {
        const nodeError = res.errors.find((e) => e.path?.[0] === 'nodes' && e.path[1] === index);
        const reason =
          values && 'reason' in values
            ? values.reason
            : `item not readable via GitHub project ${this.label}${nodeError?.message ? `: ${nodeError.message}` : ' (not visible to the identity)'}`;
        for (const f of metadata.fields) setUnknown(item, f.name, reason);
        return;
      }
      for (const f of metadata.fields) {
        const v = values.get(f.name);
        if (v === undefined) continue;
        if (typeof v === 'object' && v !== null && 'reason' in v) setUnknown(item, f.name, v.reason);
        else setValue(item, f.name, v as FieldValue);
      }
    });
  }

  /** Values of one issue/PR node; `{ reason }` if none can be determined. */
  private nodeValues(
    node: NodeJson,
    metadata: ProjectMetadata,
  ): Map<string, FieldValue | { reason: string }> | { reason: string } | undefined {
    const items = node.projectItems;
    if (!items || !Array.isArray(items.nodes)) return undefined;
    const total = typeof items.totalCount === 'number' ? items.totalCount : items.nodes.length;
    const entry = items.nodes.find((n) => n?.project?.id === metadata.projectId);
    const out = new Map<string, FieldValue | { reason: string }>();
    if (!entry) {
      if (total > items.nodes.length || total > PROJECT_ITEMS_PER_NODE) {
        return { reason: `item belongs to more than ${PROJECT_ITEMS_PER_NODE} projects; GitHub project ${this.label} not among those read` };
      }
      // Not in the project: known to be empty.
      for (const f of metadata.fields) out.set(f.name, null);
      return out;
    }
    metadata.fields.forEach((f, i) => out.set(f.name, fieldValue(entry[`f${i}`], f)));
    return out;
  }

  private markAll(item: ProjectTarget, reason: string): void {
    for (const name of this.fieldNames()) setUnknown(item, name, reason);
  }

  /** Log a warning when the reason of a field changes (not on every poll). */
  private note(key: string, reason: string | undefined): void {
    const previous = this.lastReasons.get(key);
    if (previous === reason) return;
    this.lastReasons.set(key, reason);
    if (reason !== undefined) {
      this.deps.logger.warn('GitHub project field unavailable', { project: this.label, ...(key ? { field: key } : {}), reason });
    } else if (previous !== undefined) {
      this.deps.logger.info('GitHub project field available again', { project: this.label, ...(key ? { field: key } : {}) });
    }
  }
}

/** Value of one `fieldValueByName` result for a field of `kind`. */
function fieldValue(raw: unknown, field: ResolvedField): FieldValue | { reason: string } {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return { reason: `unexpected value for project field "${field.githubName}"` };
  const v = raw as Record<string, unknown>;
  const expected: Record<ProjectFieldKind, [string, string]> = {
    single_select: ['ProjectV2ItemFieldSingleSelectValue', 'name'],
    text: ['ProjectV2ItemFieldTextValue', 'text'],
    number: ['ProjectV2ItemFieldNumberValue', 'number'],
    date: ['ProjectV2ItemFieldDateValue', 'date'],
    iteration: ['ProjectV2ItemFieldIterationValue', 'title'],
  };
  const [typename, key] = expected[field.kind];
  if (v.__typename !== typename) {
    return { reason: `project field "${field.githubName}" returned ${String(v.__typename)} instead of ${typename}` };
  }
  const value = v[key];
  if (value === null || value === undefined) return null;
  if (field.kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : { reason: `project field "${field.githubName}" returned a non-number` };
  return typeof value === 'string' ? value : { reason: `project field "${field.githubName}" returned a non-string` };
}

function setValue(item: ProjectTarget, name: string, value: FieldValue): void {
  item.fields[name] = value;
  if (item.unknownFields) delete item.unknownFields[name];
}

function setUnknown(item: ProjectTarget, name: string, reason: string): void {
  delete item.fields[name];
  item.unknownFields = { ...(item.unknownFields ?? {}), [name]: reason };
}

function errorsText(errors: readonly GraphQLErrorJson[]): string {
  return errors
    .slice(0, 3)
    .map((e) => `${e.type ? `${e.type}: ` : ''}${e.message ?? 'error'}`)
    .join('; ');
}

function describeError(err: unknown): string {
  if (err instanceof SourceError) return `${err.kind}: ${err.message}`;
  return 'unexpected error';
}
