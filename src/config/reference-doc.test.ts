/**
 * Keeps docs/configuration-reference.md in sync with the code:
 *
 * - Every ```yaml block with a `# file: <path>` header belongs to an example
 *   set (`# example: <name>`). Each set is written to a temporary config dir
 *   (after the files of its `# extends: <set>` base) and loaded with the real
 *   loader. Sets marked `# invalid` must fail with exactly the documented
 *   errors (`# expect: <file>: <path>: <message>` substrings); all other sets
 *   must load, with exactly the documented warnings (`# expect-warning:`).
 * - The named filter grammar (`Use`) and its depth limit are documented.
 * - The placeholder whitelist, the GitHub field catalogue (incl. the project
 *   field kinds), the view run fields, hooks, operators and notification
 *   events must all be documented.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTAINER_LABELS, CONTAINER_PATHS, FILTER_OPERATORS, HOOK_NAMES, NOTIFICATION_EVENT_TYPES, OPERATORS_BY_TYPE, PLACEHOLDERS } from '../core/index.js';
import {
  CLOSING_PRS_FIRST,
  GITHUB_FIELD_DEFINITIONS,
  LINKED_BRANCHES_FIRST,
  PROJECT_FIELD_DATA_TYPES,
  PROJECT_FIELD_KINDS,
  PROJECT_FIELD_TYPES,
} from '../sources/github/index.js';
import { VIEW_RUN_FIELDS } from '../views/index.js';
import { KEEP_MAX_ENTRIES, KEEP_MAX_FILES } from '../runs/index.js';
import {
  DEFAULT_WORKING_DIRECTORY,
  DEFAULTS,
  MAX_DEFAULT_MONITORING_INTERVAL_MS,
  MAX_MONITORING_SAMPLES,
  MIN_MONITORING_INTERVAL_MS,
  MIN_MONITORING_SAMPLES,
  loadConfig, MAX_EXPANDED_FILTER_NODES, MAX_FILTER_USE_DEPTH, type ConfigIssue } from './index.js';
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
    for (const name of ['reference', 'minimal', 'github', 'cron', 'manual-params', 'notifications', 'projects', 'named-filters', 'multi-source', 'linked']) {
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
    expect(markdown).toContain('`{source.vars.<name>}`');
    expect(markdown).toContain(`\`${DEFAULT_WORKING_DIRECTORY}\``);
  });

  it('documents the complete GitHub field catalogue and the view run fields with their types', () => {
    for (const f of [...GITHUB_FIELD_DEFINITIONS, ...VIEW_RUN_FIELDS]) {
      expect(markdown, f.name).toContain(`| \`${f.name}\` | ${f.type} |`);
    }
  });

  it('documents every project field kind with its field type and GitHub data type (WI-14)', () => {
    for (const kind of PROJECT_FIELD_KINDS) {
      expect(markdown, kind).toMatch(new RegExp(`\\| \`${kind}\` \\| ${PROJECT_FIELD_TYPES[kind]} \\| [^|]+ \\| \`${PROJECT_FIELD_DATA_TYPES[kind]}\` \\|`));
    }
  });

  it('documents the value of every project field kind in source.update and the write mutations (WI-16)', () => {
    for (const kind of PROJECT_FIELD_KINDS) expect(markdown, kind).toMatch(new RegExp(`\\| \`${kind}\` \\| (String|Zahl|Datum)`));
    for (const name of ['addProjectV2ItemById', 'updateProjectV2ItemFieldValue', 'clearProjectV2ItemFieldValue', 'Projects: Read and write']) {
      expect(markdown, name).toContain(name);
    }
  });

  it('documents the linked branch/PR query limits and the unknown rule of the placeholders (WI-21)', () => {
    expect(markdown).toContain(`linkedBranches(first: ${LINKED_BRANCHES_FIRST})`);
    expect(markdown).toContain(`closedByPullRequestsReferences(first: ${CLOSING_PRS_FIRST}, includeClosedPrs: true)`);
    expect(markdown).toContain('### 5.3 Teure Platzhalter `{item.work_branch}`, `{item.work_pr}`');
    expect(markdown).toContain('run_linked_field_unknown');
    expect(markdown).toContain('lifecycle_linked_field_unknown');
  });

  it('documents the allowed operators per field type (validated since WI-13)', () => {
    for (const [type, operators] of Object.entries(OPERATORS_BY_TYPE)) {
      expect(markdown, type).toContain(`| \`${type}\` | ${operators.join(', ')} |`);
    }
  });

  it('documents the grammar, depth limit and size cap of named filters (WI-15)', () => {
    expect(markdown).toContain('Use        := { use: <Filter-ID> }');
    expect(markdown).toContain('Wurzel     := Knoten | <Filter-ID>');
    expect(markdown).toMatch(new RegExp(`tiefer\\s+als ${MAX_FILTER_USE_DEPTH} Ebenen`));
    const cap = String(MAX_EXPANDED_FILTER_NODES).replace(/\B(?=(\d{3})+$)/g, ' ');
    expect(markdown).toContain(`höchstens **${cap} Knoten** je Wurzel`);
    expect(markdown).toContain(`Expanded filter would exceed ${MAX_EXPANDED_FILTER_NODES} nodes`);
  });

  it('documents execute.keep: keys, default, glob syntax, event, API and limits (WI-22)', () => {
    expect(markdown).toContain('| `keep` | Liste String | nein | `[]` |');
    expect(markdown).toContain(`| \`keep_max_size\` | Größe | nein | \`${DEFAULTS.keepMaxSize}\` |`);
    expect(markdown).toContain('`run.kept_files`');
    expect(markdown).toContain('**Secrets werden beim Kopieren redigiert** – best effort, wie Logs');
    expect(markdown).toContain('GET /api/v1/runs/:id/kept');
    const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
    expect(markdown).toContain(`höchstens ${fmt(KEEP_MAX_FILES)} Dateien und ${fmt(KEEP_MAX_ENTRIES)} untersuchte Verzeichniseinträge`);
  });

  it('documents the container executor: keys, defaults, mounts, labels and config.yaml (WI-19)', () => {
    for (const key of ['image', 'engine', 'command', 'workdir', 'mounts', 'mounts[].source', 'mounts[].target', 'mounts[].mode', 'resources.memory', 'resources.cpus', 'resources.pids', 'user', 'network', 'pull']) {
      expect(markdown, key).toContain(`| \`${key}\` |`);
    }
    expect(markdown).toContain(`| \`container.engine\` | Enum | \`${DEFAULTS.containerEngine}\` |`);
    expect(markdown).toContain(`| \`pull\` | Enum | nein | \`${DEFAULTS.containerPull}\` |`);
    for (const p of Object.values(CONTAINER_PATHS)) expect(markdown, p).toContain(p);
    for (const l of Object.values(CONTAINER_LABELS)) expect(markdown, l).toContain(`${l}=`);
    expect(markdown).toContain('--cap-drop ALL --security-opt no-new-privileges');
    expect(markdown).toContain('`recovery.container_stopped`');
    expect(sets.get('container')?.invalid).toBe(false);
  });

  it('documents the monitoring section: keys, defaults and limits (WI-23)', () => {
    for (const key of ['enabled', 'interval', 'retention', 'top_processes', 'min_cpu_percent']) expect(markdown, key).toContain(`| \`monitoring.${key}\` |`);
    expect(markdown).toContain(`| \`monitoring.retention\` | Dauer | \`${DEFAULTS.monitoringRetention}\` | ≥ ${MIN_MONITORING_SAMPLES} und ≤ ${String(MAX_MONITORING_SAMPLES).replace(/\B(?=(\d{3})+$)/g, ' ')} Intervalle |`);
    expect(markdown).toContain(`| \`monitoring.top_processes\` | Integer | \`${DEFAULTS.monitoringTopProcesses}\` |`);
    expect(markdown).toContain(`| \`monitoring.min_cpu_percent\` | Zahl | \`${DEFAULTS.monitoringMinCpuPercent}\` |`);
    expect(markdown).toContain(`höchstens \`${MAX_DEFAULT_MONITORING_INTERVAL_MS / 1000}s\` | ≥ ${MIN_MONITORING_INTERVAL_MS / 1000} s |`);
    expect(markdown).toContain('ps -A -o pid=,ppid=,pgid=,time=,rss=,comm=');
    expect(markdown).toContain('**nur Befehlsnamen, nie Argumente**');
  });

  it('documents all hooks, operators and notification events', () => {
    for (const name of [...HOOK_NAMES, 'on_result', 'on_result.<outcome>', ...FILTER_OPERATORS, ...NOTIFICATION_EVENT_TYPES]) {
      expect(markdown, name).toContain(`\`${name}\``);
    }
  });
});
