/**
 * In-memory fake of the GitHub REST API subset used by the orchestrator,
 * exposed as an injectable `fetch` (no network). Shared test double for
 * WI-06 and the E2E tests of WI-07/08/09/10.
 *
 * Supported endpoints (relative to `baseUrl`):
 * - `POST /app/installations/{id}/access_tokens` (verifies the RS256 app JWT)
 * - `GET  /repos/{o}/{r}/issues` (`state`, `labels`, `sort=created`, `direction`, pagination)
 * - `GET  /repos/{o}/{r}/issues/{n}`
 * - `GET  /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` (pagination, cross-repo)
 * - `POST /repos/{o}/{r}/issues/{n}/labels`, `DELETE /repos/{o}/{r}/issues/{n}/labels/{name}`
 * - `GET|POST /repos/{o}/{r}/issues/{n}/comments` (pagination)
 * - `PATCH /repos/{o}/{r}/issues/{n}` (`state`, `title`)
 * - `GET  /repos/{o}/{r}/labels` (labels of {@link FakeGitHub.addRepoLabels} plus those used on items; pagination)
 * - `GET  /repos/{o}/{r}` (`default_branch`), `GET /repos/{o}/{r}/branches` (alphabetical) and
 *   `GET /repos/{o}/{r}/tags` (as set) of {@link FakeGitHub.setRepoRefs} (WI-31; pagination)
 * - `GET  /user` (user tokens from {@link FakeGitHub.createUserToken})
 * - `GET  /repos/{o}/{r}/issues/{n}/timeline` (WI-33; label changes and state changes through the API
 *   and the setup helpers are recorded with their actor, plus {@link FakeGitHub.addTimelineEvent}; pagination)
 * - `POST /graphql` (GHES: `/api/graphql`): the GitHub Projects (v2)
 *   queries of the adapter – `repositoryOwner { projectV2 }` metadata (field
 *   IDs, single-select options, iterations), `nodes(ids:) { projectItems {
 *   fieldValueByName } }` values, `node(id:)` of one issue/PR or project item
 *   (WI-16), and the mutations `addProjectV2ItemById`,
 *   `updateProjectV2ItemFieldValue` and `clearProjectV2ItemFieldValue`. Field
 *   names are taken from the variables `$f<i>` bound to the aliases `f<i>`;
 *   mutation inputs only from variables. Also `repository { issueOrPullRequest
 *   }` with `linkedBranches` / `closedByPullRequestsReferences` of an issue or
 *   `headRefName`/`state` of a PR (WI-21), with `owner`/`name`/`number` taken
 *   from the variables only.
 *
 * Fault injection: {@link FakeGitHub.failNext}; access control:
 * {@link FakeGitHub.restrictRepo}, {@link FakeGitHub.denyDependencies},
 * {@link FakeGitHub.denyProject}, {@link FakeGitHub.denyProjectWrites},
 * {@link FakeGitHub.denyLinked}.
 */
import { createPublicKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from 'node:crypto';
import { systemClock, type AccessToken, type Clock, type CredentialProvider, type FetchLike } from '../../../core/index.js';

/** Actor of a recorded timeline event (WI-33). */
export interface FakeTimelineActor {
  login: string;
  type: 'User' | 'Bot';
  /** App ID if performed through a GitHub App (`performed_via_github_app`). */
  viaAppId?: string;
}

/** A recorded timeline event (raw JSON as GitHub returns it, WI-33). */
export type FakeTimelineEvent = Record<string, unknown> & { event: string; created_at: string };

/** Initial values for {@link FakeGitHub.createIssue}. */
export interface FakeIssueInit {
  number?: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
  assignees?: string[];
  author?: string;
  isPullRequest?: boolean;
  createdAt?: string | Date;
  milestone?: string;
  /** Issue type name (`type.name`). */
  issueType?: string;
  stateReason?: string;
  /** PRs: head branch (default `pr-<number>`). */
  headRef?: string;
  /** PRs: draft. */
  isDraft?: boolean;
  /** PRs: numbers of issues in the same repository this PR closes ("Closes #n"). */
  closes?: number[];
  /** PRs: head branch lives in a fork (`isCrossRepository`). */
  crossRepository?: boolean;
}

/** Stored issue / pull request. Mutate via the helper methods. */
export interface FakeIssue {
  id: number;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  author: string;
  isPullRequest: boolean;
  createdAt: string;
  updatedAt: string;
  /** Blockers as `owner/repo#number` references (native "blocked by"). */
  blockedBy: Array<{ repo: string; number: number }>;
  /** GraphQL node ID (`node_id`). */
  nodeId: string;
  milestone: string | null;
  issueType: string | null;
  stateReason: string | null;
  /** PRs: head branch. */
  headRef: string | null;
  isDraft: boolean;
  merged: boolean;
  crossRepository: boolean;
  /** PRs: issues this PR closes. */
  closes: Array<{ repo: string; number: number }>;
  /** Issues: branches linked under "Development". */
  linkedBranches: Array<{ repo: string; name: string }>;
}

/** `dataType` of a fake project field (as in GitHub's `ProjectV2FieldType`). */
export type FakeProjectFieldDataType = 'SINGLE_SELECT' | 'TEXT' | 'NUMBER' | 'DATE' | 'ITERATION' | 'TITLE' | 'ASSIGNEES' | 'LABELS';

/** Field definition for {@link FakeGitHub.createProject}. */
export interface FakeProjectFieldInit {
  name: string;
  dataType: FakeProjectFieldDataType;
  /** Option names of a `SINGLE_SELECT` field. */
  options?: string[];
  /** Titles of the active/upcoming iterations of an `ITERATION` field. */
  iterations?: string[];
  /** Titles of completed iterations of an `ITERATION` field. */
  completedIterations?: string[];
}

/** Field of a fake GitHub project. */
export interface FakeProjectField {
  id: string;
  name: string;
  dataType: FakeProjectFieldDataType;
  options: Array<{ id: string; name: string }>;
  iterations: Array<{ id: string; title: string }>;
  completedIterations: Array<{ id: string; title: string }>;
}

/** Stored GitHub Projects (v2) project. */
export interface FakeProject {
  id: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  number: number;
  title: string;
  fields: FakeProjectField[];
  /** Issue node ID → field name → value (option name / iteration title; `null`/absent = empty). */
  items: Map<string, Record<string, string | number | null>>;
  /** Issue node ID → project item ID (`PVTI_…`). */
  itemIds: Map<string, string>;
}

/** Stored conversation comment. */
export interface FakeComment {
  id: number;
  body: string;
  author: string;
  /** GitHub `user.type`. */
  authorType: 'User' | 'Bot';
  /** App ID if the comment was written through a GitHub App (`performed_via_github_app`). */
  viaAppId?: string;
  createdAt: string;
}

/** Author details for {@link FakeGitHub.addComment}. */
export interface FakeCommentAuthor {
  type?: 'User' | 'Bot';
  /** Simulate a comment written through this GitHub App. */
  viaAppId?: string | number;
}

/** A recorded request (no token values, only whether one was sent). */
export interface FakeRequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Token presented in `Authorization` (for assertions in tests). */
  token: string | undefined;
  apiVersion: string | null;
  status: number | 'network_error';
  /** Parsed body of GraphQL requests. */
  graphql?: { query: string; variables: Record<string, unknown> };
}

/** Matcher for {@link FakeGitHub.failNext}. */
export interface FakeRequestMatcher {
  method?: string;
  /** Exact path or regex tested against the path (without base URL / query). */
  path?: string | RegExp;
  /** Query parameters that must all match (e.g. `{ page: '2' }`). */
  query?: Record<string, string>;
}

/** Injected failure. */
export type FakeFault =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  /** Simulated network error; with `afterApply` the request takes effect first (outcome unknown). */
  | { network: true; afterApply?: boolean };

/** Registered GitHub App installation. */
export interface FakeApp {
  appId: string;
  installationId: string;
  publicKey: KeyObject;
  /** Bot login used as comment author, e.g. `coder-bot[bot]`. */
  login: string;
}

/** Credentials generated by {@link FakeGitHub.createApp}. */
export interface FakeAppCredentials {
  appId: string;
  installationId: string;
  /** PKCS#8 PEM private key (test-only key). */
  privateKeyPem: string;
  login: string;
}

/** Options of {@link FakeGitHub}. */
export interface FakeGitHubOptions {
  clock?: Clock;
  /** API base URL the fake answers on. Default `https://api.github.com`. */
  baseUrl?: string;
  /** Web base URL used for `html_url`. Default `https://github.com`. */
  webBaseUrl?: string;
  /** Lifetime of issued installation tokens. Default 1 h. */
  tokenTtlMs?: number;
  /**
   * Require a valid installation token on `/repos/...` calls. Default: true
   * as soon as an app is registered, otherwise any (or no) token is accepted.
   */
  requireAuth?: boolean;
}

interface Fault {
  matcher: FakeRequestMatcher;
  fault: FakeFault;
  remaining: number;
}

interface IssuedToken {
  /** Installation token of this app … */
  app?: FakeApp;
  /** … or a user token (personal access token) of this login. */
  userLogin?: string;
  expiresAt: number;
}

/** In-memory GitHub fake. */
export class FakeGitHub {
  readonly baseUrl: string;
  readonly webBaseUrl: string;
  /** All requests in order. */
  readonly requests: FakeRequestRecord[] = [];
  /** Injectable fetch implementation. */
  readonly fetch: FetchLike;
  /** Include `issue_dependencies_summary` in issue JSON (set false to simulate its absence). */
  includeDependencySummary = true;

  private readonly clock: Clock;
  private readonly tokenTtlMs: number;
  private readonly requireAuthOption: boolean | undefined;
  private readonly repos = new Map<string, Map<number, FakeIssue>>();
  private readonly commentsByIssue = new Map<number, FakeComment[]>();
  /** Timeline per issue ID (WI-33). */
  private readonly timelines = new Map<number, FakeTimelineEvent[]>();
  private nextEventId = 90_000;
  private readonly apps = new Map<string, FakeApp>();
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly restricted = new Set<string>();
  private readonly deniedDependencies = new Set<string>();
  private readonly projects: FakeProject[] = [];
  private readonly ownerTypes = new Map<string, 'User' | 'Organization'>();
  private readonly deniedProjects = new Set<string>();
  private readonly deniedProjectWrites = new Set<string>();
  private readonly deniedLinked = new Set<string>();
  /** Labels defined in a repository besides those used on its items. */
  private readonly repoLabelDefs = new Map<string, Set<string>>();
  /** Branches/tags per repository (WI-31). */
  private readonly repoRefs = new Map<string, { defaultBranch: string; branches: string[]; tags: string[] }>();
  /** Deleted branches as `repo:name`. */
  private readonly deletedBranches = new Set<string>();
  private faults: Fault[] = [];
  private nextId = 1000;
  private nextCommentId = 5000;
  private nextApp = 1;

  constructor(options: FakeGitHubOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.webBaseUrl = (options.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '');
    this.tokenTtlMs = options.tokenTtlMs ?? 60 * 60_000;
    this.requireAuthOption = options.requireAuth;
    this.fetch = (input, init) => this.handle(input, init);
  }

  // ---------------------------------------------------------------- setup

  /** Create an issue (or PR with `isPullRequest`) in `repo` (`owner/name`). */
  createIssue(repo: string, init: FakeIssueInit = {}): FakeIssue {
    const issues = this.repoIssues(repo);
    const number = init.number ?? Math.max(0, ...issues.keys()) + 1;
    if (issues.has(number)) throw new Error(`Issue ${repo}#${number} already exists`);
    const created = init.createdAt ? new Date(init.createdAt).toISOString() : this.nowIso();
    const issue: FakeIssue = {
      id: this.nextId++,
      repo: normalizeRepo(repo),
      number,
      title: init.title ?? `Issue ${number}`,
      body: init.body ?? '',
      state: init.state ?? 'open',
      labels: [...(init.labels ?? [])],
      assignees: [...(init.assignees ?? [])],
      author: init.author ?? 'octocat',
      isPullRequest: init.isPullRequest ?? false,
      createdAt: created,
      updatedAt: created,
      blockedBy: [],
      nodeId: '',
      milestone: init.milestone ?? null,
      issueType: init.issueType ?? null,
      stateReason: init.stateReason ?? null,
      headRef: init.isPullRequest ? (init.headRef ?? `pr-${number}`) : null,
      isDraft: init.isDraft ?? false,
      merged: false,
      crossRepository: init.crossRepository ?? false,
      closes: (init.closes ?? []).map((n) => ({ repo: normalizeRepo(repo), number: n })),
      linkedBranches: [],
    };
    issue.nodeId = `${issue.isPullRequest ? 'PR' : 'I'}_kw${issue.id}`;
    issues.set(number, issue);
    return issue;
  }

  /** Get a stored issue; throws if missing. */
  issue(repo: string, number: number): FakeIssue {
    const issue = this.repoIssues(repo).get(number);
    if (!issue) throw new Error(`No issue ${repo}#${number}`);
    return issue;
  }

  /** Close an issue (timeline: `closed` by `actor`). */
  closeIssue(repo: string, number: number, actor: FakeTimelineActor = MANUAL_ACTOR): void {
    const issue = this.touch(this.issue(repo, number));
    if (issue.state !== 'closed') this.recordEvent(issue, 'closed', actor, { state_reason: 'completed' });
    issue.state = 'closed';
  }

  /** Reopen an issue (timeline: `reopened` by `actor`). */
  reopenIssue(repo: string, number: number, actor: FakeTimelineActor = MANUAL_ACTOR): void {
    const issue = this.touch(this.issue(repo, number));
    if (issue.state !== 'open') this.recordEvent(issue, 'reopened', actor);
    issue.state = 'open';
  }

  /** Replace the labels of an issue (simulates manual changes; timeline: `labeled`/`unlabeled` by `actor`). */
  setLabels(repo: string, number: number, labels: string[], actor: FakeTimelineActor = MANUAL_ACTOR): void {
    const issue = this.touch(this.issue(repo, number));
    const lower = (xs: readonly string[]) => new Set(xs.map((l) => l.toLowerCase()));
    const before = lower(issue.labels);
    const after = lower(labels);
    for (const l of issue.labels) if (!after.has(l.toLowerCase())) this.recordEvent(issue, 'unlabeled', actor, { label: { name: l } });
    for (const l of labels) if (!before.has(l.toLowerCase())) this.recordEvent(issue, 'labeled', actor, { label: { name: l } });
    issue.labels = [...labels];
  }

  /** Append a raw timeline event (WI-33), e.g. `{ event: 'cross-referenced', source: {…} }`; `created_at` defaults to now. */
  addTimelineEvent(repo: string, number: number, event: Omit<FakeTimelineEvent, 'created_at'> & { created_at?: string }, actor: FakeTimelineActor = MANUAL_ACTOR): FakeTimelineEvent {
    const issue = this.issue(repo, number);
    const { event: kind, ...rest } = event;
    return this.recordEvent(issue, String(kind), actor, rest);
  }

  /** Recorded timeline of an issue (WI-33). */
  timeline(repo: string, number: number): FakeTimelineEvent[] {
    return [...(this.timelines.get(this.issue(repo, number).id) ?? [])];
  }

  /** Label names of an issue. */
  labels(repo: string, number: number): string[] {
    return [...this.issue(repo, number).labels];
  }

  /** Mark `repo#number` as blocked by `blockerRepo#blockerNumber` (cross-repo allowed). */
  addBlockedBy(repo: string, number: number, blockerRepo: string, blockerNumber: number): void {
    this.issue(blockerRepo, blockerNumber); // must exist
    this.touch(this.issue(repo, number)).blockedBy.push({ repo: normalizeRepo(blockerRepo), number: blockerNumber });
  }

  /** Remove a blocked-by relation. */
  removeBlockedBy(repo: string, number: number, blockerRepo: string, blockerNumber: number): void {
    const issue = this.touch(this.issue(repo, number));
    issue.blockedBy = issue.blockedBy.filter((b) => !(b.repo === normalizeRepo(blockerRepo) && b.number === blockerNumber));
  }

  /** Open a pull request in `repo` (`isPullRequest` with head ref, optional "Closes #n"). */
  openPullRequest(repo: string, init: FakeIssueInit & { headRef: string }): FakeIssue {
    return this.createIssue(repo, { ...init, isPullRequest: true });
  }

  /** Merge a PR (closed + merged). The issues it closes are left unchanged (close them explicitly if needed). */
  mergePullRequest(repo: string, number: number): void {
    const pr = this.touch(this.issue(repo, number));
    if (!pr.isPullRequest) throw new Error(`${repo}#${number} is not a pull request`);
    pr.state = 'closed';
    pr.merged = true;
  }

  /** Let PR `prRepo#prNumber` close `repo#number` (cross-repository closing references). */
  addClosingReference(prRepo: string, prNumber: number, repo: string, number: number): void {
    this.issue(repo, number); // must exist
    this.touch(this.issue(prRepo, prNumber)).closes.push({ repo: normalizeRepo(repo), number });
  }

  /** Link a branch to an issue ("Development"); `branchRepo` defaults to the issue's repository. */
  linkBranch(repo: string, number: number, name: string, branchRepo: string = repo): void {
    this.touch(this.issue(repo, number)).linkedBranches.push({ repo: normalizeRepo(branchRepo), name });
    this.deletedBranches.delete(`${normalizeRepo(branchRepo)}:${name}`);
  }

  /** Delete a branch: links to it stay, but their `ref` is `null` (as on GitHub). */
  deleteBranch(repo: string, name: string): void {
    this.deletedBranches.add(`${normalizeRepo(repo)}:${name}`);
  }

  /** Answer the linked-branch query of one issue (or of all of `repo`) with a FORBIDDEN partial error. */
  denyLinked(repo: string, number?: number): void {
    this.deniedLinked.add(number === undefined ? normalizeRepo(repo) : `${normalizeRepo(repo)}#${number}`);
  }

  /** Comments of an issue (in creation order). */
  comments(repo: string, number: number): FakeComment[] {
    return [...(this.commentsByIssue.get(this.issue(repo, number).id) ?? [])];
  }

  /** Add a comment directly (default: a human `User` comment). */
  addComment(repo: string, number: number, body: string, author = 'octocat', as: FakeCommentAuthor = {}): FakeComment {
    const issue = this.touch(this.issue(repo, number));
    const comment: FakeComment = {
      id: this.nextCommentId++,
      body,
      author,
      authorType: as.type ?? (as.viaAppId !== undefined ? 'Bot' : 'User'),
      ...(as.viaAppId !== undefined ? { viaAppId: String(as.viaAppId) } : {}),
      createdAt: this.nowIso(),
    };
    const list = this.commentsByIssue.get(issue.id) ?? [];
    list.push(comment);
    this.commentsByIssue.set(issue.id, list);
    return comment;
  }

  /**
   * Simulate that no installation can access `repo`: its endpoints answer
   * 404 and its issues are omitted from other issues' blocked-by lists
   * (while still being counted in `issue_dependencies_summary`).
   */
  restrictRepo(repo: string): void {
    this.restricted.add(normalizeRepo(repo));
  }

  /** Undo {@link restrictRepo}. */
  unrestrictRepo(repo: string): void {
    this.restricted.delete(normalizeRepo(repo));
  }

  /** Answer 403 on the blocked-by endpoint of one issue (or of all issues of `repo`). */
  denyDependencies(repo: string, number?: number): void {
    this.deniedDependencies.add(number === undefined ? normalizeRepo(repo) : `${normalizeRepo(repo)}#${number}`);
  }

  /** Inject a failure for the next `times` matching requests. */
  failNext(matcher: FakeRequestMatcher, fault: FakeFault, times = 1): void {
    this.faults.push({ matcher, fault, remaining: times });
  }

  /** Register an app installation with a public key. */
  registerApp(app: { appId: string | number; installationId: string | number; publicKey: KeyObject | string; login?: string }): FakeApp {
    const entry: FakeApp = {
      appId: String(app.appId),
      installationId: String(app.installationId),
      publicKey: typeof app.publicKey === 'string' ? createPublicKey(app.publicKey) : app.publicKey,
      login: app.login ?? `app-${app.appId}[bot]`,
    };
    this.apps.set(entry.installationId, entry);
    return entry;
  }

  /** Generate a test RSA key pair and register a new app installation for it. */
  createApp(options: { login?: string; appId?: string | number; installationId?: string | number } = {}): FakeAppCredentials {
    const n = this.nextApp++;
    const appId = String(options.appId ?? 100000 + n);
    const installationId = String(options.installationId ?? 200000 + n);
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const app = this.registerApp({ appId, installationId, publicKey, ...(options.login ? { login: options.login } : {}) });
    return {
      appId,
      installationId,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      login: app.login,
    };
  }

  /**
   * Create a GitHub Projects (v2) project of `owner`. Projects of a `User`
   * owner are not readable with app installation tokens (as on GitHub); use
   * a user token ({@link createUserToken}) or {@link staticCredentials}.
   */
  createProject(
    owner: string,
    init: { number?: number; ownerType?: 'User' | 'Organization'; title?: string; fields: FakeProjectFieldInit[] },
  ): FakeProject {
    const login = owner.toLowerCase();
    const ownerType = init.ownerType ?? this.ownerTypes.get(login) ?? 'Organization';
    this.ownerTypes.set(login, ownerType);
    const number = init.number ?? Math.max(0, ...this.projects.filter((p) => p.owner === login).map((p) => p.number)) + 1;
    const project: FakeProject = {
      id: `PVT_kw${this.nextId++}`,
      owner: login,
      ownerType,
      number,
      title: init.title ?? `Project ${number}`,
      fields: init.fields.map((f) => this.newField(f)),
      items: new Map(),
      itemIds: new Map(),
    };
    this.projects.push(project);
    return project;
  }

  /** Add a field to an existing project (simulates a change of the board). */
  addProjectField(project: FakeProject, init: FakeProjectFieldInit): FakeProjectField {
    const field = this.newField(init);
    project.fields.push(field);
    return field;
  }

  /** Add an option to a single-select field of `project`. */
  addProjectOption(project: FakeProject, fieldName: string, name: string): void {
    const field = project.fields.find((f) => f.name === fieldName);
    if (!field) throw new Error(`No field ${fieldName} in project ${project.number}`);
    field.options.push({ id: `opt${this.nextId++}`, name });
  }

  private newField(f: FakeProjectFieldInit): FakeProjectField {
    return {
      id: `PVTF_kw${this.nextId++}`,
      name: f.name,
      dataType: f.dataType,
      options: (f.options ?? []).map((name) => ({ id: `opt${this.nextId++}`, name })),
      iterations: (f.iterations ?? []).map((title) => ({ id: `it${this.nextId++}`, title })),
      completedIterations: (f.completedIterations ?? []).map((title) => ({ id: `it${this.nextId++}`, title })),
    };
  }

  /** Add `repo#number` to `project` with field values (by exact project field name). */
  addProjectItem(project: FakeProject, repo: string, number: number, values: Record<string, string | number | null> = {}): void {
    const nodeId = this.issue(repo, number).nodeId;
    project.items.set(nodeId, { ...values });
    if (!project.itemIds.has(nodeId)) project.itemIds.set(nodeId, `PVTI_kw${this.nextId++}`);
  }

  /** Field values of `repo#number` in `project` (by exact field name), or `undefined` if not in the project. */
  projectValues(project: FakeProject, repo: string, number: number): Record<string, string | number | null> | undefined {
    const values = project.items.get(this.issue(repo, number).nodeId);
    return values ? { ...values } : undefined;
  }

  /** Change one field value of an item that is already in `project`. */
  setProjectValue(project: FakeProject, repo: string, number: number, field: string, value: string | number | null): void {
    const values = project.items.get(this.issue(repo, number).nodeId);
    if (!values) throw new Error(`${repo}#${number} is not in project ${project.number}`);
    values[field] = value;
  }

  /** Define labels in `repo` (listed by `GET /repos/{o}/{r}/labels` even if no item uses them). */
  addRepoLabels(repo: string, ...names: string[]): void {
    const key = normalizeRepo(repo);
    const set = this.repoLabelDefs.get(key) ?? new Set<string>();
    for (const n of names) set.add(n);
    this.repoLabelDefs.set(key, set);
  }

  /**
   * Branches (listed alphabetically like GitHub), tags (listed in the given
   * order, i.e. newest first) and the default branch of `repo` (WI-31).
   * Creates the repository if needed.
   */
  setRepoRefs(repo: string, refs: { defaultBranch?: string; branches?: string[]; tags?: string[] }): void {
    const key = normalizeRepo(repo);
    this.repoIssues(key);
    const branches = [...(refs.branches ?? ['main'])];
    this.repoRefs.set(key, { defaultBranch: refs.defaultBranch ?? branches[0] ?? 'main', branches, tags: [...(refs.tags ?? [])] });
  }

  /** Make a project unreadable for every token (GraphQL answers `projectV2: null` + FORBIDDEN error). */
  denyProject(project: FakeProject): void {
    this.deniedProjects.add(project.id);
  }

  /** Make a project read-only for every token (mutations answer `FORBIDDEN` with HTTP 200). */
  denyProjectWrites(project: FakeProject): void {
    this.deniedProjectWrites.add(project.id);
  }

  /** Undo {@link denyProject} and {@link denyProjectWrites}. */
  allowProject(project: FakeProject): void {
    this.deniedProjects.delete(project.id);
    this.deniedProjectWrites.delete(project.id);
  }

  /** Recorded GraphQL mutations (`addProjectV2ItemById`, `updateProjectV2ItemFieldValue`, `clearProjectV2ItemFieldValue`). */
  projectMutations(): Array<{ name: string; variables: Record<string, unknown>; status: number | 'network_error' }> {
    return this.requests
      .filter((r) => r.graphql && /^\s*mutation\b/.test(r.graphql.query))
      .map((r) => ({ name: mutationName(r.graphql?.query ?? ''), variables: r.graphql?.variables ?? {}, status: r.status }));
  }

  /** Issue a user token (personal access token) for `login`; comments made with it are authored by `login`. */
  createUserToken(login: string): string {
    const token = `ghp_fake${randomBytes(12).toString('hex')}`;
    this.tokens.set(token, { userLogin: login, expiresAt: Number.MAX_SAFE_INTEGER });
    return token;
  }

  /** Number of installation tokens issued so far. */
  tokenRequestCount(): number {
    return this.requests.filter((r) => r.method === 'POST' && /^\/app\/installations\/[^/]+\/access_tokens$/.test(r.path) && r.status === 201)
      .length;
  }

  // ---------------------------------------------------------------- HTTP

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const rawBody = init?.body ?? (request ? await request.text() : undefined);
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');

    const basePath = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
    const record: FakeRequestRecord = {
      method,
      path: url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || '/' : url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      token: bearer(headers),
      apiVersion: headers.get('x-github-api-version'),
      status: 0,
    };
    if (method === 'POST' && isGraphqlPath(url.pathname, basePath)) {
      const body = parseBody(rawBody);
      record.graphql = {
        query: typeof body.query === 'string' ? body.query : '',
        variables: body.variables && typeof body.variables === 'object' ? (body.variables as Record<string, unknown>) : {},
      };
    }
    this.requests.push(record);

    if (url.origin !== new URL(this.baseUrl).origin) {
      record.status = 'network_error';
      throw new TypeError('fetch failed');
    }

    const fault = this.takeFault(method, record.path, record.query);
    if (fault && 'network' in fault) {
      if (fault.afterApply) this.route(method, record.path, url, headers, rawBody);
      record.status = 'network_error';
      throw new TypeError('fetch failed');
    }
    if (fault) {
      record.status = fault.status;
      return json(fault.status, fault.body ?? { message: `Injected HTTP ${fault.status}` }, fault.headers);
    }

    const res = this.route(method, record.path, url, headers, rawBody);
    record.status = res.status;
    return res;
  }

  private takeFault(method: string, path: string, query: Record<string, string>): FakeFault | undefined {
    const idx = this.faults.findIndex(
      (f) =>
        (f.matcher.method === undefined || f.matcher.method.toUpperCase() === method) &&
        (f.matcher.path === undefined || (typeof f.matcher.path === 'string' ? f.matcher.path === path : f.matcher.path.test(path))) &&
        Object.entries(f.matcher.query ?? {}).every(([k, v]) => query[k] === v),
    );
    if (idx < 0) return undefined;
    const f = this.faults[idx] as Fault;
    f.remaining -= 1;
    if (f.remaining <= 0) this.faults.splice(idx, 1);
    return f.fault;
  }

  private route(method: string, path: string, url: URL, headers: Headers, rawBody: unknown): Response {
    const tokenMatch = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
    if (tokenMatch) {
      if (method !== 'POST') return json(404, { message: 'Not Found' });
      return this.issueToken(decodeURIComponent(tokenMatch[1] as string), headers);
    }

    if (method === 'POST' && isGraphqlPath(url.pathname, new URL(this.baseUrl).pathname.replace(/\/+$/, ''))) {
      const auth = this.authenticate(headers);
      if (auth instanceof Response) return auth;
      return this.graphql(parseBody(rawBody), auth);
    }
    if (path === '/user' && method === 'GET') {
      const auth = this.authenticate(headers);
      if (auth instanceof Response) return auth;
      if (auth?.userLogin) return json(200, { login: auth.userLogin, type: 'User' });
      if (auth?.app) return json(403, { message: 'Resource not accessible by integration' });
      return json(401, { message: 'Requires authentication' });
    }

    const labelsMatch = /^\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(path);
    if (labelsMatch && method === 'GET') {
      const repo = normalizeRepo(`${decodeURIComponent(labelsMatch[1] as string)}/${decodeURIComponent(labelsMatch[2] as string)}`);
      const auth = this.authenticate(headers);
      if (auth instanceof Response) return auth;
      if (this.restricted.has(repo) || !this.repos.has(repo)) return json(404, { message: 'Not Found' });
      const names = new Map<string, string>();
      for (const n of this.repoLabelDefs.get(repo) ?? []) names.set(n.toLowerCase(), n);
      for (const issue of this.repoIssues(repo).values()) for (const n of issue.labels) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
      return this.page([...names.values()].sort().map((name) => ({ name })), url);
    }
    const refsMatch = /^\/repos\/([^/]+)\/([^/]+)(\/branches|\/tags)?$/.exec(path);
    if (refsMatch && method === 'GET') {
      const repo = normalizeRepo(`${decodeURIComponent(refsMatch[1] as string)}/${decodeURIComponent(refsMatch[2] as string)}`);
      const auth = this.authenticate(headers);
      if (auth instanceof Response) return auth;
      if (this.restricted.has(repo) || !this.repos.has(repo)) return json(404, { message: 'Not Found' });
      const refs = this.repoRefs.get(repo) ?? { defaultBranch: 'main', branches: ['main'], tags: [] };
      if (refsMatch[3] === '/branches') return this.page([...refs.branches].sort().map((name) => ({ name, protected: false })), url);
      if (refsMatch[3] === '/tags') return this.page(refs.tags.map((name) => ({ name })), url);
      return json(200, { full_name: repo, default_branch: refs.defaultBranch });
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/issues(?:\/(\d+)(\/.*)?)?$/.exec(path);
    if (!m) return json(404, { message: 'Not Found' });
    const repo = normalizeRepo(`${decodeURIComponent(m[1] as string)}/${decodeURIComponent(m[2] as string)}`);
    const auth = this.authenticate(headers);
    if (auth instanceof Response) return auth;
    if (this.restricted.has(repo) || !this.repos.has(repo)) return json(404, { message: 'Not Found' });

    const number = m[3] === undefined ? undefined : Number(m[3]);
    const rest = m[4] ?? '';
    if (number === undefined) {
      if (method === 'GET') return this.listIssues(repo, url);
      return json(404, { message: 'Not Found' });
    }
    const issue = this.repoIssues(repo).get(number);
    if (!issue) return json(404, { message: 'Not Found' });
    const body = parseBody(rawBody);

    if (rest === '') {
      if (method === 'GET') return json(200, this.issueJson(issue));
      if (method === 'PATCH') {
        const patch = body as { state?: unknown; title?: unknown };
        if ((patch.state === 'open' || patch.state === 'closed') && patch.state !== issue.state) {
          this.recordEvent(issue, patch.state === 'closed' ? 'closed' : 'reopened', actorOf(auth));
          issue.state = patch.state;
        }
        if (typeof patch.title === 'string') issue.title = patch.title;
        this.touch(issue);
        return json(200, this.issueJson(issue));
      }
    }
    if (rest === '/dependencies/blocked_by' && method === 'GET') {
      if (this.deniedDependencies.has(repo) || this.deniedDependencies.has(`${repo}#${number}`)) {
        return json(403, { message: 'Resource not accessible by integration' });
      }
      const visible = issue.blockedBy
        .filter((b) => !this.restricted.has(b.repo))
        .map((b) => this.repoIssues(b.repo).get(b.number))
        .filter((b): b is FakeIssue => b !== undefined)
        .map((b) => this.issueJson(b, true));
      return this.page(visible, url);
    }
    if (rest === '/labels' && method === 'POST') {
      const labels = (body as { labels?: unknown }).labels;
      if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) return json(422, { message: 'Validation Failed' });
      for (const label of labels as string[]) {
        if (!issue.labels.some((l) => l.toLowerCase() === label.toLowerCase())) {
          issue.labels.push(label);
          this.recordEvent(issue, 'labeled', actorOf(auth), { label: { name: label } });
        }
      }
      this.touch(issue);
      return json(200, issue.labels.map((name) => ({ name })));
    }
    const labelMatch = /^\/labels\/(.+)$/.exec(rest);
    if (labelMatch && method === 'DELETE') {
      const name = decodeURIComponent(labelMatch[1] as string);
      const idx = issue.labels.findIndex((l) => l.toLowerCase() === name.toLowerCase());
      if (idx < 0) return json(404, { message: 'Label does not exist' });
      const [removed] = issue.labels.splice(idx, 1);
      this.recordEvent(issue, 'unlabeled', actorOf(auth), { label: { name: removed } });
      this.touch(issue);
      return json(200, issue.labels.map((n) => ({ name: n })));
    }
    if (rest === '/timeline' && method === 'GET') {
      return this.page(this.timelines.get(issue.id) ?? [], url);
    }
    if (rest === '/comments') {
      if (method === 'GET') {
        return this.page(
          (this.commentsByIssue.get(issue.id) ?? []).map((c) => this.commentJson(repo, issue, c)),
          url,
        );
      }
      if (method === 'POST') {
        const text = (body as { body?: unknown }).body;
        if (typeof text !== 'string' || text === '') return json(422, { message: 'Validation Failed' });
        const comment = auth?.app
          ? this.addComment(repo, number, text, auth.app.login, { type: 'Bot', viaAppId: auth.app.appId })
          : auth?.userLogin
            ? this.addComment(repo, number, text, auth.userLogin, { type: 'User' })
            : this.addComment(repo, number, text, 'test-bot[bot]', { type: 'Bot' });
        return json(201, this.commentJson(repo, issue, comment));
      }
    }
    return json(404, { message: 'Not Found' });
  }

  private requireAuth(): boolean {
    return this.requireAuthOption ?? this.apps.size > 0;
  }

  /** Returns the token owner, `undefined` when auth is not required, or a 401 response. */
  private authenticate(headers: Headers): IssuedToken | undefined | Response {
    const token = bearer(headers);
    const issued = token ? this.tokens.get(token) : undefined;
    if (issued && issued.expiresAt > this.clock.now().getTime()) return issued;
    if (!this.requireAuth()) return undefined;
    return json(401, { message: 'Bad credentials' });
  }

  // ------------------------------------------------------------- GraphQL

  private graphql(body: Record<string, unknown>, auth: IssuedToken | undefined): Response {
    const query = typeof body.query === 'string' ? body.query : '';
    const variables = (body.variables && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
    if (/^\s*mutation\b/.test(query)) return this.graphqlMutation(query, variables, auth);
    if (query.includes('repositoryOwner(')) return this.graphqlMetadata(variables, auth);
    if (query.includes('issueOrPullRequest(')) return this.graphqlIssueOrPullRequest(query, variables);
    if (query.includes('nodes(ids:')) return this.graphqlNodes(query, variables, auth);
    if (query.includes('node(id:')) return this.graphqlNode(query, variables, auth);
    return json(200, { errors: [{ message: 'Unsupported query in FakeGitHub' }] });
  }

  private projectReadable(project: FakeProject, auth: IssuedToken | undefined): boolean {
    if (this.deniedProjects.has(project.id)) return false;
    // GitHub App installation tokens cannot read user-owned projects.
    return !(project.ownerType === 'User' && auth?.app);
  }

  private graphqlMetadata(variables: Record<string, unknown>, auth: IssuedToken | undefined): Response {
    const owner = String(variables.owner ?? '').toLowerCase();
    const ownerType = this.ownerTypes.get(owner);
    if (!ownerType) {
      return json(200, {
        data: { repositoryOwner: null },
        errors: [{ type: 'NOT_FOUND', path: ['repositoryOwner'], message: `Could not resolve to a RepositoryOwner with the login of '${owner}'.` }],
      });
    }
    const project = this.projects.find((p) => p.owner === owner && p.number === Number(variables.number));
    if (!project || !this.projectReadable(project, auth)) {
      return json(200, {
        data: { repositoryOwner: { __typename: ownerType, projectV2: null } },
        errors: project
          ? [{ type: 'FORBIDDEN', path: ['repositoryOwner', 'projectV2'], message: 'Resource not accessible by integration' }]
          : [{ type: 'NOT_FOUND', path: ['repositoryOwner', 'projectV2'], message: `Could not resolve to a ProjectV2 with the number ${String(variables.number)}.` }],
      });
    }
    return json(200, {
      data: {
        repositoryOwner: {
          __typename: ownerType,
          projectV2: {
            id: project.id,
            title: project.title,
            fields: { nodes: project.fields.map((f) => fieldMetadataJson(f)) },
          },
        },
      },
    });
  }

  private graphqlNodes(query: string, variables: Record<string, unknown>, auth: IssuedToken | undefined): Response {
    const ids = Array.isArray(variables.ids) ? variables.ids.map(String) : [];
    if (ids.length > 100) return json(200, { errors: [{ type: 'EXCESSIVE_PAGINATION', message: 'Too many ids' }] });
    const aliases = fieldAliases(query, variables);
    const firstMatch = /projectItems\(first: (\d+)/.exec(query);
    const first = firstMatch ? Number(firstMatch[1]) : 20;
    const byNodeId = new Map<string, FakeIssue>();
    for (const issues of this.repos.values()) for (const issue of issues.values()) byNodeId.set(issue.nodeId, issue);
    const errors: unknown[] = [];
    const nodes = ids.map((id, index) => {
      const issue = byNodeId.get(id);
      if (!issue || this.restricted.has(issue.repo)) {
        errors.push({ type: 'NOT_FOUND', path: ['nodes', index], message: `Could not resolve to a node with the global id of '${id}'` });
        return null;
      }
      // Memberships in projects the token cannot read come back as null + FORBIDDEN error (conservative model).
      const memberships = this.projects.filter((p) => p.items.has(id));
      return {
        __typename: issue.isPullRequest ? 'PullRequest' : 'Issue',
        projectItems: {
          totalCount: memberships.length,
          nodes: memberships.slice(0, first).map((p, k) => {
            if (!this.projectReadable(p, auth)) {
              errors.push({ type: 'FORBIDDEN', path: ['nodes', index, 'projectItems', 'nodes', k], message: 'Resource not accessible by integration' });
              return null;
            }
            return this.projectItemJson(p, id, aliases);
          }),
        },
      };
    });
    return json(200, { data: { nodes }, ...(errors.length > 0 ? { errors } : {}) });
  }

  /** `{ id, project { id }, f<i>: fieldValueByName(…) }` of the item of issue `nodeId` in `project`. */
  private projectItemJson(project: FakeProject, nodeId: string, aliases: ReadonlyArray<{ alias: string; name: string }>): Record<string, unknown> {
    const values = project.items.get(nodeId) ?? {};
    const entry: Record<string, unknown> = { id: project.itemIds.get(nodeId), project: { id: project.id } };
    for (const { alias, name } of aliases) {
      // fieldValueByName matches the exact field name here (GitHub's behaviour is not relied upon).
      const field = project.fields.find((f) => f.name === name);
      const value = values[name];
      entry[alias] = field && value !== null && value !== undefined ? fieldValueJson(field, value) : null;
    }
    return entry;
  }

  /** `node(id:)` of one issue/PR (with `projectItems`) or of one project item (WI-16 write path). */
  private graphqlNode(query: string, variables: Record<string, unknown>, auth: IssuedToken | undefined): Response {
    const id = String(variables.id ?? '');
    const aliases = fieldAliases(query, variables);
    const firstMatch = /projectItems\(first: (\d+)/.exec(query);
    const first = firstMatch ? Number(firstMatch[1]) : 20;
    const notFound = (): Response =>
      json(200, { data: { node: null }, errors: [{ type: 'NOT_FOUND', path: ['node'], message: `Could not resolve to a node with the global id of '${id}'` }] });
    for (const p of this.projects) {
      for (const [nodeId, itemId] of p.itemIds) {
        if (itemId !== id || !p.items.has(nodeId)) continue;
        if (!this.projectReadable(p, auth)) return notFound();
        return json(200, { data: { node: { __typename: 'ProjectV2Item', ...this.projectItemJson(p, nodeId, aliases) } } });
      }
    }
    const issue = this.issueByNodeId(id);
    if (!issue || this.restricted.has(issue.repo)) return notFound();
    const errors: unknown[] = [];
    const memberships = this.projects.filter((p) => p.items.has(id));
    const node = {
      __typename: issue.isPullRequest ? 'PullRequest' : 'Issue',
      id,
      projectItems: {
        totalCount: memberships.length,
        nodes: memberships.slice(0, first).map((p, k) => {
          if (!this.projectReadable(p, auth)) {
            errors.push({ type: 'FORBIDDEN', path: ['node', 'projectItems', 'nodes', k], message: 'Resource not accessible by integration' });
            return null;
          }
          return this.projectItemJson(p, id, aliases);
        }),
      },
    };
    return json(200, { data: { node }, ...(errors.length > 0 ? { errors } : {}) });
  }

  /** `repository(owner:, name:) { issueOrPullRequest(number:) { … } }` (WI-21); arguments from the variables only. */
  private graphqlIssueOrPullRequest(query: string, variables: Record<string, unknown>): Response {
    const repo = `${String(variables.owner ?? '')}/${String(variables.name ?? '')}`.toLowerCase();
    if (this.restricted.has(repo) || !this.repos.has(repo)) {
      return json(200, {
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', path: ['repository'], message: `Could not resolve to a Repository with the name '${repo}'.` }],
      });
    }
    const issue = this.repoIssues(repo).get(Number(variables.number));
    if (!issue) {
      return json(200, {
        data: { repository: { issueOrPullRequest: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'issueOrPullRequest'], message: 'Could not resolve to an issue or pull request.' }],
      });
    }
    if (issue.isPullRequest) return json(200, { data: { repository: { issueOrPullRequest: this.pullRequestJson(issue) } } });
    const firstOf = (field: string): number => Number(new RegExp(`${field}\\(first: (\\d+)`).exec(query)?.[1] ?? 20);
    const links = issue.linkedBranches.map((b) => ({
      ref: this.deletedBranches.has(`${b.repo}:${b.name}`) ? null : { name: b.name, repository: { nameWithOwner: b.repo } },
    }));
    const closing = [...this.repos.values()]
      .flatMap((issues) => [...issues.values()])
      .filter((pr) => pr.isPullRequest && pr.closes.some((c) => c.repo === issue.repo && c.number === issue.number))
      .sort((a, b) => a.id - b.id)
      .map((pr) => this.pullRequestJson(pr));
    const denied = this.deniedLinked.has(repo) || this.deniedLinked.has(`${repo}#${issue.number}`);
    const node = {
      __typename: 'Issue',
      linkedBranches: { totalCount: links.length, nodes: links.slice(0, firstOf('linkedBranches')) },
      closedByPullRequestsReferences: denied
        ? null
        : { totalCount: closing.length, nodes: closing.slice(0, firstOf('closedByPullRequestsReferences')) },
    };
    return json(200, {
      data: { repository: { issueOrPullRequest: node } },
      ...(denied
        ? {
            errors: [
              {
                type: 'FORBIDDEN',
                path: ['repository', 'issueOrPullRequest', 'closedByPullRequestsReferences'],
                message: 'Resource not accessible by integration',
              },
            ],
          }
        : {}),
    });
  }

  private pullRequestJson(pr: FakeIssue): Record<string, unknown> {
    return {
      __typename: 'PullRequest',
      number: pr.number,
      state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pr.merged,
      isDraft: pr.isDraft,
      headRefName: pr.headRef,
      url: `${this.webBaseUrl}/${pr.repo}/pull/${pr.number}`,
      isCrossRepository: pr.crossRepository,
      repository: { nameWithOwner: pr.repo },
    };
  }

  /** The three project mutations; inputs are read from the variables only. */
  private graphqlMutation(query: string, variables: Record<string, unknown>, auth: IssuedToken | undefined): Response {
    const name = mutationName(query);
    const fail = (type: string | undefined, message: string): Response =>
      json(200, { data: { [name]: null }, errors: [{ ...(type ? { type } : {}), path: [name], message }] });
    const project = this.projects.find((p) => p.id === variables.projectId);
    if (!project || this.deniedProjects.has(project.id)) {
      return fail('NOT_FOUND', `Could not resolve to a node with the global id of '${String(variables.projectId)}'`);
    }
    if (!this.projectReadable(project, auth) || this.deniedProjectWrites.has(project.id)) {
      return fail('FORBIDDEN', 'Resource not accessible by integration');
    }
    if (name === 'addProjectV2ItemById') {
      const issue = this.issueByNodeId(String(variables.contentId ?? ''));
      if (!issue || this.restricted.has(issue.repo)) {
        return fail('NOT_FOUND', `Could not resolve to a node with the global id of '${String(variables.contentId)}'`);
      }
      // Idempotent like GitHub: an existing item is returned unchanged.
      if (!project.items.has(issue.nodeId)) this.addProjectItem(project, issue.repo, issue.number);
      return json(200, { data: { addProjectV2ItemById: { item: { id: project.itemIds.get(issue.nodeId) } } } });
    }
    if (name !== 'updateProjectV2ItemFieldValue' && name !== 'clearProjectV2ItemFieldValue') {
      return json(200, { errors: [{ message: 'Unsupported mutation in FakeGitHub' }] });
    }
    const nodeId = [...project.itemIds].find(([, itemId]) => itemId === variables.itemId)?.[0];
    const values = nodeId === undefined ? undefined : project.items.get(nodeId);
    if (!values) return fail('NOT_FOUND', `Could not resolve to a node with the global id of '${String(variables.itemId)}'`);
    const field = project.fields.find((f) => f.id === variables.fieldId);
    if (!field) return fail('NOT_FOUND', `Could not resolve to a node with the global id of '${String(variables.fieldId)}'`);
    if (name === 'clearProjectV2ItemFieldValue') {
      values[field.name] = null;
      return json(200, { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } } });
    }
    const value = (variables.value ?? {}) as Record<string, unknown>;
    if (Object.keys(value).length !== 1) return fail(undefined, 'Exactly one value must be provided');
    let stored: string | number | undefined;
    switch (field.dataType) {
      case 'SINGLE_SELECT':
        stored = field.options.find((o) => o.id === value.singleSelectOptionId)?.name;
        break;
      case 'ITERATION':
        stored = [...field.iterations, ...field.completedIterations].find((i) => i.id === value.iterationId)?.title;
        break;
      case 'NUMBER':
        stored = typeof value.number === 'number' ? value.number : undefined;
        break;
      case 'DATE':
        stored = typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : undefined;
        break;
      case 'TEXT':
        stored = typeof value.text === 'string' ? value.text : undefined;
        break;
      default:
        stored = undefined;
    }
    if (stored === undefined) return fail(undefined, `Invalid value for field "${field.name}" (${field.dataType})`);
    values[field.name] = stored;
    return json(200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } } });
  }

  private issueByNodeId(nodeId: string): FakeIssue | undefined {
    for (const issues of this.repos.values()) for (const issue of issues.values()) if (issue.nodeId === nodeId) return issue;
    return undefined;
  }

  private issueToken(installationId: string, headers: Headers): Response {
    const app = this.apps.get(installationId);
    if (!app) return json(404, { message: 'Not Found' });
    const jwt = bearer(headers);
    if (!jwt || !verifyAppJwt(jwt, app, this.clock.now())) {
      return json(401, { message: 'A JSON web token could not be decoded' });
    }
    const token = `ghs_fake${randomBytes(12).toString('hex')}`;
    const expiresAt = this.clock.now().getTime() + this.tokenTtlMs;
    this.tokens.set(token, { app, expiresAt });
    return json(201, { token, expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }

  private listIssues(repo: string, url: URL): Response {
    const state = url.searchParams.get('state') ?? 'open';
    const labels = (url.searchParams.get('labels') ?? '')
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l !== '');
    const direction = url.searchParams.get('direction') ?? 'desc';
    const issues = [...this.repoIssues(repo).values()]
      .filter((i) => state === 'all' || i.state === state)
      .filter((i) => labels.every((l) => i.labels.some((x) => x.toLowerCase() === l)))
      .sort((a, b) => (a.createdAt === b.createdAt ? a.number - b.number : a.createdAt < b.createdAt ? -1 : 1));
    if (direction === 'desc') issues.reverse();
    return this.page(
      issues.map((i) => this.issueJson(i)),
      url,
    );
  }

  private page(all: unknown[], url: URL): Response {
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const links: string[] = [];
    const linkTo = (p: number, rel: string): void => {
      const next = new URL(url.toString());
      next.searchParams.set('page', String(p));
      next.searchParams.set('per_page', String(perPage));
      links.push(`<${next.toString()}>; rel="${rel}"`);
    };
    if (page < lastPage) {
      linkTo(page + 1, 'next');
      linkTo(lastPage, 'last');
    }
    if (page > 1) {
      linkTo(1, 'first');
      linkTo(page - 1, 'prev');
    }
    return json(200, slice, links.length > 0 ? { link: links.join(', ') } : undefined);
  }

  private issueJson(issue: FakeIssue, withRepository = false): Record<string, unknown> {
    const [owner, name] = issue.repo.split('/');
    const htmlUrl = `${this.webBaseUrl}/${issue.repo}/${issue.isPullRequest ? 'pull' : 'issues'}/${issue.number}`;
    const blockers = issue.blockedBy.map((b) => this.repoIssues(b.repo).get(b.number)).filter((b): b is FakeIssue => b !== undefined);
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      html_url: htmlUrl,
      url: `${this.baseUrl}/repos/${issue.repo}/issues/${issue.number}`,
      repository_url: `${this.baseUrl}/repos/${issue.repo}`,
      labels: issue.labels.map((l) => ({ name: l })),
      assignees: issue.assignees.map((login) => ({ login })),
      user: { login: issue.author },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      node_id: issue.nodeId,
      state_reason: issue.stateReason,
      milestone: issue.milestone !== null ? { title: issue.milestone, number: 1 } : null,
      type: issue.issueType !== null ? { name: issue.issueType } : null,
      ...(issue.isPullRequest ? { pull_request: { html_url: htmlUrl } } : {}),
      ...(this.includeDependencySummary
        ? {
            issue_dependencies_summary: {
              blocked_by: blockers.filter((b) => b.state === 'open').length,
              total_blocked_by: blockers.length,
              blocking: 0,
              total_blocking: 0,
            },
          }
        : {}),
      ...(withRepository ? { repository: { full_name: issue.repo, owner: { login: owner }, name } } : {}),
    };
  }

  private commentJson(repo: string, issue: FakeIssue, comment: FakeComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.author, type: comment.authorType },
      performed_via_github_app: comment.viaAppId !== undefined ? { id: Number(comment.viaAppId), slug: comment.author.replace(/\[bot\]$/, '') } : null,
      created_at: comment.createdAt,
      html_url: `${this.webBaseUrl}/${repo}/${issue.isPullRequest ? 'pull' : 'issues'}/${issue.number}#issuecomment-${comment.id}`,
    };
  }

  private repoIssues(repo: string): Map<number, FakeIssue> {
    const key = normalizeRepo(repo);
    let issues = this.repos.get(key);
    if (!issues) {
      issues = new Map();
      this.repos.set(key, issues);
    }
    return issues;
  }

  private recordEvent(issue: FakeIssue, kind: string, actor: FakeTimelineActor, extra: Record<string, unknown> = {}): FakeTimelineEvent {
    const list = this.timelines.get(issue.id) ?? [];
    const event: FakeTimelineEvent = {
      id: this.nextEventId++,
      node_id: `E_${this.nextEventId}`,
      event: kind,
      actor: { login: actor.login, type: actor.type },
      performed_via_github_app: actor.viaAppId !== undefined ? { id: Number(actor.viaAppId), slug: actor.login.replace(/\[bot\]$/, '') } : null,
      created_at: this.nowIso(),
      ...extra,
    };
    list.push(event);
    this.timelines.set(issue.id, list);
    return event;
  }

  private touch(issue: FakeIssue): FakeIssue {
    issue.updatedAt = this.nowIso();
    return issue;
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

/** Default actor of setup helpers (a person changing the issue on GitHub). */
const MANUAL_ACTOR: FakeTimelineActor = { login: 'octocat', type: 'User' };

/** Timeline actor of an API request. */
function actorOf(auth: IssuedToken | undefined): FakeTimelineActor {
  if (auth?.app) return { login: auth.app.login, type: 'Bot', viaAppId: auth.app.appId };
  if (auth?.userLogin) return { login: auth.userLogin, type: 'User' };
  return { login: 'test-bot[bot]', type: 'Bot' };
}

/**
 * Credential provider returning a fixed token for every identity (for tests
 * that do not exercise GitHub App authentication). Use with a
 * {@link FakeGitHub} that has no registered apps.
 */
export function staticCredentials(token = 'test-token'): CredentialProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getToken(identity): Promise<AccessToken> {
      calls.push(identity);
      return Promise.resolve({ token, expiresAt: new Date('2999-01-01T00:00:00Z') });
    },
  };
}

/** Verify an app JWT the way GitHub does (signature, issuer, lifetime). */
export function verifyAppJwt(jwt: string, app: Pick<FakeApp, 'appId' | 'publicKey'>, now: Date): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { iat?: number; exp?: number; iss?: string };
    if (header.alg !== 'RS256') return false;
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), app.publicKey, Buffer.from(s, 'base64url'))) return false;
    const nowS = Math.floor(now.getTime() / 1000);
    if (String(payload.iss) !== app.appId) return false;
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return false;
    if (payload.iat > nowS + 60 || payload.exp <= nowS) return false;
    if (payload.exp - nowS > 600) return false;
    return true;
  } catch {
    return false;
  }
}

function isGraphqlPath(pathname: string, basePath: string): boolean {
  // github.com: `/graphql`; GHES: base `/api/v3` → `/api/graphql`.
  const endpoint = basePath.endsWith('/api/v3') ? `${basePath.slice(0, -'/v3'.length)}/graphql` : `${basePath}/graphql`;
  return pathname === endpoint;
}

/** Aliases `f<i>` bound to the variables `$f<i>` that carry the field names. */
function fieldAliases(query: string, variables: Record<string, unknown>): Array<{ alias: string; name: string }> {
  return [...query.matchAll(/\b(f\d+): fieldValueByName\(name: \$(f\d+)\)/g)].map((m) => ({
    alias: m[1] as string,
    name: String(variables[m[2] as string] ?? ''),
  }));
}

/** Name of the (single) mutation field of a mutation document. */
function mutationName(query: string): string {
  return /\b(addProjectV2ItemById|updateProjectV2ItemFieldValue|clearProjectV2ItemFieldValue)\s*\(/.exec(query)?.[1] ?? 'unknown';
}

/** Metadata JSON of a field (superset of what the read and the write metadata queries select). */
function fieldMetadataJson(field: FakeProjectField): Record<string, unknown> {
  const out: Record<string, unknown> = { id: field.id, name: field.name, dataType: field.dataType };
  if (field.dataType === 'SINGLE_SELECT') out.options = field.options.map((o) => ({ ...o }));
  if (field.dataType === 'ITERATION') {
    out.configuration = {
      iterations: field.iterations.map((i) => ({ ...i })),
      completedIterations: field.completedIterations.map((i) => ({ ...i })),
    };
  }
  return out;
}

function fieldValueJson(field: FakeProjectField, value: string | number): Record<string, unknown> {
  switch (field.dataType) {
    case 'SINGLE_SELECT':
      return { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: value, optionId: field.options.find((o) => o.name === value)?.id ?? null };
    case 'NUMBER':
      return { __typename: 'ProjectV2ItemFieldNumberValue', number: value };
    case 'DATE':
      return { __typename: 'ProjectV2ItemFieldDateValue', date: value };
    case 'ITERATION': {
      const iteration = [...field.iterations, ...field.completedIterations].find((i) => i.title === value);
      return { __typename: 'ProjectV2ItemFieldIterationValue', title: value, iterationId: iteration?.id ?? null };
    }
    default:
      return { __typename: 'ProjectV2ItemFieldTextValue', text: value };
  }
}

function normalizeRepo(repo: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`Invalid repo "${repo}" (expected owner/name)`);
  return repo.toLowerCase();
}

function bearer(headers: Headers): string | undefined {
  const value = headers.get('authorization');
  const match = value ? /^(?:Bearer|token)\s+(.+)$/i.exec(value) : null;
  return match?.[1];
}

function parseBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) },
  });
}
