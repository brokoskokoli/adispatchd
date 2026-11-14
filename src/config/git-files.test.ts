/** WI-40: source `type: git_files`, `source.update.fields`, declared fields in filters and views. */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ConfigIssue, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

const SOURCES = [
  'sources:',
  '  repo_a: { type: github, owner: example, repository: a, identity: maintainer }',
  '  issues:',
  '    type: git_files',
  '    repository: https://github.com/acme/app-meta.git',
  '    identity: maintainer',
  '    fields: { priority: number, area: string, tags: "string[]" }',
  '  notes:',
  '    type: git_files',
  '    repository: ../meta-repo',
  '    branch: trunk',
  '    path: ./docs/items/',
  '    commit_author: { name: notes-bot, email: notes-bot@example.invalid }',
  '    closed_when: { status: [shipped], labels: wontfix }',
  '    comments_heading: "## Verlauf"',
  '    fields: { priority: number }',
  '    web_url: https://git.example.invalid/acme/meta/src/{ref}/{path}',
  '',
].join('\n');

function workflow(id: string, source: string, rest = ''): string {
  return `id: ${id}\ntrigger: { type: source, source: ${source} }\nexecute:\n  type: shell\n  command: /bin/true\n${rest}`;
}

describe('config: git_files sources (WI-40)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(files: Record<string, string>): Promise<{ config: LoadedConfig | null; errors: string[]; warnings: string[] }> {
    t = await createTempConfigDir({ ...BASE_FILES, 'sources.yaml': SOURCES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok
      ? { config: res.config, errors: [], warnings: res.warnings.map(text) }
      : { config: null, errors: res.errors.map(text), warnings: res.warnings.map(text) };
  }

  it('normalizes git_files sources with defaults', async () => {
    const { config, errors } = await load({});
    expect(errors).toEqual([]);
    expect(config?.sources.issues).toEqual({
      id: 'issues',
      type: 'git_files',
      repository: 'https://github.com/acme/app-meta.git',
      branch: 'main',
      path: 'issues',
      identity: 'maintainer',
      project: null,
      commitAuthor: { name: 'adispatchd', email: 'adispatchd@users.noreply.invalid' },
      closedWhen: { status: ['done', 'closed'] },
      commentsHeading: '## Log',
      fields: { priority: 'number', area: 'string', tags: 'string[]' },
      webUrl: 'https://github.com/acme/app-meta/blob/{ref}/{path}',
      location: 'acme/app-meta',
      vars: {},
    });
    expect(config?.sources.notes).toMatchObject({
      repository: path.resolve(t?.dir ?? '', '../meta-repo'),
      branch: 'trunk',
      path: 'docs/items',
      identity: null,
      commitAuthor: { name: 'notes-bot', email: 'notes-bot@example.invalid' },
      closedWhen: { status: ['shipped'], labels: ['wontfix'] },
      commentsHeading: '## Verlauf',
      webUrl: 'https://git.example.invalid/acme/meta/src/{ref}/{path}',
    });
  });

  it('rejects unsafe or invalid settings', async () => {
    const { errors } = await load({
      'sources.yaml': [
        'sources:',
        '  bad:',
        '    type: git_files',
        '    repository: https://user:secret@github.com/acme/x.git',
        '    branch: "a..b"',
        '    path: ../outside',
        '    comments_heading: Log',
        '    closed_when: { state: [closed] }',
        '    fields: { title: string, "bad name": string }',
        '    web_url: https://git.example.invalid/no-path',
        '    identity: nobody',
        '',
      ].join('\n'),
    });
    const all = errors.join('\n');
    expect(all).toContain('sources.bad.repository: "repository" must not contain credentials');
    expect(all).toContain('sources.bad.branch: "a..b" is not a valid git branch name');
    expect(all).toContain('sources.bad.path: "path" must be a folder relative to the repository root');
    expect(all).toContain('sources.bad.comments_heading: "comments_heading" must be one Markdown heading line');
    expect(all).toContain('sources.bad.closed_when.state: "state" cannot decide the state');
    expect(all).toContain('sources.bad.fields.title: "title" is a built-in field of git_files sources and cannot be declared');
    expect(all).toContain('sources.bad.fields.bad name: Invalid field name');
    expect(all).toContain('sources.bad.web_url: "web_url" must contain "{path}"');
    expect(all).toContain('sources.bad.identity: Unknown identity "nobody"');
  });

  it('accepts declared and built-in fields in filters, priorities and views; rejects unknown ones', async () => {
    const good = await load({
      'workflows/w.yaml': workflow(
        'w',
        'issues',
        [
          'filter:',
          '  all:',
          '    - { field: state, operator: equals, value: open }',
          '    - { field: status, operator: in, value: [todo, ready] }',
          '    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }',
          '    - { field: priority, operator: greater_than, value: 1 }',
          '    - { field: labels, operator: contains, value: agent }',
          'item_priority:',
          '  rules:',
          '    - { when: { field: tags, operator: contains, value: urgent }, value: 10 }',
          '',
        ].join('\n'),
      ),
      'views/v.yaml': 'id: v\nsources: [issues, notes]\nfields: [{ field: number }, { field: title }, { field: status }, { field: priority }, { field: work_branch }, { field: comments }]\nsort: [{ field: priority, direction: desc }]\n',
    });
    expect(good.errors).toEqual([]);

    const bad = await load({
      'workflows/w.yaml': workflow(
        'w',
        'issues',
        ['filter:', '  all:', '    - { field: priorty, operator: equals, value: 1 }', '    - { field: priority, operator: equals, value: high }', '    - { field: comments, operator: contains, value: x }', ''].join('\n'),
      ),
      'views/v.yaml': 'id: v\nsources: [issues, notes]\nfields: [{ field: area }]\n',
    });
    const all = bad.errors.join('\n');
    expect(all).toContain('Unknown field "priorty" for source type git_files (did you mean "priority"?)');
    expect(all).toContain('Value for field "priority" (type number) must be a number');
    expect(all).toContain('Field "comments" (type object[]) cannot be used in filters');
    expect(all).toContain('Unknown field "area" for source type git_files');
  });

  it('checks source.update.fields per source type', async () => {
    const good = await load({
      'workflows/w.yaml': workflow(
        'w',
        'issues',
        [
          'on_start:',
          '  - { type: source.update, fields: { status: coding, priority: 2, tags: [a, b], branch: null } }',
          '  - { type: source.update, labels: { add: [coding] } }',
          '  - { type: source.comment, message: "Started {run.id} on #{item.number} ({item.title}) {item.work_branch}" }',
          '',
        ].join('\n'),
      ),
    });
    expect(good.errors).toEqual([]);
    expect(good.config?.workflows.w?.hooks.on_start?.[0]).toMatchObject({ type: 'source.update', fields: { status: 'coding', priority: 2, tags: ['a', 'b'], branch: null } });

    const bad = await load({
      'workflows/g.yaml': workflow('g', 'repo_a', ['on_start:', '  - { type: source.update, fields: { status: x } }', ''].join('\n')),
      'workflows/w.yaml': workflow(
        'w',
        'issues',
        [
          'on_start:',
          '  - { type: source.update, project: { Status: x } }',
          '  - { type: source.update, fields: { state: closed, labels: [x], unknown: 1, priority: high } }',
          '  - { type: source.update, fields: {} }',
          '',
        ].join('\n'),
      ),
    });
    const all = bad.errors.join('\n');
    expect(all).toContain('workflows/g.yaml: on_start[0].fields: "fields" is only available for git_files sources ("repo_a": github)');
    expect(all).toContain('workflows/w.yaml: on_start[0].project: "project" is only available for github sources');
    expect(all).toContain('on_start[1].fields.state: Field "state" cannot be set: it is derived and cannot be set');
    expect(all).toContain('on_start[1].fields.labels: Field "labels" cannot be set: use "labels: { add, remove }"');
    expect(all).toContain('on_start[1].fields.unknown: Field "unknown" cannot be set: it is not a writable frontmatter field');
    expect(all).toContain('on_start[1].fields.priority: Invalid value for field "priority" (number): expected a number');
    expect(all).toContain('on_start[2].fields: "fields" must set at least one field');
  });
});
