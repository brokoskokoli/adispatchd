import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor, type FilterNode, type SourceItem } from '../../core/index.js';
import { createItemFieldSource, evaluateFilter } from '../../filters/index.js';
import { GitHubAppCredentialProvider } from '../../identities/index.js';
import { PROJECT_METADATA_LISTING_TTL_MS, PROJECT_METADATA_TTL_MS, graphqlUrlFor, projectValuesQuery, type GitHubSourceProjectConfig } from './index.js';
import { FakeGitHub, createFakeGitHubSource, type FakeProject } from './testing/index.js';

const REPO = 'example/project-a';

const DECLARED: GitHubSourceProjectConfig = {
  number: 3,
  fields: {
    Status: 'single_select',
    Priority: 'single_select',
    Estimate: 'number',
    Due: 'date',
    Sprint: 'iteration',
    Notes: 'text',
  },
};

let clock: FakeClock;
let github: FakeGitHub;
let logger: MemoryLogger;

function createProject(owner = 'example', init: Partial<Parameters<FakeGitHub['createProject']>[1]> = {}): FakeProject {
  return github.createProject(owner, {
    number: 3,
    fields: [
      { name: 'Title', dataType: 'TITLE' },
      { name: 'Status', dataType: 'SINGLE_SELECT' },
      { name: 'Priority', dataType: 'SINGLE_SELECT' },
      { name: 'Estimate', dataType: 'NUMBER' },
      { name: 'Due', dataType: 'DATE' },
      { name: 'Sprint', dataType: 'ITERATION' },
      { name: 'Notes', dataType: 'TEXT' },
    ],
    ...init,
  });
}

function source(project: GitHubSourceProjectConfig = DECLARED, options: Parameters<typeof createFakeGitHubSource>[1] = {}) {
  return createFakeGitHubSource(github, { clock, logger, project, ...options });
}

function graphqlRequests(kind: 'meta' | 'values') {
  return github.requests.filter((r) => r.graphql && (kind === 'meta' ? r.graphql.query.includes('repositoryOwner(') : r.graphql.query.includes('nodes(ids:')));
}

beforeEach(() => {
  clock = new FakeClock('2026-10-19T12:00:00Z');
  github = new FakeGitHub({ clock });
  logger = new MemoryLogger();
});

describe('project field definitions', () => {
  it('extends the catalogue per source with project.<name> of the declared kind', () => {
    const defs = source().fieldDefinitions();
    const byName = new Map(defs.map((d) => [d.name, d]));
    expect(byName.get('project.Status')).toMatchObject({ type: 'string', operators: ['equals', 'not_equals', 'contains', 'in'] });
    expect(byName.get('project.Sprint')?.type).toBe('string');
    expect(byName.get('project.Notes')?.type).toBe('string');
    expect(byName.get('project.Estimate')).toMatchObject({ type: 'number' });
    expect(byName.get('project.Due')).toMatchObject({ type: 'date' });
    for (const d of defs.filter((x) => x.name.startsWith('project.'))) {
      expect(d.expensive).toBeUndefined();
      expect(d.pushdown).toBeUndefined();
    }
    // Sources without a project have no project fields.
    expect(createFakeGitHubSource(github, { clock }).fieldDefinitions().some((d) => d.name.startsWith('project.'))).toBe(false);
  });
});

describe('listCandidates with project fields', () => {
  it('reads values of all five kinds; items not in the project are known empty', async () => {
    const project = createProject();
    github.createIssue(REPO, { title: 'in project' });
    github.createIssue(REPO, { title: 'not in project' });
    github.createIssue(REPO, { title: 'partly set', isPullRequest: true });
    github.addProjectItem(project, REPO, 1, { Status: 'Ready', Priority: 'P1', Estimate: 3, Due: '2026-11-01', Sprint: 'Sprint 7', Notes: 'hello' });
    github.addProjectItem(project, REPO, 3, { Status: 'Todo' });

    const items = await source().listCandidates();
    expect(items.map((i) => i.itemId)).toEqual(['1', '2', '3']);
    const [a, b, c] = items as [SourceItem, SourceItem, SourceItem];
    expect(a.fields).toMatchObject({
      'project.Status': 'Ready',
      'project.Priority': 'P1',
      'project.Estimate': 3,
      'project.Due': '2026-11-01',
      'project.Sprint': 'Sprint 7',
      'project.Notes': 'hello',
    });
    expect(a.unknownFields).toBeUndefined();
    for (const name of Object.keys(DECLARED.fields)) expect(b.fields[`project.${name}`]).toBeNull();
    expect(c.fields).toMatchObject({ 'project.Status': 'Todo', 'project.Priority': null, 'project.Estimate': null });
    // One metadata and one values query per listing.
    expect(graphqlRequests('meta')).toHaveLength(1);
    expect(graphqlRequests('values')).toHaveLength(1);
  });

  it('passes field names only as variables, never in the query text', async () => {
    const weird = 'Prio") { __typename } #';
    const project = github.createProject('example', { number: 3, fields: [{ name: weird, dataType: 'SINGLE_SELECT' }] });
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { [weird]: 'High' });

    const [it1] = await source({ number: 3, fields: { [weird]: 'single_select' } }).listCandidates();
    expect(it1?.fields[`project.${weird}`]).toBe('High');
    const values = graphqlRequests('values')[0]?.graphql;
    expect(values?.query).not.toContain('Prio');
    expect(values?.query).toContain('f0: fieldValueByName(name: $f0)');
    expect(values?.variables).toMatchObject({ f0: weird, ids: [github.issue(REPO, 1).nodeId] });
    expect(graphqlRequests('meta')[0]?.graphql?.variables).toEqual({ owner: 'example', number: 3 });
    expect(projectValuesQuery(2)).toContain('$f1: String!');
  });

  it('matches declared names case-insensitively and queries the exact project field name', async () => {
    const project = createProject();
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Done' });
    const [it1] = await source({ number: 3, fields: { status: 'single_select' } }).listCandidates();
    expect(it1?.fields['project.status']).toBe('Done');
    expect(graphqlRequests('values')[0]?.graphql?.variables.f0).toBe('Status');
  });

  it('uses the project owner and identity when given', async () => {
    const project = createProject('other-org');
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Ready' });
    const [it1] = await source({ ...DECLARED, owner: 'other-org', identity: 'project_reader' }).listCandidates();
    expect(it1?.fields['project.Status']).toBe('Ready');
    expect(graphqlRequests('meta')[0]?.graphql?.variables.owner).toBe('other-org');
  });

  it('N listings of one source within 30 s share one metadata lookup', async () => {
    createProject();
    github.createIssue(REPO);
    const adapter = source();
    await adapter.listCandidates();
    await adapter.listCandidates({ filter: { field: 'labels', operator: 'contains', value: 'x' } });
    await adapter.listCandidates();
    expect(graphqlRequests('meta')).toHaveLength(1);
    expect(graphqlRequests('values')).toHaveLength(2); // the label listing is empty
  });

  it('splits more than 50 items into several values queries', async () => {
    const project = createProject();
    for (let n = 1; n <= 120; n++) {
      github.createIssue(REPO);
      if (n % 2 === 0) github.addProjectItem(project, REPO, n, { Status: `S${n}` });
    }
    const items = await source().listCandidates();
    expect(items).toHaveLength(120);
    const chunks = graphqlRequests('values').map((r) => (r.graphql?.variables.ids as unknown[]).length);
    expect(chunks).toEqual([50, 50, 20]);
    expect(items[99]?.fields['project.Status']).toBe('S100');
    expect(items[98]?.fields['project.Status']).toBeNull();
    expect(graphqlRequests('meta')).toHaveLength(1);
  });

  it('missing project / no access → all project.* unknown with reason; the listing still succeeds', async () => {
    github.createIssue(REPO);
    // Owner without a project number 3.
    createProject('example', { number: 1 });
    const [it1] = await source().listCandidates();
    expect(it1?.fields).toHaveProperty('title');
    expect(it1?.fields).not.toHaveProperty('project.Status');
    expect(it1?.unknownFields?.['project.Status']).toMatch(/GitHub project example\/3 unavailable: .*Could not resolve to a ProjectV2/);
    expect(Object.keys(it1?.unknownFields ?? {})).toHaveLength(6);

    // No access (e.g. app without "Projects: read").
    const denied = createProject('example');
    github.denyProject(denied);
    const [again] = await source().listCandidates();
    expect(again?.unknownFields?.['project.Status']).toMatch(/unavailable: forbidden: FORBIDDEN: Resource not accessible by integration/);
    expect(it1?.unknownFields?.['project.Status']).toMatch(/unavailable: not_found: NOT_FOUND: /);
    expect(graphqlRequests('values')).toHaveLength(0);
  });

  it('user-owned project: not readable with an app installation token (unknown), readable with a user token', async () => {
    const app = github.createApp({ login: 'reader-bot[bot]' });
    const userToken = github.createUserToken('octo-user');
    const project = createProject('octo-user', { ownerType: 'User' });
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Ready' });
    const appCredentials = new GitHubAppCredentialProvider(
      { reader: { appId: app.appId, installationId: app.installationId, privateKeyEnv: 'KEY' } },
      { clock, fetch: github.fetch, env: { KEY: app.privateKeyPem } },
    );
    const viaApp = source({ ...DECLARED, owner: 'octo-user' }, { identity: 'reader', credentials: appCredentials });
    const [a] = await viaApp.listCandidates();
    expect(a?.unknownFields?.['project.Status']).toMatch(/unavailable/);

    // Source reads via the app, the project via a token identity.
    const mixed = source(
      { ...DECLARED, owner: 'octo-user', identity: 'pat' },
      {
        identity: 'reader',
        credentials: {
          getToken: (identity, options) =>
            identity === 'pat' ? Promise.resolve({ token: userToken, expiresAt: new Date('2999-01-01') }) : appCredentials.getToken(identity, options),
        },
      },
    );
    const [b] = await mixed.listCandidates();
    expect(b?.fields['project.Status']).toBe('Ready');
  });

  it('field missing in the project or of another kind → only that field unknown, warned once per reason', async () => {
    const project = github.createProject('example', {
      number: 3,
      fields: [
        { name: 'Status', dataType: 'SINGLE_SELECT' },
        { name: 'Estimate', dataType: 'TEXT' },
      ],
    });
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Ready', Estimate: 'three' });
    const adapter = source({ number: 3, fields: { Status: 'single_select', Estimate: 'number', Sprint: 'iteration' } });
    const [it1] = await adapter.listCandidates();
    expect(it1?.fields['project.Status']).toBe('Ready');
    expect(it1?.unknownFields?.['project.Estimate']).toMatch(/has type TEXT, but is declared as number \(expects NUMBER\)/);
    expect(it1?.unknownFields?.['project.Sprint']).toMatch(/project field "Sprint" not found in GitHub project example\/3/);
    // Only the usable field is queried.
    expect(graphqlRequests('values')[0]?.graphql?.variables).toMatchObject({ f0: 'Status' });
    expect(graphqlRequests('values')[0]?.graphql?.variables).not.toHaveProperty('f1');

    await adapter.listCandidates();
    const warnings = logger.records.filter((r) => r.level === 'warn' && r.msg === 'GitHub project field unavailable');
    expect(warnings.map((w) => w.fields.field)).toEqual(['project.Estimate', 'project.Sprint']);

    // Fixed in the project → info once, values come back (after the shared listing metadata expired).
    project.fields.push({ name: 'Sprint', dataType: 'ITERATION' });
    clock.advance(PROJECT_METADATA_LISTING_TTL_MS);
    github.setProjectValue(project, REPO, 1, 'Sprint', 'S1');
    const [fixed] = await adapter.listCandidates();
    expect(fixed?.fields['project.Sprint']).toBe('S1');
    expect(logger.records.filter((r) => r.msg === 'GitHub project field available again').map((r) => r.fields.field)).toEqual(['project.Sprint']);
  });

  it('GraphQL errors, HTTP errors and rate limits → project.* unknown, listing succeeds', async () => {
    createProject();
    github.createIssue(REPO);
    const adapter = source();

    github.failNext({ path: '/graphql' }, { status: 200, body: { errors: [{ type: 'INTERNAL', message: 'Something went wrong' }] } });
    let [it1] = await adapter.listCandidates();
    expect(it1?.unknownFields?.['project.Status']).toMatch(/unavailable: transient: INTERNAL: Something went wrong/);

    github.failNext({ path: '/graphql' }, { status: 502 });
    [it1] = await adapter.listCandidates();
    expect(it1?.unknownFields?.['project.Status']).toMatch(/unavailable: transient: POST \/graphql failed with HTTP 502/);

    github.failNext({ path: '/graphql' }, { status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } });
    [it1] = await adapter.listCandidates();
    expect(it1?.unknownFields?.['project.Status']).toMatch(/rate_limited: POST \/graphql failed: GraphQL rate limit exceeded/);
  });

  it('a rate limit never stalls the listing and pauses project reads until the reset', async () => {
    const project = createProject();
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Ready' });
    // Retries enabled: a sleeping client would hang here (fake timers never advance).
    const adapter = source(DECLARED, { maxRetries: 2 });
    github.failNext({ path: '/graphql' }, { status: 403, headers: { 'retry-after': '30' }, body: { message: 'You have exceeded a secondary rate limit' } });
    let [it1] = await adapter.listCandidates();
    expect(it1?.unknownFields?.['project.Status']).toMatch(/rate_limited/);
    const calls = graphqlRequests('meta').length + graphqlRequests('values').length;
    expect(calls).toBe(1);

    clock.advance(10_000);
    [it1] = await adapter.listCandidates();
    expect(it1?.unknownFields?.['project.Status']).toBe('GitHub GraphQL rate limit until 2026-10-19T12:00:30.000Z');
    expect(graphqlRequests('meta').length + graphqlRequests('values').length).toBe(calls);
    expect(it1?.fields).toHaveProperty('title');

    clock.advance(20_000);
    [it1] = await adapter.listCandidates();
    expect(it1?.fields['project.Status']).toBe('Ready');

    // GraphQL RATE_LIMITED without reset headers: fallback 60 s; also from the values query.
    clock.advance(PROJECT_METADATA_LISTING_TTL_MS - 1);
    github.failNext({ path: '/graphql' }, { status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] } });
    [it1] = await adapter.listCandidates();
    expect(it1?.unknownFields?.['project.Status']).toMatch(/reading GitHub project example\/3 failed: rate_limited/);
    clock.advance(59_000);
    [it1] = await adapter.listCandidates();
    expect(it1?.unknownFields?.['project.Status']).toMatch(/^GitHub GraphQL rate limit until /);
    clock.advance(2_000);
    [it1] = await adapter.listCandidates();
    expect(it1?.fields['project.Status']).toBe('Ready');
  });

  it('partial GraphQL errors below an item make all its project fields unknown (fail closed)', async () => {
    const project = createProject();
    for (let n = 1; n <= 5; n++) {
      github.createIssue(REPO);
      github.addProjectItem(project, REPO, n, { Status: 'Ready' });
    }
    const adapter = source();
    await adapter.listCandidates(); // caches the metadata for the next listing
    const projectId = project.id;
    const okNode = { __typename: 'Issue', projectItems: { totalCount: 1, nodes: [{ project: { id: projectId }, f0: { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Ready' } }] } };
    const nodes = [okNode, okNode, okNode, okNode, okNode].map((n) => structuredClone(n)) as Array<Record<string, unknown>>;
    // Item 4: the value is null because resolving it failed.
    (nodes[3] as { projectItems: { nodes: Array<Record<string, unknown>> } }).projectItems.nodes[0]!.f0 = null;
    // Item 5: its project item was nulled by an error (absence of the project not proven).
    (nodes[4] as { projectItems: { totalCount: number; nodes: unknown[] } }).projectItems = { totalCount: 1, nodes: [null] };
    github.failNext(
      { path: '/graphql' },
      {
        status: 200,
        body: {
          data: { nodes },
          errors: [
            { type: 'INTERNAL', path: ['nodes', 3, 'projectItems', 'nodes', 0, 'f0'], message: 'value failed' },
            { type: 'FORBIDDEN', path: ['nodes', 4, 'projectItems', 'nodes', 0], message: 'item hidden' },
          ],
        },
      },
    );
    const items = await adapter.listCandidates();
    expect(graphqlRequests('meta')).toHaveLength(1);
    expect(items.slice(0, 3).map((i) => i.fields['project.Status'])).toEqual(['Ready', 'Ready', 'Ready']);
    for (const name of Object.keys(DECLARED.fields)) {
      expect(items[3]?.unknownFields?.[`project.${name}`]).toBe('item not readable via GitHub project example/3: value failed');
      expect(items[4]?.unknownFields?.[`project.${name}`]).toBe('item not readable via GitHub project example/3: item hidden');
      expect(items[3]?.fields).not.toHaveProperty(`project.${name}`);
    }

    // A nulled membership without an error entry: still not proven absent.
    const hidden = { __typename: 'Issue', projectItems: { totalCount: 2, nodes: [null, { project: { id: 'PVT_other' } }] } };
    github.failNext({ path: '/graphql' }, { status: 200, body: { data: { nodes: [hidden, okNode, okNode, okNode, okNode] } } });
    const again = await adapter.listCandidates();
    expect(again[0]?.unknownFields?.['project.Status']).toMatch(/project memberships of the item not fully readable/);
    expect(again[1]?.fields['project.Status']).toBe('Ready');
  });

  it('values query failures after a good metadata lookup make the fields unknown', async () => {
    const project = createProject();
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Ready' });
    const adapter = source();
    expect((await adapter.getItem('1'))?.fields['project.Status']).toBe('Ready');
    // getItem reuses the cached metadata, so the fault hits the values query.
    github.failNext({ path: '/graphql' }, { status: 200, body: { data: { nodes: null }, errors: [{ message: 'nodes broke' }] } });
    const it1 = (await adapter.getItem('1')) as SourceItem;
    expect(it1.unknownFields?.['project.Status']).toMatch(/reading GitHub project example\/3 failed: invalid: nodes broke/);
    expect(it1.fields).toHaveProperty('title');
    // Same failure again: warned only once; recovery is logged once.
    github.failNext({ path: '/graphql' }, { status: 200, body: { data: { nodes: null }, errors: [{ message: 'nodes broke' }] } });
    await adapter.getItem('1');
    expect(logger.records.filter((r) => r.msg === 'Could not read project field values')).toHaveLength(1);
    expect((await adapter.getItem('1'))?.fields['project.Status']).toBe('Ready');
    expect(logger.records.filter((r) => r.msg === 'Project field values readable again')).toHaveLength(1);

    // A node that cannot be resolved (e.g. repository invisible to the project identity).
    github.failNext(
      { path: '/graphql' },
      { status: 200, body: { data: { nodes: [null] }, errors: [{ type: 'NOT_FOUND', path: ['nodes', 0], message: 'Could not resolve to a node' }] } },
    );
    const it2 = (await adapter.getItem('1')) as SourceItem;
    expect(it2.unknownFields?.['project.Status']).toMatch(/item not readable via GitHub project example\/3: Could not resolve to a node/);
  });

  it('an item in more than 20 projects without a match is unknown', async () => {
    const target = createProject('example', { number: 3 });
    github.createIssue(REPO);
    github.createIssue(REPO);
    for (let n = 10; n < 31; n++) {
      const other = createProject('example', { number: n });
      github.addProjectItem(other, REPO, 1, {});
    }
    github.addProjectItem(target, REPO, 2, { Status: 'Ready' });
    for (let n = 10; n < 31; n++) github.addProjectItem(createProject('example', { number: 100 + n }), REPO, 2, {});
    const [a, b] = (await source().listCandidates()) as [SourceItem, SourceItem];
    expect(a.unknownFields?.['project.Status']).toMatch(/more than 20 projects/);
    // Found among the first 20 → known.
    expect(b.fields['project.Status']).toBe('Ready');
  });

  it('propagates an aborted signal during the project lookup', async () => {
    createProject();
    github.createIssue(REPO);
    const controller = new AbortController();
    const adapter = source(
      { ...DECLARED, identity: 'pat' },
      {
        credentials: {
          getToken: (identity) => {
            if (identity === 'pat') controller.abort(new Error('stop'));
            return Promise.resolve({ token: 'test-token', expiresAt: new Date('2999-01-01') });
          },
        },
      },
    );
    await expect(adapter.listCandidates({ signal: controller.signal })).rejects.toThrow('stop');
  });

  it('never logs tokens', async () => {
    const redactor = new SecretRedactor();
    const memory = new MemoryLogger(redactor.asRedactor);
    createProject();
    github.createIssue(REPO);
    github.failNext({ path: '/graphql' }, { status: 403, body: { message: 'Resource not accessible by integration' } });
    await createFakeGitHubSource(github, { clock, logger: memory, project: DECLARED }).listCandidates();
    expect(JSON.stringify(memory.records)).not.toContain('test-token');
  });
});

describe('getItem with project fields', () => {
  it('reads the values of the single item and caches metadata for up to 5 minutes', async () => {
    const project = createProject();
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Todo' });
    const adapter = source();
    expect((await adapter.getItem('1'))?.fields['project.Status']).toBe('Todo');
    github.setProjectValue(project, REPO, 1, 'Status', 'Ready');
    clock.advance(PROJECT_METADATA_TTL_MS - 1000);
    expect((await adapter.getItem('1'))?.fields['project.Status']).toBe('Ready');
    expect(graphqlRequests('meta')).toHaveLength(1);
    expect(graphqlRequests('values')).toHaveLength(2);
    expect(graphqlRequests('values')[1]?.graphql?.variables.ids).toEqual([github.issue(REPO, 1).nodeId]);
    clock.advance(2000);
    await adapter.getItem('1');
    expect(graphqlRequests('meta')).toHaveLength(2);
    // Listings share metadata only for 30 s; this one is younger → reused, an older one is refetched.
    await adapter.listCandidates();
    expect(graphqlRequests('meta')).toHaveLength(2);
    clock.advance(PROJECT_METADATA_LISTING_TTL_MS);
    await adapter.listCandidates();
    expect(graphqlRequests('meta')).toHaveLength(3);
  });

  it('resolveFields answers project.* from the item, including unknown reasons', async () => {
    github.createIssue(REPO);
    const adapter = source();
    const it1 = (await adapter.getItem('1')) as SourceItem;
    const res = await adapter.resolveFields(it1, ['project.Status', 'title']);
    expect(res['project.Status']).toMatchObject({ known: false, reason: expect.stringMatching(/unavailable/) });
    expect(res.title).toEqual({ known: true, value: 'Issue 1' });
  });
});

describe('filter evaluation on project fields', () => {
  it('project.Status in [...] is true / false / unknown', async () => {
    const project = createProject();
    github.createIssue(REPO);
    github.createIssue(REPO);
    github.createIssue(REPO);
    github.addProjectItem(project, REPO, 1, { Status: 'Ready' });
    github.addProjectItem(project, REPO, 2, { Status: 'Done' });
    const adapter = source();
    const filter: FilterNode = { field: 'project.Status', operator: 'in', value: ['Todo', 'Ready'] };
    const evaluate = async (item: SourceItem) =>
      (await evaluateFilter(filter, createItemFieldSource(item, { definitions: adapter.fieldDefinitions() }))).value;
    const [a, b, c] = (await adapter.listCandidates()) as [SourceItem, SourceItem, SourceItem];
    expect(await evaluate(a)).toBe(true);
    expect(await evaluate(b)).toBe(false);
    expect(await evaluate(c)).toBe(false); // not in the project: null is not in the list

    github.denyProject(project);
    clock.advance(PROJECT_METADATA_LISTING_TTL_MS);
    const [unknownItem] = (await adapter.listCandidates()) as [SourceItem];
    const evaluation = await evaluateFilter(filter, createItemFieldSource(unknownItem, { definitions: adapter.fieldDefinitions() }));
    expect(evaluation.value).toBe('unknown');
    expect(evaluation.trace).toMatchObject({ kind: 'predicate', reason: expect.stringMatching(/GitHub project example\/3 unavailable/) });
    // `not` of unknown stays unknown (fail closed).
    expect((await evaluateFilter({ not: filter }, createItemFieldSource(unknownItem, { definitions: adapter.fieldDefinitions() }))).value).toBe('unknown');
  });
});

describe('GraphQL endpoint', () => {
  it('derives the endpoint from the REST base URL (github.com and GHES)', async () => {
    expect(graphqlUrlFor('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrlFor('https://api.github.com/')).toBe('https://api.github.com/graphql');
    expect(graphqlUrlFor('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com/api/graphql');
    expect(graphqlUrlFor('https://ghe.example.com/api/v3/')).toBe('https://ghe.example.com/api/graphql');

    const ghes = new FakeGitHub({ clock, baseUrl: 'https://ghe.example.com/api/v3', webBaseUrl: 'https://ghe.example.com' });
    const project = ghes.createProject('example', { number: 3, fields: [{ name: 'Status', dataType: 'SINGLE_SELECT' }] });
    ghes.createIssue(REPO);
    ghes.addProjectItem(project, REPO, 1, { Status: 'Ready' });
    const adapter = createFakeGitHubSource(ghes, { clock, project: { number: 3, fields: { Status: 'single_select' } } });
    const [it1] = await adapter.listCandidates();
    expect(it1?.fields['project.Status']).toBe('Ready');
    expect(ghes.requests.filter((r) => r.graphql).map((r) => r.path)).toEqual(['/api/graphql', '/api/graphql']);
  });
});
