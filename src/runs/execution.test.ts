import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialProvider, SourceItem } from '../core/index.js';
import { buildExecutionSpec, type ExecutionInput } from './execution.js';
import { ITEM_KEY, ITEM_URL, createRunsEnv, type RunsTestEnv } from './testing/helpers.js';

const ITEM: SourceItem = {
  sourceId: 'repo_a',
  itemId: '7',
  key: ITEM_KEY,
  url: ITEM_URL,
  type: 'issue',
  fields: { title: 'Fix ../../etc/passwd', labels: ['coding'] },
};

describe('buildExecutionSpec', () => {
  let env: RunsTestEnv;
  let counter = 100;
  beforeEach(() => {
    env = createRunsEnv();
  });
  afterEach(() => env.cleanup());

  async function input(executeYaml: string, extra: Partial<ExecutionInput> = {}): Promise<ExecutionInput> {
    const snapshot = await env.snapshot(`
id: wf
name: Coder
trigger: { type: source, source: repo_a }
execute:
${executeYaml}
`);
    const run = env.reserve(snapshot, { sourceItemKey: `repo_a:${++counter}` });
    return {
      run,
      snapshot,
      item: ITEM,
      dataDir: env.dataDir,
      startedAt: new Date('2026-10-16T19:00:00.000Z'),
      now: new Date('2026-10-16T19:00:01.000Z'),
      ...extra,
    };
  }

  it('renders workspace (path mode, sanitized), args/env (text mode), secrets and the worker context', async () => {
    const calls: string[] = [];
    const credentials: CredentialProvider = {
      getToken: async (identity) => {
        calls.push(identity);
        return { token: 'ghs_secret_token', expiresAt: new Date('2027-01-01T00:00:00Z') };
      },
    };
    const i = await input(
      `  type: shell
  command: /bin/echo
  working_directory: '{workspace.base_dir}/{workflow.id}/{item.title}/{run.id}'
  args: ['{item.number}', '{workspace.path}', '{source.repository}']
  env: { TITLE: '{item.title}' }
  secrets: { GH_TOKEN: { identity: coder } }
  timeout: { max_duration: 1h }
  cancel_grace: 2s`,
      { credentials, maxLogBytes: 1234 },
    );
    const { spec, workspaceBaseDir } = await buildExecutionSpec(i);
    const ws = path.join(env.workspaces, 'wf', 'Fix_.._.._etc_passwd', i.run.id);
    expect(spec.workingDirectory).toBe(ws);
    expect(workspaceBaseDir).toBe(env.workspaces);
    expect(spec.args).toEqual(['7', ws, 'example/a']);
    expect(spec.env).toEqual({ TITLE: 'Fix ../../etc/passwd' });
    expect(spec.secrets).toEqual({ GH_TOKEN: 'ghs_secret_token' });
    expect(calls).toEqual(['coder']);
    expect(spec.timeouts).toEqual({ maxDurationMs: 3_600_000 });
    expect(spec.cancelGraceMs).toBe(2000);
    expect(spec.maxLogBytes).toBe(1234);
    expect(spec.files.resultFile).toBe(path.join(env.dataDir, 'runs', i.run.id, 'result.json'));
    expect(spec.context).toEqual({
      schema_version: 1,
      run: { id: i.run.id, trigger: 'source', started_at: '2026-10-16T19:00:00.000Z' },
      workflow: { id: 'wf', name: 'Coder' },
      source: { id: 'repo_a', type: 'github', item_id: '7', item_key: ITEM_KEY, url: ITEM_URL, attributes: ITEM.fields },
      parameters: {},
      workspace: { path: ws },
    });
    expect(JSON.stringify(spec.context)).not.toContain('ghs_secret_token');
  });

  it('allows absolute workspaces outside base_dir (no base guard, never cleaned) but rejects base_dir itself', async () => {
    const outside = await input(`  type: shell\n  command: /bin/true\n  working_directory: '/tmp/orch-elsewhere/{run.id}'`);
    const prepared = await buildExecutionSpec(outside);
    expect(prepared.workspaceBaseDir).toBeUndefined();
    expect(prepared.spec.workingDirectory).toBe(`/tmp/orch-elsewhere/${outside.run.id}`);

    const base = await input(`  type: shell\n  command: /bin/true\n  working_directory: '{workspace.base_dir}'`);
    await expect(buildExecutionSpec(base)).rejects.toMatchObject({ code: 'run_invalid_workspace' });
  });

  it('leaves secrets with delivery file to the controller (token files, WI-18); old snapshots default to env', async () => {
    const calls: string[] = [];
    const credentials: CredentialProvider = {
      getToken: async (identity) => {
        calls.push(identity);
        return { token: `ghs_${identity}_token`, expiresAt: new Date('2027-01-01T00:00:00Z') };
      },
    };
    const i = await input(
      `  type: shell
  command: /bin/true
  secrets:
    GH_TOKEN: { identity: coder, delivery: file }
    OTHER: { identity: maintainer }`,
      { credentials },
    );
    const prepared = await buildExecutionSpec(i);
    expect(prepared.tokenFiles).toEqual([{ name: 'GH_TOKEN', identity: 'coder' }]);
    expect(prepared.spec.secrets).toEqual({ OTHER: 'ghs_maintainer_token' });
    expect(prepared.spec.env).toEqual({});
    expect(calls).toEqual(['maintainer']);

    // A snapshot written before WI-18 has no `delivery`.
    const old = await input(`  type: shell\n  command: /bin/true\n  secrets: { GH_TOKEN: { identity: coder } }`, { credentials });
    delete (old.snapshot.workflow.execute.secrets.GH_TOKEN as { delivery?: string }).delivery;
    const oldPrepared = await buildExecutionSpec(old);
    expect(oldPrepared.spec.secrets).toEqual({ GH_TOKEN: 'ghs_coder_token' });
    expect(oldPrepared.tokenFiles).toEqual([]);
  });

  it('fails (→ start_error) on secrets without credential provider and on missing items', async () => {
    const secrets = await input(`  type: shell\n  command: /bin/true\n  secrets: { GH_TOKEN: { identity: coder } }`);
    await expect(buildExecutionSpec(secrets)).rejects.toMatchObject({ code: 'run_no_credentials' });
    const noItem = await input(`  type: shell\n  command: /bin/true`, { item: null });
    await expect(buildExecutionSpec(noItem)).rejects.toMatchObject({ code: 'run_item_missing' });
  });

  it('container (WI-19): resolves mounts, workspace target, container paths, linked fields and the out dir', async () => {
    const i = await input(
      `  type: container
  image: busybox
  command: ['{item.number}', '{workspace.path}', '{item.work_branch}', '{source.repository}']
  env: { BRANCH: '{item.work_branch}', WS: '{workspace.path}' }
  mounts:
    - { source: '{workspace.path}', target: /work/repo, mode: rw }
    - { source: '{workspace.path}/cache', target: /cache, mode: rw }`,
      { linked: { work_branch: { known: true, value: 'feature/oauth' } } },
    );
    const { spec } = await buildExecutionSpec(i);
    const workspace = spec.workingDirectory;
    expect(spec.command).toBe('docker');
    expect(spec.args).toEqual(['7', '/work/repo', 'feature/oauth', 'example/a']);
    expect(spec.env).toEqual({ BRANCH: 'feature/oauth', WS: '/work/repo' });
    expect(spec.files.resultFile).toBe(path.join(env.dataDir, 'runs', i.run.id, 'out', 'result.json'));
    expect((spec.context as { workspace: { path: string } }).workspace.path).toBe('/work/repo');
    expect(spec.container).toMatchObject({
      name: `adispatch-${i.run.id}`,
      mounts: [
        { source: workspace, target: '/work/repo', mode: 'rw' },
        { source: path.join(workspace, 'cache'), target: '/cache', mode: 'rw' },
      ],
      workspaceTarget: '/work/repo',
      workdir: '/work/repo',
      labels: { 'adispatch.run': i.run.id, 'adispatch.workflow': 'wf' },
    });

    // Without a workspace mount the workspace is mounted at /work automatically.
    const auto = await buildExecutionSpec(await input(`  type: container\n  image: busybox\n  workdir: /tmp`));
    expect(auto.spec.container).toMatchObject({
      mounts: [{ source: auto.spec.workingDirectory, target: '/work', mode: 'rw' }],
      workspaceTarget: '/work',
      workdir: '/tmp',
    });
  });
});
