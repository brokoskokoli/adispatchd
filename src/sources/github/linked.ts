/**
 * Linked branches and closing pull requests of an issue (WI-21): the expensive
 * fields `linked_branches`, `closing_prs`, `work_branch`, `work_pr` (and the
 * view link target `work_pr_url`), all from ONE GraphQL query per item:
 *
 * - issues: `linkedBranches(first: 20)` ("Development") and
 *   `closedByPullRequestsReferences(first: 20, includeClosedPrs: true)`;
 * - pull requests: their own `number`, `state` and `headRefName`.
 *
 * Only branches and PRs of the source repository count. Values travel only
 * as variables, never interpolated into the query text.
 *
 * Fail closed: an HTTP/GraphQL error, any partial error, an unexpected shape,
 * more results than read or a rate limit make ALL fields unknown (with the
 * reason) – never empty. After a rate limit, reads answer "unknown" without
 * calling GitHub until the limit resets (pause shared with WI-14).
 */
import { SourceError, type Clock, type FieldResolution, type IdentityRef, type Logger } from '../../core/index.js';
import { LINKED_FIELDS } from './fields.js';
import type { GitHubHttpClient, GraphQLErrorJson } from './http.js';
import { GRAPHQL_MAX_RETRY_WAIT_MS, GraphQLRateLimitPause } from './rate-limit.js';

/** Linked branches read per issue; more → unknown. */
export const LINKED_BRANCHES_FIRST = 20;
/** Closing PRs read per issue; more → unknown. */
export const CLOSING_PRS_FIRST = 20;

/** Name of a linked field. */
export type LinkedFieldName = (typeof LINKED_FIELDS)[number];

/** `closing_prs` entry state. */
export type ClosingPrState = 'open' | 'merged' | 'closed';

/** One entry of `closing_prs` (a type alias, so it is assignable to {@link FieldObject}). */
export type ClosingPr = {
  number: number;
  state: ClosingPrState;
  head_ref: string;
  is_draft: boolean;
  url: string;
};

/** The query (generated identifiers only; owner/name/number are variables). */
export const LINKED_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        linkedBranches(first: ${LINKED_BRANCHES_FIRST}) {
          totalCount
          nodes { ref { name repository { nameWithOwner } } }
        }
        closedByPullRequestsReferences(first: ${CLOSING_PRS_FIRST}, includeClosedPrs: true) {
          totalCount
          nodes { number state isDraft merged headRefName url isCrossRepository repository { nameWithOwner } }
        }
      }
      ... on PullRequest { number state isDraft merged headRefName url }
    }
  }
}`;

/** Runs `fn` with a token of `identity` (adapter: invalidate + one retry on 401). */
export type LinkedWithToken = <T>(identity: IdentityRef, signal: AbortSignal | undefined, fn: (token: string) => Promise<T>) => Promise<T>;

/** Settings of one source. */
export interface GitHubLinkedSettings {
  owner: string;
  repository: string;
  /** Identity of the reads (the source identity). */
  identity: IdentityRef;
}

type Json = Record<string, unknown>;

/** Values of all linked fields, or the reason why none can be determined. */
type Parsed = { values: Record<LinkedFieldName, FieldResolution> } | { reason: string };

/** Reads the linked fields of single items of one source. */
export class GitHubLinkedReader {
  private readonly pause: GraphQLRateLimitPause;
  private readonly repo: string;
  /** Last logged failure (warn only on changes, info on recovery). */
  private lastFailure: string | undefined;

  constructor(
    private readonly settings: GitHubLinkedSettings,
    private readonly deps: { http: GitHubHttpClient; clock: Clock; logger: Logger; withToken: LinkedWithToken },
  ) {
    this.repo = `${settings.owner}/${settings.repository}`;
    this.pause = new GraphQLRateLimitPause(deps, 'GitHub GraphQL rate limit: linked branches/PRs unknown until reset', {
      repository: this.repo,
    });
  }

  /**
   * All linked fields of item `number` (key `key` for messages). Never throws
   * except when `signal` is aborted: failures are `{ known: false, reason }`.
   */
  async resolve(number: number, key: string, signal?: AbortSignal): Promise<Record<LinkedFieldName, FieldResolution>> {
    const limited = this.pause.reason();
    if (limited) return unknownAll(limited);
    let parsed: Parsed;
    try {
      const res = await this.deps.withToken(this.settings.identity, signal, (token) =>
        this.deps.http.graphql<Json>(
          LINKED_QUERY,
          { owner: this.settings.owner, name: this.settings.repository, number },
          { token, maxRetryWaitMs: GRAPHQL_MAX_RETRY_WAIT_MS, ...(signal ? { signal } : {}) },
        ),
      );
      parsed = res.errors.length > 0 ? { reason: `GraphQL error: ${errorsText(res.errors)}` } : this.parse(res.data);
    } catch (err) {
      if (signal?.aborted) throw err;
      this.pause.note(err);
      parsed = { reason: err instanceof SourceError ? `${err.kind}: ${err.message}` : 'unexpected error' };
    }
    if ('reason' in parsed) {
      const reason = `linked branches/PRs of ${key} not readable: ${parsed.reason}`;
      this.noteFailure(parsed.reason, key);
      return unknownAll(reason);
    }
    this.noteFailure(undefined, key);
    return parsed.values;
  }

  private parse(data: Json | null): Parsed {
    const repository = obj(data?.repository);
    if (!repository) return { reason: 'repository not found or not accessible to the identity' };
    const node = obj(repository.issueOrPullRequest);
    if (!node) return { reason: 'item not found' };
    if (node.__typename === 'PullRequest') return this.parsePullRequest(node);
    if (node.__typename === 'Issue') return this.parseIssue(node);
    return { reason: `unexpected item type ${String(node.__typename)}` };
  }

  /** PR item: own head ref; own number while open. */
  private parsePullRequest(node: Json): Parsed {
    const pr = pullRequest(node);
    if ('reason' in pr) return pr;
    const open = pr.state === 'open';
    return {
      values: values({
        linked_branches: [],
        closing_prs: [],
        work_branch: pr.head_ref,
        work_pr: open ? pr.number : null,
        work_pr_url: open ? pr.url : null,
      }),
    };
  }

  private parseIssue(node: Json): Parsed {
    const branches = connection(node.linkedBranches, LINKED_BRANCHES_FIRST, 'linked branches');
    if ('reason' in branches) return branches;
    const linked: string[] = [];
    for (const entry of branches.nodes) {
      const ref = entry.ref;
      // A deleted branch stays linked without a ref: it is no usable work branch.
      if (ref === null || ref === undefined) continue;
      const r = obj(ref);
      const name = r?.name;
      const owner = obj(r?.repository)?.nameWithOwner;
      if (typeof name !== 'string' || name === '' || typeof owner !== 'string') return { reason: 'linked branch with unexpected shape' };
      if (this.sameRepo(owner) && !linked.includes(name)) linked.push(name);
    }

    const prs = connection(node.closedByPullRequestsReferences, CLOSING_PRS_FIRST, 'closing pull requests');
    if ('reason' in prs) return prs;
    const closing: Array<{ pr: ClosingPr; crossRepository: boolean }> = [];
    for (const entry of prs.nodes) {
      const pr = pullRequest(entry);
      if ('reason' in pr) return pr;
      const owner = obj(entry.repository)?.nameWithOwner;
      if (typeof owner !== 'string') return { reason: `closing pull request #${pr.number} without repository` };
      // Closing PRs of other repositories: their numbers and branches mean nothing here.
      if (!this.sameRepo(owner)) continue;
      closing.push({ pr, crossRepository: entry.isCrossRepository === true });
    }
    const order: Record<ClosingPrState, number> = { open: 0, merged: 1, closed: 2 };
    closing.sort((a, b) => order[a.pr.state] - order[b.pr.state] || a.pr.number - b.pr.number);

    const firstOpen = closing.find((c) => c.pr.state === 'open');
    // Branches of fork PRs do not exist in this repository: not a work branch.
    const branchOf = (state: ClosingPrState): string | undefined =>
      closing.find((c) => c.pr.state === state && !c.crossRepository)?.pr.head_ref;
    const workBranch = linked[0] ?? branchOf('open') ?? branchOf('merged') ?? null;
    return {
      values: values({
        linked_branches: linked,
        closing_prs: closing.map((c) => c.pr),
        work_branch: workBranch,
        work_pr: firstOpen?.pr.number ?? null,
        work_pr_url: firstOpen?.pr.url ?? null,
      }),
    };
  }

  private sameRepo(nameWithOwner: string): boolean {
    return nameWithOwner.toLowerCase() === this.repo.toLowerCase();
  }

  private noteFailure(reason: string | undefined, key: string): void {
    const previous = this.lastFailure;
    if (previous === reason) return;
    this.lastFailure = reason;
    if (reason !== undefined) this.deps.logger.warn('Could not read linked branches/PRs', { repository: this.repo, item: key, reason });
    else this.deps.logger.info('Linked branches/PRs readable again', { repository: this.repo });
  }
}

function values(v: {
  linked_branches: string[];
  closing_prs: ClosingPr[];
  work_branch: string | null;
  work_pr: number | null;
  work_pr_url: string | null;
}): Record<LinkedFieldName, FieldResolution> {
  return {
    linked_branches: { known: true, value: v.linked_branches },
    closing_prs: { known: true, value: v.closing_prs },
    work_branch: { known: true, value: v.work_branch },
    work_pr: { known: true, value: v.work_pr },
    work_pr_url: { known: true, value: v.work_pr_url },
  };
}

function unknownAll(reason: string): Record<LinkedFieldName, FieldResolution> {
  return Object.fromEntries(LINKED_FIELDS.map((f) => [f, { known: false, reason }])) as Record<LinkedFieldName, FieldResolution>;
}

function obj(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

/** Nodes of a connection; fail closed on missing/null nodes or more results than read. */
function connection(value: unknown, first: number, what: string): { nodes: Json[] } | { reason: string } {
  const c = obj(value);
  if (!c || !Array.isArray(c.nodes)) return { reason: `${what} missing in the response` };
  const nodes = c.nodes as unknown[];
  if (nodes.some((n) => obj(n) === undefined)) return { reason: `${what} not fully readable` };
  const total = typeof c.totalCount === 'number' ? c.totalCount : nodes.length;
  if (total > nodes.length || nodes.length > first) {
    return { reason: `more than ${Math.min(nodes.length, first)} ${what} (${total}); only the first ${first} are read` };
  }
  return { nodes: nodes as Json[] };
}

/** One PR node → entry; `{ reason }` for an unexpected shape. */
function pullRequest(node: Json): ClosingPr | { reason: string } {
  const { number, url, headRefName } = node;
  const state = prState(node.state, node.merged);
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return { reason: 'pull request without number' };
  if (!state) return { reason: `pull request #${number} with unexpected state ${String(node.state)}` };
  if (typeof headRefName !== 'string' || headRefName === '') return { reason: `pull request #${number} without head ref` };
  if (typeof url !== 'string') return { reason: `pull request #${number} without URL` };
  return { number, state, head_ref: headRefName, is_draft: node.isDraft === true, url };
}

function prState(state: unknown, merged: unknown): ClosingPrState | undefined {
  if (state === 'MERGED' || (state === 'CLOSED' && merged === true)) return 'merged';
  if (state === 'OPEN') return 'open';
  if (state === 'CLOSED') return 'closed';
  return undefined;
}

function errorsText(errors: readonly GraphQLErrorJson[]): string {
  return errors
    .slice(0, 3)
    .map((e) => `${e.type ? `${e.type}: ` : ''}${e.message ?? 'error'}`)
    .join('; ');
}
