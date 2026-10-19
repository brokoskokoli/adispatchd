import { describe, expect, it } from 'vitest';
import {
  buildTemplateValues,
  extractPlaceholders,
  linkedFieldsUsed,
  linkedTemplateItem,
  parseTemplate,
  renderTemplate,
  TemplateError,
  unknownLinkedField,
  validateTemplate,
  type TemplateValues,
} from './template.js';

const values: TemplateValues = buildTemplateValues({
  workflow: { id: 'coder-project-a' },
  workspace: { baseDir: '/var/lib/orch/workspaces' },
  run: { id: 'run-20261016T190000123Z-3fa2c91b', trigger: 'source' },
  source: { id: 'project_a', type: 'github', repository: 'example/project-a' },
  item: { id: '123', number: 123, key: 'project_a:123', title: 'Implement OAuth' },
  result: { status: 'completed', result: 'success', message: 'All done' },
  parameters: { version: '1.2.3' },
  now: new Date('2026-10-16T19:00:00Z'),
});

const WORKDIR = '{workspace.base_dir}/{workflow.id}/{run.id}';

describe('parseTemplate / extractPlaceholders', () => {
  it('parses literals, placeholders and escaped braces', () => {
    expect(parseTemplate('a {run.id} {{x}}')).toEqual([
      { kind: 'literal', text: 'a ' },
      { kind: 'placeholder', name: 'run.id', index: 2 },
      { kind: 'literal', text: ' {x}' },
    ]);
  });

  it('extracts distinct placeholders in order', () => {
    expect(extractPlaceholders('{run.id}-{workflow.id}-{run.id}')).toEqual(['run.id', 'workflow.id']);
  });

  it.each(['{run.id', 'x}', '{}', '{run id}', '{../x}'])('rejects syntax error in %j', (tpl) => {
    expect(() => parseTemplate(tpl)).toThrow(TemplateError);
  });
});

describe('validateTemplate', () => {
  it('accepts the spec working_directory template', () => {
    expect(validateTemplate(WORKDIR, { mode: 'path', scope: { run: true } })).toEqual([]);
  });

  it('rejects unknown placeholders', () => {
    const issues = validateTemplate('{env.HOME}', { mode: 'text' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unknown_placeholder');
  });

  it('rejects placeholders not available in scope', () => {
    const issues = validateTemplate('Done: {result.message} for {item.url}', { mode: 'text', scope: { run: true } });
    expect(issues.map((i) => i.code)).toEqual(['unavailable_placeholder', 'unavailable_placeholder']);
  });

  it('checks parameter placeholders against declared names', () => {
    expect(validateTemplate('{parameters.version}', { mode: 'text', scope: { parameters: ['version'] } })).toEqual([]);
    expect(validateTemplate('{parameters.other}', { mode: 'text', scope: { parameters: ['version'] } })[0]?.code).toBe(
      'unavailable_placeholder',
    );
  });

  it('requires path roots at the start of path templates', () => {
    const issues = validateTemplate('x/{workspace.base_dir}', { mode: 'path' });
    expect(issues[0]?.code).toBe('path_root_position');
  });
});

describe('renderTemplate text mode', () => {
  it('interpolates values verbatim', () => {
    expect(renderTemplate('Completed: {result.message} ({item.number})', values, { mode: 'text' })).toBe(
      'Completed: All done (123)',
    );
  });

  it('throws for unknown placeholders even if a value exists', () => {
    expect(() => renderTemplate('{secret.token}', { 'secret.token': 'x' }, { mode: 'text' })).toThrow(
      /Unknown placeholder/,
    );
  });

  it('renders missing values as empty by default', () => {
    expect(renderTemplate('msg: {result.message}', { 'result.message': undefined }, { mode: 'text' })).toBe('msg: ');
    expect(() =>
      renderTemplate('msg: {result.message}', {}, { mode: 'text', missing: 'error' }),
    ).toThrow(TemplateError);
  });

  it('formats {timestamp} compactly', () => {
    expect(renderTemplate('{timestamp}', values, { mode: 'text' })).toBe('20261016T190000Z');
  });
});

describe('renderTemplate path mode (traversal protection)', () => {
  it('renders the default workspace path', () => {
    expect(renderTemplate(WORKDIR, values, { mode: 'path' })).toBe(
      '/var/lib/orch/workspaces/coder-project-a/run-20261016T190000123Z-3fa2c91b',
    );
  });

  it('turns "/" in values into a single segment', () => {
    expect(renderTemplate('{workspace.base_dir}/{source.repository}', values, { mode: 'path' })).toBe(
      '/var/lib/orch/workspaces/example_project-a',
    );
  });

  it.each([
    ['..', '__'],
    ['../../etc', '.._.._etc'],
    ['/etc/passwd', '_etc_passwd'],
    ['a\0b', 'a_b'],
    ['.', '_'],
    ['', '_'],
  ])('neutralises malicious value %j', (malicious, expected) => {
    const out = renderTemplate('{workspace.base_dir}/{item.title}', { ...values, 'item.title': malicious }, {
      mode: 'path',
    });
    expect(out).toBe(`/var/lib/orch/workspaces/${expected}`);
    expect(out.startsWith('/var/lib/orch/workspaces/')).toBe(true);
    expect(out.split('/')).not.toContain('..');
    expect(out).not.toContain('\0');
  });

  it('rejects a relative or NUL-containing path root value', () => {
    expect(() => renderTemplate(WORKDIR, { ...values, 'workspace.base_dir': 'relative/dir' }, { mode: 'path' })).toThrow(
      /absolute/,
    );
    expect(() => renderTemplate(WORKDIR, { ...values, 'workspace.base_dir': '/x\0y' }, { mode: 'path' })).toThrow(
      TemplateError,
    );
  });

  it('rejects path roots that are not at the start', () => {
    expect(() => renderTemplate('/tmp/{workspace.base_dir}', values, { mode: 'path' })).toThrow(TemplateError);
  });

  it('requires "/" or end after a path root', () => {
    for (const tpl of ['{workspace.base_dir}{workflow.id}', '{workspace.base_dir}-x/{run.id}', '{workspace.base_dir}..']) {
      expect(validateTemplate(tpl, { mode: 'path', scope: { run: true } })[0]?.code).toBe('path_root_position');
      expect(() => renderTemplate(tpl, values, { mode: 'path' })).toThrow(TemplateError);
    }
    expect(renderTemplate('{workspace.base_dir}', values, { mode: 'path' })).toBe('/var/lib/orch/workspaces');
    expect(renderTemplate('{workspace.base_dir}/x', values, { mode: 'path' })).toBe('/var/lib/orch/workspaces/x');
  });

  it('fails on missing values instead of producing a shorter path', () => {
    expect(() => renderTemplate('{workspace.base_dir}/{item.number}', { 'workspace.base_dir': '/w' }, { mode: 'path' })).toThrow(
      /No value/,
    );
  });

  it('rejects NUL bytes in the template itself', () => {
    expect(() => renderTemplate('/tmp/a\0b', values, { mode: 'path' })).toThrow(TemplateError);
  });
});

describe('linked placeholders (WI-21)', () => {
  it('finds the fields behind {item.work_branch} / {item.work_pr}; skips broken templates', () => {
    expect(linkedFieldsUsed(['{item.work_pr} {item.title}', 'x/{item.work_branch}/{item.work_pr}', '{broken'])).toEqual(['work_pr', 'work_branch']);
    expect(linkedFieldsUsed(['{item.title}'])).toEqual([]);
  });

  it('are only valid with the linked scope', () => {
    expect(validateTemplate('{item.work_branch}', { mode: 'text', scope: { source: true } })).toMatchObject([
      { code: 'unavailable_placeholder', placeholder: 'item.work_branch' },
    ]);
    expect(validateTemplate('{item.work_branch}', { mode: 'text', scope: { source: true, linked: true } })).toEqual([]);
  });

  it('renders resolved values; null is empty in text mode and an error in path mode', () => {
    const resolved = { work_branch: { known: true as const, value: 'feature/x' }, work_pr: { known: true as const, value: null } };
    const v = buildTemplateValues({
      workflow: { id: 'w' },
      workspace: { baseDir: '/base' },
      item: { id: '1', ...linkedTemplateItem(resolved) },
      now: new Date('2026-10-19T00:00:00Z'),
    });
    expect(renderTemplate('{item.work_branch}#{item.work_pr}', v, { mode: 'text' })).toBe('feature/x#');
    expect(renderTemplate('{workspace.base_dir}/{item.work_branch}', v, { mode: 'path' })).toBe('/base/feature_x');
    expect(() => renderTemplate('{workspace.base_dir}/{item.work_pr}', v, { mode: 'path' })).toThrow(/No value/);
  });

  it('reports the first used field that is unknown or missing', () => {
    expect(unknownLinkedField(['work_pr'], { work_pr: { known: false, reason: 'rate limit' } })).toEqual({
      field: 'work_pr',
      placeholder: 'item.work_pr',
      reason: 'rate limit',
    });
    expect(unknownLinkedField(['work_branch'], undefined)).toMatchObject({ placeholder: 'item.work_branch', reason: expect.stringMatching(/not resolved/) });
    expect(unknownLinkedField(['work_pr'], { work_pr: { known: true, value: 3 } })).toBeUndefined();
  });
});
