/**
 * Source adapter `github` (Spec §5.2, §6, §10): issues and pull requests of
 * one repository, native "blocked by" dependencies, labels and comments, and
 * optionally the fields of one GitHub Projects (v2) project (`project.*`, WI-14).
 */
import {
  SourceError,
  noopLogger,
  sourceItemKey,
  systemTimers,
  type CommentRef,
  type CredentialProvider,
  type FieldDefinition,
  type FieldResolution,
  type FieldValue,
  type IdentityRef,
  type ListCandidatesOptions,
  type Logger,
  type SourceAdapter,
  type SourceAdapterDeps,
  type SourceAdapterFactory,
  type SourceItem,
  type SourceUpdate,
  type SourceUpdateResult,
  type Timers,
} from '../../core/index.js';
import { DEPENDENCY_FIELDS, GITHUB_FIELD_DEFINITIONS, projectFieldDefinitions, type ProjectFieldKind } from './fields.js';
import { GitHubHttpClient, type GitHubHttpClientOptions } from './http.js';
import { GitHubProjectReader, type ProjectLookupItem } from './project.js';
import { pushdownQuery } from './pushdown.js';
import { ITEM_ID_PATTERN, parseGitHubItemRef } from './refs.js';

/** Adapter type name. */
export const GITHUB_SOURCE_TYPE = 'github';

/** Validated configuration of one GitHub source (normalised, camelCase). */
export interface GitHubSourceConfig {
  owner: string;
  repository: string;
  /** Default identity for reads (and fallback for writes). */
  identity: IdentityRef;
  /** REST API base URL; default `https://api.github.com`. */
  apiBaseUrl?: string;
  /** Web base URL for parsing item references; default `https://github.com`. */
  webBaseUrl?: string;
  /** GitHub Projects (v2) project whose fields are provided as `project.<name>`. */
  project?: GitHubSourceProjectConfig;
}

/** Project settings of a GitHub source (`sources.yaml` → `project`). */
export interface GitHubSourceProjectConfig {
  /** User or organisation login of the project; default: the source owner. */
  owner?: string;
  /** Project number from the URL `…/projects/<number>`. */
  number: number;
  /** Identity for reading the project; default: the source identity. */
  identity?: IdentityRef;
  /** Declared fields: name (as used in `project.<name>`) → kind. */
  fields: Readonly<Record<string, ProjectFieldKind>>;
}

/** Subset of the GitHub issue JSON used by the adapter. */
export interface GitHubIssueJson {
  id?: number;
  /** GraphQL node ID (used for the project lookup). */
  node_id?: string;
  number: number;
  title?: string;
  state?: string;
  html_url?: string;
  repository_url?: string;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string }> | null;
  user?: { login?: string } | null;
  pull_request?: unknown;
  created_at?: string;
  updated_at?: string;
  repository?: { full_name?: string } | null;
  issue_dependencies_summary?: { blocked_by?: number; total_blocked_by?: number } | null;
  state_reason?: string | null;
  milestone?: { title?: string | null } | null;
  /** Issue type (organisations with issue types only). */
  type?: { name?: string | null } | null;
}

interface GitHubCommentJson {
  id?: unknown;
  html_url?: string;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  performed_via_github_app?: { id?: number | string; slug?: string } | null;
}

/** Options beyond {@link SourceAdapterDeps}. */
export interface GitHubAdapterOptions {
  timers?: Timers;
  /** Pre-built HTTP client (tests / sharing); otherwise one is created from deps. */
  http?: GitHubHttpClient;
  /** Extra HTTP client settings (retries, timeouts). */
  httpOptions?: Partial<Omit<GitHubHttpClientOptions, 'fetch' | 'clock' | 'timers' | 'logger' | 'baseUrl'>>;
}

/** Marker pattern accepted by {@link GitHubSourceAdapter.postComment} (see `commentMarker`). */
const MARKER_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** {@link SourceAdapter} for one GitHub repository. */
export class GitHubSourceAdapter implements SourceAdapter {
  readonly type = GITHUB_SOURCE_TYPE;
  readonly sourceId: string;
  readonly repository: string;
  private readonly config: GitHubSourceConfig;
  private readonly http: GitHubHttpClient;
  private readonly credentials: CredentialProvider;
  private readonly logger: Logger;
  private readonly repoPath: string;
  private readonly definitions: readonly FieldDefinition[];
  private readonly project: GitHubProjectReader | undefined;
  /** Login per `github_token` identity (from `GET /user`), for comment authorship checks. */
  private readonly userLogins = new Map<IdentityRef, Promise<string>>();

  constructor(sourceId: string, config: GitHubSourceConfig, deps: SourceAdapterDeps, options: GitHubAdapterOptions = {}) {
    if (!config.owner || !config.repository) throw new SourceError('invalid', `Source "${sourceId}": owner and repository are required`);
    this.sourceId = sourceId;
    this.config = config;
    this.repository = `${config.owner}/${config.repository}`;
    this.repoPath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;
    this.credentials = deps.credentials;
    this.logger = (deps.logger ?? noopLogger).child({ component: 'source', sourceId });
    this.http =
      options.http ??
      new GitHubHttpClient({
        ...options.httpOptions,
        clock: deps.clock,
        timers: options.timers ?? systemTimers,
        logger: this.logger,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
      });
    const project = config.project;
    this.definitions = Object.freeze(project ? [...GITHUB_FIELD_DEFINITIONS, ...projectFieldDefinitions(project.fields)] : GITHUB_FIELD_DEFINITIONS);
    this.project = project
      ? new GitHubProjectReader(
          {
            owner: project.owner ?? config.owner,
            number: project.number,
            identity: project.identity ?? config.identity,
            fields: project.fields,
          },
          {
            http: this.http,
            clock: deps.clock,
            logger: this.logger,
            withToken: (identity, signal, fn) => this.withToken(identity, signal, fn),
          },
        )
      : undefined;
  }

  /** Static GitHub fields plus the declared `project.*` fields of this source. */
  fieldDefinitions(): readonly FieldDefinition[] {
    return this.definitions;
  }

  async listCandidates(options: ListCandidatesOptions = {}): Promise<SourceItem[]> {
    const query = pushdownQuery(options.filter);
    const issues = await this.withToken(this.config.identity, options.signal, (token) =>
      this.http.paginate<GitHubIssueJson>(`${this.repoPath}/issues`, {
        token,
        query: {
          state: query.state,
          ...(query.labels.length > 0 ? { labels: query.labels.join(',') } : {}),
          sort: 'created',
          direction: 'asc',
        },
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    const items = issues.map((issue) => this.toItem(issue));
    await this.addProjectFields(items, issues, options.signal, true);
    return items;
  }

  async getItem(itemId: string, options: { signal?: AbortSignal } = {}): Promise<SourceItem | null> {
    const issue = await this.fetchIssue(itemId, this.config.identity, options.signal);
    if (!issue) return null;
    const item = this.toItem(issue);
    await this.addProjectFields([item], [issue], options.signal, false);
    return item;
  }

  parseItemRef(ref: string): string | null {
    return parseGitHubItemRef(ref, this.config.owner, this.config.repository, this.config.webBaseUrl);
  }

  async resolveFields(
    item: SourceItem,
    fields: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, FieldResolution>> {
    const out: Record<string, FieldResolution> = {};
    const wantsDependencies = fields.some((f) => (DEPENDENCY_FIELDS as readonly string[]).includes(f));
    const dependencies = wantsDependencies ? await this.resolveDependencies(item, options.signal) : undefined;
    for (const name of fields) {
      if (dependencies && name in dependencies) {
        out[name] = dependencies[name] as FieldResolution;
      } else if (Object.hasOwn(item.fields, name)) {
        out[name] = { known: true, value: item.fields[name] as FieldValue };
      } else if (item.unknownFields && Object.hasOwn(item.unknownFields, name)) {
        out[name] = { known: false, reason: item.unknownFields[name] as string };
      } else {
        out[name] = { known: false, reason: `unknown field "${name}" for source type github` };
      }
    }
    return out;
  }

  async applyUpdate(item: SourceItem, update: SourceUpdate, identity: IdentityRef): Promise<SourceUpdateResult> {
    this.assertOwnItem(item);
    const add = uniqueCaseInsensitive(update.labels?.add ?? []);
    const addLower = new Set(add.map((l) => l.toLowerCase()));
    // A label listed in both add and remove is added (remove ignored).
    const remove = uniqueCaseInsensitive(update.labels?.remove ?? []).filter((l) => !addLower.has(l.toLowerCase()));
    if (add.length === 0 && remove.length === 0) return { changed: false };

    // Re-read the item first so manual changes since the snapshot are respected (Spec §10).
    const fresh = await this.fetchIssue(item.itemId, identity);
    if (!fresh) throw new SourceError('not_found', `Item ${this.repository}#${item.itemId} not found`, { retryable: false });
    const current = labelNames(fresh);
    const currentByLower = new Map(current.map((l) => [l.toLowerCase(), l]));
    const toAdd = add.filter((l) => !currentByLower.has(l.toLowerCase()));
    const toRemove = remove.map((l) => currentByLower.get(l.toLowerCase())).filter((l): l is string => l !== undefined);

    const issuePath = `${this.repoPath}/issues/${item.itemId}`;
    if (toAdd.length > 0) {
      await this.withToken(identity, undefined, (token) =>
        // Adding labels is idempotent on GitHub's side: repeating is safe.
        this.http.request('POST', `${issuePath}/labels`, { token, body: { labels: toAdd }, idempotent: true }),
      );
    }
    const removed: string[] = [];
    for (const label of toRemove) {
      try {
        await this.withToken(identity, undefined, (token) =>
          this.http.request('DELETE', `${issuePath}/labels/${encodeURIComponent(label)}`, { token, idempotent: true }),
        );
        removed.push(label);
      } catch (err) {
        // Already removed concurrently: desired state reached.
        if (err instanceof SourceError && err.kind === 'not_found') continue;
        throw err;
      }
    }
    const changed = toAdd.length > 0 || removed.length > 0;
    this.logger.info('Applied label update', { item: item.key, labelsAdded: toAdd, labelsRemoved: removed });
    return {
      changed,
      ...(changed ? { applied: { labelsAdded: toAdd, labelsRemoved: removed } } : {}),
    };
  }

  async postComment(item: SourceItem, body: string, marker: string, identity: IdentityRef): Promise<CommentRef> {
    this.assertOwnItem(item);
    const markerLine = renderMarker(marker);
    const fullBody = `${body.replace(/\s+$/, '')}\n\n${markerLine}`;
    const res = await this.withToken(identity, undefined, (token) =>
      this.http.request<GitHubCommentJson>('POST', `${this.repoPath}/issues/${item.itemId}/comments`, {
        token,
        body: { body: fullBody },
      }),
    );
    const id = res.data?.id;
    if ((typeof id !== 'number' && typeof id !== 'string') || String(id) === '') {
      // The comment may exist although the response is unusable: reconcile via marker.
      throw new SourceError('transient', `Comment on ${item.key} returned no comment id; outcome unknown`, {
        status: res.status,
        outcomeUnknown: true,
      });
    }
    return toCommentRef(res.data);
  }

  async findCommentByMarker(item: SourceItem, marker: string, identity: IdentityRef): Promise<CommentRef | null> {
    this.assertOwnItem(item);
    const pattern = markerPattern(marker);
    const comments = await this.withToken(identity, undefined, (token) =>
      this.http.paginate<GitHubCommentJson>(`${this.repoPath}/issues/${item.itemId}/comments`, { token }),
    );
    const isOwn = await this.authorPredicate(identity);
    const found = comments.find((c) => typeof c.body === 'string' && pattern.test(c.body) && isOwn(c));
    return found ? toCommentRef(found) : null;
  }

  /**
   * Only comments written by the identity itself count as carrying a marker;
   * otherwise anybody could suppress an orchestrator comment by posting the
   * marker. With a known app ID (CredentialProvider.describe) the comment must
   * have `performed_via_github_app.id === appId`. For `github_token`
   * identities (personal access tokens) the comment author must be the
   * token's user (`GET /user`, cached per identity). Otherwise at least a bot
   * author (`user.type === 'Bot'`) is required.
   */
  private async authorPredicate(identity: IdentityRef): Promise<(c: GitHubCommentJson) => boolean> {
    const description = this.credentials.describe?.(identity);
    const appId = description?.appId;
    if (appId !== undefined) {
      return (c) => c.performed_via_github_app?.id !== undefined && String(c.performed_via_github_app.id) === appId;
    }
    if (description?.kind === 'github_token') {
      const login = (await this.userLogin(identity)).toLowerCase();
      return (c) => typeof c.user?.login === 'string' && c.user.login.toLowerCase() === login;
    }
    return (c) => c.user?.type === 'Bot';
  }

  /** Login of the user behind a token identity (first use: `GET /user`; failures are not cached). */
  private userLogin(identity: IdentityRef): Promise<string> {
    let login = this.userLogins.get(identity);
    if (!login) {
      login = this.withToken(identity, undefined, (token) => this.http.request<{ login?: unknown }>('GET', '/user', { token })).then((res) => {
        if (typeof res.data?.login !== 'string' || res.data.login === '') {
          throw new SourceError('invalid', `GET /user returned no login for identity "${identity}"`, { retryable: false });
        }
        return res.data.login;
      });
      const pending = login;
      pending.catch(() => {
        if (this.userLogins.get(identity) === pending) this.userLogins.delete(identity);
      });
      this.userLogins.set(identity, pending);
    }
    return login;
  }

  /** Add `project.*` values/unknown reasons to freshly built items (no-op without a project). */
  private async addProjectFields(
    items: SourceItem[],
    issues: readonly GitHubIssueJson[],
    signal: AbortSignal | undefined,
    freshMetadata: boolean,
  ): Promise<void> {
    if (!this.project) return;
    const lookup: ProjectLookupItem[] = items.map((item, i) => {
      const nodeId = issues[i]?.node_id;
      return { item, nodeId: typeof nodeId === 'string' && nodeId !== '' ? nodeId : undefined };
    });
    await this.project.annotate(lookup, { ...(signal ? { signal } : {}), freshMetadata });
  }

  // -------------------------------------------------------------------------

  private async resolveDependencies(item: SourceItem, signal: AbortSignal | undefined): Promise<Record<string, FieldResolution>> {
    this.assertOwnItem(item);
    let issue: GitHubIssueJson | null;
    let blockers: GitHubIssueJson[];
    try {
      // Fresh issue (for the authoritative blocker count) and the visible blocker list.
      [issue, blockers] = await Promise.all([
        this.fetchIssue(item.itemId, this.config.identity, signal),
        this.withToken(this.config.identity, signal, (token) =>
          this.http.paginate<GitHubIssueJson>(`${this.repoPath}/issues/${item.itemId}/dependencies/blocked_by`, {
            token,
            ...(signal ? { signal } : {}),
          }),
        ),
      ]);
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason =
        err instanceof SourceError ? `dependencies unavailable (${err.kind}): ${err.message}` : 'dependencies unavailable (unexpected error)';
      this.logger.warn('Could not resolve dependencies', { item: item.key, reason });
      return unknownDependencies(reason);
    }
    if (!issue) return unknownDependencies(`item ${item.key} not found while resolving dependencies`);
    const summaryTotal = issue.issue_dependencies_summary?.total_blocked_by;
    if (typeof summaryTotal !== 'number' || !Number.isInteger(summaryTotal) || summaryTotal < 0) {
      return unknownDependencies('issue_dependencies_summary missing; completeness of blockers cannot be verified');
    }

    let open = 0;
    for (const blocker of blockers) {
      if (blocker.state === 'open') open += 1;
      else if (blocker.state !== 'closed') return unknownDependencies(`blocker with unexpected state "${String(blocker.state)}"`);
    }
    const total = blockers.length;
    if (summaryTotal > total) {
      // GitHub knows more blockers than this identity can see (e.g. cross-repo without access): fail closed.
      return unknownDependencies(`${summaryTotal - total} of ${summaryTotal} blockers not visible to identity (missing access?)`);
    }
    return {
      'dependencies.blocked_by_total': { known: true, value: total },
      'dependencies.blocked_by_open': { known: true, value: open },
      'dependencies.blocked': { known: true, value: open > 0 },
      'dependencies.status': { known: true, value: 'ok' },
    };
  }

  private async fetchIssue(itemId: string, identity: IdentityRef, signal?: AbortSignal): Promise<GitHubIssueJson | null> {
    if (!ITEM_ID_PATTERN.test(itemId)) return null;
    try {
      const res = await this.withToken(identity, signal, (token) =>
        this.http.request<GitHubIssueJson>('GET', `${this.repoPath}/issues/${itemId}`, { token, ...(signal ? { signal } : {}) }),
      );
      // Transferred issues redirect to another repository: not an item of this source.
      if (res.data.repository_url && !sameRepoUrl(res.data.repository_url, this.config.owner, this.config.repository)) return null;
      return res.data;
    } catch (err) {
      if (err instanceof SourceError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  /** Run `fn` with a token; on 401 invalidate the cached token and retry once. */
  private async withToken<T>(identity: IdentityRef, signal: AbortSignal | undefined, fn: (token: string) => Promise<T>): Promise<T> {
    const first = await this.credentials.getToken(identity, signal ? { signal } : {});
    try {
      return await fn(first.token);
    } catch (err) {
      if (!(err instanceof SourceError) || err.kind !== 'auth') throw err;
      // The credentials may have changed (e.g. a rotated token of another user): forget the cached login.
      this.userLogins.delete(identity);
      if (!this.credentials.invalidate) throw err;
      this.credentials.invalidate(identity);
      const second = await this.credentials.getToken(identity, signal ? { signal } : {});
      return fn(second.token);
    }
  }

  private toItem(issue: GitHubIssueJson): SourceItem {
    if (!Number.isInteger(issue.number) || issue.number <= 0) {
      throw new SourceError('invalid', `GitHub returned an item without a valid number in ${this.repository}`);
    }
    const itemId = String(issue.number);
    const isPr = issue.pull_request !== undefined && issue.pull_request !== null;
    const url = issue.html_url ?? `${(this.config.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')}/${this.repository}/${isPr ? 'pull' : 'issues'}/${itemId}`;
    return {
      sourceId: this.sourceId,
      itemId,
      key: sourceItemKey(this.sourceId, itemId),
      url,
      type: isPr ? 'pull_request' : 'issue',
      ...(issue.created_at ? { createdAt: issue.created_at } : {}),
      fields: {
        number: issue.number,
        title: issue.title ?? '',
        state: issue.state ?? null,
        labels: labelNames(issue),
        assignees: (issue.assignees ?? []).map((a) => a.login).filter((l): l is string => typeof l === 'string'),
        author: issue.user?.login ?? null,
        is_pull_request: isPr,
        created_at: issue.created_at ?? null,
        updated_at: issue.updated_at ?? null,
        url,
        repository: this.repository,
        state_reason: typeof issue.state_reason === 'string' ? issue.state_reason : null,
        milestone: typeof issue.milestone?.title === 'string' ? issue.milestone.title : null,
        issue_type: typeof issue.type?.name === 'string' ? issue.type.name : null,
      },
    };
  }

  private assertOwnItem(item: SourceItem): void {
    if (item.sourceId !== this.sourceId || !ITEM_ID_PATTERN.test(item.itemId)) {
      throw new SourceError('invalid', `Item ${item.key} does not belong to source "${this.sourceId}"`, { retryable: false });
    }
  }
}

/** Factory registered under type `github`. */
export function createGitHubSourceFactory(options: GitHubAdapterOptions = {}): SourceAdapterFactory<GitHubSourceConfig> {
  return {
    type: GITHUB_SOURCE_TYPE,
    create: (sourceId, config, deps) => new GitHubSourceAdapter(sourceId, config, deps, options),
  };
}

/** Default factory (real timers). */
export const githubSourceFactory: SourceAdapterFactory<GitHubSourceConfig> = createGitHubSourceFactory();

/** Render the HTML comment that carries an idempotency marker. */
export function renderMarker(marker: string): string {
  if (!MARKER_PATTERN.test(marker)) throw new SourceError('invalid', 'Comment marker contains unsupported characters', { retryable: false });
  return `<!-- ${marker} -->`;
}

/**
 * Regex matching the marker as the LAST line of the body, i.e. the marker that
 * `postComment` appends itself. A marker text inside the body (e.g. copied from
 * untrusted worker output into the message) is followed by the real marker and
 * therefore never matches — it cannot forge the idempotency check (WI-07 review).
 */
function markerPattern(marker: string): RegExp {
  const line = renderMarker(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)[ \\t]*${line}\\s*$`);
}

function unknownDependencies(reason: string): Record<string, FieldResolution> {
  return {
    'dependencies.blocked_by_total': { known: false, reason },
    'dependencies.blocked_by_open': { known: false, reason },
    'dependencies.blocked': { known: false, reason },
    // The status itself is always known: it says that the others are not.
    'dependencies.status': { known: true, value: 'unknown' },
  };
}

function labelNames(issue: GitHubIssueJson): string[] {
  return (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((l): l is string => typeof l === 'string' && l !== '');
}

function uniqueCaseInsensitive(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (v === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function sameRepoUrl(repositoryUrl: string, owner: string, repo: string): boolean {
  return repositoryUrl.toLowerCase().endsWith(`/repos/${owner}/${repo}`.toLowerCase());
}

function toCommentRef(comment: GitHubCommentJson): CommentRef {
  return { id: String(comment.id as string | number), ...(comment.html_url ? { url: comment.html_url } : {}) };
}
