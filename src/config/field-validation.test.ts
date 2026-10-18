/**
 * WI-13 regression tests: zero intervals, `state` outside the top level,
 * field names / operators / value types against the adapter catalogue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ConfigIssue } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

function workflow(body: string): string {
  return `id: w\ntrigger: { type: source, source: repo_a }\nexecute: { type: shell, command: /bin/true }\n${body}`;
}

function view(body: string): string {
  return `id: v\nsources: [repo_a, repo_b]\n${body}`;
}

describe('config validation (WI-13)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function errors(files: Record<string, string>): Promise<string[]> {
    t = await createTempConfigDir({ ...BASE_FILES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok ? [] : res.errors.map(text);
  }

  it('rejects zero/too short loop intervals and zero timeouts, but allows a zero retry delay', async () => {
    const found = await errors({
      'config.yaml': 'scheduler: { polling_interval: 0s }\nretention: { cleanup_interval: 500ms }\nlifecycle: { action_retry: { delay: 0s } }\n',
      'workflows/w.yaml': workflow(
        [
          'shell_filter: { command: /bin/true, timeout: 0s }',
          'conditions:',
          '  workflow: [ { type: shell, command: /bin/true, timeout: 0ms } ]',
          '  item: [ { type: shell, command: /bin/true, timeout: 0s } ]',
          'on_success: [ { type: shell, command: /bin/true, timeout: 0s, retry: { delay: 0s } } ]',
        ].join('\n'),
      ),
    });
    expect(found.sort()).toEqual(
      [
        'config.yaml: scheduler.polling_interval: Duration must be at least 1s',
        'config.yaml: retention.cleanup_interval: Duration must be at least 1s',
        'workflows/w.yaml: shell_filter.timeout: Duration must be greater than 0',
        'workflows/w.yaml: conditions.workflow[0].timeout: Duration must be greater than 0',
        'workflows/w.yaml: conditions.item[0].timeout: Duration must be greater than 0',
        'workflows/w.yaml: on_success[0].timeout: Duration must be greater than 0',
      ].sort(),
    );
  });

  it('rejects "state" where it cannot select the listed items, accepts top-level selectors', async () => {
    const found = await errors({
      'workflows/w.yaml': workflow(
        [
          'filter:',
          '  all:',
          '    - any: [ { field: state, operator: equals, value: closed }, { field: labels, operator: contains, value: x } ]',
          '    - not: { field: state, operator: equals, value: open }',
          '    - { field: state, operator: not_equals, value: open }',
          '    - { field: state, operator: in, value: [open, merged] }',
        ].join('\n'),
      ),
      'views/v.yaml': view(
        'filter: { any: [ { field: state, operator: equals, value: closed } ] }\nfields: [ { field: title } ]\n',
      ),
    });
    expect(found.map((e) => e.split(': ').slice(0, 2).join(': '))).toEqual([
      'views/v.yaml: filter.any[0].field',
      'workflows/w.yaml: filter.all[0].any[0].field',
      'workflows/w.yaml: filter.all[1].not.field',
      'workflows/w.yaml: filter.all[2].operator',
      'workflows/w.yaml: filter.all[3].value',
    ]);
    expect(found[0]).toContain('"state" only works at the top level of the filter');
    expect(found[3]).toContain('"state" must use "equals" or "in"');
    expect(found[4]).toContain('"state" values must be "open" or "closed", got string "merged"');

    const ok = await errors({
      'workflows/w.yaml': workflow(
        [
          'filter:',
          '  all:',
          '    - { field: state, operator: in, value: [open, closed] }',
          '    - all: [ { field: labels, operator: contains, value: "priority:high" } ]',
          'item_priority:',
          '  rules: [ { when: { not: { field: state, operator: equals, value: open } }, value: 5 } ]',
        ].join('\n'),
      ),
      'views/v.yaml': view('filter: { field: state, operator: equals, value: closed }\nfields: [ { field: title } ]\n'),
    });
    expect(ok).toEqual([]);
  });

  it('rejects a label that is added and removed in different case', async () => {
    const found = await errors({
      'workflows/w.yaml': workflow('on_start:\n  - type: source.update\n    labels: { add: [Coding], remove: [coding] }\n'),
    });
    expect(found).toEqual(['workflows/w.yaml: on_start[0].labels: Label "Coding" is both added and removed']);
  });

  it('checks field names (with suggestion), operators, value types and view-only run fields', async () => {
    const found = await errors({
      'workflows/w.yaml': workflow(
        [
          'filter:',
          '  all:',
          '    - { field: labls, operator: contains, value: ready }',
          '    - { field: labels, operator: greater_than, value: 3 }',
          "    - { field: is_pull_request, operator: equals, value: 'true' }",
          '    - { field: created_at, operator: greater_than, value: yesterday }',
          '    - { field: run.last_status, operator: equals, value: completed }',
          'item_priority:',
          '  rules: [ { when: { field: dependencies.blocked_by_opne, operator: equals, value: 0 }, value: 1 } ]',
        ].join('\n'),
      ),
      'views/v.yaml': view(
        'filter: { field: run.last_started_at, operator: greater_than, value: 2026-01-01 }\n' +
          'fields: [ { field: titel }, { field: number, link: urll }, { field: run.last_workflow } ]\nsort: { field: updated }\n',
      ),
    });
    expect(found).toEqual([
      'views/v.yaml: fields[0].field: Unknown field "titel" for source type github (did you mean "title"?)',
      'views/v.yaml: fields[1].link: Unknown field "urll" for source type github (did you mean "url"?)',
      'views/v.yaml: sort.field: Unknown field "updated" for source type github',
      'workflows/w.yaml: filter.all[0].field: Unknown field "labls" for source type github (did you mean "labels"?)',
      'workflows/w.yaml: filter.all[1].operator: Operator "greater_than" is not supported for field "labels" (type string[]); allowed: contains, in',
      'workflows/w.yaml: filter.all[2].value: Value for field "is_pull_request" (type boolean) must be a boolean, got string "true"',
      'workflows/w.yaml: filter.all[3].value: Value "yesterday" for date field "created_at" is not an ISO-8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM])',
      'workflows/w.yaml: filter.all[4].field: Field "run.last_status" is only available in views, not in workflows',
      'workflows/w.yaml: item_priority.rules[0].when.field: Unknown field "dependencies.blocked_by_opne" for source type github (did you mean "dependencies.blocked_by_open"?)',
    ]);
  });
});
