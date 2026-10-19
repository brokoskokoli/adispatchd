/**
 * WI-21: linked branches / PRs – field catalogue, `object[]` validation and
 * the placeholders `{item.work_branch}` / `{item.work_pr}`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ConfigIssue } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

describe('config: linked branches and PRs (WI-21)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function errors(files: Record<string, string>): Promise<string[]> {
    t = await createTempConfigDir({ ...BASE_FILES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok ? [] : res.errors.map(text);
  }

  const sourceWorkflow = (body: string): string =>
    `id: w\ntrigger: { type: source, source: repo_a }\nexecute:\n  type: shell\n  command: /bin/true\n${body}`;

  it('accepts work_pr / work_branch / linked_branches in filters and item_priority', async () => {
    expect(
      await errors({
        'workflows/w.yaml': sourceWorkflow(
          [
            'filter:',
            '  all:',
            '    - { field: work_pr, operator: not_equals, value: null }',
            '    - { field: work_branch, operator: contains, value: feature/ }',
            '    - { field: linked_branches, operator: contains, value: main }',
            'item_priority:',
            '  rules:',
            '    - { when: { field: work_pr, operator: equals, value: null }, value: 1 }',
            '',
          ].join('\n'),
        ),
      }),
    ).toEqual([]);
  });

  it('rejects closing_prs (object[]) in filters with a hint to work_pr – also nested and in item_priority', async () => {
    const found = await errors({
      'workflows/w.yaml': sourceWorkflow(
        [
          'filter:',
          '  any:',
          '    - { field: closing_prs, operator: contains, value: 3 }',
          'item_priority:',
          '  rules:',
          '    - { when: { field: closing_prs, operator: equals, value: null }, value: 1 }',
          '',
        ].join('\n'),
      ),
    });
    expect(found).toEqual([
      expect.stringMatching(
        /w\.yaml: filter\.any\[0\]\.field: Field "closing_prs" \(type object\[\]\) cannot be used in filters; use "work_pr" .*not_equals, value: null.* or "work_branch" instead/,
      ),
      expect.stringMatching(/item_priority\.rules\[0\]\.when\.field: Field "closing_prs" \(type object\[\]\) cannot be used in filters/),
    ]);
  });

  it('views: closing_prs and work_pr as columns are fine; sorting by closing_prs is not', async () => {
    const view = (sort: string): string =>
      [
        'id: v',
        'title: Work',
        'sources: [repo_a, repo_b]',
        'fields:',
        '  - { field: work_pr, label: PR }',
        '  - { field: closing_prs, label: Closing PRs }',
        '  - { field: work_branch, label: Branch }',
        `sort: { field: ${sort} }`,
        '',
      ].join('\n');
    expect(await errors({ 'views/v.yaml': view('work_pr') })).toEqual([]);
    expect(await errors({ 'views/v.yaml': view('closing_prs') })).toEqual([
      expect.stringMatching(/v\.yaml: sort\.field: Views cannot be sorted by "closing_prs" \(type object\[\]\)/),
    ]);
  });

  it('allows {item.work_branch} / {item.work_pr} in execute and lifecycle actions of source workflows', async () => {
    expect(
      await errors({
        'workflows/w.yaml': [
          'id: w',
          'trigger: { type: source, source: repo_a }',
          'execute:',
          '  type: shell',
          '  command: /bin/true',
          "  working_directory: '{workspace.base_dir}/{item.work_branch}'",
          "  args: ['--branch', '{item.work_branch}']",
          "  env: { WORK_PR: '{item.work_pr}' }",
          'on_start:',
          "  - { type: source.comment, message: 'Working on {item.work_branch}' }",
          'on_success:',
          "  - { type: shell, command: /bin/true, args: ['{item.work_pr}'] }",
          '',
        ].join('\n'),
      }),
    ).toEqual([]);
  });

  it('rejects the placeholders in item conditions and in workflows without a source', async () => {
    const found = await errors({
      'workflows/w.yaml': sourceWorkflow(
        ['conditions:', '  item:', "    - { type: shell, command: /bin/true, args: ['{item.work_branch}'] }", ''].join('\n'),
      ),
      'workflows/s.yaml': [
        'id: s',
        "trigger: { type: schedule, cron: '0 * * * *' }",
        'execute:',
        '  type: shell',
        '  command: /bin/true',
        "  args: ['{item.work_pr}']",
        '',
      ].join('\n'),
    });
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /w\.yaml: conditions\.item\[0\]\.args\[0\]: Placeholder "\{item\.work_branch\}" is only available in "execute" and lifecycle actions of workflows triggered by a GitHub source/,
        ),
        expect.stringMatching(/s\.yaml: execute\.args\[0\]: Placeholder "\{item\.work_pr\}" is only available in "execute"/),
      ]),
    );
    expect(found).toHaveLength(2);
  });
});
