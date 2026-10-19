/**
 * End-to-end (WI-28): a view over two repositories with an organization
 * project, sorted by a custom value order of `project.Status`, split into
 * sections. Checks the API shape, one issue listing per source, and the
 * warning for `order` values the project does not offer.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, REPO_B, startAppEnv, type AppEnv } from './api/testing/helpers.js';
import type { FakeProject } from './sources/github/testing/index.js';

let env: AppEnv;
let project: FakeProject;

const VIEW = [
  'id: pipeline',
  'title: Pipeline',
  'sources: [repo_a, repo_b]',
  'fields:',
  '  - { field: repository, label: Repository }',
  '  - { field: number, label: Issue }',
  '  - { field: title, label: Title, link: url }',
  '  - { field: project.Status, label: Status }',
  'sort:',
  '  - { field: project.Status, order: [open, coding, review, merging, shipped] }',
  '  - { field: number, direction: asc }',
  'group_by_first: true',
  'sections:',
  '  - title: Needs maintainer',
  '    filter: { field: labels, operator: contains, value: needs-maintainer }',
  '  - title: Review',
  '    filter: { field: project.Status, operator: in, value: [review, merging] }',
  '    sort: { field: number, direction: desc }',
  '  - title: Other',
  '    rest: true',
  '',
].join('\n');

beforeAll(async () => {
  env = await startAppEnv({ views: { pipeline: VIEW } }, (e) => {
    project = e.github.createProject('example', {
      number: 7,
      fields: [{ name: 'Status', dataType: 'SINGLE_SELECT', options: ['open', 'coding', 'review', 'merging'] }],
    });
    writeFileSync(
      path.join(e.configDir, 'sources.yaml'),
      [
        'sources:',
        '  repo_a: { type: github, owner: example, repository: a, identity: maintainer, project: { number: 7, fields: { Status: single_select } } }',
        '  repo_b: { type: github, owner: example, repository: b, identity: maintainer, project: { number: 7, fields: { Status: single_select } } }',
        '',
      ].join('\n'),
    );
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('view sections end-to-end (WI-28)', () => {
  it('lists each source once, places items in sections, sorts by the value order and warns about unknown options', async () => {
    const issue = (repo: string, number: number, status: string | null, labels: string[] = []): void => {
      env.github.createIssue(repo, { number, title: `${repo} ${number}`, labels });
      if (status !== null) env.github.addProjectItem(project, repo, number, { Status: status });
    };
    issue(REPO_A, 1, 'coding');
    issue(REPO_A, 2, 'review');
    issue(REPO_A, 3, 'open', ['needs-maintainer']);
    issue(REPO_B, 4, 'merging');
    issue(REPO_B, 5, 'open');
    issue(REPO_B, 6, null);

    const def = await env.request('GET', '/api/v1/views/pipeline');
    expect(def.status).toBe(200);
    expect(def.json.sort).toEqual([
      { field: 'project.Status', direction: 'asc', order: ['open', 'coding', 'review', 'merging', 'shipped'] },
      { field: 'number', direction: 'asc', order: null },
    ]);
    expect(def.json.sections.map((s: { title: string }) => s.title)).toEqual(['Needs maintainer', 'Review', 'Other']);

    const before = env.github.requests.filter((r) => r.method === 'GET' && /^\/repos\/example\/[ab]\/issues$/.test(r.path)).length;
    const res = await env.request('GET', '/api/v1/views/pipeline/items?refresh=1');
    expect(res.status).toBe(200);
    const listings = env.github.requests.filter((r) => r.method === 'GET' && /^\/repos\/example\/[ab]\/issues$/.test(r.path)).length - before;
    expect(listings).toBe(2); // one per source, shared by all sections

    const body = res.json;
    expect(body.rows).toEqual([]);
    expect(body.errors).toEqual([]);
    expect(body.warnings).toEqual([
      'Sort "order" of "project.Status" lists "shipped", which the project of source "repo_a" does not offer as option(s)',
      'Sort "order" of "project.Status" lists "shipped", which the project of source "repo_b" does not offer as option(s)',
    ]);
    const keys = (s: { rows: Array<{ key: string }> }): string[] => s.rows.map((r) => r.key);
    const [maint, review, other] = body.sections;
    expect(keys(maint)).toEqual(['repo_a:3']);
    expect(keys(review)).toEqual(['repo_b:4', 'repo_a:2']); // own sort: number desc
    expect(review.groupBy).toBeNull();
    expect(keys(other)).toEqual(['repo_b:5', 'repo_a:1', 'repo_b:6']); // open, coding, empty last
    expect(other.groupBy).toEqual({ field: 'project.Status', label: 'Status' });
    expect(other.rows.map((r: { group: string | null }) => r.group)).toEqual(['open', 'coding', null]);
    expect(other.counts).toEqual({ rows: 3, filterUnknown: 0, truncated: false });
    expect(other.fields.map((c: { field: string }) => c.field)).toEqual(['repository', 'number', 'title', 'project.Status']);
  });
});
