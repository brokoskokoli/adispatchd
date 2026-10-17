import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, REPO_B, startAppEnv, type AppEnv } from '../api/testing/helpers.js';
import { safeLink } from './service.js';

const VIEW = `
id: needs-maintainer
title: Needs Maintainer
sources: [repo_a, repo_b]
filter:
  all:
    - { field: labels, operator: contains, value: needs-maintainer }
fields:
  - { field: repository, label: Repository }
  - { field: number, label: Issue }
  - { field: title, label: Titel, link: url }
  - { field: run.last_workflow, label: Letzter Agent }
  - { field: run.last_result.message, label: Ergebnis }
  - { field: run.last_status, label: Status }
sort: { field: number, direction: desc }
`;

let env: AppEnv;

beforeAll(async () => {
  env = await startAppEnv({ views: { 'needs-maintainer': VIEW } }, (e) => {
    e.github.createIssue(REPO_A, { number: 1, title: 'A one', labels: ['needs-maintainer'] });
    e.github.createIssue(REPO_A, { number: 2, title: 'A two', labels: ['ready'] });
    e.github.createIssue(REPO_B, { number: 3, title: 'B three <script>', labels: ['needs-maintainer', 'x'] });
  });
  // A finished run for repo_a:1 with a business failure message.
  const p = env.app.persistence;
  const run = p.runs.reserve({ workflowId: 'coder', triggerType: 'source', sourceId: 'repo_a', sourceItemKey: 'repo_a:1', configSnapshot: {} });
  p.runs.transition(run.id, 'starting');
  p.runs.transition(run.id, 'running');
  p.runs.beginFinalization(run.id, { status: 'completed', businessResult: 'failure', reason: 'result failure' }, {
    update: { result: { schema_version: 1, result: 'failure', message: 'Question for maintainer' } },
  });
  p.runs.finish(run.id);
});

afterAll(async () => {
  await env.cleanup();
});

describe('views (scenario 10)', () => {
  it('combines two repositories, enriches with the last run and links the title', async () => {
    const list = await env.request('GET', '/api/v1/views');
    expect(list.json.views).toMatchObject([{ id: 'needs-maintainer', title: 'Needs Maintainer', sources: ['repo_a', 'repo_b'] }]);
    const def = await env.request('GET', '/api/v1/views/needs-maintainer');
    expect(def.json.columns.map((c: { field: string }) => c.field)).toContain('run.last_workflow');

    const res = await env.request('GET', '/api/v1/views/needs-maintainer/items');
    expect(res.status).toBe(200);
    const body = res.json;
    expect(body.errors).toEqual([]);
    expect(body.cached).toBe(false);
    expect(body.rows.map((r: { key: string }) => r.key)).toEqual(['repo_b:3', 'repo_a:1']); // sorted by number desc
    const [b3, a1] = body.rows;
    const col = (name: string) => body.columns.findIndex((c: { field: string }) => c.field === name);
    expect(a1.cells[col('repository')].value).toBe('example/a');
    expect(b3.cells[col('repository')].value).toBe('example/b');
    expect(a1.cells[col('title')]).toMatchObject({ value: 'A one', link: 'https://github.com/example/a/issues/1' });
    expect(b3.cells[col('title')].value).toBe('B three <script>'); // raw text, UI escapes
    expect(a1.cells[col('run.last_workflow')].value).toBe('coder');
    expect(a1.cells[col('run.last_result.message')].value).toBe('Question for maintainer');
    expect(a1.cells[col('run.last_status')].value).toBe('completed');
    expect(a1.lastRunId).toBeTruthy();
    expect(b3.cells[col('run.last_workflow')]).toEqual({ value: null, known: true, link: null });
  });

  it('caches results briefly, refreshes on demand and reports failing sources', async () => {
    env.github.createIssue(REPO_A, { number: 4, title: 'A four', labels: ['needs-maintainer'] });
    const cached = await env.request('GET', '/api/v1/views/needs-maintainer/items');
    expect(cached.json.cached).toBe(true);
    expect(cached.json.rows).toHaveLength(2);
    env.app.redactor.add('LEAKED-SECRET-123');
    env.github.failNext({ method: 'GET', path: '/repos/example/b/issues' }, { status: 404, body: { message: 'Not Found LEAKED-SECRET-123' } }, 5);
    const fresh = await env.request('GET', '/api/v1/views/needs-maintainer/items?refresh=true');
    expect(fresh.json.cached).toBe(false);
    expect(fresh.json.rows.map((r: { key: string }) => r.key)).toEqual(['repo_a:4', 'repo_a:1']);
    expect(fresh.json.errors).toMatchObject([{ sourceId: 'repo_b' }]);
    expect(JSON.stringify(fresh.json.errors)).not.toContain('LEAKED-SECRET-123');
  });

  it('only allows http(s) links', () => {
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('https://x.test/a')).toBe('https://x.test/a');
    expect(safeLink(42)).toBeNull();
  });
});
