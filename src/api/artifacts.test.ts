/** Artifact routes (WI-35): listing, filters, detail, roles, errors. The full flow is in src/artifacts.e2e.test.ts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authEnvSetup, AUTH_PASSWORDS, FAST_AUTH, PASSWORD_AUTH_CONFIG } from './testing/auth.js';
import { startAppEnv, type AppEnv } from './testing/helpers.js';

let env: AppEnv;
const cookies: Record<string, string> = {};
const as = (user: keyof typeof AUTH_PASSWORDS): Record<string, string> => ({ cookie: cookies[user]! });
const get = (url: string) => env.request('GET', url, undefined, as('victor'));

const ID = (n: number): string => `art-20261029T10000${n}000Z-0000000${n}`;

function store(n: number, over: Partial<Parameters<AppEnv['app']['persistence']['artifacts']['insert']>[0]> = {}): string {
  const id = ID(n);
  const kind = over.kind ?? 'file';
  const content = path.join(env.dataDir, 'artifacts', id, 'content');
  if (kind === 'file') {
    mkdirSync(path.dirname(content), { recursive: true });
    writeFileSync(content, `file ${n}`);
  } else {
    mkdirSync(path.join(content, 'sub'), { recursive: true });
    writeFileSync(path.join(content, 'sub', 'x.txt'), 'x');
  }
  env.app.persistence.artifacts.insert({
    id,
    name: `Artifact ${n}`,
    type: 'report',
    kind,
    fileName: kind === 'file' ? `a${n}.txt` : 'dir',
    size: 6,
    fileCount: 1,
    workflowId: 'make',
    runId: 'run-gone',
    ordinal: n,
    parentId: null,
    ...over,
  });
  return id;
}

beforeAll(async () => {
  env = await startAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: FAST_AUTH }, (e) => {
    authEnvSetup(e);
    writeFileSync(path.join(e.configDir, 'sources.yaml'), ['sources:', '  artifacts: { type: artifacts }', ''].join('\n'));
    writeFileSync(
      path.join(e.configDir, 'workflows', 'process.yaml'),
      ['id: process', 'name: Process', 'trigger: { type: source, source: artifacts }', 'execute:', '  type: shell', '  command: /bin/true', ''].join('\n'),
    );
    writeFileSync(path.join(e.configDir, 'workflows', 'other.yaml'), ['id: other', 'trigger: { type: manual }', 'execute:', '  type: shell', '  command: /bin/true', ''].join('\n'));
  });
  for (const [name, password] of Object.entries(AUTH_PASSWORDS)) {
    const res = await env.request('POST', '/api/v1/auth/login', { name, password });
    cookies[name] = String(res.headers['set-cookie']).split(';')[0]!;
  }
});
afterAll(async () => env?.cleanup());

describe('artifact routes (WI-35)', () => {
  it('lists newest first with filters, paging and facets', async () => {
    store(1, { name: 'Alpha report', type: 'report', createdAt: '2026-10-29T10:00:01.000Z' });
    store(2, { name: 'Beta logs', type: 'logs', kind: 'folder', workflowId: 'collect', createdAt: '2026-10-29T10:00:02.000Z' });
    store(3, { name: 'Gamma report', type: 'report', parentId: ID(1), createdAt: '2026-10-29T10:00:03.000Z' });
    const all = await env.request('GET', '/api/v1/artifacts', undefined, as('victor'));
    expect(all.status).toBe(200);
    expect(all.json.artifacts.map((a: { id: string }) => a.id)).toEqual([ID(3), ID(2), ID(1)]);
    expect(all.json).toMatchObject({ total: 3, limit: 50, offset: 0, sourceId: 'artifacts', facets: { types: ['logs', 'report'], workflows: ['collect', 'make'] } });
    expect(all.json.artifacts[2]).toEqual({
      id: ID(1),
      name: 'Alpha report',
      type: 'report',
      kind: 'file',
      fileName: 'a1.txt',
      size: 6,
      fileCount: 1,
      workflow: 'make',
      runId: 'run-gone',
      parent: null,
      consumedBy: [],
      createdAt: '2026-10-29T10:00:01.000Z',
      url: `#/artifacts/${ID(1)}`,
    });
    const ids = async (query: string): Promise<string[]> => (await get(`/api/v1/artifacts?${query}`)).json.artifacts.map((a: { id: string }) => a.id);
    expect(await ids('type=report')).toEqual([ID(3), ID(1)]);
    expect(await ids('workflow=collect')).toEqual([ID(2)]);
    expect(await ids('kind=folder')).toEqual([ID(2)]);
    expect(await ids('parent=' + ID(1))).toEqual([ID(3)]);
    expect(await ids('q=GAMMA')).toEqual([ID(3)]);
    expect(await ids('run=run-gone&limit=1&offset=1')).toEqual([ID(2)]);
    for (const bad of ['kind=bundle', 'limit=0', 'limit=500', 'offset=-1', 'unknown=1']) {
      const res = await get(`/api/v1/artifacts?${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.json.error.code).toBe('invalid_request');
    }
  });

  it('shows the detail with file tree, parent, children and the workflows that can start on it', async () => {
    const detail = await get(`/api/v1/artifacts/${ID(2)}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({
      artifact: { id: ID(2), kind: 'folder' },
      files: [{ path: 'sub/x.txt', size: 1 }],
      filesTruncated: false,
      producer: { runId: 'run-gone', workflow: 'collect', run: null },
      parent: null,
      children: [],
      runs: [],
      itemKey: `artifacts:${ID(2)}`,
      sourceId: 'artifacts',
    });
    expect(detail.json.workflows).toEqual([{ id: 'process', name: 'Process', enabled: true }]);
    const withParent = await get(`/api/v1/artifacts/${ID(3)}`);
    expect(withParent.json.parent).toEqual({ id: ID(1), exists: true, name: 'Alpha report' });
    expect((await get(`/api/v1/artifacts/${ID(1)}`)).json.children.map((a: { id: string }) => a.id)).toEqual([ID(3)]);
    for (const id of ['nope', '../x', ID(9)]) expect((await get(`/api/v1/artifacts/${encodeURIComponent(id)}`)).json.error?.code, id).toBe('artifact_not_found');
  });

  it('downloads a stored file with safe headers', async () => {
    const res = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${ID(1)}/download`, headers: as('victor') });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('file 1');
    expect(res.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="a1.txt"; filename*=UTF-8\'\'a1.txt',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    });
    const byPath = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${ID(1)}/files/a1.txt`, headers: as('victor') });
    expect(byPath.body).toBe('file 1');
    const missing = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${ID(1)}/files/other.txt`, headers: as('victor') });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('artifact_file_not_found');
    const bad = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${ID(2)}/files/sub%2F..%2F..%2Fx`, headers: as('victor') });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('artifact_invalid_path');
  });

  it('enforces roles: viewers read, operators start, only admins delete', async () => {
    expect((await env.request('POST', `/api/v1/artifacts/${ID(1)}/start`, { workflow: 'process' }, as('victor'))).status).toBe(403);
    expect((await env.request('DELETE', `/api/v1/artifacts/${ID(1)}`, undefined, as('victor'))).status).toBe(403);
    const operatorDelete = await env.request('DELETE', `/api/v1/artifacts/${ID(1)}`, undefined, as('olga'));
    expect(operatorDelete.status).toBe(403);
    expect(operatorDelete.json.error.details).toMatchObject({ requiredRole: 'admin', role: 'operator' });
    expect((await env.request('GET', `/api/v1/artifacts/${ID(1)}`, undefined, as('victor'))).status).toBe(200);

    const started = await env.request('POST', `/api/v1/artifacts/${ID(1)}/start`, { workflow: 'process' }, as('olga'));
    expect(started.status).toBe(202);
    expect(started.json.run).toMatchObject({ workflowId: 'process', triggerType: 'manual', sourceItemKey: `artifacts:${ID(1)}` });
    await env.waitTerminal(started.json.run.id);
    // The audit names the user on the run.
    const events = env.app.persistence.events.listForRun(started.json.run.id);
    expect(events.find((e) => e.type === 'audit.user_action')?.payload).toMatchObject({ action: 'start', actor: 'olga', artifact: ID(1) });
    // No processing of an artifact that is not an item of the workflow's source.
    expect((await env.request('POST', `/api/v1/artifacts/${ID(1)}/start`, { workflow: 'other' }, as('olga'))).json.error.code).toBe('workflow_not_applicable');
    expect((await env.request('POST', `/api/v1/artifacts/${ID(1)}/start`, { workflow: 'process', extra: 1 }, as('olga'))).status).toBe(400);

    const deleted = await env.request('DELETE', `/api/v1/artifacts/${ID(1)}`, undefined, as('alice'));
    expect(deleted.status).toBe(200);
    expect(deleted.json.artifact.id).toBe(ID(1));
    expect((await env.request('GET', `/api/v1/artifacts/${ID(1)}`, undefined, as('alice'))).status).toBe(404);
  });
});
