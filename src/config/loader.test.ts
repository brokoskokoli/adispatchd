import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { formatConfigIssue, loadConfig, type ConfigIssue, type LoadConfigResult, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, EXAMPLE_CONFIG_DIR, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

async function tempDir(files: Record<string, string>): Promise<TempConfigDir> {
  const t = await createTempConfigDir({ ...BASE_FILES, ...files });
  temps.push(t);
  return t;
}

async function load(files: Record<string, string>): Promise<LoadConfigResult> {
  const t = await tempDir(files);
  return loadConfig(t.dir, { dataDir: t.dataDir });
}

function expectOk(result: LoadConfigResult): LoadedConfig {
  if (!result.ok) throw new Error(`expected valid config:\n${result.errors.map(formatConfigIssue).join('\n')}`);
  return result.config;
}

function errorsOf(result: LoadConfigResult): ConfigIssue[] {
  if (result.ok) throw new Error('expected invalid config');
  return result.errors;
}

function expectError(result: LoadConfigResult, file: string, pathStr: string, message: RegExp): ConfigIssue {
  const errors = errorsOf(result);
  const hit = errors.find((e) => e.file === file && e.path === pathStr && message.test(e.message));
  if (!hit) {
    throw new Error(
      `no error ${file} ${pathStr} ${message}; got:\n${errors.map(formatConfigIssue).join('\n')}`,
    );
  }
  return hit;
}

const MANUAL_WF = (extra = ''): string =>
  `id: wf\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: /bin/true\n${extra}`;

const SOURCE_WF = (extra = '', executeExtra = ''): string =>
  [
    'id: wf',
    'trigger: { type: source, source: repo_a }',
    'execute:',
    '  type: shell',
    '  command: /bin/true',
    executeExtra,
    extra,
  ].join('\n');

/** Extract the ```yaml blocks of the spec in document order. */
async function specYamlBlocks(): Promise<string[]> {
  const spec = await readFile(path.resolve(EXAMPLE_CONFIG_DIR, '../../docs/spec-v0.1.md'), 'utf8');
  return [...spec.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] as string);
}

describe('loadConfig – spec examples', () => {
  it('validates examples/config', async () => {
    const result = await loadConfig(EXAMPLE_CONFIG_DIR, { dataDir: '/var/lib/adispatchd' });
    const config = expectOk(result);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(config.workflows).sort()).toEqual(['coder-project-a', 'deploy', 'make-report', 'nightly-maintenance', 'release', 'reviewer-project-b', 'summarize-report']);
    // WI-35: artifacts as a source; the chain make-report → summarize-report.
    expect(config.sources.artifacts).toMatchObject({ type: 'artifacts', identity: null });
    expect(config.workflows['make-report']?.execute.artifacts.map((a) => a.type)).toEqual(['report', 'site']);
    expect(config.workflows['summarize-report']?.trigger).toEqual({ type: 'source', source: 'artifacts' });
    // WI-31: selection lists fetched at run time.
    expect(config.workflows.release?.parameters.branch).toMatchObject({ optionsFrom: { type: 'github', github: 'branches', source: 'project_a' } });
    expect(config.workflows.release?.parameters.target).toMatchObject({ optionsFrom: { type: 'command', cacheMs: 300_000 }, allowCustom: true });
    expect(Object.keys(config.views)).toEqual(['needs-maintainer', 'pipeline']);
    expect(config.views.pipeline?.sections?.map((s) => s.title)).toEqual(['Braucht Maintainer', 'Review', 'In Arbeit', 'Übrige']);
    // The named filter is shared by the view and the coder workflow (WI-15).
    const needsMaintainer = { field: 'labels', operator: 'contains', value: 'needs-maintainer' };
    expect(config.filters['needs-maintainer']?.filter).toEqual(needsMaintainer);
    expect(config.views['needs-maintainer']?.filter).toEqual(needsMaintainer);
    expect(config.workflows['coder-project-a']?.filter).toMatchObject({ all: expect.arrayContaining([{ not: needsMaintainer }]) });
    // WI-24: named condition and an info tile.
    expect(config.workflows['coder-project-a']?.conditions.workflow[0]?.name).toBe('Credits available');
    expect(config.dashboard?.info.map((t) => t.id)).toEqual(['data-disk']);
  });

  it('validates the literal YAML examples of spec §5.1–§5.5 and §17', async () => {
    const blocks = await specYamlBlocks();
    expect(blocks).toHaveLength(7);
    const [global, sources, identities, coder, nightly, deploy, view] = blocks as [
      string, string, string, string, string, string, string,
    ];
    expect(coder).toContain('id: coder-project-a');
    expect(view).toContain('id: needs-maintainer');
    const t = await createTempConfigDir({
      'config.yaml': global,
      'sources.yaml': sources,
      'identities.yaml': identities,
      'workflows/coder-project-a.yaml': coder,
      'workflows/nightly-maintenance.yaml': nightly,
      'workflows/deploy.yaml': deploy,
      'views/needs-maintainer.yaml': view,
    });
    temps.push(t);
    const result = await loadConfig(t.dir, { dataDir: t.dataDir });
    expectOk(result);
    expect(result.warnings).toEqual([]);
  });

  it('normalizes values: durations in ms, sizes in bytes, defaults, action IDs and retries', async () => {
    const clock = new FakeClock(Date.parse('2026-10-16T12:00:00Z'));
    const config = expectOk(await loadConfig(EXAMPLE_CONFIG_DIR, { dataDir: '/data', clock, version: 7 }));
    expect(config.version).toBe(7);
    expect(config.loadedAt).toBe('2026-10-16T12:00:00.000Z');
    expect(config.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(config.global).toMatchObject({
      server: { host: '127.0.0.1', port: 8787 },
      scheduler: { pollingIntervalMs: 30_000, maxConcurrent: 5 },
      workspace: { baseDir: '/var/lib/adispatchd/workspaces', cleanup: 'on_success' },
      lifecycle: { actionRetry: { maxAttempts: 3, delayMs: 30_000 } },
      retention: {
        completedRunsMs: 30 * 86_400_000,
        uiActionsMs: 365 * 86_400_000,
        artifactsMs: null,
        failedRunsMs: 90 * 86_400_000,
        blockedRunsMs: null,
        maxLogSizePerRunBytes: 100 * 1024 * 1024,
        cleanupIntervalMs: 86_400_000,
      },
      notifications: { on: ['retry_block_created', 'lifecycle_action_failed', 'recovery_failed'], channels: [] },
    });
    const coder = config.workflows['coder-project-a'];
    expect(coder).toMatchObject({
      name: 'Coder – Project A',
      file: 'workflows/coder-project-a.yaml',
      enabled: true,
      priority: 50,
      maxConcurrent: 3,
      identity: 'coder',
      trigger: { type: 'source', source: 'project_a' },
      itemPriority: { default: 0 },
      conditions: { workflow: [{ timeoutMs: 15_000, cacheMs: 60_000, args: [] }], item: [] },
      execute: {
        workingDirectory: '{workspace.base_dir}/{workflow.id}/{run.id}',
        createDirectory: true,
        env: { NODE_ENV: 'production' },
        secrets: { GH_TOKEN: { identity: 'coder' } },
        timeout: { maxDurationMs: 6 * 3_600_000, idleTimeoutMs: 45 * 60_000 },
        cancelGraceMs: 30_000,
      },
      retry: { maxTechnicalFailures: 3 },
    });
    expect(coder?.hooks.on_start.map((a) => a.id)).toEqual(['on_start.0', 'on_start.1']);
    expect(coder?.hooks.on_success[1]).toMatchObject({
      type: 'source.comment',
      continueOnError: true,
      identity: 'coder',
      retry: { maxAttempts: 3, delayMs: 30_000 },
    });
    expect(coder?.hooks.on_failure[1]).toMatchObject({ type: 'source.comment', identity: null, continueOnError: false });

    expect(config.workflows['nightly-maintenance']).toMatchObject({
      enabled: true,
      priority: 20,
      trigger: { type: 'schedule', cron: '0 3 * * *', timezone: 'Europe/Berlin' },
      filter: null,
      hooks: { on_start: [], on_success: [] },
    });
    expect(config.workflows.deploy).toMatchObject({
      name: 'Deploy',
      priority: 0,
      maxConcurrent: 1,
      trigger: { type: 'manual' },
      parameters: {
        environment: { type: 'enum', values: ['staging', 'production'], required: true, default: null },
        version: { type: 'string', required: true, default: null },
      },
      execute: { workingDirectory: '{workspace.base_dir}/{workflow.id}/{run.id}', args: [], env: {} },
    });
    expect(config.views['needs-maintainer']).toMatchObject({
      title: 'Needs Maintainer',
      sources: ['project_a', 'project_b'],
      fields: expect.arrayContaining([{ field: 'title', label: 'Titel', link: 'url' }]),
      sort: [{ field: 'updated_at', direction: 'desc', order: null }],
      sections: null,
      exclusive: true,
    });
  });

  it('applies defaults when config.yaml is missing and uses ${dataDir}/workspaces', async () => {
    const t = await createTempConfigDir({ 'workflows/wf.yaml': MANUAL_WF() });
    temps.push(t);
    const result = await loadConfig(t.dir, { dataDir: t.dataDir });
    const config = expectOk(result);
    expect(result.warnings.map((w) => w.file)).toEqual(['config.yaml']);
    expect(config.global.workspace.baseDir).toBe(path.join(t.dataDir, 'workspaces'));
    expect(config.global.scheduler).toEqual({ pollingIntervalMs: 30_000, maxConcurrent: 5 });
    expect(config.global.server).toEqual({ host: '127.0.0.1', port: 8787, allowedHosts: [] });
    expect(config.global.retention.blockedRunsMs).toBeNull();
  });

  it('resolves a relative workspace.base_dir against the config dir', async () => {
    const t = await tempDir({ 'config.yaml': 'workspace:\n  base_dir: ../ws\n' });
    const config = expectOk(await loadConfig(t.dir, { dataDir: t.dataDir }));
    expect(config.global.workspace.baseDir).toBe(path.resolve(t.dir, '../ws'));
  });

  it('returns a deeply frozen config with a content hash', async () => {
    const t = await tempDir({ 'workflows/wf.yaml': MANUAL_WF() });
    const a = expectOk(await loadConfig(t.dir, { dataDir: t.dataDir }));
    const b = expectOk(await loadConfig(t.dir, { dataDir: t.dataDir }));
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.workflows.wf?.execute.env)).toBe(true);
    expect(Object.isFrozen(a.workflows.wf?.hooks.on_start)).toBe(true);
    expect(a.hash).toBe(b.hash);
    await t.write({ 'workflows/wf.yaml': MANUAL_WF('priority: 3\n') });
    const c = expectOk(await loadConfig(t.dir, { dataDir: t.dataDir }));
    expect(c.hash).not.toBe(a.hash);
    expect(c.workflowHashes.wf).not.toBe(a.workflowHashes.wf);
  });

  it('accepts notification webhook channels', async () => {
    const config = expectOk(
      await load({
        'config.yaml': [
          'notifications:',
          '  on: [retry_block_created, recovery_failed]',
          '  channels:',
          '    - type: webhook',
          '      url_env: SLACK_URL',
          '      headers_env: { Authorization: SLACK_AUTH }',
          '    - id: ops',
          '      type: webhook',
          '      url: https://hooks.example.com/abc',
          '      on: [lifecycle_action_failed]',
          '',
        ].join('\n'),
      }),
    );
    expect(config.global.notifications.channels).toEqual([
      {
        id: 'channel-1',
        type: 'webhook',
        url: null,
        urlEnv: 'SLACK_URL',
        headersEnv: { Authorization: 'SLACK_AUTH' },
        on: ['retry_block_created', 'recovery_failed'],
      },
      { id: 'ops', type: 'webhook', url: 'https://hooks.example.com/abc', urlEnv: null, headersEnv: {}, on: ['lifecycle_action_failed'] },
    ]);
  });
});

describe('loadConfig – errors with file and path', () => {
  it('reports unknown references (source, identities of workflow/secret/action/source)', async () => {
    const result = await load({
      'sources.yaml': 'sources:\n  repo_a: { type: github, owner: o, repository: a, identity: ghost }\n',
      'workflows/wf.yaml': [
        'id: wf',
        'identity: nobody',
        'trigger: { type: source, source: missing_repo }',
        'execute:',
        '  type: shell',
        '  command: /bin/true',
        '  secrets:',
        '    GH_TOKEN: { identity: unknown_app }',
        'on_success:',
        '  - type: source.comment',
        '    message: done',
        '    identity: nope',
        '',
      ].join('\n'),
    });
    expectError(result, 'sources.yaml', 'sources.repo_a.identity', /Unknown identity "ghost"/);
    expectError(result, 'workflows/wf.yaml', 'identity', /Unknown identity "nobody"/);
    expectError(result, 'workflows/wf.yaml', 'trigger.source', /Unknown source "missing_repo"/);
    expectError(result, 'workflows/wf.yaml', 'execute.secrets.GH_TOKEN.identity', /Unknown identity "unknown_app"/);
    expectError(result, 'workflows/wf.yaml', 'on_success[0].identity', /Unknown identity "nope"/);
  });

  it('reports line numbers', async () => {
    const result = await load({
      'workflows/wf.yaml': 'id: wf\ntrigger: { type: source, source: missing_repo }\nexecute:\n  type: shell\n  command: /bin/true\n',
    });
    const issue = expectError(result, 'workflows/wf.yaml', 'trigger.source', /Unknown source/);
    expect(issue.line).toBe(2);
    expect(formatConfigIssue(issue)).toBe('workflows/wf.yaml:2: trigger.source: Unknown source "missing_repo"');
  });

  it('reports duplicate workflow and view IDs', async () => {
    const view = 'id: v\nsources: [repo_a]\nfields: [{ field: title }]\n';
    const result = await load({
      'workflows/a.yaml': MANUAL_WF(),
      'workflows/b.yaml': MANUAL_WF(),
      'views/one.yaml': view,
      'views/two.yaml': view,
    });
    expectError(result, 'workflows/b.yaml', 'id', /Duplicate workflow ID "wf" \(already defined in workflows\/a.yaml\)/);
    expectError(result, 'views/two.yaml', 'id', /Duplicate view ID "v"/);
  });

  it('warns when the workflow ID differs from the file name', async () => {
    const result = await load({ 'workflows/other.yaml': MANUAL_WF() });
    expectOk(result);
    expect(result.warnings).toEqual([
      expect.objectContaining({ file: 'workflows/other.yaml', path: 'id', severity: 'warning' }),
    ]);
  });

  it('reports unknown and unavailable placeholders per context', async () => {
    const result = await load({
      'workflows/wf.yaml': [
        'id: wf',
        'trigger: { type: schedule, cron: "0 3 * * *" }',
        'parameters:',
        '  version: { type: string, default: "1" }',
        'execute:',
        '  type: shell',
        '  command: /bin/true',
        "  working_directory: '{workspace.base_dir}/{workflow.id}/{workspace.path}'",
        "  args: ['{run.idd}', '{parameters.version}', '{parameters.other}']",
        '  env:',
        "    ITEM: '{item.url}'",
        'on_start:',
        '  - type: shell',
        '    command: /bin/echo',
        "    args: ['{result.message}']",
        'on_success:',
        '  - type: shell',
        '    command: /bin/echo',
        "    args: ['{result.message} {workspace.path} {run.id}']",
        '',
      ].join('\n'),
    });
    const f = 'workflows/wf.yaml';
    expectError(result, f, 'execute.working_directory', /workspace\.path.*not available|directory root/);
    expectError(result, f, 'execute.args[0]', /Unknown placeholder "\{run\.idd\}"/);
    expectError(result, f, 'execute.args[2]', /Parameter "other" is not declared/);
    expectError(result, f, 'execute.env.ITEM', /"\{item\.url\}" is not available/);
    expectError(result, f, 'on_start[0].args[0]', /"\{result\.message\}" is not available/);
    const errors = errorsOf(result);
    expect(errors.some((e) => e.path === 'execute.args[1]')).toBe(false);
    expect(errors.some((e) => e.path.startsWith('on_success'))).toBe(false);
  });

  it('reports template syntax errors and unsafe path roots', async () => {
    const result = await load({
      'workflows/wf.yaml': SOURCE_WF(
        "on_success:\n  - type: source.comment\n    message: 'Done {result.message'\n",
        "  working_directory: '/tmp/{workspace.base_dir}/x'",
      ),
    });
    expectError(result, 'workflows/wf.yaml', 'execute.working_directory', /directory root/);
    expectError(result, 'workflows/wf.yaml', 'on_success[0].message', /Unclosed/);
  });

  it('reports invalid cron expressions and time zones', async () => {
    const result = await load({
      'workflows/a.yaml': MANUAL_WF().replace('id: wf', 'id: a').replace('{ type: manual }', '{ type: schedule, cron: "61 3 * * *" }'),
      'workflows/b.yaml': MANUAL_WF()
        .replace('id: wf', 'id: b')
        .replace('{ type: manual }', '{ type: schedule, cron: "0 3 * * *", timezone: Mars/Base }'),
      'workflows/c.yaml': MANUAL_WF().replace('id: wf', 'id: c').replace('{ type: manual }', '{ type: schedule, cron: "0 3 * *" }'),
    });
    expectError(result, 'workflows/a.yaml', 'trigger.cron', /Invalid cron expression "61 3 \* \* \*"/);
    expectError(result, 'workflows/b.yaml', 'trigger.timezone', /Invalid time zone "Mars\/Base"/);
    expectError(result, 'workflows/c.yaml', 'trigger.cron', /Invalid cron expression/);
  });

  it('reports parameter defaults that do not match the type', async () => {
    const result = await load({
      'workflows/wf.yaml': MANUAL_WF(
        [
          'parameters:',
          '  count: { type: number, default: "three" }',
          '  flag: { type: boolean, default: 1 }',
          '  env: { type: enum, values: [staging, production], default: prod }',
          '  name: { type: string, default: 5 }',
          '  dup: { type: enum, values: [a, a] }',
          '',
        ].join('\n'),
      ),
    });
    const f = 'workflows/wf.yaml';
    expectError(result, f, 'parameters.count.default', /expected a number/);
    expectError(result, f, 'parameters.flag.default', /expected a boolean/);
    expectError(result, f, 'parameters.env.default', /expected one of "staging", "production"/);
    expectError(result, f, 'parameters.name.default', /expected a string/);
    expectError(result, f, 'parameters.dup.values', /unique/);
  });

  it('rejects required parameters without default in automatic workflows', async () => {
    const result = await load({
      'workflows/wf.yaml': SOURCE_WF('parameters:\n  v: { type: string, required: true }\n'),
    });
    expectError(result, 'workflows/wf.yaml', 'parameters.v.required', /automatically triggered/);
  });

  it('reports contradictions: source-only settings on schedule/manual workflows, shell_filter in views', async () => {
    const result = await load({
      'workflows/wf.yaml': MANUAL_WF(
        [
          'filter: { field: labels, operator: contains, value: x }',
          'shell_filter: { command: /bin/true }',
          'item_priority: { rules: [], default: 1 }',
          'conditions:',
          '  item: [{ type: shell, command: /bin/true }]',
          'on_start:',
          '  - type: source.update',
          '    labels: { add: [x] }',
          '',
        ].join('\n'),
      ),
      'views/v.yaml': 'id: v\nsources: [repo_a]\nshell_filter: { command: /bin/true }\nfields: [{ field: title }]\n',
    });
    const f = 'workflows/wf.yaml';
    expectError(result, f, 'filter', /only allowed for workflows with a source trigger/);
    expectError(result, f, 'shell_filter', /only allowed/);
    expectError(result, f, 'item_priority', /only allowed/);
    expectError(result, f, 'conditions.item', /only allowed/);
    expectError(result, f, 'on_start[0].type', /needs a source item/);
    expectError(result, 'views/v.yaml', 'shell_filter', /Views do not support "shell_filter"/);
  });

  it('reports view source problems', async () => {
    const result = await load({
      'views/v.yaml': 'id: v\nsources: [repo_a, nope, repo_a]\nfields: [{ field: title }]\n',
    });
    expectError(result, 'views/v.yaml', 'sources[1]', /Unknown source "nope"/);
    expectError(result, 'views/v.yaml', 'sources', /unique/);
  });

  it('reports schema errors: unknown keys, invalid durations, wrong types, invalid filters', async () => {
    const result = await load({
      'config.yaml': 'scheduler:\n  polling_interval: 30\n  max_concurent: 3\nretention:\n  completed_runs: forever\n',
      'workflows/wf.yaml': SOURCE_WF(
        'filter:\n  all:\n    - { field: labels, operator: has, value: x }\n    - { field: n, operator: in, value: 3 }\n',
        '  timeout: { max_duration: 1h30m }',
      ),
    });
    expectError(result, 'config.yaml', 'scheduler.polling_interval', /duration/);
    expectError(result, 'config.yaml', 'scheduler', /Unknown key\(s\): "max_concurent"/);
    expectError(result, 'config.yaml', 'retention.completed_runs', /Invalid duration "forever".*never/);
    expectError(result, 'workflows/wf.yaml', 'execute.timeout.max_duration', /Invalid duration "1h30m"/);
    expectError(result, 'workflows/wf.yaml', 'filter.all[0].operator', /one of: equals/);
    expectError(result, 'workflows/wf.yaml', 'filter.all[1].value', /"in" requires a non-empty list/);
  });

  it('reports YAML syntax errors and duplicate keys with line', async () => {
    const result = await load({
      'workflows/a.yaml': 'id: a\ntrigger: { type: manual\n',
      'workflows/b.yaml': 'id: b\nid: c\n',
    });
    const errors = errorsOf(result);
    expect(errors.find((e) => e.file === 'workflows/a.yaml')?.message).toMatch(/YAML syntax error/);
    const dup = errors.find((e) => e.file === 'workflows/b.yaml');
    expect(dup?.message).toMatch(/YAML syntax error/);
    expect(dup?.line).toBe(2);
  });

  it('collects all errors across files at once', async () => {
    const result = await load({
      'config.yaml': 'server: { port: 99999 }\n',
      'workflows/a.yaml': MANUAL_WF().replace('id: wf', 'id: a').replace('command: /bin/true', 'command: ""'),
      'workflows/b.yaml': MANUAL_WF().replace('id: wf', 'id: b').replace('{ type: manual }', '{ type: nope }'),
      'views/v.yaml': 'id: v\nsources: []\nfields: []\n',
    });
    const files = new Set(errorsOf(result).map((e) => e.file));
    expect([...files].sort()).toEqual(['config.yaml', 'views/v.yaml', 'workflows/a.yaml', 'workflows/b.yaml']);
  });

  it('reports a missing config directory', async () => {
    const result = await loadConfig('/nonexistent/orch-config-dir', { dataDir: '/tmp/x' });
    expect(errorsOf(result)[0]?.message).toMatch(/does not exist/);
  });

  it('reports env problems: reserved ADISPATCH_ prefix, env/secret clash; warns about literal secrets', async () => {
    const result = await load({
      'workflows/wf.yaml': SOURCE_WF(
        '',
        [
          '  env:',
          '    ADISPATCH_RUN_ID: x',
          '    GH_TOKEN: literal',
          '  secrets:',
          '    GH_TOKEN: { identity: coder }',
        ].join('\n'),
      ),
    });
    expectError(result, 'workflows/wf.yaml', 'execute.env.ADISPATCH_RUN_ID', /reserved/);
    expectError(result, 'workflows/wf.yaml', 'execute.secrets.GH_TOKEN', /both in "env" and "secrets"/);
    expect(result.warnings.some((w) => w.path === 'execute.env.GH_TOKEN' && /secret/.test(w.message))).toBe(true);
  });

  it('reports invalid webhook channels without echoing the URL', async () => {
    const result = await load({
      'config.yaml': [
        'notifications:',
        '  channels:',
        '    - type: webhook',
        '      url: "ftp://user:s3cr3t-token@example.com"',
        '    - type: webhook',
        '      url: https://example.com/x',
        '      url_env: X',
        '',
      ].join('\n'),
    });
    expectError(result, 'config.yaml', 'notifications.channels[0].url', /absolute http\(s\) URL/);
    expectError(result, 'config.yaml', 'notifications.channels[1]', /exactly one of "url" or "url_env"/);
    expect(JSON.stringify(result)).not.toContain('s3cr3t-token');
  });
});

describe('loadConfig – review findings', () => {
  it('resolves relative commands containing "/" against the config dir; bare names stay for PATH lookup', async () => {
    const t = await tempDir({
      'workflows/wf.yaml': [
        'id: wf',
        'trigger: { type: source, source: repo_a }',
        'shell_filter: { command: ./scripts/filter.sh }',
        'conditions:',
        '  workflow: [{ type: shell, command: scripts/check.sh }]',
        '  item: [{ type: shell, command: /opt/x/../check-item.sh }]',
        'execute:',
        '  type: shell',
        '  command: scripts/coder.sh',
        'on_success:',
        '  - { type: shell, command: bash, args: [-c, "true"] }',
        '  - { type: shell, command: ../shared/notify.sh }',
        '',
      ].join('\n'),
    });
    const config = expectOk(await loadConfig(t.dir, { dataDir: t.dataDir }));
    const wf = config.workflows.wf;
    expect(wf?.execute.command).toBe(path.join(t.dir, 'scripts/coder.sh'));
    expect(wf?.shellFilter?.command).toBe(path.join(t.dir, 'scripts/filter.sh'));
    expect(wf?.conditions.workflow[0]?.command).toBe(path.join(t.dir, 'scripts/check.sh'));
    expect(wf?.conditions.item[0]?.command).toBe('/opt/check-item.sh');
    const [bash, notify] = wf?.hooks.on_success ?? [];
    expect(bash?.type === 'shell' && bash.command).toBe('bash');
    expect(notify?.type === 'shell' && notify.command).toBe(path.resolve(t.dir, '../shared/notify.sh'));
  });

  it('requires an absolute working_directory', async () => {
    const result = await load({
      'workflows/a.yaml': MANUAL_WF().replace('id: wf', 'id: a') + "  working_directory: 'work/{run.id}'\n",
      'workflows/b.yaml': MANUAL_WF().replace('id: wf', 'id: b') + "  working_directory: '/srv/work/{workflow.id}/{run.id}'\n",
    });
    expectError(result, 'workflows/a.yaml', 'execute.working_directory', /Must be absolute/);
    expect(errorsOf(result).some((e) => e.file === 'workflows/b.yaml')).toBe(false);
  });

  it('allows only required or defaulted parameters in working_directory', async () => {
    const result = await load({
      'workflows/wf.yaml': [
        'id: wf',
        'trigger: { type: manual }',
        'parameters:',
        '  env: { type: enum, values: [a, b], required: true }',
        '  tag: { type: string, default: latest }',
        '  note: { type: string }',
        'execute:',
        '  type: shell',
        '  command: /bin/true',
        "  working_directory: '{workspace.base_dir}/{parameters.env}/{parameters.tag}/{parameters.note}'",
        "  args: ['{parameters.note}']",
        '',
      ].join('\n'),
    });
    expect(errorsOf(result)).toEqual([
      expect.objectContaining({
        path: 'execute.working_directory',
        message: 'Parameter "note" is optional without default and cannot be used in a path',
      }),
    ]);
  });

  it('stringifies scalar enum defaults like the values', async () => {
    const config = expectOk(
      await load({ 'workflows/wf.yaml': MANUAL_WF('parameters:\n  level: { type: enum, values: [1, 2], default: 1 }\n') }),
    );
    expect(config.workflows.wf?.parameters.level).toMatchObject({ values: ['1', '2'], default: '1' });
  });

  it('rejects cache on item conditions and zero execute timeouts', async () => {
    const cache = await load({
      'workflows/wf.yaml': SOURCE_WF('conditions:\n  item: [{ type: shell, command: /bin/true, cache: 60s }]\n'),
    });
    expectError(cache, 'workflows/wf.yaml', 'conditions.item[0].cache', /only supported for workflow conditions/);
    const result = await load({
      'workflows/wf.yaml': SOURCE_WF('', '  timeout: { max_duration: 0s, idle_timeout: 0ms }'),
    });
    expectError(result, 'workflows/wf.yaml', 'execute.timeout.max_duration', /greater than 0/);
    expectError(result, 'workflows/wf.yaml', 'execute.timeout.idle_timeout', /greater than 0/);
  });

  it('normalizes execute.keep and keep_max_size (default 100MB) and validates the patterns (WI-22)', async () => {
    const ok = expectOk(
      await load({
        'workflows/a.yaml': MANUAL_WF().replace('id: wf', 'id: a') + "  keep: ['.agent/transcript.jsonl', '.agent/gate/*.log', '**/*.xml']\n  keep_max_size: 50MB\n",
        'workflows/b.yaml': MANUAL_WF().replace('id: wf', 'id: b'),
      }),
    );
    expect(ok.workflows.a?.execute).toMatchObject({ keep: ['.agent/transcript.jsonl', '.agent/gate/*.log', '**/*.xml'], keepMaxSizeBytes: 50 * 1024 * 1024 });
    expect(ok.workflows.b?.execute).toMatchObject({ keep: [], keepMaxSizeBytes: 100 * 1024 * 1024 });

    const bad = await load({
      'workflows/wf.yaml': MANUAL_WF() + "  keep: ['../outside.log', '/etc/passwd', '', 'a//b', 'logs/**']\n",
    });
    const f = 'workflows/wf.yaml';
    expectError(bad, f, 'execute.keep[0]', /must not contain "\.\."/);
    expectError(bad, f, 'execute.keep[1]', /relative to the workspace/);
    expectError(bad, f, 'execute.keep[2]', /must not be empty/);
    expectError(bad, f, 'execute.keep[3]', /empty or "\." segments/);
    expectError(bad, f, 'execute.keep[4]', /must not end with "\*\*"/);
    const sizes = await load({ 'workflows/wf.yaml': MANUAL_WF() + '  keep: [a.log]\n  keep_max_size: 0MB\n' });
    expectError(sizes, f, 'execute.keep_max_size', /greater than 0/);
    const unit = await load({ 'workflows/wf.yaml': MANUAL_WF() + '  keep: [a.log]\n  keep_max_size: 50 bytes\n' });
    expectError(unit, f, 'execute.keep_max_size', /Invalid size/);
    const notList = await load({ 'workflows/wf.yaml': MANUAL_WF() + '  keep: a.log\n' });
    expectError(notList, f, 'execute.keep', /array/i);
  });
});

describe('loadConfig – secrets', () => {
  it('never reads or exposes environment secret values', async () => {
    const secret = '-----BEGIN PRIVATE KEY-----\nTOP-SECRET-KEY-MATERIAL\n-----END PRIVATE KEY-----';
    process.env.GITHUB_CODER_PRIVATE_KEY = secret;
    try {
      const result = await loadConfig(EXAMPLE_CONFIG_DIR, { dataDir: '/data' });
      const config = expectOk(result);
      expect(config.identities.coder).toMatchObject({ type: 'github_app', privateKeyEnv: 'GITHUB_CODER_PRIVATE_KEY' });
      expect(JSON.stringify(result)).not.toContain('TOP-SECRET-KEY-MATERIAL');
    } finally {
      delete process.env.GITHUB_CODER_PRIVATE_KEY;
    }
  });
});
