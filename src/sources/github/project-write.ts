/**
 * Setting GitHub Projects (v2) field values from `source.update` (WI-16).
 *
 * Flow per update (all values travel ONLY as GraphQL variables, never in the
 * query text):
 * 1. Metadata: project ID, field IDs/`dataType`, single-select options and
 *    iterations (incl. completed ones). Cached up to
 *    {@link PROJECT_WRITE_METADATA_TTL_MS}; when a declared field, option or
 *    iteration cannot be resolved against cached metadata it is reloaded once.
 * 2. The item of the issue/PR in the project, read fresh (`node(id:)` →
 *    `projectItems`). Not in the project → `addProjectV2ItemById` (idempotent
 *    on GitHub's side: an existing item is returned) and the new item is read.
 * 3. Read first, then write (Spec §10): a field whose current value already
 *    equals the desired value is skipped; otherwise
 *    `updateProjectV2ItemFieldValue` (one mutation per field) or, for `null`,
 *    `clearProjectV2ItemFieldValue`.
 *
 * The mutations converge on the desired state, so repeating them is safe:
 * lifecycle retries simply run the whole flow again. GraphQL errors (also
 * with HTTP 200) are mapped to {@link SourceError} kinds; problems with the
 * configuration (unknown field/option, kind mismatch) are not retryable.
 */
import {
  SourceError,
  type Clock,
  type IdentityRef,
  type Logger,
  type ProjectFieldOption,
  type ProjectFieldUpdateValue,
  type SourceUpdateApplied,
} from '../../core/index.js';
import { PROJECT_FIELD_DATA_TYPES, type ProjectFieldKind } from './fields.js';
import type { GitHubHttpClient, GraphQLErrorJson, GraphQLResponse } from './http.js';
import { PROJECT_ITEMS_PER_NODE, type WithToken } from './project.js';

/** Write metadata (field IDs, options, iterations) is reused this long. */
export const PROJECT_WRITE_METADATA_TTL_MS = 5 * 60_000;

/** Pattern of a date value (`YYYY-MM-DD`). */
export const PROJECT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Settings of the project writer of one source. */
export interface GitHubProjectWriteSettings {
  owner: string;
  number: number;
  /** Declared field name → kind (as in `sources.yaml`). */
  fields: Readonly<Record<string, ProjectFieldKind>>;
  /** Explicit `project.identity` of the source; without it the identity of the update is used. */
  writeIdentity?: IdentityRef;
}

/** What one {@link GitHubProjectWriter.apply} call changed. */
export interface ProjectWriteResult {
  /** Changed fields: declared name → new value (`null` = cleared; options/iterations by their GitHub name). */
  changed: Record<string, ProjectFieldUpdateValue>;
  /** True if the item was added to the project first. */
  itemAdded: boolean;
  /** Old values of the changed fields as read before writing (WI-33); `null` = was empty. */
  previous: Record<string, ProjectFieldUpdateValue>;
}

interface FieldMeta {
  id: string;
  name: string;
  dataType: string;
  options: Array<{ id: string; name: string }>;
  iterations: Array<{ id: string; title: string }>;
}

interface WriteMetadata {
  projectId: string;
  fields: FieldMeta[];
}

/** Desired value of one field resolved against the metadata. */
type Target =
  | { kind: 'clear' }
  | { kind: 'single_select'; optionId: string; name: string }
  | { kind: 'iteration'; iterationId: string; title: string }
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'date'; date: string };

interface ResolvedWrite {
  /** Declared name (key of the update). */
  name: string;
  field: FieldMeta;
  target: Target;
}

interface ItemJson {
  id?: unknown;
  project?: { id?: unknown } | null;
  [alias: string]: unknown;
}

interface NodeJson extends ItemJson {
  __typename?: string;
  projectItems?: { totalCount?: unknown; nodes?: Array<ItemJson | null> | null } | null;
}

interface WriteMetadataJson {
  repositoryOwner?: {
    projectV2?: {
      id?: unknown;
      fields?: {
        nodes?: Array<{
          id?: unknown;
          name?: unknown;
          dataType?: unknown;
          options?: Array<{ id?: unknown; name?: unknown } | null> | null;
          configuration?: {
            iterations?: Array<{ id?: unknown; title?: unknown } | null> | null;
            completedIterations?: Array<{ id?: unknown; title?: unknown } | null> | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

const WRITE_METADATA_QUERY = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    __typename
    ... on User { projectV2(number: $number) { ...ProjectWriteMeta } }
    ... on Organization { projectV2(number: $number) { ...ProjectWriteMeta } }
  }
}
fragment ProjectWriteMeta on ProjectV2 {
  id
  fields(first: 100) {
    nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name } }
      ... on ProjectV2IterationField { configuration { iterations { id title } completedIterations { id title } } }
    }
  }
}`;

/**
 * Item query for `count` fields: `node(id:)` of an issue/PR (its project
 * items) or of a project item. Only generated identifiers (`$f<i>`, `f<i>`)
 * appear in the text; the field names travel in the variables.
 */
export function projectItemQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `, $f${i}: String!`).join('');
  const values = Array.from({ length: count }, (_, i) => `f${i}: fieldValueByName(name: $f${i}) { ...WriteValue }`).join(' ');
  const items = `projectItems(first: ${PROJECT_ITEMS_PER_NODE}, includeArchived: true) { totalCount nodes { ...Item } }`;
  return `query($id: ID!${vars}) {
  node(id: $id) {
    __typename
    ... on Issue { ${items} }
    ... on PullRequest { ${items} }
    ... on ProjectV2Item { ...Item }
  }
}
fragment Item on ProjectV2Item { id project { id } ${values} }
fragment WriteValue on ProjectV2ItemFieldValue {
  __typename
  ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
  ... on ProjectV2ItemFieldTextValue { text }
  ... on ProjectV2ItemFieldNumberValue { number }
  ... on ProjectV2ItemFieldDateValue { date }
  ... on ProjectV2ItemFieldIterationValue { title iterationId }
}`;
}

const ADD_ITEM_MUTATION = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;

const UPDATE_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id } }
}`;

const CLEAR_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } }
}`;

/** Writes `project.*` values of the items of one source. */
export class GitHubProjectWriter {
  private cached: { at: number; identity: IdentityRef; metadata: WriteMetadata } | undefined;
  private readonly label: string;

  constructor(
    private readonly settings: GitHubProjectWriteSettings,
    private readonly deps: { http: GitHubHttpClient; clock: Clock; logger: Logger; withToken: WithToken },
  ) {
    this.label = `${settings.owner}/${settings.number}`;
  }

  /**
   * Bring the project fields of the issue/PR `contentId` (GraphQL node ID) to
   * `desired`. `identity` is the identity of the update; an explicit
   * `project.identity` of the source takes precedence.
   */
  async apply(
    content: { contentId: string; key: string },
    desired: Readonly<Record<string, ProjectFieldUpdateValue>>,
    identity: IdentityRef,
    options: { exactIdentity?: boolean } = {},
  ): Promise<ProjectWriteResult> {
    const names = Object.keys(desired);
    if (names.length === 0) return { changed: {}, itemAdded: false, previous: {} };
    this.checkDesired(desired);
    // UI actions (WI-27) write strictly as the chosen identity, never as `project.identity`.
    const writer = options.exactIdentity === true ? identity : (this.settings.writeIdentity ?? identity);
    const progress: ProjectWriteResult = { changed: {}, itemAdded: false, previous: {} };
    try {
      // A NOT_FOUND for an ID from cached metadata (e.g. a deleted and re-created option): reload once and redo.
      if (await this.pass(content, desired, writer, false, progress)) await this.pass(content, desired, writer, true, progress);
    } catch (err) {
      throw withApplied(err, progress);
    }
    if (progress.itemAdded || Object.keys(progress.changed).length > 0) {
      this.deps.logger.info('Applied project field update', {
        item: content.key,
        project: this.label,
        fields: Object.keys(progress.changed),
        itemAdded: progress.itemAdded,
      });
    }
    return progress;
  }

  /**
   * Declared fields with their selectable options/iterations, resolved
   * against the project metadata read with `identity` (cached like writes).
   */
  async fieldOptions(identity: IdentityRef): Promise<ProjectFieldOption[]> {
    const { metadata } = await this.metadata(identity, false);
    return Object.entries(this.settings.fields).map(([name, kind]) => {
      const field =
        metadata.fields.find((f) => f.name === name) ?? metadata.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (!field) return { name, kind, choices: [], problem: `not found in GitHub project ${this.label}` };
      if (field.dataType !== PROJECT_FIELD_DATA_TYPES[kind]) {
        return { name, kind, choices: [], problem: `has type ${field.dataType || 'unknown'} in GitHub project ${this.label}, declared as ${kind}` };
      }
      const choices = kind === 'single_select' ? field.options.map((o) => o.name) : kind === 'iteration' ? field.iterations.map((i) => i.title) : [];
      return { name, kind, choices, problem: null };
    });
  }

  /**
   * One read-then-write pass; records applied changes in `progress`. Returns
   * true if it stopped because a mutation answered NOT_FOUND for IDs taken
   * from cached metadata (the caller retries with fresh metadata); throws
   * otherwise. A failed mutation always drops the cached metadata so later
   * attempts (also manual retries) reload option and field IDs.
   */
  private async pass(
    content: { contentId: string; key: string },
    desired: Readonly<Record<string, ProjectFieldUpdateValue>>,
    writer: IdentityRef,
    fresh: boolean,
    progress: ProjectWriteResult,
  ): Promise<boolean> {
    // Resolve against (possibly cached) metadata; unresolvable → reload once.
    let metadata = await this.metadata(writer, fresh);
    let resolved = this.resolve(metadata.metadata, desired);
    if ('problems' in resolved && metadata.cached) {
      metadata = await this.metadata(writer, true);
      resolved = this.resolve(metadata.metadata, desired);
    }
    if ('problems' in resolved) {
      throw new SourceError('invalid', resolved.problems.join('; '), { retryable: false, details: { project: this.label } });
    }
    const { projectId } = metadata.metadata;
    const writes = resolved.writes;

    try {
      // Fresh item (read first, then write).
      let item = await this.readItem(writer, content.contentId, projectId, writes);
      if (!('itemId' in item)) {
        const itemId = await this.addItem(writer, projectId, content.contentId);
        // Only claim "added" when absence was proven; otherwise GitHub may have returned an existing item.
        if (item.absent === 'proven') progress.itemAdded = true;
        const added = await this.readItem(writer, itemId, projectId, writes);
        if (!('itemId' in added)) {
          throw new SourceError('transient', `Item ${content.key} was added to GitHub project ${this.label} but cannot be read back`);
        }
        item = added;
      }
      for (const [index, write] of writes.entries()) {
        if (sameValue(item.values[index], write.target)) continue;
        await this.writeField(writer, projectId, item.itemId, write);
        // The first pass that changed the field knows its old value (a retried pass sees the new one).
        if (!Object.hasOwn(progress.previous, write.name)) progress.previous[write.name] = currentValue(item.values[index]);
        progress.changed[write.name] = targetValue(write.target);
      }
      return false;
    } catch (err) {
      if (!(err instanceof MutationError)) throw err;
      this.cached = undefined;
      if (metadata.cached && err.cause instanceof SourceError && err.cause.kind === 'not_found') return true;
      throw err.cause;
    }
  }

  /** Runtime check of names and value types (the config validation normally guarantees them). */
  private checkDesired(desired: Readonly<Record<string, ProjectFieldUpdateValue>>): void {
    const problems: string[] = [];
    for (const [name, value] of Object.entries(desired)) {
      const kind = Object.hasOwn(this.settings.fields, name) ? this.settings.fields[name] : undefined;
      if (!kind) {
        problems.push(`project field "${name}" is not declared in "project.fields" of the source`);
        continue;
      }
      const problem = valueProblem(kind, value);
      if (problem) problems.push(`project field "${name}": ${problem}`);
    }
    if (problems.length > 0) throw new SourceError('invalid', problems.join('; '), { retryable: false });
  }

  private async metadata(identity: IdentityRef, fresh: boolean): Promise<{ metadata: WriteMetadata; cached: boolean }> {
    const now = this.deps.clock.now().getTime();
    const cached = this.cached;
    if (!fresh && cached && cached.identity === identity && now - cached.at < PROJECT_WRITE_METADATA_TTL_MS) {
      return { metadata: cached.metadata, cached: true };
    }
    const res = await this.deps.withToken(identity, undefined, (token) =>
      this.deps.http.graphql<WriteMetadataJson>(WRITE_METADATA_QUERY, { owner: this.settings.owner, number: this.settings.number }, { token }),
    );
    const metadata = this.parseMetadata(res);
    this.cached = { at: now, identity, metadata };
    return { metadata, cached: false };
  }

  private parseMetadata(res: GraphQLResponse<WriteMetadataJson>): WriteMetadata {
    const project = res.data?.repositoryOwner?.projectV2;
    if (!project || typeof project.id !== 'string') {
      const detail = res.errors.length > 0 ? errorsText(res.errors) : 'project not found or not accessible to the identity';
      throw new SourceError(metadataErrorKind(res.errors), `GitHub project ${this.label} unavailable: ${detail}`, { details: { project: this.label } });
    }
    const fields: FieldMeta[] = [];
    for (const node of project.fields?.nodes ?? []) {
      if (!node || typeof node.id !== 'string' || typeof node.name !== 'string') continue;
      const iterations = [...(node.configuration?.iterations ?? []), ...(node.configuration?.completedIterations ?? [])];
      fields.push({
        id: node.id,
        name: node.name,
        dataType: typeof node.dataType === 'string' ? node.dataType : '',
        options: (node.options ?? [])
          .filter((o): o is { id: string; name: string } => typeof o?.id === 'string' && typeof o.name === 'string')
          .map((o) => ({ id: o.id, name: o.name })),
        iterations: iterations
          .filter((i): i is { id: string; title: string } => typeof i?.id === 'string' && typeof i.title === 'string')
          .map((i) => ({ id: i.id, title: i.title })),
      });
    }
    return { projectId: project.id, fields };
  }

  /** Field, kind and option/iteration of every desired value; all problems at once. */
  private resolve(
    metadata: WriteMetadata,
    desired: Readonly<Record<string, ProjectFieldUpdateValue>>,
  ): { writes: ResolvedWrite[] } | { problems: string[] } {
    const writes: ResolvedWrite[] = [];
    const problems: string[] = [];
    for (const [name, value] of Object.entries(desired)) {
      const kind = this.settings.fields[name] as ProjectFieldKind;
      const field =
        metadata.fields.find((f) => f.name === name) ?? metadata.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (!field) {
        problems.push(`project field "${name}" not found in GitHub project ${this.label}`);
        continue;
      }
      if (field.dataType !== PROJECT_FIELD_DATA_TYPES[kind]) {
        problems.push(
          `project field "${field.name}" in GitHub project ${this.label} has type ${field.dataType || 'unknown'}, ` +
            `but is declared as ${kind} (expects ${PROJECT_FIELD_DATA_TYPES[kind]})`,
        );
        continue;
      }
      const target = resolveTarget(kind, value, field);
      if ('problem' in target) problems.push(`project field "${field.name}" in GitHub project ${this.label}: ${target.problem}`);
      else writes.push({ name, field, target });
    }
    return problems.length > 0 ? { problems } : { writes };
  }

  /**
   * Item ID and current values (by index of `writes`) of `id` in the project:
   * `id` is an issue/PR (its project items are searched) or a project item.
   * `{ absent: 'proven' }` if the issue/PR has no item in the project,
   * `{ absent: 'unknown' }` if it was not found among the memberships read
   * (more than {@link PROJECT_ITEMS_PER_NODE} or unreadable ones – adding it
   * is idempotent anyway).
   */
  private async readItem(
    identity: IdentityRef,
    id: string,
    projectId: string,
    writes: readonly ResolvedWrite[],
  ): Promise<{ itemId: string; values: unknown[] } | { absent: 'proven' | 'unknown' }> {
    const variables: Record<string, unknown> = { id };
    writes.forEach((w, i) => {
      variables[`f${i}`] = w.field.name;
    });
    const res = await this.deps.withToken(identity, undefined, (token) =>
      this.deps.http.graphql<{ node?: NodeJson | null }>(projectItemQuery(writes.length), variables, { token }),
    );
    const node = res.data?.node;
    if (!node) {
      throw this.graphqlError(res.errors, `reading item ${id} in GitHub project ${this.label} failed`, 'not_found');
    }
    let entry: ItemJson | undefined;
    let entryPath: Array<string | number> = ['node'];
    let absent: 'proven' | 'unknown' = 'unknown';
    if (node.__typename === 'ProjectV2Item') {
      if (node.project?.id === projectId) entry = node;
    } else {
      const items = node.projectItems;
      const nodes = items?.nodes;
      if (!Array.isArray(nodes)) throw this.graphqlError(res.errors, `reading the project items of ${id} failed`, 'invalid');
      const index = nodes.findIndex((n) => n?.project?.id === projectId);
      if (index >= 0) {
        entry = nodes[index] as ItemJson;
        entryPath = ['node', 'projectItems', 'nodes', index];
      } else {
        const total = typeof items?.totalCount === 'number' ? items.totalCount : Infinity;
        if (nodes.every((n) => typeof n?.project?.id === 'string') && total <= nodes.length) absent = 'proven';
      }
    }
    if (!entry) return { absent };
    // Errors below the entry make its values unreliable (errors of other memberships do not matter).
    const entryErrors = res.errors.filter((e) => entryPath.every((p, i) => e.path?.[i] === p));
    if (entryErrors.length > 0) throw this.graphqlError(entryErrors, `reading item ${id} in GitHub project ${this.label} failed`, 'transient');
    if (typeof entry.id !== 'string') throw new SourceError('invalid', `GitHub project ${this.label} returned an item without ID`, { retryable: false });
    return { itemId: entry.id, values: writes.map((_, i) => entry[`f${i}`] ?? null) };
  }

  private async addItem(identity: IdentityRef, projectId: string, contentId: string): Promise<string> {
    const data = await this.mutate<{ addProjectV2ItemById?: { item?: { id?: unknown } | null } | null }>(
      identity,
      ADD_ITEM_MUTATION,
      { projectId, contentId },
      'adding the item to',
    );
    const id = data.addProjectV2ItemById?.item?.id;
    if (typeof id !== 'string') {
      // Repeating is safe: GitHub returns the existing item.
      throw new MutationError(new SourceError('transient', `Adding the item to GitHub project ${this.label} returned no item ID`));
    }
    return id;
  }

  private async writeField(identity: IdentityRef, projectId: string, itemId: string, write: ResolvedWrite): Promise<void> {
    const base = { projectId, itemId, fieldId: write.field.id };
    const what = `setting field "${write.field.name}" in`;
    if (write.target.kind === 'clear') {
      const data = await this.mutate<{ clearProjectV2ItemFieldValue?: unknown }>(identity, CLEAR_FIELD_MUTATION, base, what);
      if (!data.clearProjectV2ItemFieldValue) {
        throw new MutationError(new SourceError('transient', `Clearing field "${write.field.name}" in GitHub project ${this.label} returned no item`));
      }
      return;
    }
    const data = await this.mutate<{ updateProjectV2ItemFieldValue?: unknown }>(
      identity,
      UPDATE_FIELD_MUTATION,
      { ...base, value: fieldValueInput(write.target) },
      what,
    );
    if (!data.updateProjectV2ItemFieldValue) {
      throw new MutationError(new SourceError('transient', `Setting field "${write.field.name}" in GitHub project ${this.label} returned no item`));
    }
  }

  /** Run one mutation; GraphQL errors (also with HTTP 200) become a {@link SourceError}. */
  private async mutate<T>(identity: IdentityRef, mutation: string, variables: Record<string, unknown>, what: string): Promise<T> {
    // `graphql()` treats the request as idempotent: the mutations converge on the desired state.
    let res: GraphQLResponse<T>;
    try {
      res = await this.deps.withToken(identity, undefined, (token) => this.deps.http.graphql<T>(mutation, variables, { token }));
    } catch (err) {
      throw new MutationError(err);
    }
    if (res.errors.length > 0 || !res.data) {
      throw new MutationError(this.graphqlError(res.errors, `${what} GitHub project ${this.label} failed`, 'transient'));
    }
    return res.data;
  }

  /** Error for GraphQL `errors`; `fallback` is used when there are none (empty/unusable response). */
  private graphqlError(errors: readonly GraphQLErrorJson[], message: string, fallback: SourceError['kind']): SourceError {
    const kind = errors.length > 0 ? writeErrorKind(errors) : fallback;
    const hint = kind === 'forbidden' ? ' (the identity needs write access to the project)' : '';
    return new SourceError(kind, `${message}: ${errors.length > 0 ? errorsText(errors) : 'unexpected response'}${hint}`, {
      ...(kind === 'invalid' ? { retryable: false } : {}),
      details: { project: this.label },
    });
  }
}

/** Internal wrapper marking a failed mutation (the original error is `cause`). */
class MutationError extends Error {
  constructor(override readonly cause: unknown) {
    super('project mutation failed');
  }
}

/**
 * `err` with what was applied before it attached as `details.applied` (shape
 * of {@link SourceUpdateApplied}; entries already attached win). Non-source
 * errors are returned unchanged.
 */
export function withApplied(err: unknown, applied: SourceUpdateApplied | ProjectWriteResult): unknown {
  if (!(err instanceof SourceError)) return err;
  const normalized: SourceUpdateApplied =
    'changed' in applied
      ? {
          ...(Object.keys(applied.changed).length > 0 ? { projectFields: { ...applied.changed } } : {}),
          ...(Object.keys(applied.changed).length > 0 ? { projectFieldsPrevious: pick(applied.previous, Object.keys(applied.changed)) } : {}),
          ...(applied.itemAdded ? { projectItemAdded: true } : {}),
        }
      : applied;
  const previous = (err.details?.applied ?? {}) as SourceUpdateApplied;
  const merged: SourceUpdateApplied = { ...normalized, ...previous };
  if (Object.keys(merged).length === 0) return err;
  return new SourceError(err.kind, err.message, {
    cause: err.cause,
    details: { ...(err.details ?? {}), applied: merged },
    retryable: err.retryable,
    outcomeUnknown: err.outcomeUnknown,
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    ...(err.status !== undefined ? { status: err.status } : {}),
  });
}

function pick(values: Readonly<Record<string, ProjectFieldUpdateValue>>, names: readonly string[]): Record<string, ProjectFieldUpdateValue> {
  const out: Record<string, ProjectFieldUpdateValue> = {};
  for (const n of names) if (Object.hasOwn(values, n)) out[n] = values[n] ?? null;
  return out;
}

/** Problem of a value for a field of `kind`, or `undefined` if valid. */
export function valueProblem(kind: ProjectFieldKind, value: unknown): string | undefined {
  if (value === null) return undefined;
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'expected a number or null';
    case 'date':
      return typeof value === 'string' && isValidDate(value) ? undefined : 'expected a date YYYY-MM-DD or null';
    default:
      if (typeof value !== 'string') return 'expected a string or null';
      return value === '' ? 'empty value; use null to clear the field' : undefined;
  }
}

/** True for a valid calendar date `YYYY-MM-DD`. */
export function isValidDate(value: string): boolean {
  if (!PROJECT_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function resolveTarget(kind: ProjectFieldKind, value: ProjectFieldUpdateValue, field: FieldMeta): Target | { problem: string } {
  if (value === null) return { kind: 'clear' };
  switch (kind) {
    case 'single_select': {
      const match = matchByName(String(value), field.options.map((o) => ({ id: o.id, name: o.name })));
      if ('problem' in match) return { problem: `option ${match.problem}` };
      return { kind: 'single_select', optionId: match.id, name: match.name };
    }
    case 'iteration': {
      const match = matchByName(String(value), field.iterations.map((i) => ({ id: i.id, name: i.title })));
      if ('problem' in match) return { problem: `iteration ${match.problem}` };
      return { kind: 'iteration', iterationId: match.id, title: match.name };
    }
    case 'text':
      return { kind: 'text', text: String(value) };
    case 'number':
      return { kind: 'number', number: Number(value) };
    case 'date':
      return { kind: 'date', date: String(value) };
  }
}

/** Exact name, otherwise a unique case-insensitive match. */
function matchByName(wanted: string, candidates: ReadonlyArray<{ id: string; name: string }>): { id: string; name: string } | { problem: string } {
  const available = candidates.length > 0 ? candidates.map((c) => `"${c.name}"`).join(', ') : 'none';
  const exact = candidates.filter((c) => c.name === wanted);
  if (exact.length === 1) return exact[0] as { id: string; name: string };
  const loose = exact.length > 1 ? exact : candidates.filter((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (loose.length === 1) return loose[0] as { id: string; name: string };
  if (loose.length > 1) return { problem: `"${wanted}" is ambiguous (matches ${loose.map((c) => `"${c.name}"`).join(', ')}; available: ${available})` };
  return { problem: `"${wanted}" not found (available: ${available})` };
}

/** `ProjectV2FieldValue` input of a target. */
function fieldValueInput(target: Exclude<Target, { kind: 'clear' }>): Record<string, unknown> {
  switch (target.kind) {
    case 'single_select':
      return { singleSelectOptionId: target.optionId };
    case 'iteration':
      return { iterationId: target.iterationId };
    case 'text':
      return { text: target.text };
    case 'number':
      return { number: target.number };
    case 'date':
      return { date: target.date };
  }
}

/** Value recorded in the journal for a target. */
function targetValue(target: Target): ProjectFieldUpdateValue {
  switch (target.kind) {
    case 'clear':
      return null;
    case 'single_select':
      return target.name;
    case 'iteration':
      return target.title;
    case 'text':
      return target.text;
    case 'number':
      return target.number;
    case 'date':
      return target.date;
  }
}

/** Display value of a `fieldValueByName` result (WI-33: old value in the item history); `null` = empty. */
function currentValue(current: unknown): ProjectFieldUpdateValue {
  if (current === null || current === undefined || typeof current !== 'object') return null;
  const v = current as Record<string, unknown>;
  switch (v.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      return typeof v.name === 'string' ? v.name : null;
    case 'ProjectV2ItemFieldIterationValue':
      return typeof v.title === 'string' ? v.title : null;
    case 'ProjectV2ItemFieldTextValue':
      return typeof v.text === 'string' ? v.text : null;
    case 'ProjectV2ItemFieldNumberValue':
      return typeof v.number === 'number' ? v.number : null;
    case 'ProjectV2ItemFieldDateValue':
      return typeof v.date === 'string' ? v.date.slice(0, 10) : null;
    default:
      return null;
  }
}

/** True if the current `fieldValueByName` result already equals the target. */
function sameValue(current: unknown, target: Target): boolean {
  if (current === null || current === undefined) return target.kind === 'clear';
  if (typeof current !== 'object') return false;
  const v = current as Record<string, unknown>;
  switch (target.kind) {
    case 'clear':
      return false;
    case 'single_select':
      return v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && (typeof v.optionId === 'string' ? v.optionId === target.optionId : v.name === target.name);
    case 'iteration':
      return v.__typename === 'ProjectV2ItemFieldIterationValue' && (typeof v.iterationId === 'string' ? v.iterationId === target.iterationId : v.title === target.title);
    case 'text':
      return v.__typename === 'ProjectV2ItemFieldTextValue' && v.text === target.text;
    case 'number':
      return v.__typename === 'ProjectV2ItemFieldNumberValue' && v.number === target.number;
    case 'date':
      return v.__typename === 'ProjectV2ItemFieldDateValue' && typeof v.date === 'string' && v.date.slice(0, 10) === target.date;
  }
}

/** Error kind of failed metadata reads. */
function metadataErrorKind(errors: readonly GraphQLErrorJson[]): SourceError['kind'] {
  if (errors.length === 0) return 'not_found';
  return writeErrorKind(errors);
}

/**
 * Error kind of GraphQL errors on the write path. Rate limits are already
 * thrown by the HTTP client. Typed errors other than access problems are
 * permanent (`invalid`); untyped ones (e.g. "Something went wrong") are
 * treated as transient – repeating the converging writes is safe.
 */
function writeErrorKind(errors: readonly GraphQLErrorJson[]): SourceError['kind'] {
  const types = new Set(errors.map((e) => e.type));
  if (types.has('RATE_LIMITED')) return 'rate_limited';
  if (types.has('FORBIDDEN') || types.has('INSUFFICIENT_SCOPES')) return 'forbidden';
  if (types.has('NOT_FOUND')) return 'not_found';
  if (errors.some((e) => e.type !== undefined)) return 'invalid';
  return 'transient';
}

function errorsText(errors: readonly GraphQLErrorJson[]): string {
  return errors
    .slice(0, 3)
    .map((e) => `${e.type ? `${e.type}: ` : ''}${e.message ?? 'error'}`)
    .join('; ');
}
