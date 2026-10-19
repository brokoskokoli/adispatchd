import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempConfigDir, type TempConfigDir } from '../config/testing/fixtures.js';
import { loadConfig, snapshotWorkflow } from '../config/index.js';
import { openPersistence } from '../persistence/index.js';
import { FakeGitHub } from '../sources/github/testing/index.js';
import type { DryRunResult } from '../scheduler/index.js';
import { createProgram, type CliIo } from './program.js';
import { createWorkflowDryRunHandler } from './workflow-dry-run.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

function captureIo(): CliIo & { out: string; err: string; code: number | undefined } {
  const io = {
    out: '',
    err: '',
    code: undefined as number | undefined,
    stdout: (t: string) => {
      io.out += t;
    },
    stderr: (t: string) => {
      io.err += t;
    },
    setExitCode: (c: number) => {
      io.code = c;
    },
  };
  return io;
}

async function setup() {
  const github = new FakeGitHub();
  const app = github.createApp({ login: 'maintainer[bot]' });
  github.createIssue('example/a', { number: 1, title: 'Ready one', labels: ['ready-for-coding'] });
  github.createIssue('example/a', { number: 2, title: 'Locked one', labels: ['ready-for-coding'] });
  github.createIssue('example/a', { number: 3, title: 'Not ready' });
  const tmp = await createTempConfigDir({
    'config.yaml': 'scheduler:\n  max_concurrent: 4\n',
    'identities.yaml': `identities:\n  maintainer:\n    type: github_app\n    app_id: ${app.appId}\n    installation_id: ${app.installationId}\n    private_key_env: TEST_DRY_RUN_KEY\n`,
    'sources.yaml': 'sources:\n  repo_a:\n    type: github\n    owner: example\n    repository: a\n    identity: maintainer\n',
  });
  temps.push(tmp);
  const marker = path.join(tmp.dir, 'executed');
  const script = path.join(tmp.dir, 'touch.sh');
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(script, 0o755);
  await tmp.write({
    'workflows/coder.yaml': `id: coder
name: Coder
max_concurrent: 2
trigger: { type: source, source: repo_a }
filter: { field: labels, operator: contains, value: ready-for-coding }
conditions:
  workflow:
    - { type: shell, command: ${script} }
execute: { type: shell, command: ${script} }
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
`,
  });
  // Existing database with an active run on issue #2.
  const loaded = await loadConfig(tmp.dir, { dataDir: tmp.dataDir });
  if (!loaded.ok) throw new Error('invalid config');
  const p = openPersistence(tmp.dataDir);
  const holder = p.runs.reserve({
    workflowId: 'coder',
    triggerType: 'source',
    sourceId: 'repo_a',
    sourceItemKey: 'repo_a:2',
    configSnapshot: snapshotWorkflow(loaded.config, 'coder'),
  });
  p.close();
  // No orchestrator instance is "running": the API client gets connection refused → local fallback.
  const refused = async (): Promise<Response> => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  };
  const deps = { fetch: github.fetch, apiFetch: refused, env: { TEST_DRY_RUN_KEY: app.privateKeyPem } };
  return { github, tmp, marker, holder, deps };
}

async function run(args: string[], deps: Parameters<typeof createWorkflowDryRunHandler>[1]) {
  const io = captureIo();
  await createProgram({ workflowDryRun: createWorkflowDryRunHandler(io, deps) }, io).parseAsync(args, { from: 'user' });
  return io;
}

describe('cli workflow dry-run (local)', () => {
  it('prints candidates incl. locks from the database without executing anything', async () => {
    const { github, tmp, marker, holder, deps } = await setup();
    const io = await run(['workflow', 'dry-run', 'coder', '--config-dir', tmp.dir, '--data-dir', tmp.dataDir], deps);
    expect(io.err).toBe('');
    expect(io.code).toBe(0);
    expect(io.out).toContain("Dry-run of workflow 'coder'");
    expect(io.out).toContain('repo_a:1 "Ready one"');
    expect(io.out).toMatch(/repo_a:2 "Locked one"\n.*locked/);
    expect(io.out).toContain(holder.id);
    expect(io.out).toContain('workflow condition 0');
    expect(io.out).toContain('unknown / not evaluated');
    expect(io.out).toContain('capacity: workflow 1/2 active, global 1/4 active');
    expect(io.out).toContain('no running instance at http://127.0.0.1:8787: evaluated locally');
    expect(existsSync(marker)).toBe(false);
    expect(github.requests.filter((r) => r.method !== 'GET' && !r.path.includes('access_tokens'))).toEqual([]);
    expect(github.labels('example/a', 1)).toEqual(['ready-for-coding']);
    // The database was only read.
    const p = openPersistence(tmp.dataDir);
    expect(p.runs.list({}).total).toBe(1);
    p.close();
  });

  it('--json prints the structured result; without data dir a note explains the limits', async () => {
    const { tmp, deps } = await setup();
    const io = await run(['workflow', 'dry-run', 'coder', '--json', '--config-dir', tmp.dir], deps);
    expect(io.code).toBe(0);
    const result = JSON.parse(io.out) as DryRunResult;
    expect(result.candidates.map((c) => [c.itemKey, c.decision])).toEqual([
      ['repo_a:1', 'pending_checks'],
      ['repo_a:2', 'pending_checks'],
    ]); // #3 is excluded by the label pushdown
    expect(result.source).toMatchObject({ polled: 2, pushdown: { field: 'labels', operator: 'contains', value: 'ready-for-coding' } });
    expect(result.notes.some((n) => n.includes('no --data-dir'))).toBe(true);
  });

  it('shows the expanded filter of a workflow using a named filter (WI-15)', async () => {
    const { tmp, deps } = await setup();
    const workflow = readFileSync(path.join(tmp.dir, 'workflows/coder.yaml'), 'utf8');
    await tmp.write({
      'filters/ready.yaml': 'id: ready\nfilter: { field: labels, operator: contains, value: ready-for-coding }\n',
      'workflows/coder.yaml': workflow.replace(/^filter: .*$/m, 'filter: { all: [ { use: ready } ] }'),
    });
    const io = await run(['workflow', 'dry-run', 'coder', '--config-dir', tmp.dir], deps);
    expect(io.err).toBe('');
    expect(io.code).toBe(0);
    const predicate = '{"field":"labels","operator":"contains","value":"ready-for-coding"}';
    expect(io.out).toContain(`  filter: {"all":[${predicate}]}\n`);
    expect(io.out).toContain(`2 item(s) polled, pushdown ${predicate}`);
    expect(io.out).toContain('labels contains "ready-for-coding": true');
    expect(io.out).not.toContain('"use"');
  });

  it('fails for unknown workflows, missing config dir and source errors', async () => {
    const { tmp, deps } = await setup();
    let io = await run(['workflow', 'dry-run', 'nope', '--config-dir', tmp.dir], deps);
    expect(io.code).toBe(1);
    expect(io.err).toContain("unknown workflow 'nope'");
    io = await run(['workflow', 'dry-run', 'coder'], deps);
    expect(io.code).toBe(2);
    expect(io.err).toContain('no running instance');
    io = await run(['workflow', 'dry-run', 'coder', '--local'], deps);
    expect(io.code).toBe(2);
    // --local never asks the API.
    let asked = false;
    io = await run(['workflow', 'dry-run', 'coder', '--local', '--config-dir', tmp.dir], {
      ...deps,
      apiFetch: async () => {
        asked = true;
        throw new Error('must not be called');
      },
    });
    expect(io.code).toBe(0);
    expect(asked).toBe(false);
    // Missing private key → source error, reported in the output.
    io = await run(['workflow', 'dry-run', 'coder', '--config-dir', tmp.dir], { ...deps, env: {} });
    expect(io.code).toBe(1);
    expect(io.out).toContain('SOURCE ERROR');
    expect(io.out).not.toContain('BEGIN');
  });
});
