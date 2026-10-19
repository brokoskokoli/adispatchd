/**
 * End-to-end (WI-14): complete app with configuration files and Fake-GitHub.
 * The source is read with a GitHub App identity, the user-owned project with
 * a `github_token` identity (app installation tokens cannot read user-owned
 * projects). A workflow filtering on `project.Status equals "Ready"` starts
 * only the matching item; the dry-run and a view show the project fields.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';
import { formatDryRun } from './scheduler/index.js';
import type { FakeProject } from './sources/github/testing/index.js';

let env: AppEnv;
let project: FakeProject;
let userToken: string;

beforeAll(async () => {
  env = await startAppEnv({}, (e) => {
    userToken = e.github.createUserToken('octo-user');
    e.env.PROJECT_TOKEN = userToken;
    project = e.github.createProject('octo-user', {
      number: 5,
      ownerType: 'User',
      fields: [
        { name: 'Status', dataType: 'SINGLE_SELECT' },
        { name: 'Priority', dataType: 'SINGLE_SELECT' },
      ],
    });
    writeFileSync(
      path.join(e.configDir, 'identities.yaml'),
      `${readIdentities(e)}  project_reader:\n    type: github_token\n    token_env: PROJECT_TOKEN\n`,
    );
    writeFileSync(
      path.join(e.configDir, 'sources.yaml'),
      [
        'sources:',
        '  repo_a:',
        '    type: github',
        '    owner: example',
        '    repository: a',
        '    identity: maintainer',
        '    project:',
        '      owner: octo-user',
        '      number: 5',
        '      identity: project_reader',
        '      fields: { Status: single_select, Priority: single_select }',
        '  repo_b: { type: github, owner: example, repository: b, identity: maintainer }',
        '',
      ].join('\n'),
    );
    const worker = e.script('coder.sh', `printf '{"schema_version":1,"result":"success","message":"ok"}' > "$ADISPATCH_RESULT_FILE"`);
    writeFileSync(
      path.join(e.configDir, 'workflows', 'coder.yaml'),
      [
        'id: coder',
        'name: Coder',
        'trigger: { type: source, source: repo_a }',
        'identity: coder',
        'filter: { field: project.Status, operator: equals, value: Ready }',
        'item_priority:',
        '  rules:',
        '    - when: { field: project.Priority, operator: in, value: [P0, P1] }',
        '      value: 10',
        'execute:',
        '  type: shell',
        `  command: ${worker}`,
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(e.configDir, 'views', 'board.yaml'),
      [
        'id: board',
        'sources: [repo_a]',
        'filter: { field: project.Status, operator: in, value: [Todo, Ready] }',
        'fields:',
        '  - { field: title, link: url }',
        '  - { field: project.Status, label: Status }',
        '  - { field: project.Priority, label: Priority }',
        'sort: { field: project.Status, direction: desc }',
        '',
      ].join('\n'),
    );
  });
});

afterAll(async () => {
  await env?.cleanup();
});

function readIdentities(e: AppEnv): string {
  // Keep the app identities written by the helper and append the token identity.
  return readFileSync(path.join(e.configDir, 'identities.yaml'), 'utf8');
}

describe('project fields end-to-end', () => {
  it('starts only the item whose project status is Ready; dry-run and view show the project fields', async () => {
    env.github.createIssue(REPO_A, { number: 1, title: 'ready one' });
    env.github.createIssue(REPO_A, { number: 2, title: 'todo one' });
    env.github.createIssue(REPO_A, { number: 3, title: 'not in project' });
    env.github.addProjectItem(project, REPO_A, 1, { Status: 'Ready', Priority: 'P1' });
    env.github.addProjectItem(project, REPO_A, 2, { Status: 'Todo' });

    const dry = await env.request('POST', '/api/v1/workflows/coder/dry-run');
    expect(dry.status).toBe(200);
    const byKey = new Map((dry.json.candidates as Array<{ itemKey: string; decision: string; itemPriority: number; projectFields: unknown }>).map((c) => [c.itemKey, c]));
    expect(byKey.get('repo_a:1')).toMatchObject({
      decision: 'would_start',
      itemPriority: 10,
      projectFields: { 'project.Status': { known: true, value: 'Ready' }, 'project.Priority': { known: true, value: 'P1' } },
    });
    expect(byKey.get('repo_a:2')).toMatchObject({ decision: 'filtered', projectFields: { 'project.Status': { known: true, value: 'Todo' } } });
    expect(byKey.get('repo_a:3')).toMatchObject({ decision: 'filtered', projectFields: { 'project.Status': { known: true, value: null } } });
    expect(formatDryRun(dry.json)).toContain('     project fields:\n       project.Status: "Ready"\n       project.Priority: "P1"');

    const report = await env.app.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    const run = await env.waitTerminal(report.startedRunIds[0] as string);
    expect(run).toMatchObject({ sourceItemKey: 'repo_a:1', status: 'completed', businessResult: 'success' });
    const all = env.app.persistence.runs.list({ workflowId: 'coder' });
    expect(all.runs.map((r) => r.sourceItemKey)).toEqual(['repo_a:1']);

    const view = await env.request('GET', '/api/v1/views/board/items?refresh=1');
    expect(view.status).toBe(200);
    expect(view.json.columns.map((c: { field: string; type: string | null }) => [c.field, c.type])).toEqual([
      ['title', 'string'],
      ['project.Status', 'string'],
      ['project.Priority', 'string'],
    ]);
    expect(view.json.rows.map((r: { itemId: string; cells: Array<{ value: unknown }> }) => [r.itemId, r.cells.map((c) => c.value)])).toEqual([
      ['2', ['todo one', 'Todo', null]],
      ['1', ['ready one', 'Ready', 'P1']],
    ]);

    // The project was read with the token identity only; the token never shows up in logs.
    const graphql = env.github.requests.filter((r) => r.graphql);
    expect(graphql.length).toBeGreaterThan(0);
    expect(graphql.every((r) => r.token === userToken)).toBe(true);
    expect(JSON.stringify(env.logger.records)).not.toContain(userToken);
  });

  it('without project access the filter is unknown and nothing starts', async () => {
    env.github.createIssue(REPO_A, { number: 4, title: 'also ready' });
    env.github.addProjectItem(project, REPO_A, 4, { Status: 'Ready' });
    env.github.denyProject(project);
    const dry = await env.request('POST', '/api/v1/workflows/coder/dry-run');
    const c4 = (dry.json.candidates as Array<{ itemKey: string; decision: string; projectFields: Record<string, { known: boolean; reason?: string }> }>).find(
      (c) => c.itemKey === 'repo_a:4',
    );
    expect(c4?.decision).toBe('filter_unknown');
    // Metadata is still shared from the previous listing (< 30 s): the values query reports the lost access.
    expect(c4?.projectFields['project.Status']).toMatchObject({
      known: false,
      reason: expect.stringMatching(/GitHub project octo-user\/5( unavailable|: Resource not accessible)/),
    });
    expect(formatDryRun(dry.json)).toMatch(/project\.Status: unknown – .*GitHub project octo-user\/5/);
    const report = await env.app.scheduler.planOnce();
    expect(report.startedRunIds).toEqual([]);
  });
});
