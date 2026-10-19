/** WI-19: `execute.type: container` and `config.yaml` `container` – schema, normalization and validation. */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, snapshotWorkflow, type ConfigIssue, type LoadConfigResult } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

function workflow(execute: string, extra = ''): string {
  return `id: w
trigger: { type: source, source: repo_a }
execute:
  type: container
${execute}
${extra}`;
}

describe('container executor configuration (WI-19)', () => {
  const temps: TempConfigDir[] = [];
  afterEach(async () => {
    while (temps.length) await temps.pop()?.cleanup();
  });

  async function load(wf: string, files: Record<string, string> = {}): Promise<{ res: LoadConfigResult; temp: TempConfigDir }> {
    const temp = await createTempConfigDir({ ...BASE_FILES, 'agents/reviewer.md': 'x\n', 'workflows/w.yaml': wf, ...files });
    temps.push(temp);
    return { res: await loadConfig(temp.dir, { dataDir: temp.dataDir }), temp };
  }

  async function errors(wf: string, files: Record<string, string> = {}): Promise<string[]> {
    const { res } = await load(wf, files);
    return res.ok ? [] : res.errors.map(text);
  }

  it('normalizes a full container execute with defaults from config.yaml', async () => {
    const { res, temp } = await load(
      workflow(
        [
          '  image: localhost/worker:current',
          "  command: [claude, -p, '{item.url}']",
          '  workdir: /work/repo',
          '  mounts:',
          "    - { source: '{workspace.path}', target: /work, mode: rw }",
          '    - { source: agents/, target: /home/worker/.claude/agents, mode: ro }',
          '  env: { MODE: review }',
          '  secrets:',
          '    GH_TOKEN: { identity: coder, delivery: file }',
          '  resources: { memory: 8g, cpus: 1.5, pids: 4096 }',
          "  user: '1000:1000'",
          '  network: none',
          '  pull: always',
          '  timeout: { max_duration: 2h }',
          '  cancel_grace: 10s',
        ].join('\n'),
        'on_result:\n  approved: []',
      ),
      { 'config.yaml': 'container: { engine: podman }\n' },
    );
    expect(res.ok, res.ok ? '' : res.errors.map(text).join('\n')).toBe(true);
    if (!res.ok) return;
    expect(res.config.global.container).toEqual({ engine: 'podman' });
    const exec = res.config.workflows.w!.execute;
    expect(exec).toMatchObject({
      type: 'container',
      engine: 'podman',
      image: 'localhost/worker:current',
      command: ['claude', '-p', '{item.url}'],
      workdir: '/work/repo',
      mounts: [
        { source: '{workspace.path}', target: '/work', mode: 'rw' },
        { source: path.join(temp.dir, 'agents'), target: '/home/worker/.claude/agents', mode: 'ro' },
      ],
      resources: { memory: '8g', cpus: 1.5, pids: 4096 },
      user: '1000:1000',
      network: 'none',
      pull: 'always',
      cancelGraceMs: 10_000,
      workingDirectory: '{workspace.base_dir}/{workflow.id}/{run.id}',
      keep: [],
    });
    // The snapshot carries the resolved engine (recovery needs it without the live config).
    expect(snapshotWorkflow(res.config, 'w').workflow.execute).toMatchObject({ type: 'container', engine: 'podman' });
  });

  it('applies the defaults: engine docker, pull missing, network default, no mounts', async () => {
    const { res } = await load(workflow('  image: busybox'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.global.container).toEqual({ engine: 'docker' });
    expect(res.config.workflows.w!.execute).toMatchObject({
      engine: 'docker',
      command: [],
      workdir: null,
      mounts: [],
      resources: { memory: null, cpus: null, pids: null },
      user: null,
      network: 'default',
      pull: 'missing',
    });
  });

  it('requires an image and validates engine, pull, mode and resources', async () => {
    expect(await errors(workflow('  command: [x]'))).toEqual([expect.stringContaining('workflows/w.yaml: execute.image:')]);
    const errs = await errors(
      workflow(
        [
          '  image: busybox',
          '  engine: dockr',
          '  pull: sometimes',
          '  mounts:',
          '    - { source: agents, target: /a, mode: rx }',
          '  resources: { memory: 8 GB, cpus: 0, pids: -1 }',
          "  user: 'a b'",
          "  network: 'my net'",
        ].join('\n'),
      ),
    );
    const at = errs.map((e) => e.split(': ').slice(0, 2).join(': '));
    expect(at).toEqual(
      expect.arrayContaining([
        'workflows/w.yaml: execute.engine',
        'workflows/w.yaml: execute.pull',
        'workflows/w.yaml: execute.mounts[0].mode',
        'workflows/w.yaml: execute.resources.memory',
        'workflows/w.yaml: execute.resources.cpus',
        'workflows/w.yaml: execute.resources.pids',
        'workflows/w.yaml: execute.user',
        'workflows/w.yaml: execute.network',
      ]),
    );
    expect(errs.find((e) => e.includes('execute.engine'))).toContain('did you mean "docker"?');
    expect(await errors(workflow('  image: busybox'), { 'config.yaml': 'container: { engine: kubectl }\n' })).toEqual([
      expect.stringContaining('config.yaml: container.engine: Invalid option'),
    ]);
  });

  it('checks mount sources, targets and the workdir', async () => {
    const errs = await errors(
      workflow(
        [
          '  image: busybox',
          '  workdir: /adispatch/out',
          '  mounts:',
          '    - { source: missing-dir, target: /data, mode: ro }',
          "    - { source: '{run.id}', target: /run, mode: ro }",
          "    - { source: '{workspace.path}/../x', target: /x, mode: ro }",
          '    - { source: agents, target: relative, mode: ro }',
          '    - { source: agents, target: /a/../b, mode: ro }',
          '    - { source: agents, target: /, mode: ro }',
          '    - { source: agents, target: /adispatch/secrets, mode: ro }',
          '    - { source: agents, target: /data, mode: ro }',
          '    - { source: agents, target: /work, mode: ro }',
          "    - { source: 'a,b', target: /c, mode: ro }",
        ].join('\n'),
      ),
    );
    // Issues are ordered by line.
    expect(errs).toEqual([
      `workflows/w.yaml: execute.workdir: "/adispatch" is reserved for the daemon's own mounts (context, result, token files)`,
      expect.stringContaining('execute.mounts[0].source: Mount source does not exist:'),
      'workflows/w.yaml: execute.mounts[1].source: Only "{workspace.path}" (optionally followed by "/<path>") is allowed as template in a mount source',
      'workflows/w.yaml: execute.mounts[2].source: Must not contain ".." (the mount must stay inside the workspace)',
      'workflows/w.yaml: execute.mounts[3].target: Must be an absolute path inside the container (start with "/")',
      'workflows/w.yaml: execute.mounts[4].target: Must be a normalized path ("/b")',
      'workflows/w.yaml: execute.mounts[5].target: Must not be "/"',
      `workflows/w.yaml: execute.mounts[6].target: "/adispatch" is reserved for the daemon's own mounts (context, result, token files)`,
      'workflows/w.yaml: execute.mounts[7].target: Duplicate mount target "/data" (also used by mounts[0])',
      'workflows/w.yaml: execute.mounts[8].target: "/work" is the target of the automatic workspace mount; mount "{workspace.path}" explicitly or use another target',
      'workflows/w.yaml: execute.mounts[9].source: Must not contain commas, double quotes, line breaks or NUL',
    ]);
  });

  it('accepts sub-paths of the workspace and an explicit workspace mount at /work', async () => {
    const { res } = await load(
      workflow(
        [
          '  image: busybox',
          '  mounts:',
          "    - { source: '{workspace.path}', target: /work, mode: rw }",
          "    - { source: '{ workspace.path }/cache', target: /cache, mode: rw }",
        ].join('\n'),
      ),
    );
    expect(res.ok, res.ok ? '' : res.errors.map(text).join('\n')).toBe(true);
  });

  it('checks command templates and rejects secrets named like engine variables', async () => {
    const errs = await errors(
      workflow(
        [
          '  image: busybox',
          "  command: ['{item.nmber}']",
          '  secrets:',
          '    HOME: { identity: coder }',
          '    DOCKER_HOST: { identity: coder }',
        ].join('\n'),
      ),
    );
    expect(errs).toEqual([
      expect.stringContaining('workflows/w.yaml: execute.command[0]: Unknown placeholder "{item.nmber}"'),
      'workflows/w.yaml: execute.secrets.HOME: "HOME" belongs to the environment of the container engine process and cannot be a secret of a container run',
      'workflows/w.yaml: execute.secrets.DOCKER_HOST: "DOCKER_HOST" belongs to the environment of the container engine process and cannot be a secret of a container run',
    ]);
  });

  it('suggests container keys for typos', async () => {
    const errs = await errors(workflow('  image: busybox\n  mount: []'));
    expect(errs).toEqual([expect.stringContaining('Unknown key(s): "mount" (did you mean "mounts"?)')]);
  });
});
