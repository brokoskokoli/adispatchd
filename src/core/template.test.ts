import { describe, expect, it } from 'vitest';
import {
  buildTemplateValues,
  extractPlaceholders,
  parseTemplate,
  renderTemplate,
  TemplateError,
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

  it('fails on missing values instead of producing a shorter path', () => {
    expect(() => renderTemplate('{workspace.base_dir}/{item.number}', { 'workspace.base_dir': '/w' }, { mode: 'path' })).toThrow(
      /No value/,
    );
  });

  it('rejects NUL bytes in the template itself', () => {
    expect(() => renderTemplate('/tmp/a\0b', values, { mode: 'path' })).toThrow(TemplateError);
  });
});
