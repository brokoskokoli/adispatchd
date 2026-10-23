/** WI-31: `options_from` / `allow_custom` of enum parameters (schema, normalization, validation, start-time checks). */
import { afterEach, describe, expect, it } from 'vitest';
import { formatConfigIssue, loadConfig, snapshotWorkflow, validateParameters, workflowSecrets, type LoadConfigResult, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

async function load(workflow: string, extraFiles: Record<string, string> = {}): Promise<LoadConfigResult> {
  const t = await createTempConfigDir({ ...BASE_FILES, 'scripts/list.sh': '#!/bin/sh\necho a\n', ...extraFiles, 'workflows/wf.yaml': workflow });
  temps.push(t);
  return loadConfig(t.dir, { dataDir: t.dataDir });
}

function expectOk(result: LoadConfigResult): LoadedConfig {
  if (!result.ok) throw new Error(`expected valid config:\n${result.errors.map(formatConfigIssue).join('\n')}`);
  return result.config;
}

function errors(result: LoadConfigResult): string[] {
  return (result.ok ? [] : result.errors).map((i) => `${i.path}: ${i.message}`);
}

const MANUAL = (params: string): string =>
  ['id: wf', 'trigger: { type: manual }', 'parameters:', params, 'execute: { type: shell, command: /bin/true }'].join('\n');
const CRON = (params: string): string =>
  ['id: wf', "trigger: { type: schedule, cron: '0 3 * * *' }", 'parameters:', params, 'execute: { type: shell, command: /bin/true }'].join('\n');
const SOURCE = (params: string): string =>
  ['id: wf', 'trigger: { type: source, source: repo_b }', 'parameters:', params, 'execute: { type: shell, command: /bin/true }'].join('\n');

describe('options_from configuration (WI-31)', () => {
  it('normalizes github and command options with defaults', async () => {
    const config = expectOk(
      await load(
        MANUAL(`  branch:
    type: enum
    options_from: { github: branches, source: repo_a }
    default: main
  tag:
    type: enum
    options_from: { github: tags, source: repo_b, limit: 50, cache: 5m, timeout: 20s }
  target:
    type: enum
    options_from:
      command: ./scripts/list.sh
      args: ['--wf', '{workflow.id}', '{timestamp}']
      secrets: { GH_TOKEN: { identity: coder, delivery: file } }
      cache: 30s
    allow_custom: true`),
      ),
    );
    const p = config.workflows.wf!.parameters;
    expect(p.branch).toEqual({
      type: 'enum',
      required: false,
      description: null,
      values: [],
      default: 'main',
      optionsFrom: { type: 'github', github: 'branches', source: 'repo_a', limit: 100, timeoutMs: 10_000, cacheMs: 60_000 },
      allowCustom: false,
    });
    expect(p.tag).toMatchObject({ optionsFrom: { type: 'github', github: 'tags', source: 'repo_b', limit: 50, timeoutMs: 20_000, cacheMs: 300_000 } });
    const target = p.target;
    expect(target?.type === 'enum' && target.optionsFrom).toMatchObject({
      type: 'command',
      args: ['--wf', '{workflow.id}', '{timestamp}'],
      secrets: { GH_TOKEN: { identity: 'coder', delivery: 'file' } },
      timeoutMs: 10_000,
      cacheMs: 30_000,
    });
    expect(target?.type === 'enum' && target.optionsFrom?.type === 'command' && target.optionsFrom.command).toMatch(/[/\\]scripts[/\\]list\.sh$/);
    expect(target).toMatchObject({ allowCustom: true });
    // Secrets of the options script are listed (names/identities only) and survive the snapshot.
    expect(workflowSecrets(config.workflows.wf!)).toEqual([
      { where: 'parameters.target.options_from', name: 'GH_TOKEN', identity: 'coder', delivery: 'file', variable: 'GH_TOKEN_FILE' },
    ]);
    const snap = snapshotWorkflow(config, 'wf');
    expect(snap.identityRefs).toContain('coder');
    expect(snap.workflow.parameters.branch).toMatchObject({ optionsFrom: { source: 'repo_a' } });
  });

  it('defaults the GitHub source to the only trigger source', async () => {
    const config = expectOk(await load(SOURCE("  branch: { type: enum, options_from: { github: branches }, default: main }")));
    expect(config.workflows.wf!.parameters.branch).toMatchObject({ optionsFrom: { source: 'repo_b' } });
  });

  it('defaults the GitHub source to the only configured source, else requires it', async () => {
    const single = {
      'sources.yaml': 'sources:\n  only:\n    type: github\n    owner: example\n    repository: a\n    identity: maintainer\n',
    };
    const config = expectOk(await load(MANUAL('  branch: { type: enum, options_from: { github: branches } }'), single));
    expect(config.workflows.wf!.parameters.branch).toMatchObject({ optionsFrom: { source: 'only' } });
    expect(errors(await load(MANUAL('  branch: { type: enum, options_from: { github: branches } }')))).toEqual([
      'parameters.branch.options_from.source: "source" is required: the workflow has no single source to read branches/tags from',
    ]);
  });

  it('reports invalid combinations', async () => {
    const result = await load(
      MANUAL(`  a: { type: enum, values: [x], options_from: { github: branches, source: repo_a } }
  b: { type: enum }
  c: { type: enum, options_from: {} }
  d: { type: enum, options_from: { github: tags, command: ./scripts/list.sh, source: repo_a } }
  e: { type: enum, options_from: { github: tags, source: nope } }
  f: { type: enum, options_from: { github: tags, source: repo_a, args: [x], secrets: { T: { identity: coder } } } }
  g: { type: enum, options_from: { command: ./scripts/list.sh, source: repo_a, limit: 3 } }
  h: { type: enum, options_from: { command: ./scripts/list.sh, timeout: 2m } }
  i: { type: enum, options_from: { command: ./scripts/missing.sh, args: ['{run.id}'], secrets: { T: { identity: ghost } } } }`),
    );
    expect(errors(result)).toEqual([
      'parameters.a.options_from: "options_from" cannot be combined with "values" (use one of them)',
      'parameters.b.values: Enum needs "values" or "options_from"',
      'parameters.c.options_from: "options_from" needs "github" (branches|tags) or "command"',
      'parameters.d.options_from: "options_from" needs exactly one of "github" or "command", not both',
      'parameters.e.options_from.source: Unknown source "nope"',
      'parameters.f.options_from.args: "args" is only allowed with "options_from.command"',
      'parameters.f.options_from.secrets: "secrets" is only allowed with "options_from.command"',
      'parameters.g.options_from.limit: "limit" is only allowed with "options_from.github"',
      'parameters.g.options_from.source: "source" is only allowed with "options_from.github"',
      'parameters.h.options_from.timeout: "timeout" must not exceed 60s',
      'parameters.i.options_from.args[0]: Placeholder "{run.id}" is not available in this context',
      expect.stringMatching(/^parameters\.i\.options_from\.command: Script does not exist: .*missing\.sh/),
      'parameters.i.options_from.secrets.T.identity: Unknown identity "ghost"',
    ]);
  });

  it('checks schema bounds and keys', async () => {
    const result = await load(
      MANUAL(`  a: { type: enum, options_from: { github: tags, source: repo_a, limit: 501 } }
  b: { type: enum, options_from: { github: forks, source: repo_a } }
  c: { type: string, options_from: { github: tags } }
  d: { type: string, allow_custom: true }`),
    );
    const list = errors(result);
    expect(list.some((e) => e.startsWith('parameters.a.options_from.limit: Must be at most 500'))).toBe(true);
    expect(list.some((e) => e.startsWith('parameters.b.options_from.github:'))).toBe(true);
    expect(list.some((e) => e.startsWith('parameters.c') && e.includes('options_from'))).toBe(true);
    expect(list.some((e) => e.startsWith('parameters.d') && e.includes('allow_custom'))).toBe(true);
  });

  it('requires a default for options_from in automatic workflows and does not check it against a list', async () => {
    expect(errors(await load(CRON('  branch: { type: enum, options_from: { github: branches, source: repo_a } }')))).toEqual([
      'parameters.branch.default: "options_from" without "default" in an automatically triggered workflow: automatic runs only receive the default',
    ]);
    expectOk(await load(CRON('  branch: { type: enum, options_from: { github: branches, source: repo_a }, default: release-1 }')));
  });

  it('allow_custom with static values accepts a default outside the values', async () => {
    const config = expectOk(await load(MANUAL('  env: { type: enum, values: [staging, prod], allow_custom: true, default: qa }')));
    expect(config.workflows.wf!.parameters.env).toMatchObject({ values: ['staging', 'prod'], default: 'qa', allowCustom: true, optionsFrom: null });
    expect(errors(await load(MANUAL('  env: { type: enum, values: [staging, prod], default: qa }')))).toEqual([
      'parameters.env.default: Default does not match parameter type: expected one of "staging", "prod"',
    ]);
  });
});

describe('validateParameters with dynamic enums (WI-31)', () => {
  const base = { required: false, description: null, default: null } as const;
  it('accepts any sane string for options_from / allow_custom, rejects control characters and long values', () => {
    const defs = {
      branch: { ...base, type: 'enum', values: [], optionsFrom: { type: 'github', github: 'branches', source: 's', limit: 100, timeoutMs: 1, cacheMs: 0 } },
      env: { ...base, type: 'enum', values: ['a'], allowCustom: true },
      fixed: { ...base, type: 'enum', values: ['a'] },
    } as const;
    expect(validateParameters(defs, { branch: 'feature/x', env: 'zzz', fixed: 'a' })).toEqual({ ok: true, values: { branch: 'feature/x', env: 'zzz', fixed: 'a' } });
    expect(validateParameters(defs, { branch: 'a\nb', env: 'x'.repeat(201), fixed: 'b' })).toEqual({
      ok: false,
      errors: [
        { parameter: 'branch', message: 'Value contains control characters' },
        { parameter: 'env', message: 'Value is longer than 200 characters' },
        { parameter: 'fixed', message: 'Expected one of: a' },
      ],
    });
  });
});
