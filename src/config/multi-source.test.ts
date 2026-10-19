/**
 * WI-20: workflows over several sources (`trigger.sources`), per-source limit
 * and source variables (`sources.<id>.vars`, `{source.vars.<name>}`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, snapshotWorkflow, triggerSourceIds, type ConfigIssue, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

const SOURCES = [
  'sources:',
  '  repo_a:',
  '    type: github',
  '    owner: example',
  '    repository: a',
  '    identity: maintainer',
  '    vars: { base_branch: main, deploy-env: staging, port: 8080 }',
  '    project:',
  '      number: 3',
  '      fields: { Status: single_select, Estimate: number, Sprint: iteration }',
  '  repo_b:',
  '    type: github',
  '    owner: example',
  '    repository: b',
  '    identity: maintainer',
  '    vars: { base_branch: develop }',
  '    project:',
  '      number: 4',
  '      fields: { Status: single_select, Estimate: text }',
  '  repo_c: { type: github, owner: example, repository: c, identity: maintainer }',
  '',
].join('\n');

function workflow(trigger: string, rest = ''): string {
  return `id: w\ntrigger: ${trigger}\nexecute:\n  type: shell\n  command: /bin/true\n${rest}`;
}

describe('config: multi-source workflows and source variables (WI-20)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(files: Record<string, string>): Promise<{ config: LoadedConfig | null; errors: string[]; warnings: string[] }> {
    t = await createTempConfigDir({ ...BASE_FILES, 'sources.yaml': SOURCES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok
      ? { config: res.config, errors: [], warnings: res.warnings.map(text) }
      : { config: null, errors: res.errors.map(text), warnings: res.warnings.map(text) };
  }

  it('normalizes "sources" (first entry also in "source"); single-source triggers stay unchanged', async () => {
    const { config, errors } = await load({
      'workflows/w.yaml': workflow('{ type: source, sources: [repo_b, repo_a] }', 'max_concurrent: 3\nmax_concurrent_per_source: 1\n'),
      'workflows/single.yaml': workflow('{ type: source, source: repo_a }').replace('id: w', 'id: single'),
    });
    expect(errors).toEqual([]);
    const w = config?.workflows.w;
    expect(w?.trigger).toEqual({ type: 'source', source: 'repo_b', sources: ['repo_b', 'repo_a'] });
    expect(w?.maxConcurrentPerSource).toBe(1);
    const single = config?.workflows.single;
    expect(single?.trigger).toEqual({ type: 'source', source: 'repo_a' });
    expect(single).not.toHaveProperty('maxConcurrentPerSource');
    if (single?.trigger.type === 'source') expect(triggerSourceIds(single.trigger)).toEqual(['repo_a']);
    if (w?.trigger.type === 'source') expect(triggerSourceIds(w.trigger)).toEqual(['repo_b', 'repo_a']);
    // Variables: scalars are stringified; sources without "vars" have none.
    expect(config?.sources.repo_a?.vars).toEqual({ base_branch: 'main', 'deploy-env': 'staging', port: '8080' });
    expect(config?.sources.repo_c?.vars).toEqual({});
  });

  it('snapshots carry the source of the run item', async () => {
    const { config } = await load({ 'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_b] }') });
    const loaded = config as LoadedConfig;
    expect(snapshotWorkflow(loaded, 'w').source?.id).toBe('repo_a');
    expect(snapshotWorkflow(loaded, 'w', 'repo_b').source).toMatchObject({ id: 'repo_b', vars: { base_branch: 'develop' } });
    expect(() => snapshotWorkflow(loaded, 'w', 'repo_c')).toThrow(/not a source of workflow "w"/);
  });

  it('rejects "source" together with "sources", an empty list, duplicates and unknown sources', async () => {
    let r = await load({ 'workflows/w.yaml': workflow('{ type: source, source: repo_a, sources: [repo_b] }') });
    expect(r.errors).toEqual([
      expect.stringContaining('workflows/w.yaml: trigger.sources: "source" and "sources" are mutually exclusive'),
    ]);
    r = await load({ 'workflows/w.yaml': workflow('{ type: source }') });
    expect(r.errors).toEqual([expect.stringContaining('workflows/w.yaml: trigger: A source trigger needs "source: <id>" or "sources: [<id>, ...]"')]);
    r = await load({ 'workflows/w.yaml': workflow('{ type: source, sources: [] }') });
    expect(r.errors).toEqual(['workflows/w.yaml: trigger.sources: "sources" must not be empty']);
    r = await load({ 'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_b, repo_a] }') });
    expect(r.errors).toEqual(['workflows/w.yaml: trigger.sources[2]: Source "repo_a" is listed more than once']);
    r = await load({ 'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_x] }') });
    expect(r.errors).toEqual(['workflows/w.yaml: trigger.sources[1]: Unknown source "repo_x"']);
    // Single source: path and message as before.
    r = await load({ 'workflows/w.yaml': workflow('{ type: source, source: repo_x }') });
    expect(r.errors).toEqual(['workflows/w.yaml: trigger.source: Unknown source "repo_x"']);
  });

  it('allows max_concurrent_per_source only for source triggers', async () => {
    const r = await load({ 'workflows/w.yaml': workflow('{ type: manual }', 'max_concurrent_per_source: 2\n') });
    expect(r.errors).toEqual([
      'workflows/w.yaml: max_concurrent_per_source: "max_concurrent_per_source" is only allowed for workflows with a source trigger (trigger is "manual")',
    ]);
    const zero = await load({ 'workflows/w.yaml': workflow('{ type: source, source: repo_a }', 'max_concurrent_per_source: 0\n') });
    expect(zero.errors).toEqual([expect.stringContaining('workflows/w.yaml: max_concurrent_per_source: Must be greater than 0')]);
  });

  it('checks {source.vars.<name>} against every source of the workflow and names the missing ones', async () => {
    const rest = [
      '  args: ["{source.vars.base_branch}", "{source.vars.deploy-env}"]',
      '  env: { PORT: "{source.vars.port}" }',
      '  working_directory: "{workspace.base_dir}/{source.vars.base_branch}/{run.id}"',
      'conditions:',
      '  item:',
      '    - { type: shell, command: /bin/true, args: ["{source.vars.nope}"] }',
      'on_success:',
      '  - { type: source.comment, message: "Merged into {source.vars.base_branch}" }',
      '',
    ].join('\n');
    const r = await load({ 'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_b, repo_c] }', rest) });
    expect(r.errors.sort()).toEqual(
      [
        'workflows/w.yaml: execute.args[0]: Source variable "base_branch" is not defined in "vars" of source "repo_c" (sources.yaml)',
        'workflows/w.yaml: execute.args[1]: Source variable "deploy-env" is not defined in "vars" of sources "repo_b", "repo_c" (sources.yaml)',
        'workflows/w.yaml: execute.env.PORT: Source variable "port" is not defined in "vars" of sources "repo_b", "repo_c" (sources.yaml)',
        'workflows/w.yaml: execute.working_directory: Source variable "base_branch" is not defined in "vars" of source "repo_c" (sources.yaml)',
        'workflows/w.yaml: conditions.item[0].args[0]: Source variable "nope" is not defined in "vars" of sources "repo_a", "repo_b", "repo_c" (sources.yaml)',
        'workflows/w.yaml: on_success[0].message: Source variable "base_branch" is not defined in "vars" of source "repo_c" (sources.yaml)',
      ].sort(),
    );
  });

  it('accepts source variables in single-source workflows and rejects them without a source trigger', async () => {
    const ok = await load({
      'workflows/w.yaml': workflow('{ type: source, source: repo_a }', '  env: { BASE: "{source.vars.base_branch}" }\n'),
    });
    expect(ok.errors).toEqual([]);
    const manual = await load({ 'workflows/w.yaml': workflow('{ type: manual }', '  env: { BASE: "{source.vars.base_branch}" }\n') });
    expect(manual.errors).toEqual(['workflows/w.yaml: execute.env.BASE: Placeholder "{source.vars.base_branch}" is not available in this context']);
  });

  it('validates the names and values of source variables', async () => {
    let r = await load({ 'sources.yaml': SOURCES.replace('vars: { base_branch: develop }', 'vars: { "1bad": x, also.bad: y }') });
    expect(r.errors).toEqual([
      expect.stringContaining('sources.yaml: sources.repo_b.vars.1bad: Invalid variable name'),
      expect.stringContaining('sources.yaml: sources.repo_b.vars.also.bad: Invalid variable name'),
    ]);
    r = await load({ 'sources.yaml': SOURCES.replace('vars: { base_branch: develop }', 'vars: { ok: [1, 2] }') });
    expect(r.errors).toEqual(['sources.yaml: sources.repo_b.vars.ok: Expected a string (numbers and booleans are converted)']);
  });

  it('offers project fields only when all sources declare them with the same kind', async () => {
    const rest = [
      'filter:',
      '  all:',
      '    - { field: project.Status, operator: equals, value: Todo }',
      '    - { field: project.Sprint, operator: equals, value: S1 }',
      'item_priority:',
      '  rules:',
      '    - when: { field: project.Estimate, operator: greater_than, value: 3 }',
      '      value: 10',
      'on_start:',
      '  - type: source.update',
      '    project: { Status: In Progress, Estimate: 2, Sprint: S1, Statsu: x }',
      '',
    ].join('\n');
    const r = await load({ 'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_b] }', rest) });
    expect(r.errors.sort()).toEqual(
      [
        'workflows/w.yaml: filter.all[1].field: Unknown project field "project.Sprint": workflows with several sources only offer project fields declared by all their sources (missing in "repo_b")',
        'workflows/w.yaml: item_priority.rules[0].when.field: Unknown project field "project.Estimate": its kind differs between the sources of the workflow ("repo_a": number, "repo_b": text); declare it with the same kind everywhere',
        'workflows/w.yaml: on_start[0].project.Estimate: Project field "Estimate" has different kinds in the sources of the workflow ("repo_a": number, "repo_b": text); declare it with the same kind everywhere',
        'workflows/w.yaml: on_start[0].project.Sprint: Unknown project field "Sprint": it is not declared in "project.fields" of all sources of the workflow (missing in "repo_b")',
        'workflows/w.yaml: on_start[0].project.Statsu: Unknown project field "Statsu": it is not declared in "project.fields" of any source of the workflow ("repo_a", "repo_b") (did you mean "Status"?)',
      ].sort(),
    );
    const without = await load({
      'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_c] }', 'on_start:\n  - { type: source.update, project: { Status: Todo } }\n'),
    });
    expect(without.errors).toEqual([
      'workflows/w.yaml: on_start[0].project: Source "repo_c" has no "project" in sources.yaml; project fields cannot be set',
    ]);
  });

  it('checks named filters (WI-15) at the place of use against all sources of the workflow', async () => {
    const named = [
      'id: ready',
      'filter:',
      '  all:',
      '    - { field: labels, operator: contains, value: ready }',
      '    - { field: project.Status, operator: equals, value: Todo }',
      '',
    ].join('\n');
    const ok = await load({
      'filters/ready.yaml': named,
      'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_b] }', 'filter: ready\n'),
    });
    expect(ok.errors).toEqual([]);
    expect(ok.config?.workflows.w?.filter).toEqual({
      all: [
        { field: 'labels', operator: 'contains', value: 'ready' },
        { field: 'project.Status', operator: 'equals', value: 'Todo' },
      ],
    });
    // repo_c has no project: the same named filter is invalid for a workflow that includes it.
    const bad = await load({
      'filters/ready.yaml': named,
      'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_c] }', 'filter:\n  all:\n    - { use: ready }\n'),
    });
    expect(bad.errors).toEqual([
      'workflows/w.yaml: filter.all[0] (use "ready" → filters/ready.yaml: filter.all[1].field): Unknown project field "project.Status": ' +
        'workflows with several sources only offer project fields declared by all their sources (missing in "repo_c")',
    ]);
  });

  it('keeps the "state" rule per source and accepts a common project field', async () => {
    const rest = [
      'filter:',
      '  all:',
      '    - { field: state, operator: in, value: [open, closed] }',
      '    - { field: project.Status, operator: equals, value: Todo }',
      'on_success:',
      '  - { type: source.update, project: { Status: Done } }',
      '',
    ].join('\n');
    const r = await load({ 'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_b] }', rest) });
    expect(r.errors).toEqual([]);
    const bad = await load({
      'workflows/w.yaml': workflow('{ type: source, sources: [repo_a, repo_b] }', 'filter:\n  any:\n    - { field: state, operator: equals, value: closed }\n'),
    });
    expect(bad.errors).toEqual([expect.stringContaining('workflows/w.yaml: filter.any[0].field: "state" only works at the top level of the filter')]);
  });
});
