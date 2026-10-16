import { afterEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../core/index.js';
import {
  ConfigLoadError,
  ConfigManager,
  snapshotWorkflow,
  toPublicConfig,
  UnknownWorkflowError,
  type ConfigChangeEvent,
} from './index.js';
import { BASE_FILES, createTempConfigDir, EXAMPLE_CONFIG_DIR, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

const wf = (id: string, extra = ''): string =>
  `id: ${id}\npriority: 10\nmax_concurrent: 2\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: /bin/true\n${extra}`;

async function setup(files: Record<string, string> = {}): Promise<{ t: TempConfigDir; manager: ConfigManager }> {
  const t = await createTempConfigDir({
    ...BASE_FILES,
    'workflows/a.yaml': wf('a'),
    'workflows/b.yaml': wf('b'),
    ...files,
  });
  temps.push(t);
  const manager = await ConfigManager.create({ configDir: t.dir, dataDir: t.dataDir, logger: new MemoryLogger() });
  return { t, manager };
}

describe('ConfigManager', () => {
  it('throws ConfigLoadError with all issues when the initial config is invalid', async () => {
    const t = await createTempConfigDir({ 'workflows/a.yaml': 'id: a\n' });
    temps.push(t);
    const err = await ConfigManager.create({ configDir: t.dir, dataDir: t.dataDir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect((err as ConfigLoadError).errors.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the active config unchanged on an invalid reload (scenario 11)', async () => {
    const { t, manager } = await setup();
    const before = manager.current;
    const events: ConfigChangeEvent[] = [];
    manager.onChange((e) => events.push(e));

    await t.write({ 'workflows/a.yaml': 'id: a\ntrigger: { type: manual\n' }); // YAML syntax error
    const syntax = await manager.reload();
    expect(syntax.ok).toBe(false);
    expect(manager.current).toBe(before);

    await t.write({ 'workflows/a.yaml': wf('a', 'identity: ghost\n'), 'workflows/c.yaml': wf('c') }); // semantic error
    const semantic = await manager.reload();
    expect(semantic.ok).toBe(false);
    if (!semantic.ok) {
      expect(semantic.errors).toEqual([
        expect.objectContaining({ file: 'workflows/a.yaml', path: 'identity', message: 'Unknown identity "ghost"' }),
      ]);
    }
    expect(manager.current).toBe(before);
    expect(manager.current.workflows.c).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('activates a valid reload atomically, increments the version and notifies listeners', async () => {
    const { t, manager } = await setup();
    const before = manager.current;
    const events: ConfigChangeEvent[] = [];
    const unsubscribe = manager.onChange((e) => events.push(e));

    await t.write({ 'workflows/a.yaml': wf('a', 'enabled: false\n'), 'workflows/b.yaml': null, 'workflows/c.yaml': wf('c') });
    const result = await manager.reload();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.diff).toEqual({ addedWorkflows: ['c'], removedWorkflows: ['b'], changedWorkflows: ['a'] });
    expect(manager.current).toBe(result.config);
    expect(manager.current.version).toBe(before.version + 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'reload', previous: before, config: result.config });

    unsubscribe();
    const again = await manager.reload();
    expect(again.ok && again.changed).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('applies overrides to effective values without changing the config', async () => {
    const { manager } = await setup();
    expect(manager.getWorkflow('a')).toMatchObject({ enabled: true, priority: 10, maxConcurrent: 2, overrides: {} });
    expect(manager.maxConcurrent).toBe(4);

    const effective = manager.setWorkflowOverrides('a', { enabled: false, priority: 99, maxConcurrent: 7 });
    expect(effective).toMatchObject({ enabled: false, priority: 99, maxConcurrent: 7 });
    manager.setGlobalMaxConcurrent(1);
    expect(manager.maxConcurrent).toBe(1);
    expect(manager.current.workflows.a?.priority).toBe(10);
    expect(manager.listWorkflows().map((w) => [w.config.id, w.priority])).toEqual([
      ['a', 99],
      ['b', 10],
    ]);

    manager.setWorkflowOverrides('a', { priority: undefined });
    expect(manager.getWorkflow('a')).toMatchObject({ enabled: false, priority: 10, maxConcurrent: 7 });
    expect(() => manager.setWorkflowOverrides('a', { maxConcurrent: 0 })).toThrow(/maxConcurrent/);
    expect(() => manager.setWorkflowOverrides('zzz', { enabled: true })).toThrow(UnknownWorkflowError);
    manager.clearWorkflowOverrides('a');
    expect(manager.getWorkflow('a')?.overrides).toEqual({});
    manager.setGlobalMaxConcurrent(undefined);
    expect(manager.maxConcurrent).toBe(4);
  });

  it('resets overrides of affected workflows on reload and keeps the others', async () => {
    const { t, manager } = await setup();
    manager.setWorkflowOverrides('a', { enabled: false });
    manager.setWorkflowOverrides('b', { priority: 1 });
    manager.setGlobalMaxConcurrent(2);

    // Unchanged config: nothing is reset.
    const same = await manager.reload();
    expect(same.ok && same.resetOverrides).toEqual([]);
    expect(manager.getWorkflow('a')?.enabled).toBe(false);

    // Workflow a changes, global max_concurrent changes.
    await t.write({
      'workflows/a.yaml': wf('a', 'name: Renamed\n'),
      'config.yaml': 'scheduler:\n  max_concurrent: 6\n',
    });
    const result = await manager.reload();
    expect(result.ok && result.resetOverrides).toEqual(['a', '*']);
    expect(manager.getWorkflow('a')).toMatchObject({ enabled: true, overrides: {} });
    expect(manager.getWorkflow('b')).toMatchObject({ priority: 1, overrides: { priority: 1 } });
    expect(manager.maxConcurrent).toBe(6);

    // Removed workflow: its overrides disappear.
    await t.write({ 'workflows/b.yaml': null });
    const removed = await manager.reload();
    expect(removed.ok && removed.resetOverrides).toEqual(['b']);
    expect(manager.getOverrides()).toEqual({ global: {}, workflows: {} });
  });

  it('serializes concurrent reloads', async () => {
    const { manager } = await setup();
    const [r1, r2] = await Promise.all([manager.reload(), manager.reload()]);
    expect(r1.ok && r1.config.version).toBe(2);
    expect(r2.ok && r2.config.version).toBe(3);
  });

  it('validates manual parameters against the workflow schema', async () => {
    const manager = await ConfigManager.create({ configDir: EXAMPLE_CONFIG_DIR, dataDir: '/data' });
    expect(manager.validateParameters('deploy', { environment: 'staging', version: '1.2.3' })).toEqual({
      ok: true,
      values: { environment: 'staging', version: '1.2.3' },
    });
    expect(manager.validateParameters('deploy', { environment: 'prod' })).toEqual({
      ok: false,
      errors: [
        { parameter: 'environment', message: 'Expected one of: staging, production' },
        { parameter: 'version', message: 'Required parameter is missing' },
      ],
    });
    expect(() => manager.validateParameters('nope', {})).toThrow(UnknownWorkflowError);
  });
});

describe('snapshotWorkflow', () => {
  it('produces a serializable snapshot without secrets that survives reloads', async () => {
    const secret = 'super-secret-private-key-value';
    process.env.TEST_CODER_KEY = secret;
    try {
      const { t, manager } = await setup({
        'config.yaml': 'notifications:\n  channels:\n    - type: webhook\n      url: https://hooks.example.com/T0K3N\n',
        'workflows/s.yaml': [
          'id: s',
          'identity: coder',
          'trigger: { type: source, source: repo_a }',
          'execute:',
          '  type: shell',
          '  command: /bin/run',
          '  secrets: { GH_TOKEN: { identity: coder } }',
          'on_success:',
          '  - { type: source.comment, message: "done {result.message}", identity: maintainer }',
          '',
        ].join('\n'),
      });
      const snapshot = manager.snapshotWorkflow('s');
      const json = JSON.stringify(snapshot);
      expect(JSON.parse(json)).toEqual(snapshot);
      expect(json).not.toContain(secret);
      expect(json).not.toContain('T0K3N');
      expect(json).not.toContain('TEST_CODER_KEY');
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        configHash: manager.current.hash,
        configVersion: 1,
        workflow: { id: 's', execute: { secrets: { GH_TOKEN: { identity: 'coder' } } } },
        source: { id: 'repo_a', owner: 'example', repository: 'a' },
        identityRefs: ['coder', 'maintainer'],
      });
      expect(Object.isFrozen(snapshot)).toBe(false);

      await t.write({ 'workflows/s.yaml': null });
      expect((await manager.reload()).ok).toBe(true);
      expect(snapshot.workflow.id).toBe('s');
      expect(() => manager.snapshotWorkflow('s')).toThrow(UnknownWorkflowError);
      expect(() => snapshotWorkflow(manager.current, 'constructor')).toThrow(UnknownWorkflowError);
    } finally {
      delete process.env.TEST_CODER_KEY;
    }
  });

  it('toPublicConfig redacts literal webhook URLs', async () => {
    const { manager } = await setup({
      'config.yaml': [
        'notifications:',
        '  channels:',
        '    - { type: webhook, url: "https://hooks.example.com/T0K3N" }',
        '    - { type: webhook, url_env: HOOK_URL }',
        '',
      ].join('\n'),
    });
    const pub = toPublicConfig(manager.current);
    expect(JSON.stringify(pub)).not.toContain('T0K3N');
    expect(pub.global.notifications.channels.map((c) => [c.url, c.urlEnv])).toEqual([
      ['[REDACTED]', null],
      [null, 'HOOK_URL'],
    ]);
    expect(manager.current.global.notifications.channels[0]?.url).toBe('https://hooks.example.com/T0K3N');
  });
});
