/**
 * WI-14: `project` in sources.yaml, `github_token` identities and the
 * per-source field catalogue (`project.*`, new cheap issue fields).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ConfigIssue, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

const IDENTITIES = `${BASE_FILES['identities.yaml']}  project_reader:\n    type: github_token\n    token_env: TEST_PROJECT_TOKEN\n`;

function sources(projectA: string | null, projectB: string | null = null): string {
  const block = (p: string | null): string => (p === null ? '' : `    project:\n${p.replace(/^/gm, '      ')}\n`);
  return [
    'sources:',
    '  repo_a:',
    '    type: github',
    '    owner: example',
    '    repository: a',
    '    identity: maintainer',
    block(projectA),
    '  repo_b:',
    '    type: github',
    '    owner: example',
    '    repository: b',
    '    identity: maintainer',
    block(projectB),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const STATUS_PRIORITY = 'number: 3\nfields:\n  Status: single_select\n  Priority: single_select\n  Estimate: number\n  Due: date';

function workflow(body: string): string {
  return `id: w\ntrigger: { type: source, source: repo_a }\nexecute: { type: shell, command: /bin/true }\n${body}`;
}

describe('config: GitHub project fields (WI-14)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(files: Record<string, string>): Promise<{ config: LoadedConfig | null; errors: string[] }> {
    t = await createTempConfigDir({ ...BASE_FILES, 'identities.yaml': IDENTITIES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok ? { config: res.config, errors: [] } : { config: null, errors: res.errors.map(text) };
  }

  it('normalizes project (defaults owner/identity) and github_token identities', async () => {
    const { config, errors } = await load({
      'sources.yaml': sources(STATUS_PRIORITY, 'owner: my-user\nnumber: 7\nidentity: project_reader\nfields: { Sprint: iteration, Notes: text }'),
    });
    expect(errors).toEqual([]);
    expect(config?.sources.repo_a?.project).toEqual({
      owner: 'example',
      number: 3,
      identity: 'maintainer',
      writeIdentity: null,
      fields: { Status: 'single_select', Priority: 'single_select', Estimate: 'number', Due: 'date' },
    });
    expect(config?.sources.repo_b?.project).toEqual({ owner: 'my-user', number: 7, identity: 'project_reader', writeIdentity: 'project_reader', fields: { Sprint: 'iteration', Notes: 'text' } });
    expect(config?.identities.project_reader).toEqual({ id: 'project_reader', type: 'github_token', tokenEnv: 'TEST_PROJECT_TOKEN' });
    expect(config?.identities.maintainer?.type).toBe('github_app');
  });

  it('sources without project have project: null', async () => {
    const { config } = await load({});
    expect(config?.sources.repo_a?.project).toBeNull();
  });

  it('validates project settings and field names', async () => {
    const { errors } = await load({
      'sources.yaml': sources(
        'number: 0\nfields:\n  Status: single_select\n  Prio: select\nextra: 1',
        'number: 2\nfields:\n  " Status": single_select\n  "": text\n  "A\\tB": text',
      ),
    });
    expect(errors.sort()).toEqual(
      [
        'sources.yaml: sources.repo_a.project: Unknown key(s): "extra"',
        'sources.yaml: sources.repo_a.project.number: Must be greater than 0',
        'sources.yaml: sources.repo_a.project.fields.Prio: Expected one of: single_select, text, number, date, iteration',
        'sources.yaml: sources.repo_b.project.fields. Status: Project field name must not start or end with whitespace',
        'sources.yaml: sources.repo_b.project.fields.: Project field name must not be empty',
        'sources.yaml: sources.repo_b.project.fields.A\tB: Project field name must not contain control characters',
      ].sort(),
    );
    const empty = await load({ 'sources.yaml': sources('number: 2\nfields: {}') });
    expect(empty.errors).toEqual(['sources.yaml: sources.repo_a.project.fields: Declare at least one project field']);
  });

  it('rejects an unknown project identity and a github_token without token_env', async () => {
    const { errors } = await load({
      'identities.yaml': `${BASE_FILES['identities.yaml']}  broken:\n    type: github_token\n    token: ghp_literal\n`,
      'sources.yaml': sources('number: 3\nidentity: nobody\nfields: { Status: single_select }'),
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'identities.yaml: identities.broken: Unknown key(s): "token"',
        'identities.yaml: identities.broken.token_env: Invalid input: expected string, received undefined',
      ]),
    );
    const second = await load({ 'sources.yaml': sources('number: 3\nidentity: nobody\nfields: { Status: single_select }') });
    expect(second.errors).toEqual(['sources.yaml: sources.repo_a.project.identity: Unknown identity "nobody"']);
  });

  it('workflow context: project.* known only when the trigger source declares it; typo suggestions; value types', async () => {
    const { errors } = await load({
      'sources.yaml': sources(STATUS_PRIORITY),
      'workflows/w.yaml': workflow(
        [
          'filter:',
          '  all:',
          '    - { field: project.Status, operator: in, value: [Todo, Ready] }',
          '    - { field: project.Statsu, operator: equals, value: Ready }',
          '    - { field: project.Estimate, operator: greater_than, value: "3" }',
          '    - { field: project.Due, operator: less_than, value: "next week" }',
          '    - { field: project.Sprint, operator: equals, value: S1 }',
          '    - { field: milestone, operator: equals, value: v1 }',
          '    - { field: issue_type, operator: in, value: [Bug, Task] }',
          '    - { field: state_reason, operator: not_equals, value: not_planned }',
          'item_priority:',
          '  rules:',
          '    - when: { field: project.Priority, operator: equals, value: P0 }',
          '      value: 100',
          '    - when: { field: project.Priority, operator: greater_than, value: 1 }',
          '      value: 1',
        ].join('\n'),
      ),
    });
    expect(errors).toEqual([
      'workflows/w.yaml: filter.all[1].field: Unknown project field "project.Statsu": it is not declared in "project.fields" of source "repo_a" (did you mean "project.Status"?)',
      'workflows/w.yaml: filter.all[2].value: Value for field "project.Estimate" (type number) must be a number, got string "3"',
      expect.stringMatching(/^workflows\/w\.yaml: filter\.all\[3\]\.value: Value "next week" for date field "project\.Due" is not an ISO-8601 date/),
      'workflows/w.yaml: filter.all[4].field: Unknown project field "project.Sprint": it is not declared in "project.fields" of source "repo_a"',
      'workflows/w.yaml: item_priority.rules[1].when.operator: Operator "greater_than" is not supported for field "project.Priority" (type string); allowed: equals, not_equals, contains, in',
    ]);
  });

  it('project.* without any project on the source is an error with a hint', async () => {
    const { errors } = await load({
      'workflows/w.yaml': workflow('filter: { field: project.Status, operator: equals, value: Ready }'),
    });
    expect(errors).toEqual([
      'workflows/w.yaml: filter.field: Unknown project field "project.Status": source "repo_a" has no "project" configured in sources.yaml',
    ]);
  });

  it('view context: only fields declared by all sources with the same kind', async () => {
    const view = (body: string): string => `id: v\nsources: [repo_a, repo_b]\n${body}`;
    const ok = await load({
      'sources.yaml': sources(STATUS_PRIORITY, 'number: 9\nfields: { Status: single_select, Sprint: iteration }'),
      'views/v.yaml': view(
        [
          'filter: { field: project.Status, operator: in, value: [Todo, Ready] }',
          'fields:',
          '  - { field: title, link: url }',
          '  - { field: project.Status }',
          'sort: { field: project.Status }',
        ].join('\n'),
      ),
    });
    expect(ok.errors).toEqual([]);

    const bad = await load({
      'sources.yaml': sources(STATUS_PRIORITY, 'number: 9\nfields: { Status: text, Sprint: iteration }'),
      'views/v.yaml': view(
        [
          'fields:',
          '  - { field: project.Status }',
          '  - { field: project.Priority }',
          '  - { field: project.Nope }',
          'sort: { field: project.Sprint }',
        ].join('\n'),
      ),
    });
    expect(bad.errors).toEqual([
      'views/v.yaml: fields[0].field: Unknown project field "project.Status": its kind differs between the sources of the view ("repo_a": single_select, "repo_b": text); declare it with the same kind everywhere',
      'views/v.yaml: fields[1].field: Unknown project field "project.Priority": views only offer project fields declared by all their sources (missing in "repo_b")',
      'views/v.yaml: fields[2].field: Unknown project field "project.Nope": no source of the view declares it in "project.fields"',
      'views/v.yaml: sort.field: Unknown project field "project.Sprint": views only offer project fields declared by all their sources (missing in "repo_a")',
    ]);
  });
});
