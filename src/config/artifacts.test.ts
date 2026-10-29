/** WI-35: source `type: artifacts`, `execute.artifacts`, `retention.artifacts`, artifact placeholders. */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, snapshotWorkflow, type ConfigIssue, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

const SOURCES = ['sources:', '  repo_a: { type: github, owner: example, repository: a, identity: maintainer }', '  artifacts: { type: artifacts, vars: { team: docs } }', ''].join('\n');

function workflow(id: string, trigger: string, rest = ''): string {
  return `id: ${id}\ntrigger: ${trigger}\nexecute:\n  type: shell\n  command: /bin/true\n${rest}`;
}

describe('config: artifacts (WI-35)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(files: Record<string, string>): Promise<{ config: LoadedConfig | null; errors: string[]; warnings: string[] }> {
    t = await createTempConfigDir({ ...BASE_FILES, 'sources.yaml': SOURCES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok
      ? { config: res.config, errors: [], warnings: res.warnings.map(text) }
      : { config: null, errors: res.errors.map(text), warnings: res.warnings.map(text) };
  }

  it('normalizes the artifacts source (no identity, no project) and execute.artifacts with defaults', async () => {
    const { config, errors } = await load({
      'workflows/make.yaml': workflow(
        'make',
        '{ type: manual }',
        [
          '  artifacts:',
          '    - { name: "Report {run.id}", type: report, path: ./out/report.pdf }',
          '    - { name: logs, type: logs, path: out/logs, required: true }',
          '  artifacts_max_size: 5MB',
          '',
        ].join('\n'),
      ),
      'workflows/plain.yaml': workflow('plain', '{ type: manual }'),
    });
    expect(errors).toEqual([]);
    expect(config?.sources.artifacts).toEqual({ id: 'artifacts', type: 'artifacts', identity: null, project: null, vars: { team: 'docs' } });
    expect(config?.workflows.make?.execute).toMatchObject({
      artifacts: [
        { name: 'Report {run.id}', type: 'report', path: 'out/report.pdf', required: false },
        { name: 'logs', type: 'logs', path: 'out/logs', required: true },
      ],
      artifactsMaxSizeBytes: 5 * 1024 * 1024,
    });
    expect(config?.workflows.plain?.execute).toMatchObject({ artifacts: [], artifactsMaxSizeBytes: 100 * 1024 * 1024 });
    expect(config?.global.retention.artifactsMs).toBeNull();
  });

  it('parses retention.artifacts (duration or never)', async () => {
    const days = await load({ 'config.yaml': 'retention:\n  artifacts: 14d\n' });
    expect(days.config?.global.retention.artifactsMs).toBe(14 * 86_400_000);
    const never = await load({ 'config.yaml': 'retention:\n  artifacts: never\n' });
    expect(never.config?.global.retention.artifactsMs).toBeNull();
    const bad = await load({ 'config.yaml': 'retention:\n  artifacts: soon\n' });
    expect(bad.errors.join('\n')).toMatch(/retention\.artifacts/);
  });

  it('allows at most one artifacts source', async () => {
    const { errors } = await load({ 'sources.yaml': `${SOURCES}  more: { type: artifacts }\n` });
    expect(errors.join('\n')).toMatch(/sources\.more: Only one source of type "artifacts" is allowed \(already defined: "artifacts"\)/);
  });

  it('rejects unsafe or wildcard artifact paths, bad types and unknown keys', async () => {
    const entries = [
      '    - { name: a, type: t, path: /etc/passwd }',
      '    - { name: b, type: t, path: ../secret }',
      '    - { name: c, type: t, path: out/*.pdf }',
      '    - { name: d, type: t, path: out/ }',
      '    - { name: e, type: t, path: out\\\\x }',
      '    - { name: "{item.path}", type: t, path: ok }',
    ].join('\n');
    const { errors } = await load({ 'workflows/w.yaml': workflow('w', '{ type: manual }', `  artifacts:\n${entries}\n`) });
    const joined = errors.join('\n');
    expect(joined).toMatch(/execute\.artifacts\[0\]\.path: Path must be relative to the workspace/);
    expect(joined).toMatch(/execute\.artifacts\[1\]\.path: Path must not contain "\.\."/);
    expect(joined).toMatch(/execute\.artifacts\[2\]\.path: Path must be a literal file or folder/);
    expect(joined).toMatch(/execute\.artifacts\[3\]\.path: .*empty or "\." segments/);
    expect(joined).toMatch(/execute\.artifacts\[4\]\.path: .*"\\"/);
    expect(joined).toMatch(/execute\.artifacts\[5\]\.name: Placeholder "\{item\.path\}" is only available/);

    const structural = await load({
      'workflows/w.yaml': workflow('w', '{ type: manual }', '  artifacts:\n    - { name: f, type: t, path: ok, extra: 1 }\n    - { name: g, type: "", path: ok }\n    - { type: t, path: ok }\n'),
    });
    expect(structural.errors.join('\n')).toMatch(/execute\.artifacts\[0\]: Unknown key\(s\): "extra"/);
    expect(structural.errors.join('\n')).toMatch(/execute\.artifacts\[1\]\.type: Must not be empty/);
    expect(structural.errors.join('\n')).toMatch(/execute\.artifacts\[2\]\.name/);
  });

  it('knows the artifact fields in filters and offers a hint for typos', async () => {
    const ok = await load({
      'workflows/sum.yaml': workflow(
        'sum',
        '{ type: source, source: artifacts }',
        'filter:\n  all:\n    - { field: type, operator: equals, value: report }\n    - not: { field: consumed_by, operator: contains, value: sum }\n    - { field: size, operator: less_than, value: 1000 }\n    - { field: kind, operator: equals, value: folder }\n',
      ),
    });
    expect(ok.errors).toEqual([]);
    const bad = await load({
      'workflows/sum.yaml': workflow('sum', '{ type: source, source: artifacts }', 'filter: { field: consumed_bt, operator: contains, value: sum }\n'),
    });
    expect(bad.errors.join('\n')).toMatch(/Unknown field "consumed_bt" for source type artifacts \(did you mean "consumed_by"\?\)/);
    const github = await load({
      'workflows/sum.yaml': workflow('sum', '{ type: source, source: repo_a }', 'filter: { field: consumed_by, operator: contains, value: sum }\n'),
    });
    expect(github.errors.join('\n')).toMatch(/Unknown field "consumed_by" for source type github/);
  });

  it('allows item.name/type/path only for artifact workflows and item.path only after the input is staged', async () => {
    const good = await load({
      'workflows/sum.yaml': workflow(
        'sum',
        '{ type: source, source: artifacts }',
        [
          '  args: ["{item.path}", "{item.name}"]',
          '  env: { KIND: "{item.type}" }',
          'on_success:',
          '  - { type: shell, command: /bin/true, args: ["{item.path}"] }',
          '',
        ].join('\n'),
      ),
    });
    expect(good.errors).toEqual([]);

    const bad = await load({
      'workflows/sum.yaml': workflow(
        'sum',
        '{ type: source, source: artifacts }',
        ['  working_directory: "{workspace.base_dir}/{item.path}"', 'on_start:', '  - { type: shell, command: /bin/true, args: ["{item.path}", "{item.name}"] }', ''].join('\n'),
      ),
      'workflows/gh.yaml': workflow('gh', '{ type: source, source: repo_a }', '  args: ["{item.name}"]\n'),
    });
    const joined = bad.errors.join('\n');
    expect(joined).toMatch(/sum\.yaml: execute\.working_directory: Placeholder "\{item\.path\}" is only available once the artifact input/);
    expect(joined).toMatch(/sum\.yaml: on_start\[0\]\.args\[0\]: Placeholder "\{item\.path\}" is only available once/);
    expect(joined).not.toMatch(/on_start\[0\]\.args\[1\]/);
    expect(joined).toMatch(/gh\.yaml: execute\.args\[0\]: Placeholder "\{item\.name\}" is only available in workflows triggered by the artifacts source/);
  });

  it('rejects source.update / source.comment on artifact items and sources of mixed types', async () => {
    const { errors } = await load({
      'workflows/a.yaml': workflow(
        'a',
        '{ type: source, source: artifacts }',
        'on_success:\n  - { type: source.comment, message: hi }\n  - { type: source.update, labels: { add: [done] } }\n',
      ),
      'workflows/b.yaml': workflow('b', '{ type: source, sources: [repo_a, artifacts] }'),
    });
    const joined = errors.join('\n');
    expect(joined).toMatch(/a\.yaml: on_success\[0\]\.type: "source\.comment" is not supported for artifact items/);
    expect(joined).toMatch(/a\.yaml: on_success\[1\]\.type: "source\.update" is not supported for artifact items/);
    expect(joined).toMatch(/b\.yaml: trigger\.sources: All sources of a workflow must have the same adapter type/);
  });

  it('warns when an artifact workflow has no filter on consumed_by / attempted_by', async () => {
    const none = await load({ 'workflows/a.yaml': workflow('a', '{ type: source, source: artifacts }') });
    expect(none.errors).toEqual([]);
    expect(none.warnings.join('\n')).toMatch(/a\.yaml: filter: The workflow processes artifacts but its filter does not look at "consumed_by" or "attempted_by"/);
    const other = await load({ 'workflows/a.yaml': workflow('a', '{ type: source, source: artifacts }', 'filter: { field: type, operator: equals, value: report }\n') });
    expect(other.warnings.join('\n')).toMatch(/does not look at/);
    for (const field of ['consumed_by', 'attempted_by']) {
      const ok = await load({ 'workflows/a.yaml': workflow('a', '{ type: source, source: artifacts }', `filter:\n  not: { field: ${field}, operator: contains, value: a }\n`) });
      expect(ok.warnings, field).toEqual([]);
    }
    // GitHub workflows are not affected.
    const gh = await load({ 'workflows/g.yaml': workflow('g', '{ type: source, source: repo_a }') });
    expect(gh.warnings.join('\n')).not.toMatch(/consumed_by/);
  });

  it('snapshots carry the artifacts source and no identity', async () => {
    const { config } = await load({ 'workflows/sum.yaml': workflow('sum', '{ type: source, source: artifacts }') });
    const snapshot = snapshotWorkflow(config as LoadedConfig, 'sum');
    expect(snapshot.source).toMatchObject({ id: 'artifacts', type: 'artifacts', identity: null });
    expect(snapshot.identityRefs).toEqual([]);
  });
});
