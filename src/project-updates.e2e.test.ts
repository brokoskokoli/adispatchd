/**
 * End-to-end (WI-16): complete app with configuration files and Fake-GitHub.
 * A workflow on an organisation project sets `Status` to "In Progress" in
 * `on_start` and to "Review" in `on_success` via `source.update`. The fake
 * sees exactly these two mutations, written with the workflow identity; a
 * second pass of the hook changes nothing. A user-owned project with an
 * explicit `project.identity` (`github_token`) gets the item added.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';
import type { SourceUpdateActionConfig } from './config/index.js';
import type { FakeProject } from './sources/github/testing/index.js';

let env: AppEnv;
let project: FakeProject;
let userProject: FakeProject;
let userToken: string;

beforeAll(async () => {
  env = await startAppEnv({}, (e) => {
    project = e.github.createProject('example', {
      number: 2,
      fields: [{ name: 'Status', dataType: 'SINGLE_SELECT', options: ['Ready', 'In Progress', 'Review', 'Done'] }],
    });
    userToken = e.github.createUserToken('octo-user');
    e.env.BOARD_TOKEN = userToken;
    userProject = e.github.createProject('octo-user', {
      number: 5,
      ownerType: 'User',
      fields: [{ name: 'Status', dataType: 'SINGLE_SELECT', options: ['Triage', 'Done'] }],
    });
    writeFileSync(
      path.join(e.configDir, 'identities.yaml'),
      `${readFileSync(path.join(e.configDir, 'identities.yaml'), 'utf8')}  board:\n    type: github_token\n    token_env: BOARD_TOKEN\n`,
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
        '    project: { number: 2, fields: { Status: single_select } }',
        '  repo_b:',
        '    type: github',
        '    owner: example',
        '    repository: b',
        '    identity: maintainer',
        '    project: { owner: octo-user, number: 5, identity: board, fields: { Status: single_select } }',
        '',
      ].join('\n'),
    );
    const worker = e.script('coder.sh', `printf '{"schema_version":1,"result":"success","message":"ok"}' > "$ADISPATCH_RESULT_FILE"`);
    writeFileSync(
      path.join(e.configDir, 'workflows', 'coder.yaml'),
      [
        'id: coder',
        'trigger: { type: source, source: repo_a }',
        'identity: coder',
        'filter: { field: project.Status, operator: equals, value: Ready }',
        'execute:',
        '  type: shell',
        `  command: ${worker}`,
        'on_start:',
        '  - type: source.update',
        '    project: { Status: In Progress }',
        'on_success:',
        '  - type: source.update',
        '    project: { Status: Review }',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(e.configDir, 'workflows', 'triage.yaml'),
      [
        'id: triage',
        'trigger: { type: source, source: repo_b }',
        'identity: coder',
        'filter: { field: labels, operator: contains, value: triage }',
        'execute:',
        '  type: shell',
        `  command: ${worker}`,
        'on_success:',
        '  - type: source.update',
        '    labels: { remove: [triage] }',
        '    project: { Status: Triage }',
        '',
      ].join('\n'),
    );
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('project field updates end-to-end', () => {
  it('on_start sets "In Progress", on_success sets "Review"; a second pass changes nothing', async () => {
    env.github.createIssue(REPO_A, { number: 1, title: 'ready one' });
    env.github.addProjectItem(project, REPO_A, 1, { Status: 'Ready' });

    const report = await env.app.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    const runId = report.startedRunIds[0] as string;
    const run = await env.waitTerminal(runId);
    expect(run).toMatchObject({ sourceItemKey: 'repo_a:1', status: 'completed', businessResult: 'success', lifecycleStatus: 'succeeded' });

    const status = project.fields[0];
    const optionId = (name: string): string | undefined => status?.options.find((o) => o.name === name)?.id;
    const itemId = project.itemIds.get(env.github.issue(REPO_A, 1).nodeId);
    expect(env.github.projectMutations().map((m) => [m.name, m.variables])).toEqual([
      ['updateProjectV2ItemFieldValue', { projectId: project.id, itemId, fieldId: status?.id, value: { singleSelectOptionId: optionId('In Progress') } }],
      ['updateProjectV2ItemFieldValue', { projectId: project.id, itemId, fieldId: status?.id, value: { singleSelectOptionId: optionId('Review') } }],
    ]);
    expect(env.github.projectValues(project, REPO_A, 1)).toEqual({ Status: 'Review' });

    // Written with the workflow identity (coder), not the reading source identity (maintainer).
    const listingToken = env.github.requests.find((r) => r.method === 'GET' && r.path === '/repos/example/a/issues')?.token;
    const mutationTokens = new Set(env.github.requests.filter((r) => r.graphql?.query.trimStart().startsWith('mutation')).map((r) => r.token));
    expect(mutationTokens.size).toBe(1);
    expect(mutationTokens.has(listingToken)).toBe(false);

    // The journal (API) shows what was changed.
    const events = await env.request('GET', `/api/v1/runs/${runId}/events`);
    const applied = (events.json.events as Array<{ type: string; payload: { hook?: string; status?: string; details?: { applied?: unknown } } }>)
      .filter((e) => e.type === 'lifecycle.action' && e.payload.status === 'succeeded')
      .map((e) => [e.payload.hook, e.payload.details?.applied]);
    expect(applied).toEqual([
      ['on_start', { projectFields: { Status: 'In Progress' } }],
      ['on_success', { projectFields: { Status: 'Review' } }],
    ]);

    // Second pass: the journaled hook runs nothing, and re-applying its update changes nothing.
    const before = env.github.requests.length;
    const again = await env.app.lifecycle.runHook(runId, 'on_success', undefined, { wait: true });
    expect(again.status).toBe('succeeded');
    expect(env.github.requests.length).toBe(before);
    const adapter = env.app.sources.get('repo_a');
    const item = await adapter?.getItem('1');
    const action = env.app.config.current.workflows.coder?.hooks.on_success[0] as SourceUpdateActionConfig;
    const result = await adapter?.applyUpdate(item!, { project: action.project! }, 'coder');
    expect(result).toEqual({ changed: false });
    expect(env.github.projectMutations()).toHaveLength(2);

    // In "Review" the item no longer matches the filter.
    expect((await env.app.scheduler.planOnce()).startedRunIds).toEqual([]);
  });

  it('an explicit project.identity writes the user-owned project and adds the item', async () => {
    env.github.createIssue('example/b', { number: 9, title: 'triage me', labels: ['triage'] });
    const before = env.github.projectMutations().length;
    const report = await env.app.scheduler.planOnce();
    const runId = report.startedRunIds.find((id) => env.app.persistence.runs.get(id)?.workflowId === 'triage');
    expect(runId).toBeDefined();
    const run = await env.waitTerminal(runId as string);
    expect(run).toMatchObject({ status: 'completed', lifecycleStatus: 'succeeded' });
    const mutations = env.github.projectMutations().slice(before);
    expect(mutations.map((m) => m.name)).toEqual(['addProjectV2ItemById', 'updateProjectV2ItemFieldValue']);
    expect(env.github.projectValues(userProject, 'example/b', 9)).toEqual({ Status: 'Triage' });
    expect(env.github.labels('example/b', 9)).toEqual([]);
    const writes = env.github.requests.filter((r) => r.graphql?.query.trimStart().startsWith('mutation')).slice(before);
    expect(writes.every((r) => r.token === userToken)).toBe(true);
    expect(JSON.stringify(env.logger.records)).not.toContain(userToken);
  });
});
