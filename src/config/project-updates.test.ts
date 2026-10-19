/**
 * WI-16: `source.update.project` – setting GitHub project fields from hooks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ConfigIssue, type LoadedConfig } from './index.js';
import { workflowSchema } from './schemas.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

const SOURCES = [
  'sources:',
  '  repo_a:',
  '    type: github',
  '    owner: example',
  '    repository: a',
  '    identity: maintainer',
  '    project:',
  '      number: 3',
  '      fields: { Status: single_select, Estimate: number, Due: date, Sprint: iteration, Notes: text }',
  '  repo_b: { type: github, owner: example, repository: b, identity: maintainer }',
  '',
].join('\n');

function workflow(hooks: string, source = 'repo_a'): string {
  return `id: w\ntrigger: { type: source, source: ${source} }\nexecute: { type: shell, command: /bin/true }\n${hooks}`;
}

describe('config: source.update with project fields (WI-16)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(files: Record<string, string>): Promise<{ config: LoadedConfig | null; errors: string[] }> {
    t = await createTempConfigDir({ ...BASE_FILES, 'sources.yaml': SOURCES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok ? { config: res.config, errors: [] } : { config: null, errors: res.errors.map(text) };
  }

  it('accepts all five kinds and null; labels are optional when project fields are set', async () => {
    const { config, errors } = await load({
      'workflows/w.yaml': workflow(
        [
          'on_start:',
          '  - type: source.update',
          '    labels: { add: [in-progress], remove: [ready] }',
          '    project:',
          '      Status: In Progress',
          '      Estimate: 3',
          '      Due: 2026-11-01',
          '      Sprint: Sprint 12',
          '      Notes: null',
          'on_success:',
          '  - type: source.update',
          '    project: { Status: Review }',
          'on_failure:',
          '  - { type: source.update, labels: { add: [failed] } }',
          '',
        ].join('\n'),
      ),
    });
    expect(errors).toEqual([]);
    const hooks = config?.workflows.w?.hooks;
    expect(hooks?.on_start[0]).toMatchObject({
      type: 'source.update',
      labels: { add: ['in-progress'], remove: ['ready'] },
      project: { Status: 'In Progress', Estimate: 3, Due: '2026-11-01', Sprint: 'Sprint 12', Notes: null },
    });
    expect(hooks?.on_success[0]).toMatchObject({ type: 'source.update', labels: { add: [], remove: [] }, project: { Status: 'Review' } });
    // Label-only actions carry no `project` key (their hash is unchanged).
    expect(hooks?.on_failure[0]).not.toHaveProperty('project');
  });

  it('reports undeclared fields with a suggestion, wrong value types per kind and empty blocks', async () => {
    const { errors } = await load({
      'workflows/w.yaml': workflow(
        [
          'on_start:',
          '  - type: source.update',
          '    project:',
          '      Statsu: Done',
          '      project.Sprint: Sprint 12',
          '      Estimate: three',
          '      Due: 2026-13-01',
          '      Notes: ""',
          '      Status: 3',
          '  - type: source.update',
          '    project: { Due: 20261101, Sprint: 12 }',
          '  - { type: source.update, project: {} }',
          '  - { type: source.update }',
          '',
        ].join('\n'),
      ),
    });
    expect(errors).toEqual([
      'workflows/w.yaml: on_start[0].project.Statsu: Unknown project field "Statsu": it is not declared in "project.fields" of source "repo_a" (did you mean "Status"?)',
      'workflows/w.yaml: on_start[0].project.project.Sprint: Unknown project field "project.Sprint": it is not declared in "project.fields" of source "repo_a" (did you mean "Sprint"?)',
      'workflows/w.yaml: on_start[0].project.Estimate: Invalid value for project field "Estimate" (number): expected a number or null',
      'workflows/w.yaml: on_start[0].project.Due: Invalid value for project field "Due" (date): expected a date YYYY-MM-DD or null',
      'workflows/w.yaml: on_start[0].project.Notes: Invalid value for project field "Notes" (text): empty value; use null to clear the field',
      'workflows/w.yaml: on_start[0].project.Status: Invalid value for project field "Status" (single_select): expected a string or null',
      'workflows/w.yaml: on_start[1].project.Due: Invalid value for project field "Due" (date): expected a date YYYY-MM-DD or null',
      'workflows/w.yaml: on_start[1].project.Sprint: Invalid value for project field "Sprint" (iteration): expected a string or null',
      'workflows/w.yaml: on_start[2].project: "project" must set at least one field',
      'workflows/w.yaml: on_start[3].labels: "source.update" must add or remove at least one label or set a project field',
    ]);
  });

  it('rejects other YAML types and a source without project', async () => {
    const types = await load({
      'workflows/w.yaml': workflow('on_start:\n  - type: source.update\n    project: { Status: true, Notes: [a] }\n'),
    });
    expect(types.errors).toEqual([
      'workflows/w.yaml: on_start[0].project.Notes: Expected a string, a number, a date or null',
      'workflows/w.yaml: on_start[0].project.Status: Expected a string, a number, a date or null',
    ]);
    const noProject = await load({
      'workflows/w.yaml': workflow('on_success:\n  - type: source.update\n    project: { Status: Done }\n', 'repo_b'),
    });
    expect(noProject.errors).toEqual([
      'workflows/w.yaml: on_success[0].project: Source "repo_b" has no "project" in sources.yaml; project fields cannot be set',
    ]);
  });

  it('project fields need a source trigger like every source.update', async () => {
    const { errors } = await load({
      'workflows/w.yaml': 'id: w\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/true }\non_success:\n  - { type: source.update, project: { Status: Done } }\n',
    });
    expect(errors).toEqual(['workflows/w.yaml: on_success[0].type: "source.update" needs a source item; the workflow has no source trigger']);
  });

  it('a YAML timestamp parsed as Date becomes YYYY-MM-DD (time of day → rejected for date fields)', () => {
    const parsed = workflowSchema.parse({
      id: 'w',
      trigger: { type: 'source', source: 'repo_a' },
      execute: { type: 'shell', command: '/bin/true' },
      on_start: [{ type: 'source.update', project: { Due: new Date('2026-11-01T00:00:00Z'), Notes: new Date('2026-11-01T10:30:00Z') } }],
    });
    expect(parsed.on_start[0]).toMatchObject({ project: { Due: '2026-11-01', Notes: '2026-11-01T10:30:00.000Z' } });
  });
});
