/**
 * Keeps docs/configuration-reference.md in sync with the code:
 *
 * - Every ```yaml block with a `# file: <path>` header belongs to an example
 *   set (`# example: <name>`). Each set is written to a temporary config dir
 *   (after the files of its `# extends: <set>` base) and loaded with the real
 *   loader. Sets marked `# invalid` must fail with exactly the documented
 *   errors (`# expect: <file>: <path>: <message>` substrings); all other sets
 *   must load, with exactly the documented warnings (`# expect-warning:`).
 * - The placeholder whitelist, the GitHub field catalogue, the view run fields,
 *   hooks, operators and notification events must all be documented.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FILTER_OPERATORS, HOOK_NAMES, NOTIFICATION_EVENT_TYPES, PLACEHOLDERS } from '../core/index.js';
import { GITHUB_FIELD_DEFINITIONS } from '../sources/github/index.js';
import { VIEW_RUN_FIELDS } from '../views/index.js';
import { DEFAULT_WORKING_DIRECTORY, loadConfig, type ConfigIssue } from './index.js';
import { createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/configuration-reference.md');

interface Block {
  line: number;
  file: string;
  content: string;
}

interface ExampleSet {
  name: string;
  blocks: Block[];
  extends: string | null;
  invalid: boolean;
  expect: string[];
  expectWarning: string[];
}

/** Extract the marked yaml blocks from the markdown text and group them into example sets. */
function parseExampleSets(markdown: string): Map<string, ExampleSet> {
  const sets = new Map<string, ExampleSet>();
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== '```yaml') continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end]?.trim() !== '```') end++;
    const body = lines.slice(start, end);
    i = end;

    const header: Array<[string, string]> = [];
    for (const raw of body) {
      const m = /^#\s*(example|extends|file|invalid|expect-warning|expect)(?![\w-]):?\s*(.*)$/.exec(raw.trim());
      if (!raw.trim().startsWith('#') || !m) break;
      header.push([m[1] as string, (m[2] ?? '').trim()]);
    }
    const file = header.find(([k]) => k === 'file')?.[1];
    if (!file) continue; // illustrative snippet
    const name = header.find(([k]) => k === 'example')?.[1];
    if (!name) throw new Error(`docs line ${start}: block with "# file:" needs "# example:"`);
    const set = sets.get(name) ?? { name, blocks: [], extends: null, invalid: false, expect: [], expectWarning: [] };
    for (const [key, value] of header) {
      if (key === 'extends') set.extends = value;
      if (key === 'invalid') set.invalid = true;
      if (key === 'expect') set.expect.push(value);
      if (key === 'expect-warning') set.expectWarning.push(value);
    }
    set.blocks.push({ line: start, file, content: `${body.join('\n')}\n` });
    sets.set(name, set);
  }
  return sets;
}

/** Files of a set including its `extends` chain (own files override). */
function resolveFiles(sets: Map<string, ExampleSet>, name: string, seen: string[] = []): Record<string, string> {
  const set = sets.get(name);
  if (!set) throw new Error(`Unknown example set "${name}" (extends chain: ${seen.join(' → ')})`);
  if (seen.includes(name)) throw new Error(`Cyclic extends: ${[...seen, name].join(' → ')}`);
  const base = set.extends ? resolveFiles(sets, set.extends, [...seen, name]) : {};
  const own: Record<string, string> = {};
  for (const block of set.blocks) {
    if (block.file in own) throw new Error(`Example "${name}" defines ${block.file} twice (docs line ${block.line})`);
    own[block.file] = block.content;
  }
  return { ...base, ...own };
}

/** Line-free issue text matched by `# expect:`. */
function issueText(issue: ConfigIssue): string {
  return `${issue.file}: ${issue.path ? `${issue.path}: ` : ''}${issue.message}`;
}

const markdown = await readFile(DOC, 'utf8');
const sets = parseExampleSets(markdown);
const temps: TempConfigDir[] = [];

afterAll(async () => {
  await Promise.all(temps.map((t) => t.cleanup()));
});

async function load(name: string): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const temp = await createTempConfigDir(resolveFiles(sets, name));
  temps.push(temp);
  return loadConfig(temp.dir, { dataDir: temp.dataDir });
}

describe('docs/configuration-reference.md', () => {
  it('contains the documented example sets', () => {
    for (const name of ['reference', 'minimal', 'github', 'cron', 'manual-params', 'notifications']) {
      expect(sets.get(name)?.invalid, name).toBe(false);
    }
    expect([...sets.values()].filter((s) => s.invalid).length).toBeGreaterThanOrEqual(10);
    for (const set of sets.values()) {
      if (set.invalid) expect(set.expect.length, `${set.name} needs "# expect:"`).toBeGreaterThan(0);
      if (set.extends) expect(sets.get(set.extends)?.invalid, `${set.name} extends an invalid set`).toBe(false);
    }
  });

  for (const set of sets.values()) {
    if (set.invalid) {
      it(`example "${set.name}" fails with the documented errors`, async () => {
        const result = await load(set.name);
        expect(result.ok, `${set.name} should be invalid`).toBe(false);
        const errors = result.ok ? [] : result.errors.map(issueText);
        for (const expected of set.expect) {
          expect(errors.some((e) => e.includes(expected)), `expected error "${expected}" in:\n${errors.join('\n')}`).toBe(true);
        }
        for (const error of errors) {
          expect(set.expect.some((x) => error.includes(x)), `undocumented error in "${set.name}": ${error}`).toBe(true);
        }
      });
    } else {
      it(`example "${set.name}" is valid`, async () => {
        const result = await load(set.name);
        const errors = result.ok ? [] : result.errors.map(issueText);
        expect(errors, `${set.name} should be valid`).toEqual([]);
        const warnings = result.warnings.map(issueText);
        for (const expected of set.expectWarning) {
          expect(warnings.some((w) => w.includes(expected)), `expected warning "${expected}" in:\n${warnings.join('\n')}`).toBe(true);
        }
        for (const warning of warnings) {
          expect(set.expectWarning.some((x) => warning.includes(x)), `undocumented warning in "${set.name}": ${warning}`).toBe(true);
        }
      });
    }
  }

  it('documents every placeholder', () => {
    for (const p of PLACEHOLDERS) expect(markdown, p.name).toContain(`\`{${p.name}}\``);
    expect(markdown).toContain('`{parameters.<name>}`');
    expect(markdown).toContain(`\`${DEFAULT_WORKING_DIRECTORY}\``);
  });

  it('documents the complete GitHub field catalogue and the view run fields with their types', () => {
    for (const f of [...GITHUB_FIELD_DEFINITIONS, ...VIEW_RUN_FIELDS]) {
      expect(markdown, f.name).toContain(`| \`${f.name}\` | ${f.type} |`);
    }
  });

  it('documents all hooks, operators and notification events', () => {
    for (const name of [...HOOK_NAMES, ...FILTER_OPERATORS, ...NOTIFICATION_EVENT_TYPES]) {
      expect(markdown, name).toContain(`\`${name}\``);
    }
  });
});
