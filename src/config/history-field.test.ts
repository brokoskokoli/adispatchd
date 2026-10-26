/**
 * WI-33: view field `history` (link to the item history) – allowed in view
 * `fields` and section `fields`, not as a sort key and not in filters (view,
 * section, workflow).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ConfigIssue } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

describe('config: view field history (WI-33)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function errors(files: Record<string, string>): Promise<string[]> {
    t = await createTempConfigDir({ ...BASE_FILES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    return res.ok ? [] : res.errors.map(text);
  }

  it('is a valid column of views and sections', async () => {
    expect(
      await errors({
        'views/v.yaml': [
          'id: v',
          'sources: [repo_a]',
          'fields: [ { field: title }, { field: history, label: History } ]',
          'sections:',
          '  - { title: Open, filter: { field: state, operator: equals, value: open }, fields: [ { field: number }, { field: history } ] }',
          '  - { title: Rest, rest: true }',
          '',
        ].join('\n'),
      }),
    ).toEqual([]);
  });

  it('cannot be a sort key (view and section)', async () => {
    const errs = await errors({
      'views/v.yaml': ['id: v', 'sources: [repo_a]', 'fields: [ { field: history } ]', 'sort: [ { field: history } ]', ''].join('\n'),
    });
    expect(errs).toEqual([expect.stringMatching(/views\/v\.yaml: sort\[0\]\.field: Views cannot be sorted by "history": it is a link column/)]);
    const section = await errors({
      'views/v.yaml': ['id: v', 'sources: [repo_a]', 'fields: [ { field: title } ]', 'sections:', '  - { title: All, rest: true, sort: { field: history } }', ''].join('\n'),
    });
    expect(section).toEqual([expect.stringMatching(/sections\[0\]\.sort\.field: Views cannot be sorted by "history"/)]);
  });

  it('cannot be used in filters', async () => {
    const view = await errors({
      'views/v.yaml': ['id: v', 'sources: [repo_a]', 'fields: [ { field: title } ]', 'filter: { field: history, operator: equals, value: x }', ''].join('\n'),
    });
    expect(view).toEqual([expect.stringMatching(/filter\.field: Field "history" \(type string\) cannot be used in filters; it is a link column/)]);
    const section = await errors({
      'views/v.yaml': ['id: v', 'sources: [repo_a]', 'fields: [ { field: title } ]', 'sections:', '  - { title: A, filter: { field: history, operator: contains, value: x } }', ''].join('\n'),
    });
    expect(section).toEqual([expect.stringMatching(/sections\[0\]\.filter\.field: Field "history" .*cannot be used in filters/)]);
    // Workflows do not know the view-only field at all.
    const wf = await errors({
      'workflows/w.yaml': [
        'id: w',
        'trigger: { type: source, source: repo_a }',
        'filter: { field: history, operator: equals, value: x }',
        'execute: { type: shell, command: /bin/true }',
        '',
      ].join('\n'),
    });
    expect(wf).toEqual([expect.stringMatching(/workflows\/w\.yaml: filter\.field: Unknown field "history"/)]);
  });
});
