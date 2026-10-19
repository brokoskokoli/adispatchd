/**
 * WI-28: view sort keys (list, custom value `order`) and sections – schema,
 * normalization and validation with issue paths.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ConfigIssue, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

const SOURCES = [
  'sources:',
  '  repo_a:',
  '    type: github',
  '    owner: example',
  '    repository: a',
  '    identity: maintainer',
  '    project: { number: 3, fields: { Status: single_select, Estimate: number } }',
  '  repo_b:',
  '    type: github',
  '    owner: example',
  '    repository: b',
  '    identity: maintainer',
  '    project: { number: 4, fields: { Status: single_select, Estimate: number } }',
  '',
].join('\n');

const view = (body: string): string => `id: v\nsources: [repo_a, repo_b]\nfields: [ { field: title }, { field: project.Status } ]\n${body}\n`;

describe('config: view sort keys and sections (WI-28)', () => {
  let t: TempConfigDir | undefined;
  afterEach(async () => t?.cleanup());

  async function load(files: Record<string, string>): Promise<{ config: LoadedConfig | null; errors: string[]; warnings: string[] }> {
    t = await createTempConfigDir({ ...BASE_FILES, 'sources.yaml': SOURCES, ...files });
    const res = await loadConfig(t.dir, { dataDir: t.dataDir });
    const warnings = res.warnings.filter((w) => w.file.startsWith('views/')).map(text);
    return res.ok ? { config: res.config, errors: [], warnings } : { config: null, errors: res.errors.map(text), warnings };
  }

  it('normalizes a single sort key (backwards compatible) and a list with order', async () => {
    const single = await load({ 'views/v.yaml': view('sort: { field: updated_at, direction: desc }') });
    expect(single.errors).toEqual([]);
    expect(single.config?.views.v).toMatchObject({
      sort: [{ field: 'updated_at', direction: 'desc', order: null }],
      sections: null,
      exclusive: true,
      hideEmptySections: false,
      groupByFirst: false,
    });

    const list = await load({
      'views/v.yaml': view(
        [
          'sort:',
          '  - { field: project.Status, order: [open, ready_for_coding, coding] }',
          '  - { field: created_at, direction: asc }',
          'group_by_first: true',
        ].join('\n'),
      ),
    });
    expect(list.errors).toEqual([]);
    expect(list.config?.views.v?.sort).toEqual([
      { field: 'project.Status', direction: 'asc', order: ['open', 'ready_for_coding', 'coding'] },
      { field: 'created_at', direction: 'asc', order: null },
    ]);
    expect(list.config?.views.v?.groupByFirst).toBe(true);

    const none = await load({ 'views/v.yaml': view('') });
    expect(none.config?.views.v?.sort).toEqual([]);
  });

  it('rejects invalid sort lists and orders with paths', async () => {
    const tooMany = await load({
      'views/v.yaml': view(`sort: [${Array.from({ length: 6 }, () => '{ field: title }').join(', ')}]`),
    });
    expect(tooMany.errors).toEqual(['views/v.yaml: sort: A view can sort by at most 5 keys']);

    const empty = await load({ 'views/v.yaml': view('sort: []') });
    expect(empty.errors).toEqual(['views/v.yaml: sort: A sort list needs at least one key']);

    const scalar = await load({ 'views/v.yaml': view('sort: title') });
    expect(scalar.errors).toEqual(['views/v.yaml: sort: Expected a sort key ({ field, direction?, order? }) or a list of 1–5 sort keys']);

    const badDirection = await load({ 'views/v.yaml': view('sort: [ { field: title, direction: up } ]') });
    expect(badDirection.errors).toEqual([expect.stringMatching(/^views\/v\.yaml: sort\[0\]\.direction: Invalid option/)]);

    const typo = await load({ 'views/v.yaml': view('sort: [ { field: title, oder: [a] } ]') });
    expect(typo.errors).toEqual(['views/v.yaml: sort[0]: Unknown key(s): "oder" (did you mean "order"?)']);
    const typoSingle = await load({ 'views/v.yaml': view('sort: { field: title, oder: [a] }') });
    expect(typoSingle.errors).toEqual(['views/v.yaml: sort: Unknown key(s): "oder" (did you mean "order"?)']);

    const emptyOrder = await load({ 'views/v.yaml': view('sort: { field: project.Status, order: [] }') });
    expect(emptyOrder.errors).toEqual(['views/v.yaml: sort.order: "order" must list at least one value']);

    const tooLong = await load({
      'views/v.yaml': view(`sort: { field: project.Status, order: [${Array.from({ length: 101 }, (_, i) => `v${i}`).join(', ')}] }`),
    });
    expect(tooLong.errors).toEqual(['views/v.yaml: sort.order: "order" may list at most 100 values']);

    const semantic = await load({
      'views/v.yaml': view(
        [
          'sort:',
          '  - { field: project.Status, order: [a, b, a] }',
          '  - { field: labels, order: [bug] }',
          '  - { field: number, order: ["1"] }',
          '  - { field: project.Estimate, order: ["3"] }',
          '  - { field: titel, order: [x] }',
        ].join('\n'),
      ),
    });
    expect(semantic.errors).toEqual([
      'views/v.yaml: sort[0].order[2]: Duplicate value "a" in "order"',
      'views/v.yaml: sort[1].order: "order" is only allowed for string fields (e.g. project.* single_select/text/iteration, state, run.last_status); "labels" has type string[]',
      'views/v.yaml: sort[2].order: "order" is only allowed for string fields (e.g. project.* single_select/text/iteration, state, run.last_status); "number" has type number',
      'views/v.yaml: sort[3].order: "order" is only allowed for string fields (e.g. project.* single_select/text/iteration, state, run.last_status); "project.Estimate" has type number',
      'views/v.yaml: sort[4].field: Unknown field "titel" for source type github (did you mean "title"?)',
    ]);

    const objectField = await load({ 'views/v.yaml': view('sort: [ { field: closing_prs } ]') });
    expect(objectField.errors).toEqual(['views/v.yaml: sort[0].field: Views cannot be sorted by "closing_prs" (type object[])']);

    const okStrings = await load({
      'views/v.yaml': view('sort: [ { field: state, order: [open, closed] }, { field: run.last_status, order: [failed, running], direction: desc } ]'),
    });
    expect(okStrings.errors).toEqual([]);
  });

  it('group_by_first needs a first key with order', async () => {
    const bad = await load({ 'views/v.yaml': view('sort: { field: title }\ngroup_by_first: true') });
    expect(bad.errors).toEqual(['views/v.yaml: group_by_first: "group_by_first" needs a first sort key with "order" (in the view "sort" or in a section "sort")']);
    const viaSection = await load({
      'views/v.yaml': view(
        ['group_by_first: true', 'sections:', '  - title: A', '    filter: { field: labels, operator: contains, value: a }', '    sort: { field: project.Status, order: [x] }'].join('\n'),
      ),
    });
    expect(viaSection.errors).toEqual([]);
  });

  it('normalizes sections with own sort/fields and named filters', async () => {
    const { config, errors, warnings } = await load({
      'filters/review.yaml': 'id: review\nfilter: { field: project.Status, operator: in, value: [ready_for_review, review] }\n',
      'views/v.yaml': view(
        [
          'filter: { field: state, operator: equals, value: open }',
          'sort: { field: created_at }',
          'exclusive: false',
          'hide_empty_sections: true',
          'sections:',
          '  - title: Braucht Maintainer',
          '    filter: { field: labels, operator: contains, value: needs-maintainer }',
          '  - title: Review',
          '    filter: review',
          '    sort: { field: updated_at, direction: desc }',
          '  - title: Coding',
          '    filter: { use: review }',
          '    fields: [ { field: number, label: Nr. } ]',
          '  - title: Übrige',
          '    rest: true',
        ].join('\n'),
      ),
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    const v = config?.views.v;
    expect(v).toMatchObject({ exclusive: false, hideEmptySections: true });
    expect(v?.sections).toEqual([
      { title: 'Braucht Maintainer', filter: { field: 'labels', operator: 'contains', value: 'needs-maintainer' }, rest: false, sort: null, fields: null },
      {
        title: 'Review',
        filter: { field: 'project.Status', operator: 'in', value: ['ready_for_review', 'review'] },
        rest: false,
        sort: [{ field: 'updated_at', direction: 'desc', order: null }],
        fields: null,
      },
      {
        title: 'Coding',
        filter: { field: 'project.Status', operator: 'in', value: ['ready_for_review', 'review'] },
        rest: false,
        sort: null,
        fields: [{ field: 'number', label: 'Nr.', link: null }],
      },
      { title: 'Übrige', filter: null, rest: true, sort: null, fields: null },
    ]);
  });

  it('validates sections: count, titles, filter xor rest, single rest, fields and sorts', async () => {
    const tooMany = await load({
      'views/v.yaml': view(['sections:', ...Array.from({ length: 21 }, (_, i) => `  - { title: S${i}, rest: true }`)].join('\n')),
    });
    expect(tooMany.errors).toEqual(['views/v.yaml: sections: A view can have at most 20 sections']);
    const none = await load({ 'views/v.yaml': view('sections: []') });
    expect(none.errors).toEqual(['views/v.yaml: sections: A view with "sections" needs at least one section']);

    const bad = await load({
      'views/v.yaml': view(
        [
          'sections:',
          `  - title: ${'x'.repeat(81)}`,
          '    rest: true',
          '  - title: "  "',
          '    rest: true',
        ].join('\n'),
      ),
    });
    expect(bad.errors).toEqual([
      'views/v.yaml: sections[0].title: A section title may have at most 80 characters',
      'views/v.yaml: sections[1].title: Must not be empty',
    ]);

    const semantic = await load({
      'views/v.yaml': view(
        [
          'sections:',
          '  - title: A',
          '    filter: { field: labels, operator: contains, value: a }',
          '  - title: A',
          '    rest: true',
          '  - title: B',
          '    rest: true',
          '    filter: { field: labels, operator: contains, value: b }',
          '  - title: C',
          '  - title: D',
          '    rest: false',
          '  - title: E',
          '    rest: true',
          '  - title: F',
          '    filter: { field: lables, operator: contains, value: f }',
          '    fields: [ { field: titel } ]',
          '    sort: [ { field: title }, { field: number, order: ["1"] } ]',
          '  - title: G',
          '    filter: { field: run.last_status, operator: equals, value: failed }',
        ].join('\n'),
      ),
    });
    expect(semantic.errors).toEqual([
      'views/v.yaml: sections[1].title: Duplicate section title "A" (also used by section 1)',
      'views/v.yaml: sections[2]: A section has either "filter" or "rest: true", not both',
      'views/v.yaml: sections[2].rest: Only one section can be "rest: true" (already section 2)',
      'views/v.yaml: sections[3]: A section needs a "filter" or "rest: true"',
      'views/v.yaml: sections[4]: A section needs a "filter" or "rest: true"',
      'views/v.yaml: sections[5].rest: Only one section can be "rest: true" (already section 2)',
      'views/v.yaml: sections[6].filter.field: Unknown field "lables" for source type github (did you mean "labels"?)',
      'views/v.yaml: sections[6].fields[0].field: Unknown field "titel" for source type github (did you mean "title"?)',
      'views/v.yaml: sections[6].sort[1].order: "order" is only allowed for string fields (e.g. project.* single_select/text/iteration, state, run.last_status); "number" has type number',
    ]);
  });

  it('state in sections: local only, never beyond what the view lists', async () => {
    const section = (filter: string, viewFilter = ''): string =>
      view([viewFilter, 'sections:', '  - title: S', `    filter: ${filter}`].filter((l) => l !== '').join('\n'));
    // Default listing: open only.
    const openOk = await load({ 'views/v.yaml': section('{ any: [ { field: state, operator: equals, value: open }, { field: labels, operator: contains, value: x } ] }') });
    expect(openOk.errors).toEqual([]);
    const closed = await load({ 'views/v.yaml': section('{ field: state, operator: equals, value: closed }') });
    expect(closed.errors).toEqual([
      'views/v.yaml: sections[0].filter.field: "state" in a section only filters the items the view lists (only open issues/PRs); this section asks for "closed", which the view never reads – select them in the view filter (top level, e.g. state in [open, closed])',
    ]);
    const negated = await load({ 'views/v.yaml': section('{ not: { field: state, operator: equals, value: open } }') });
    expect(negated.errors).toEqual([expect.stringContaining('sections[0].filter.not.field: "state" in a section only filters')]);
    const notEquals = await load({ 'views/v.yaml': section('{ field: state, operator: not_equals, value: open }') });
    expect(notEquals.errors).toHaveLength(1);
    // The view lists open and closed: anything goes.
    const all = await load({
      'views/v.yaml': section('{ field: state, operator: equals, value: closed }', 'filter: { field: state, operator: in, value: [open, closed] }'),
    });
    expect(all.errors).toEqual([]);
    // The view lists closed only: asking for open is an error naming the listing.
    const closedOnly = await load({
      'views/v.yaml': section('{ field: state, operator: in, value: [open] }', 'filter: { field: state, operator: equals, value: closed }'),
    });
    expect(closedOnly.errors).toEqual([expect.stringContaining('(state closed); this section asks for "open"')]);
    // Through a named filter: located at the place of use.
    const named = await load({
      'filters/closed.yaml': 'id: closed\nfilter: { field: state, operator: equals, value: closed }\n',
      'views/v.yaml': section('closed'),
    });
    expect(named.errors).toEqual([expect.stringMatching(/^views\/v\.yaml: sections\[0\]\.filter \(use "closed" → filters\/closed\.yaml: filter\.field\): "state" in a section/)]);
  });

  it('warns about section-only options without sections', async () => {
    const res = await load({ 'views/v.yaml': view('exclusive: false\nhide_empty_sections: true') });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([
      'views/v.yaml: exclusive: "exclusive" has no effect without "sections"',
      'views/v.yaml: hide_empty_sections: "hide_empty_sections" has no effect without "sections"',
    ]);
  });
});
