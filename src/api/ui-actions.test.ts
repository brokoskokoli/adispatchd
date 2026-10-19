/**
 * UI actions as an identity (WI-27) against Fake-GitHub: comment, labels and
 * project fields as an enabled identity; rejected for disabled identities,
 * other roles, the control token, missing CSRF header, foreign items and
 * `auth.mode: none`; audit entries incl. failures; comments are never
 * retried and are redacted before sending.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONTROL_TOKEN_HEADER } from './auth.js';
import { authEnvSetup, AUTH_PASSWORDS, FAST_AUTH, PASSWORD_AUTH_CONFIG } from './testing/auth.js';
import { REPO_A, REPO_B, startAppEnv, type AppEnv } from './testing/helpers.js';
import type { FakeProject } from '../sources/github/testing/index.js';

let env: AppEnv;
let project: FakeProject;
const cookies: Record<string, string> = {};

/** Enable `ui_actions` for `maintainer` only and give repo_a a project. */
function setup(e: AppEnv): void {
  const file = path.join(e.configDir, 'identities.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('    private_key_env: MAINTAINER_KEY\n', '    private_key_env: MAINTAINER_KEY\n    ui_actions: true\n'));
  writeFileSync(
    path.join(e.configDir, 'sources.yaml'),
    [
      'sources:',
      '  repo_a:',
      '    type: github',
      '    owner: example',
      '    repository: a',
      '    identity: maintainer',
      '    project: { number: 2, fields: { Status: single_select, Notes: text, Estimate: number } }',
      '  repo_b: { type: github, owner: example, repository: b, identity: maintainer }',
      '',
    ].join('\n'),
  );
  project = e.github.createProject('example', {
    number: 2,
    fields: [
      { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Ready', 'Review'] },
      { name: 'Notes', dataType: 'TEXT' },
      { name: 'Estimate', dataType: 'NUMBER' },
    ],
  });
}

const as = (user: string): Record<string, string> => ({ cookie: cookies[user]! });
const comments = () => env.github.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'));

beforeAll(async () => {
  env = await startAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: FAST_AUTH }, (e) => {
    authEnvSetup(e);
    setup(e);
  });
  for (const [name, password] of Object.entries(AUTH_PASSWORDS)) {
    const res = await env.request('POST', '/api/v1/auth/login', { name, password });
    expect(res.status, name).toBe(200);
    cookies[name] = String(res.headers['set-cookie']).split(';')[0]!;
  }
  env.github.createIssue(REPO_A, { number: 1, title: 'First', labels: ['bug'] });
  env.github.createIssue(REPO_B, { number: 5, title: 'Only in b' });
  env.github.addProjectItem(project, REPO_A, 1, { Status: 'Ready' });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(() => {
  env.github.requests.length = 0;
});

describe('comments', () => {
  it('posts as the identity and audits the comment URL (never the text)', async () => {
    const res = await env.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: 'Thanks, **looking** into it' }, as('alice'));
    expect(res.status).toBe(200);
    expect(res.json.comment.url).toContain('/issues/1#issuecomment-');
    expect(res.json.redacted).toBe(false);
    expect(res.json.action).toMatchObject({ actor: 'alice', actorVia: 'password', identity: 'maintainer', itemKey: 'repo_a:1', kind: 'comment', result: 'succeeded', commentUrl: res.json.comment.url });
    const posted = env.github.comments(REPO_A, 1).at(-1)!;
    expect(posted).toMatchObject({ body: 'Thanks, **looking** into it', author: 'maintainer[bot]' });
    const row = env.app.persistence.db.prepare('SELECT * FROM ui_actions WHERE id = ?').get(res.json.action.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('looking');
  });

  it('redacts secrets in the text before sending', async () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const res = await env.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: `token ${token} and key ${env.env.MAINTAINER_KEY}` }, as('alice'));
    expect(res.status).toBe(200);
    expect(res.json.redacted).toBe(true);
    const body = env.github.comments(REPO_A, 1).at(-1)!.body;
    expect(body).not.toContain(token);
    expect(body).not.toContain('PRIVATE KEY');
    expect(body).toContain('[REDACTED]');
  });

  it('is never retried: rate limit, server error and lost response are audited', async () => {
    env.github.failNext({ method: 'POST', path: /\/comments$/ }, { status: 429, headers: { 'retry-after': '1' } });
    const limited = await env.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: 'x' }, as('alice'));
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('github_rate_limited');
    expect(limited.headers['retry-after']).toBe('1');
    expect(comments()).toHaveLength(1);

    env.github.failNext({ method: 'POST', path: /\/comments$/ }, { status: 502 });
    const broken = await env.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: 'y' }, as('alice'));
    expect(broken.status).toBe(502);
    expect(broken.json.error.code).toBe('github_outcome_unknown');
    expect(comments()).toHaveLength(2);

    env.github.failNext({ method: 'POST', path: /\/comments$/ }, { status: 403, body: { message: 'Unable to create comment because issue is locked.' } });
    const locked = await env.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: 'z' }, as('alice'));
    expect(locked.status).toBe(502);
    expect(locked.json.error).toMatchObject({ code: 'github_forbidden' });
    expect(locked.json.error.message).toMatch(/locked/);
    expect(comments()).toHaveLength(3);

    const audit = env.app.persistence.uiActions.list({ limit: 3 }).actions;
    expect(audit.map((a) => [a.result, a.errorCode])).toEqual([
      ['failed', 'github_forbidden'],
      ['unknown', 'github_outcome_unknown'],
      ['failed', 'github_rate_limited'],
    ]);
  });

  it('rejects empty and too long comments without contacting GitHub', async () => {
    expect((await env.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: '  ' }, as('alice'))).status).toBe(400);
    expect((await env.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: 'x'.repeat(65_537) }, as('alice'))).status).toBe(400);
    expect(comments()).toHaveLength(0);
  });
});

describe('access control', () => {
  const post = (headers: Record<string, string>, body: unknown = { identity: 'maintainer', body: 'nope' }) =>
    env.request('POST', '/api/v1/items/repo_a/1/comment', body, headers);

  it('refuses identities without ui_actions (audited) and unknown identities', async () => {
    const coder = await post(as('alice'), { identity: 'coder', body: 'nope' });
    expect(coder.status).toBe(403);
    expect(coder.json.error.code).toBe('identity_not_allowed');
    expect((await post(as('alice'), { identity: 'ghost', body: 'nope' })).json.error.code).toBe('identity_not_allowed');
    expect(env.app.persistence.uiActions.list({ limit: 1 }).actions[0]).toMatchObject({ identity: 'ghost', result: 'failed', errorCode: 'identity_not_allowed' });
    expect(comments()).toHaveLength(0);
  });

  it('needs the admin role: operator/viewer 403, no login 401', async () => {
    for (const user of ['olga', 'victor']) {
      const res = await post(as(user));
      expect(res.status, user).toBe(403);
      expect(res.json.error.code).toBe('forbidden');
      expect((await env.request('GET', '/api/v1/items/repo_a/1', undefined, as(user))).status).toBe(403);
    }
    expect((await post({})).status).toBe(401);
    expect(comments()).toHaveLength(0);
  });

  it('does not accept the local control token (workers can read it)', async () => {
    const headers = { [CONTROL_TOKEN_HEADER]: env.app.auth.controlToken };
    for (const [method, url, body] of [
      ['POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: 'x' }],
      ['POST', '/api/v1/items/repo_a/1/labels', { identity: 'maintainer', add: ['x'] }],
      ['POST', '/api/v1/items/repo_a/1/project', { identity: 'maintainer', fields: { Status: 'Review' } }],
      ['GET', '/api/v1/items/repo_a/1', undefined],
    ] as const) {
      const res = await env.request(method, url, body, headers);
      expect(res.status, url).toBe(403);
      // Refused by the route table (no controlToken flag); ui-actions.ts would refuse it again (isInteractive).
      expect(res.json.error.code).toBe('control_token_not_allowed');
    }
    expect(env.github.requests).toHaveLength(0);
  });

  it('requires the CSRF header', async () => {
    const res = await env.app.http.inject({
      method: 'POST',
      url: '/api/v1/items/repo_a/1/comment',
      headers: { 'content-type': 'application/json', ...as('alice') },
      payload: JSON.stringify({ identity: 'maintainer', body: 'x' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_header_missing');
    expect(comments()).toHaveLength(0);
  });

  it('refuses items that do not belong to the source', async () => {
    const foreign = await post(as('alice'), { identity: 'maintainer', body: 'x' });
    expect(foreign.status).toBe(200); // control: the route works
    const wrong = await env.request('POST', '/api/v1/items/repo_a/5/comment', { identity: 'maintainer', body: 'x' }, as('alice'));
    expect(wrong.status).toBe(404);
    expect(wrong.json.error.code).toBe('item_not_found');
    expect((await env.request('POST', '/api/v1/items/repo_a/01/comment', { identity: 'maintainer', body: 'x' }, as('alice'))).json.error.code).toBe('item_not_found');
    expect((await env.request('POST', '/api/v1/items/nope/1/comment', { identity: 'maintainer', body: 'x' }, as('alice'))).json.error.code).toBe('source_not_found');
    expect(env.github.comments(REPO_B, 5)).toEqual([]);
    expect(env.app.persistence.uiActions.list({ limit: 1 }).actions[0]).toMatchObject({ sourceId: 'nope', result: 'failed', errorCode: 'source_not_found' });
  });
});

describe('labels and project fields', () => {
  it('adds/removes labels idempotently as the identity', async () => {
    const res = await env.request('POST', '/api/v1/items/repo_a/1/labels', { identity: 'maintainer', add: ['ready'], remove: ['bug'] }, as('alice'));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ changed: true, applied: { labelsAdded: ['ready'], labelsRemoved: ['bug'] }, action: { kind: 'labels', result: 'succeeded' } });
    expect(env.github.labels(REPO_A, 1)).toEqual(['ready']);
    const again = await env.request('POST', '/api/v1/items/repo_a/1/labels', { identity: 'maintainer', add: ['ready'], remove: ['bug'] }, as('alice'));
    expect(again.json.changed).toBe(false);
    expect((await env.request('POST', '/api/v1/items/repo_a/1/labels', { identity: 'maintainer' }, as('alice'))).status).toBe(400);
  });

  it('sets and clears project fields, validated against project.fields', async () => {
    const res = await env.request('POST', '/api/v1/items/repo_a/1/project', { identity: 'maintainer', fields: { Status: 'Review', Notes: 'see spec', Estimate: 3 } }, as('alice'));
    expect(res.status).toBe(200);
    expect(res.json.applied.projectFields).toEqual({ Status: 'Review', Notes: 'see spec', Estimate: 3 });
    expect(env.github.projectValues(project, REPO_A, 1)).toMatchObject({ Status: 'Review', Notes: 'see spec', Estimate: 3 });
    const cleared = await env.request('POST', '/api/v1/items/repo_a/1/project', { identity: 'maintainer', fields: { Notes: null } }, as('alice'));
    expect(cleared.json.applied.projectFields).toEqual({ Notes: null });

    const bad = await env.request('POST', '/api/v1/items/repo_a/1/project', { identity: 'maintainer', fields: { Priority: 'P1', Estimate: 'many' } }, as('alice'));
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.problems).toEqual(['project field "Priority" is not declared in project.fields of source "repo_a"', 'project field "Estimate": expected a number or null']);
    const option = await env.request('POST', '/api/v1/items/repo_a/1/project', { identity: 'maintainer', fields: { Status: 'Nope' } }, as('alice'));
    expect(option.status).toBe(422);
    expect(option.json.error.code).toBe('github_rejected');
    expect(env.app.persistence.uiActions.list({ limit: 1 }).actions[0]).toMatchObject({ kind: 'project', result: 'failed', errorCode: 'github_rejected' });
    const noProject = await env.request('POST', '/api/v1/items/repo_b/5/project', { identity: 'maintainer', fields: { Status: 'Review' } }, as('alice'));
    expect(noProject.json.error.code).toBe('project_not_configured');
  });
});

describe('item details, resolve and audit list', () => {
  it('returns the item panel data', async () => {
    env.github.addRepoLabels(REPO_A, 'wontfix');
    const res = await env.request('GET', '/api/v1/items/repo_a/1', undefined, as('alice'));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      source: 'repo_a',
      itemId: '1',
      key: 'repo_a:1',
      url: 'https://github.com/example/a/issues/1',
      title: 'First',
      repository: 'example/a',
      identities: [{ id: 'maintainer', type: 'github_app' }],
      project: { owner: 'example', number: 2, error: null },
    });
    expect(res.json.availableLabels).toEqual(expect.arrayContaining(['wontfix']));
    expect(res.json.project.fields[0]).toMatchObject({ name: 'Status', kind: 'single_select', known: true, choices: ['Ready', 'Review'] });
    expect(res.json.recentActions.length).toBeGreaterThan(0);
    expect((await env.request('GET', '/api/v1/items/repo_a/5', undefined, as('alice'))).status).toBe(404);
  });

  it('resolves references', async () => {
    const get = (ref: string) => env.request('GET', `/api/v1/items/resolve?ref=${encodeURIComponent(ref)}`, undefined, as('alice'));
    expect((await get('https://github.com/example/b/issues/5')).json).toEqual({ source: 'repo_b', item: '5' });
    expect((await get('example/a#1')).json).toEqual({ source: 'repo_a', item: '1' });
    expect((await get('repo_b:7')).json).toEqual({ source: 'repo_b', item: '7' });
    expect((await get('12')).json.error.code).toBe('ambiguous_item_ref');
    expect((await get('other/repo#1')).json.error.code).toBe('item_not_found');
  });

  it('lists the audit (admin only)', async () => {
    const res = await env.request('GET', '/api/v1/ui-actions?item=repo_a:1&limit=5', undefined, as('alice'));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ enabled: true, limit: 5, identities: [{ id: 'maintainer' }] });
    expect(res.json.actions.every((a: { itemKey: string }) => a.itemKey === 'repo_a:1')).toBe(true);
    expect((await env.request('GET', '/api/v1/ui-actions', undefined, as('olga'))).status).toBe(403);
  });
});

describe('without authentication', () => {
  it('UI actions are disabled with auth.mode none', async () => {
    const plain = await startAppEnv({}, setup);
    try {
      plain.github.createIssue(REPO_A, { number: 1 });
      const res = await plain.request('POST', '/api/v1/items/repo_a/1/comment', { identity: 'maintainer', body: 'x' });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('ui_actions_disabled');
      expect((await plain.request('GET', '/api/v1/items/repo_a/1')).json.error.code).toBe('ui_actions_disabled');
      expect(plain.github.comments(REPO_A, 1)).toEqual([]);
      expect((await plain.request('GET', '/api/v1/ui-actions')).json.enabled).toBe(false);
    } finally {
      await plain.cleanup();
    }
  });
});
