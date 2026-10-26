/**
 * End-to-end (WI-32): `GET /api/v1/dashboard` (default and configured layout,
 * reload), view widgets' narrowing of `GET /api/v1/views/:id/items`
 * (`sections`, `limit`; one source query shared through the view cache) and
 * the runs filter by several workflows.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';

let env: AppEnv;

const VIEW = [
  'id: board',
  'title: Board',
  'sources: [repo_a]',
  'fields: [{ field: number, label: Nr. }, { field: title }]',
  'sort: { field: number, direction: asc }',
  'sections:',
  '  - { title: Review, filter: { field: labels, operator: contains, value: review } }',
  '  - { title: Rest, rest: true }',
  '',
].join('\n');

const wf = (id: string, command: string): string => `id: ${id}\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: ${command}\n`;

beforeAll(async () => {
  env = await startAppEnv({ views: { board: VIEW, flat: 'id: flat\ntitle: Flat\nsources: [repo_a]\nfields: [{ field: number }]\nsort: { field: number }\n' } }, (e) => {
    const ok = e.script('ok.sh', 'exit 0');
    for (const id of ['alpha', 'beta', 'gamma']) writeFileSync(path.join(e.configDir, 'workflows', `${id}.yaml`), wf(id, ok));
    for (let n = 1; n <= 5; n++) e.github.createIssue(REPO_A, { number: n, title: `Issue ${n}`, labels: n <= 3 ? ['review'] : [] });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

const listings = (): number => env.github.requests.filter((r) => r.method === 'GET' && r.path === '/repos/example/a/issues').length;

describe('dashboard layout API (WI-32)', () => {
  it('serves the default layout without dashboard.yaml and the configured one after a reload', async () => {
    const def = await env.request('GET', '/api/v1/dashboard');
    expect(def.status).toBe(200);
    expect(def.json.configured).toBe(false);
    expect(def.json.layout.map((r: { columns: Array<{ widgets: Array<{ widget: string }> }> }) => r.columns.map((c) => c.widgets[0]?.widget))).toEqual([
      ['resources'],
      ['info'],
      ['scheduler', 'capacity', 'attention'],
      ['active_runs'],
      ['recent_runs'],
    ]);

    writeFileSync(
      path.join(env.configDir, 'dashboard.yaml'),
      'layout:\n  - title: Board\n    row: [{ widget: view, view: board, sections: [Review], limit: 2, width: 2 }, { column: [scheduler] }]\n',
    );
    expect((await env.request('POST', '/api/v1/config/reload', {})).status).toBe(200);
    const res = await env.request('GET', '/api/v1/dashboard');
    expect(res.json).toEqual({
      configured: true,
      layout: [
        {
          title: 'Board',
          columns: [
            { width: 2, widgets: [{ widget: 'view', title: null, view: 'board', sections: ['Review'], limit: 2, refreshMs: 60_000 }] },
            { width: 1, widgets: [{ widget: 'scheduler', title: null }] },
          ],
        },
      ],
    });
  });

  it('narrows view items to sections and a row limit from one cached source query', async () => {
    const before = listings();
    const full = await env.request('GET', '/api/v1/views/board/items?refresh=1');
    expect(full.json.sections.map((s: { title: string; rows: unknown[] }) => [s.title, s.rows.length])).toEqual([
      ['Review', 3],
      ['Rest', 2],
    ]);
    const narrowed = await env.request('GET', '/api/v1/views/board/items?sections=Review&limit=2');
    expect(narrowed.status).toBe(200);
    expect(narrowed.json.cached).toBe(true);
    expect(narrowed.json.sections).toHaveLength(1);
    expect(narrowed.json.sections[0].rows.map((r: { key: string }) => r.key)).toEqual(['repo_a:1', 'repo_a:2']);
    expect(narrowed.json.sections[0].counts.rows).toBe(3);
    const two = await env.request('GET', '/api/v1/views/board/items?sections=Rest&sections=Review');
    expect(two.json.sections.map((s: { title: string }) => s.title)).toEqual(['Review', 'Rest']);
    expect(listings() - before).toBe(1);

    const flat = await env.request('GET', '/api/v1/views/flat/items?limit=1');
    expect(flat.json.rows).toHaveLength(1);
    expect(flat.json.totalRows).toBe(5);

    expect((await env.request('GET', '/api/v1/views/board/items?sections=Nope')).json.error.message).toBe('Unknown section(s) of view "board": "Nope"');
    expect((await env.request('GET', '/api/v1/views/flat/items?sections=Review')).json.error.message).toBe('View "flat" has no sections');
    expect((await env.request('GET', '/api/v1/views/board/items?limit=0')).status).toBe(400);
  });

  it('filters runs by a list of workflows', async () => {
    for (const id of ['alpha', 'beta', 'gamma']) {
      const res = await env.request('POST', `/api/v1/workflows/${id}/start`, {});
      expect(res.status).toBe(202);
      await env.waitTerminal(res.json.run.id);
    }
    const ids = async (q: string): Promise<string[]> =>
      ((await env.request('GET', `/api/v1/runs?${q}`)).json.runs as Array<{ workflowId: string }>).map((r) => r.workflowId).sort();
    expect(await ids('workflow=alpha,gamma')).toEqual(['alpha', 'gamma']);
    expect(await ids('workflow=beta')).toEqual(['beta']);
    expect(await ids('workflow=alpha,%20beta&active=false')).toEqual(['alpha', 'beta']);
  });
});
