import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SourceError, type AccessToken, type CredentialProvider, type SourceItem } from '../../core/index.js';
import { PROJECT_WRITE_METADATA_TTL_MS, projectItemQuery, type GitHubSourceProjectConfig } from './index.js';
import { FakeGitHub, createFakeGitHubSource, type FakeProject } from './testing/index.js';

const REPO = 'example/project-a';

const DECLARED: GitHubSourceProjectConfig = {
  number: 3,
  fields: {
    Status: 'single_select',
    Estimate: 'number',
    Due: 'date',
    Sprint: 'iteration',
    Notes: 'text',
  },
};

let clock: FakeClock;
let github: FakeGitHub;
let logger: MemoryLogger;
let project: FakeProject;

/** Credentials with one distinct token per identity (`tok-<identity>`). */
function perIdentityCredentials(): CredentialProvider {
  return {
    getToken: (identity): Promise<AccessToken> => Promise.resolve({ token: `tok-${identity}`, expiresAt: new Date('2999-01-01T00:00:00Z') }),
  };
}

function source(config: GitHubSourceProjectConfig = DECLARED) {
  return createFakeGitHubSource(github, { clock, logger, project: config, credentials: perIdentityCredentials() });
}

function itemOf(number: number): SourceItem {
  return { sourceId: 'project_a', itemId: String(number), key: `project_a:${number}`, url: '', type: 'issue', fields: {} };
}

function mutations(): Array<{ name: string; variables: Record<string, unknown> }> {
  return github.projectMutations().map(({ name, variables }) => ({ name, variables }));
}

function field(name: string) {
  const f = project.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SourceError) return err;
    throw err;
  }
  throw new Error('expected a SourceError');
}

beforeEach(() => {
  clock = new FakeClock('2026-10-19T12:00:00Z');
  github = new FakeGitHub({ clock });
  logger = new MemoryLogger();
  project = github.createProject('example', {
    number: 3,
    fields: [
      { name: 'Title', dataType: 'TITLE' },
      { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Todo', 'In Progress', 'Review', 'Done'] },
      { name: 'Estimate', dataType: 'NUMBER' },
      { name: 'Due', dataType: 'DATE' },
      { name: 'Sprint', dataType: 'ITERATION', iterations: ['Sprint 12', 'Sprint 13'], completedIterations: ['Sprint 11'] },
      { name: 'Notes', dataType: 'TEXT' },
    ],
  });
  github.createIssue(REPO, { number: 1, title: 'in project', labels: ['ready'] });
});

describe('source.update with project fields', () => {
  it('sets all five kinds with one mutation per field, values only as variables', async () => {
    github.addProjectItem(project, REPO, 1, { Status: 'Todo' });
    const result = await source().applyUpdate(
      itemOf(1),
      { project: { Status: 'In Progress', Estimate: 3.5, Due: '2026-11-01', Sprint: 'Sprint 12', Notes: 'see "spec" {x}' } },
      'maintainer',
    );
    expect(result).toEqual({
      changed: true,
      applied: { projectFields: { Status: 'In Progress', Estimate: 3.5, Due: '2026-11-01', Sprint: 'Sprint 12', Notes: 'see "spec" {x}' } },
    });
    expect(github.projectValues(project, REPO, 1)).toMatchObject({
      Status: 'In Progress',
      Estimate: 3.5,
      Due: '2026-11-01',
      Sprint: 'Sprint 12',
      Notes: 'see "spec" {x}',
    });
    const itemId = project.itemIds.get(github.issue(REPO, 1).nodeId);
    const status = field('Status');
    const sprint = field('Sprint');
    expect(mutations()).toEqual([
      {
        name: 'updateProjectV2ItemFieldValue',
        variables: { projectId: project.id, itemId, fieldId: status.id, value: { singleSelectOptionId: status.options[1]?.id } },
      },
      { name: 'updateProjectV2ItemFieldValue', variables: { projectId: project.id, itemId, fieldId: field('Estimate').id, value: { number: 3.5 } } },
      { name: 'updateProjectV2ItemFieldValue', variables: { projectId: project.id, itemId, fieldId: field('Due').id, value: { date: '2026-11-01' } } },
      {
        name: 'updateProjectV2ItemFieldValue',
        variables: { projectId: project.id, itemId, fieldId: sprint.id, value: { iterationId: sprint.iterations[0]?.id } },
      },
      { name: 'updateProjectV2ItemFieldValue', variables: { projectId: project.id, itemId, fieldId: field('Notes').id, value: { text: 'see "spec" {x}' } } },
    ]);
    // Never interpolated: no value, field name or ID appears in any GraphQL document.
    for (const r of github.requests.filter((x) => x.graphql)) {
      for (const text of ['In Progress', 'Sprint 12', 'see "spec"', '2026-11-01', 'Status', project.id, String(itemId)]) {
        expect(r.graphql?.query).not.toContain(text);
      }
    }
    expect(logger.records.find((r) => r.msg === 'Applied project field update')?.fields).toMatchObject({ item: 'project_a:1', itemAdded: false });
  });

  it('unchanged values cause no mutation; null clears only non-empty fields', async () => {
    github.addProjectItem(project, REPO, 1, { Status: 'Review', Estimate: 2, Due: '2026-11-01', Sprint: 'Sprint 11', Notes: 'x' });
    const adapter = source();
    const same = await adapter.applyUpdate(itemOf(1), { project: { Status: 'Review', Estimate: 2, Due: '2026-11-01', Sprint: 'Sprint 11' } }, 'maintainer');
    expect(same).toEqual({ changed: false });
    expect(mutations()).toEqual([]);

    const cleared = await adapter.applyUpdate(itemOf(1), { project: { Notes: null, Estimate: null } }, 'maintainer');
    expect(cleared).toEqual({ changed: true, applied: { projectFields: { Notes: null, Estimate: null } } });
    expect(mutations().map((m) => [m.name, m.variables.fieldId])).toEqual([
      ['clearProjectV2ItemFieldValue', field('Notes').id],
      ['clearProjectV2ItemFieldValue', field('Estimate').id],
    ]);
    expect(github.projectValues(project, REPO, 1)).toMatchObject({ Notes: null, Estimate: null });

    // A second run of the same update changes nothing.
    expect(await adapter.applyUpdate(itemOf(1), { project: { Notes: null, Estimate: null } }, 'maintainer')).toEqual({ changed: false });
    expect(mutations()).toHaveLength(2);
  });

  it('adds the item to the project when it is not in it yet', async () => {
    const result = await source().applyUpdate(itemOf(1), { project: { Status: 'In Progress', Notes: null } }, 'maintainer');
    expect(result).toEqual({ changed: true, applied: { projectFields: { Status: 'In Progress' }, projectItemAdded: true } });
    expect(mutations().map((m) => m.name)).toEqual(['addProjectV2ItemById', 'updateProjectV2ItemFieldValue']);
    expect(mutations()[0]?.variables).toEqual({ projectId: project.id, contentId: github.issue(REPO, 1).nodeId });
    expect(github.projectValues(project, REPO, 1)).toMatchObject({ Status: 'In Progress' });
    // Already in the project now: no second add.
    expect(await source().applyUpdate(itemOf(1), { project: { Status: 'In Progress' } }, 'maintainer')).toEqual({ changed: false });
    expect(mutations()).toHaveLength(2);
  });

  it('matches options/iterations exactly, else case-insensitively when unique; completed iterations count', async () => {
    github.addProjectItem(project, REPO, 1);
    await source().applyUpdate(itemOf(1), { project: { Status: 'in progress', Sprint: 'sprint 11' } }, 'maintainer');
    expect(github.projectValues(project, REPO, 1)).toMatchObject({ Status: 'In Progress', Sprint: 'Sprint 11' });
  });

  it('unknown or ambiguous option → not retryable, lists the options, reloads cached metadata once', async () => {
    github.addProjectItem(project, REPO, 1);
    github.addProjectOption(project, 'Status', 'review');
    const adapter = source();
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Todo' } }, 'maintainer');
    const meta = () => github.requests.filter((r) => r.graphql?.query.includes('repositoryOwner(')).length;
    expect(meta()).toBe(1);

    const unknown = await failure(adapter.applyUpdate(itemOf(1), { project: { Status: 'Blocked' } }, 'maintainer'));
    expect(unknown).toMatchObject({ kind: 'invalid', retryable: false });
    expect(unknown.message).toContain('option "Blocked" not found (available: "Todo", "In Progress", "Review", "Done", "review")');
    expect(meta()).toBe(2); // cached metadata did not resolve → reloaded once

    const ambiguous = await failure(adapter.applyUpdate(itemOf(1), { project: { Status: 'REVIEW' } }, 'maintainer'));
    expect(ambiguous.message).toContain('option "REVIEW" is ambiguous (matches "Review", "review"');
    expect(ambiguous.retryable).toBe(false);
    expect(mutations()).toHaveLength(1);

    // An option added on GitHub is found after the reload.
    github.addProjectOption(project, 'Status', 'Blocked');
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Blocked' } }, 'maintainer');
    expect(github.projectValues(project, REPO, 1)).toMatchObject({ Status: 'Blocked' });

    const iteration = await failure(adapter.applyUpdate(itemOf(1), { project: { Sprint: 'Sprint 99' } }, 'maintainer'));
    expect(iteration.message).toContain('iteration "Sprint 99" not found (available: "Sprint 12", "Sprint 13", "Sprint 11")');
  });

  it('uses cached metadata for up to 5 minutes', async () => {
    github.addProjectItem(project, REPO, 1);
    const adapter = source();
    const meta = () => github.requests.filter((r) => r.graphql?.query.includes('repositoryOwner(')).length;
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Todo' } }, 'maintainer');
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer');
    expect(meta()).toBe(1);
    clock.advance(PROJECT_WRITE_METADATA_TTL_MS);
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Review' } }, 'maintainer');
    expect(meta()).toBe(2);
  });

  it('field missing in the project or of another kind → not retryable, no mutation', async () => {
    github.addProjectItem(project, REPO, 1);
    const adapter = source({ number: 3, fields: { Status: 'single_select', Missing: 'text', Estimate: 'text' } });
    const err = await failure(adapter.applyUpdate(itemOf(1), { project: { Status: 'Done', Missing: 'x', Estimate: '3' } }, 'maintainer'));
    expect(err).toMatchObject({ kind: 'invalid', retryable: false });
    expect(err.message).toContain('project field "Missing" not found in GitHub project example/3');
    expect(err.message).toContain('project field "Estimate" in GitHub project example/3 has type NUMBER, but is declared as text (expects TEXT)');
    expect(mutations()).toEqual([]);
  });

  it('rejects undeclared fields, wrong value types and sources without a project', async () => {
    github.addProjectItem(project, REPO, 1);
    const undeclared = await failure(source().applyUpdate(itemOf(1), { project: { Priority: 'P1', Estimate: 'three', Due: '2026-02-30' } }, 'maintainer'));
    expect(undeclared).toMatchObject({ kind: 'invalid', retryable: false });
    expect(undeclared.message).toBe(
      'project field "Priority" is not declared in "project.fields" of the source; project field "Estimate": expected a number or null; ' +
        'project field "Due": expected a date YYYY-MM-DD or null',
    );
    const noProject = createFakeGitHubSource(github, { clock });
    const err = await failure(noProject.applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer'));
    expect(err).toMatchObject({ kind: 'invalid', retryable: false, message: 'Source "project_a" has no GitHub project; project fields cannot be set' });
    expect(github.requests.filter((r) => r.graphql)).toEqual([]);
  });

  it('maps GraphQL errors with HTTP 200: FORBIDDEN → forbidden (not retryable), untyped → transient', async () => {
    github.addProjectItem(project, REPO, 1);
    github.denyProjectWrites(project);
    const forbidden = await failure(source().applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer'));
    expect(forbidden).toMatchObject({ kind: 'forbidden', retryable: false });
    expect(forbidden.message).toContain('FORBIDDEN: Resource not accessible by integration (the identity needs write access to the project)');
    github.allowProject(project);

    github.failNext({ method: 'POST', path: '/graphql' }, { status: 200, body: { data: null, errors: [{ message: 'Something went wrong while executing your query.' }] } });
    const transient = await failure(source().applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer'));
    expect(transient).toMatchObject({ kind: 'transient', retryable: true });

    github.denyProject(project);
    const missing = await failure(source().applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer'));
    expect(missing).toMatchObject({ kind: 'forbidden', retryable: false });
    expect(missing.message).toContain('GitHub project example/3 unavailable');
  });

  it('a rate limit (HTTP 200 RATE_LIMITED or 403 Retry-After) is retryable with the reset delay', async () => {
    github.addProjectItem(project, REPO, 1);
    github.failNext({ method: 'POST', path: '/graphql' }, { status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, headers: { 'retry-after': '42' } });
    const limited = await failure(source().applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer'));
    expect(limited).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 42_000 });

    const adapter = source();
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Todo' } }, 'maintainer');
    github.failNext({ method: 'POST', path: '/graphql' }, { status: 403, headers: { 'retry-after': '7' }, body: { message: 'secondary rate limit' } });
    const secondary = await failure(adapter.applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer'));
    expect(secondary).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 7_000 });
    // The retry converges.
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer');
    expect(github.projectValues(project, REPO, 1)).toMatchObject({ Status: 'Done' });
  });

  it('writes with the explicit project.identity, otherwise with the identity of the update', async () => {
    github.addProjectItem(project, REPO, 1);
    await source().applyUpdate(itemOf(1), { labels: { add: ['coding'] }, project: { Status: 'Done' } }, 'coder');
    expect(new Set(github.requests.map((r) => r.token))).toEqual(new Set(['tok-coder']));

    github.requests.length = 0;
    await source({ ...DECLARED, identity: 'board', writeIdentity: 'board' }).applyUpdate(
      itemOf(1),
      { labels: { add: ['review'] }, project: { Status: 'Review' } },
      'coder',
    );
    expect(github.requests.filter((r) => r.graphql).every((r) => r.token === 'tok-board')).toBe(true);
    expect(github.requests.filter((r) => !r.graphql).every((r) => r.token === 'tok-coder')).toBe(true);
    expect(github.projectMutations()).toHaveLength(1);
  });

  it('labels first, then project fields; a project failure fails the update after the labels', async () => {
    github.addProjectItem(project, REPO, 1);
    const ok = await source().applyUpdate(itemOf(1), { labels: { add: ['in-progress'], remove: ['ready'] }, project: { Status: 'In Progress' } }, 'maintainer');
    expect(ok).toEqual({
      changed: true,
      applied: { labelsAdded: ['in-progress'], labelsRemoved: ['ready'], projectFields: { Status: 'In Progress' } },
    });
    const order = github.requests.map((r) => (r.graphql ? (r.graphql.query.trimStart().startsWith('mutation') ? 'mutation' : 'query') : `${r.method} ${r.path}`));
    expect(order.indexOf('mutation')).toBeGreaterThan(order.lastIndexOf('DELETE /repos/example/project-a/issues/1/labels/ready'));

    const err = await failure(source().applyUpdate(itemOf(1), { labels: { add: ['review'] }, project: { Status: 'Nope' } }, 'maintainer'));
    expect(err.kind).toBe('invalid');
    expect(github.labels(REPO, 1)).toContain('review');
  });

  it('a partial error for another project membership does not matter; one below our item fails closed', async () => {
    const other = github.createProject('example', { number: 4, fields: [{ name: 'Status', dataType: 'SINGLE_SELECT', options: ['A'] }] });
    github.addProjectItem(other, REPO, 1, { Status: 'A' });
    github.denyProject(other);
    github.addProjectItem(project, REPO, 1, { Status: 'Todo' });
    await source().applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer');
    expect(github.projectValues(project, REPO, 1)).toMatchObject({ Status: 'Done' });

    const adapter = source();
    // Warm the metadata cache so the injected fault hits the item query.
    await adapter.applyUpdate(itemOf(1), { project: { Status: 'Done' } }, 'maintainer');
    github.failNext(
      { method: 'POST', path: '/graphql' },
      {
        status: 200,
        body: {
          data: { node: { __typename: 'Issue', projectItems: { totalCount: 1, nodes: [{ id: 'PVTI_x', project: { id: project.id }, f0: null }] } } },
          errors: [{ type: 'FORBIDDEN', path: ['node', 'projectItems', 'nodes', 0, 'f0'], message: 'Resource not accessible by integration' }],
        },
      },
    );
    const err = await failure(adapter.applyUpdate(itemOf(1), { project: { Status: 'Todo' } }, 'maintainer'));
    expect(err.kind).toBe('forbidden');
    expect(github.projectValues(project, REPO, 1)).toMatchObject({ Status: 'Done' });
  });

  it('the item query uses only generated identifiers', () => {
    const query = projectItemQuery(2);
    expect(query).toContain('query($id: ID!, $f0: String!, $f1: String!)');
    expect(query).toContain('f1: fieldValueByName(name: $f1)');
    expect(query).toContain('... on ProjectV2Item { ...Item }');
  });
});
