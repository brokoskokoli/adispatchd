/**
 * End-to-end (WI-35): the complete app with the artifacts source. A manual
 * workflow produces a file and a folder artifact (and a warning for a missing
 * path); an automatic workflow on the artifacts source processes the file
 * exactly once (`consumed_by`) and produces a child artifact; a manual start on
 * the folder artifact stages it read-only below `inputs/`; deleting an artifact
 * that an active run uses is refused (409); downloads, SSE, retention.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSse, startAppEnv, type AppEnv, type SseClient } from './api/testing/helpers.js';
import type { RunRecord } from './persistence/index.js';

let env: AppEnv;
let sse: SseClient;
let url: string;

const RESULT = `printf '{"schema_version":1,"result":"success","message":"ok"}' > "$ADISPATCH_RESULT_FILE"`;

beforeAll(async () => {
  env = await startAppEnv({}, (e) => {
    writeFileSync(
      path.join(e.configDir, 'sources.yaml'),
      ['sources:', '  artifacts: { type: artifacts }', '  repo_a: { type: github, owner: example, repository: a, identity: maintainer }', ''].join('\n'),
    );
    const make = e.script(
      'make.sh',
      ['mkdir -p out/site/sub', "printf 'hello artifacts' > out/report.txt", "printf '<h1>site</h1>' > out/site/index.html", "printf 'a{}' > out/site/sub/a.css", RESULT].join('\n'),
    );
    // Reads the file input, proves it is read-only and writes a summary artifact.
    const summarize = e.script(
      'summarize.sh',
      [
        `echo run >> ${e.marks}/summarize.log`,
        `[ "$(cat "$INPUT")" = "hello artifacts" ] || { echo "bad input: $INPUT" >&2; exit 2; }`,
        `if [ "$(id -u)" != 0 ] && (echo changed > "$INPUT") 2>/dev/null; then echo "input is writable" >&2; exit 3; fi`,
        `[ "$(stat -c %a "$INPUT" 2>/dev/null || stat -f %Lp "$INPUT")" = 444 ] || { echo "input is not 0444" >&2; exit 4; }`,
        `grep -q '"path"' "$ADISPATCH_CONTEXT_FILE" || exit 5`,
        'mkdir -p out',
        `tr a-z A-Z < "$INPUT" > out/summary.txt`,
        RESULT,
      ].join('\n'),
    );
    // Manual only (the filter never matches): waits for a release file so that the test can try to delete the input.
    const publish = e.script(
      'publish.sh',
      [
        `echo "$INPUT" > ${e.marks}/publish.input`,
        `[ -f "$INPUT/index.html" ] && [ -f "$INPUT/sub/a.css" ] || { echo missing files >&2; exit 2; }`,
        `if [ "$(id -u)" != 0 ] && (echo x > "$INPUT/new.txt") 2>/dev/null; then echo writable >&2; exit 3; fi`,
        `touch ${e.marks}/publish.started`,
        `while [ ! -f ${e.marks}/release ]; do sleep 0.05; done`,
        RESULT,
      ].join('\n'),
    );
    const wf = (name: string, yaml: string): void => writeFileSync(path.join(e.configDir, 'workflows', `${name}.yaml`), yaml);
    const fail = `printf '{"schema_version":1,"result":"failure","message":"nope"}' > "$ADISPATCH_RESULT_FILE"`;
    const shell = (script: string): string => ['execute:', '  type: shell', `  command: ${script}`].join('\n');
    // required artifact that the worker does not write → technical failure
    wf('needs', ['id: needs', 'trigger: { type: manual }', shell(e.script('needs.sh', RESULT)), '  artifacts:', '    - { name: Must, type: t, path: out/must.txt, required: true }', 'on_crash:', `  - { type: shell, command: ${e.script('on-crash.sh', `echo crash >> ${e.marks}/needs.log`)} }`, ''].join('\n'));
    // business failure still stores the artifact; a crash stores nothing
    wf('failing', ['id: failing', 'trigger: { type: manual }', shell(e.script('failing.sh', `mkdir -p out; echo log > out/log.txt\n${fail}`)), '  artifacts:', '    - { name: Log, type: log, path: out/log.txt }', ''].join('\n'));
    wf('crashing', ['id: crashing', 'trigger: { type: manual }', shell(e.script('crashing.sh', 'mkdir -p out; echo log > out/log.txt; exit 3')), '  artifacts:', '    - { name: Log, type: crashlog, path: out/log.txt }', ''].join('\n'));
    // the completion hook runs before the artifacts are collected
    wf(
      'hooked',
      ['id: hooked', 'trigger: { type: manual }', shell(e.script('hooked.sh', `mkdir -p out; ${RESULT}`)), '  artifacts:', '    - { name: Late, type: late, path: out/late.txt }', 'on_success:', `  - { type: shell, command: ${e.script('late.sh', 'echo from-hook > out/late.txt')} }`, ''].join('\n'),
    );
    // size limit
    wf('tiny', ['id: tiny', 'trigger: { type: manual }', shell(e.script('tiny.sh', `mkdir -p out; head -c 100 /dev/zero > out/big.bin; ${RESULT}`)), '  artifacts_max_size: 50B', '  artifacts:', '    - { name: Big, type: big, path: out/big.bin }', ''].join('\n'));
    // processes an artifact but fails: no consumed_by
    wf('strict', ['id: strict', 'trigger: { type: source, source: artifacts }', 'filter: { field: type, operator: equals, value: never }', shell(e.script('strict.sh', fail)), ''].join('\n'));
    wf(
      'make',
      [
        'id: make',
        'trigger: { type: manual }',
        'execute:',
        '  type: shell',
        `  command: ${make}`,
        '  artifacts:',
        '    - { name: "Report {run.id}", type: report, path: out/report.txt }',
        '    - { name: Site, type: site, path: out/site }',
        '    - { name: Optional, type: misc, path: out/optional.txt }',
        '',
      ].join('\n'),
    );
    wf(
      'summarize',
      [
        'id: summarize',
        'trigger: { type: source, source: artifacts }',
        'filter:',
        '  all:',
        '    - { field: type, operator: equals, value: report }',
        '    - not: { field: consumed_by, operator: contains, value: summarize }',
        'execute:',
        '  type: shell',
        `  command: ${summarize}`,
        '  env: { INPUT: "{item.path}" }',
        '  artifacts:',
        '    - { name: "Summary of {item.name}", type: summary, path: out/summary.txt }',
        '',
      ].join('\n'),
    );
    wf(
      'publish',
      [
        'id: publish',
        'trigger: { type: source, source: artifacts }',
        'filter: { field: type, operator: equals, value: never }',
        'execute:',
        '  type: shell',
        `  command: ${publish}`,
        '  env: { INPUT: "{item.path}" }',
        '',
      ].join('\n'),
    );
  });
  url = (await env.app.url) as string;
  sse = await connectSse(`${url}/api/v1/events`);
});

afterAll(async () => {
  sse?.close();
  await env?.cleanup();
});

const runsOf = (workflow: string): RunRecord[] => env.app.persistence.runs.list({ workflowId: workflow }).runs;

describe('artifacts end-to-end (WI-35)', () => {
  let reportId = '';
  let siteId = '';
  let makeRunId = '';

  it('collects a file and a folder artifact after the run; a missing path is a warning, not a failure', async () => {
    const start = await env.request('POST', '/api/v1/workflows/make/start', {});
    expect(start.status).toBe(202);
    const run = await env.waitTerminal(start.json.run.id);
    makeRunId = run.id;
    expect(run).toMatchObject({ status: 'completed', businessResult: 'success' });

    const list = await env.request('GET', '/api/v1/artifacts');
    expect(list.status).toBe(200);
    expect(list.json.sourceId).toBe('artifacts');
    expect(list.json.total).toBe(2);
    expect(list.json.facets).toEqual({ types: ['report', 'site'], workflows: ['make'] });
    const report = list.json.artifacts.find((a: { type: string }) => a.type === 'report');
    const site = list.json.artifacts.find((a: { type: string }) => a.type === 'site');
    reportId = report.id;
    siteId = site.id;
    expect(report).toMatchObject({ name: `Report ${run.id}`, kind: 'file', fileName: 'report.txt', size: 15, fileCount: 1, workflow: 'make', runId: run.id, parent: null, consumedBy: [] });
    expect(site).toMatchObject({ name: 'Site', kind: 'folder', fileName: 'site', size: 16, fileCount: 2 });

    // The workspace was cleaned up, the artifacts are not.
    expect(run.workspacePath && existsSync(run.workspacePath)).toBe(false);
    expect(readFileSync(path.join(env.dataDir, 'artifacts', reportId, 'content'), 'utf8')).toBe('hello artifacts');

    const detail = await env.request('GET', `/api/v1/runs/${run.id}`);
    expect(detail.json.artifacts.created.map((a: { id: string }) => a.id).sort()).toEqual([reportId, siteId].sort());
    expect(detail.json.artifacts.report.warnings).toMatchObject([{ index: 2, path: 'out/optional.txt', reason: 'missing' }]);
    expect(detail.json.artifacts.input).toBeNull();

    const created = sse.messages.filter((m) => m.event === 'artifact.created').map((m) => m.data.payload.id);
    expect(created.sort()).toEqual([reportId, siteId].sort());
  });

  it('starts the automatic workflow exactly once per artifact; consumed_by is set when the run ends successfully', async () => {
    await env.app.scheduler.planOnce();
    const first = runsOf('summarize');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ triggerType: 'source', sourceItemKey: `artifacts:${reportId}`, sourceId: 'artifacts' });
    const run = await env.waitTerminal(first[0]!.id);
    expect(run, run.finalReason ?? '').toMatchObject({ status: 'completed', businessResult: 'success' });

    const detail = await env.request('GET', `/api/v1/artifacts/${reportId}`);
    expect(detail.json.artifact.consumedBy).toEqual(['summarize']);
    expect(detail.json.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect(detail.json.workflows.map((w: { id: string }) => w.id).sort()).toEqual(['publish', 'strict', 'summarize']);
    expect(detail.json.children).toHaveLength(1);

    // More planning steps start nothing: the filter excludes the artifact, and the summary is of type "summary".
    await env.app.scheduler.planOnce();
    await env.app.scheduler.planOnce();
    expect(runsOf('summarize')).toHaveLength(1);
    expect(readFileSync(path.join(env.marks, 'summarize.log'), 'utf8').trim().split('\n')).toHaveLength(1);

    // The summary artifact knows its parent and name from the item.
    const summaries = await env.request('GET', '/api/v1/artifacts?type=summary');
    expect(summaries.json.total).toBe(1);
    const summary = summaries.json.artifacts[0];
    expect(summary).toMatchObject({ name: `Summary of Report ${makeRunId}`, parent: reportId, workflow: 'summarize', runId: run.id });
    expect(readFileSync(path.join(env.dataDir, 'artifacts', summary.id, 'content'), 'utf8')).toBe('HELLO ARTIFACTS');
    // The run page shows the input artifact and what the run produced.
    const runDetail = await env.request('GET', `/api/v1/runs/${run.id}`);
    expect(runDetail.json.artifacts.input).toMatchObject({ id: reportId, exists: true });
    expect(runDetail.json.artifacts.created.map((a: { id: string }) => a.id)).toEqual([summary.id]);
    // The workspace with the read-only input was removed by the cleanup.
    expect(existsSync(run.workspacePath!)).toBe(false);
  });

  it('starts a workflow manually on a folder artifact; deleting is refused (409) while the run uses it', async () => {
    const bad = await env.request('POST', `/api/v1/artifacts/${siteId}/start`, { workflow: 'make' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('workflow_not_applicable');
    expect((await env.request('POST', `/api/v1/artifacts/${siteId}/start`, { workflow: 'nope' })).status).toBe(404);
    expect((await env.request('POST', '/api/v1/artifacts/art-20261029T100000000Z-aaaaaaaa/start', { workflow: 'publish' })).status).toBe(404);

    const start = await env.request('POST', `/api/v1/artifacts/${siteId}/start`, { workflow: 'publish' });
    expect(start.status).toBe(202);
    const runId = start.json.run.id;
    for (let i = 0; i < 400 && !existsSync(path.join(env.marks, 'publish.started')); i++) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(path.join(env.marks, 'publish.started'))).toBe(true);
    // The folder is available below inputs/ (read-only, checked by the script).
    expect(readFileSync(path.join(env.marks, 'publish.input'), 'utf8').trim()).toMatch(/\/inputs\/Site$/);

    const refused = await env.request('DELETE', `/api/v1/artifacts/${siteId}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: 'artifact_in_use', details: { runIds: [runId] } });
    expect(existsSync(path.join(env.dataDir, 'artifacts', siteId, 'content'))).toBe(true);

    writeFileSync(path.join(env.marks, 'release'), '');
    const run = await env.waitTerminal(runId);
    expect(run, run.finalReason ?? '').toMatchObject({ status: 'completed', businessResult: 'success' });
    expect(run.triggerType).toBe('manual');
    // Cleanup removed the workspace although it held read-only directories.
    expect(existsSync(run.workspacePath!)).toBe(false);
    expect((await env.request('GET', `/api/v1/artifacts/${siteId}`)).json.artifact.consumedBy).toEqual(['publish']);
  });

  it('downloads a file, a folder as .zip and single files; refuses traversal', async () => {
    const file = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${reportId}/download` });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('hello artifacts');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="report.txt"/);
    expect(file.headers['content-security-policy']).toBe("default-src 'none'; sandbox");

    const zip = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${siteId}/download` });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['content-disposition']).toMatch(/filename="site.zip"/);
    const zipFile = path.join(env.root, 'site.zip');
    writeFileSync(zipFile, zip.rawPayload);
    const target = path.join(env.root, 'unzipped');
    mkdirSync(target);
    execFileSync('unzip', ['-q', zipFile, '-d', target]);
    expect(readFileSync(path.join(target, 'index.html'), 'utf8')).toBe('<h1>site</h1>');
    expect(readFileSync(path.join(target, 'sub', 'a.css'), 'utf8')).toBe('a{}');

    const single = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${siteId}/files/sub/a.css` });
    expect(single.statusCode).toBe(200);
    expect(single.body).toBe('a{}');
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e%2fx', 'sub%2F..%2Findex.html', 'sub//a.css', 'sub%5C..%5Cindex.html', 'nope.txt', 'sub']) {
      const res = await env.app.http.inject({ method: 'GET', url: `/api/v1/artifacts/${siteId}/files/${bad}` });
      expect([400, 404], bad).toContain(res.statusCode);
      expect(res.body).not.toContain('root:');
    }
    const tree = await env.request('GET', `/api/v1/artifacts/${siteId}`);
    expect(tree.json.files).toEqual([
      { path: 'index.html', size: 13 },
      { path: 'sub/a.css', size: 3 },
    ]);
  });

  it('deletes an artifact (files, row, SSE); the child keeps its parent reference', async () => {
    const del = await env.request('DELETE', `/api/v1/artifacts/${reportId}`);
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ deleted: true, artifact: { id: reportId } });
    expect(existsSync(path.join(env.dataDir, 'artifacts', reportId))).toBe(false);
    expect((await env.request('GET', `/api/v1/artifacts/${reportId}`)).status).toBe(404);
    expect((await env.request('DELETE', `/api/v1/artifacts/${reportId}`)).status).toBe(404);
    await sse.waitFor((m) => m.event === 'artifact.deleted' && m.data.payload.id === reportId);
    const summaries = await env.request('GET', '/api/v1/artifacts?type=summary');
    expect(summaries.json.artifacts[0]).toMatchObject({ parent: reportId });
    const detail = await env.request('GET', `/api/v1/artifacts/${summaries.json.artifacts[0].id}`);
    expect(detail.json.parent).toEqual({ id: reportId, exists: false, name: null });
    // Deleting the artifact does not restart the automatic workflow (it is gone).
    await env.app.scheduler.planOnce();
    expect(runsOf('summarize')).toHaveLength(1);
  });

  it('retention.artifacts deletes old artifacts and leaves the rest', async () => {
    const before = (await env.request('GET', '/api/v1/artifacts')).json.total;
    const res = await env.app.artifacts.expire(new Date(Date.now() + 60_000));
    expect(res.deleted).toBe(before);
    expect((await env.request('GET', '/api/v1/artifacts')).json.total).toBe(0);
    expect(readdirSync(path.join(env.dataDir, 'artifacts'))).toEqual([]);
  });

  describe('collection rules', () => {
    const makeRun = async (workflow: string): Promise<RunRecord> => {
      const start = await env.request('POST', `/api/v1/workflows/${workflow}/start`, {});
      expect(start.status).toBe(202);
      return env.waitTerminal(start.json.run.id);
    };
    const artifactsOf = async (runId: string) => (await env.request('GET', `/api/v1/artifacts?run=${runId}`)).json.artifacts as Array<{ id: string; type: string; size: number }>;

    it('a missing required artifact makes the run a technical failure (crashed, on_crash runs, nothing stored)', async () => {
      const run = await makeRun('needs');
      expect(run.status).toBe('crashed');
      expect(run.finalReason).toMatch(/required artifact "out\/must.txt" is not available: path "out\/must.txt" does not exist/);
      expect(run.error).toMatchObject({ code: 'run_required_artifact_missing' });
      expect(await artifactsOf(run.id)).toEqual([]);
      expect(readFileSync(path.join(env.marks, 'needs.log'), 'utf8')).toBe('crash\n');
      expect(env.app.persistence.blocks.counter('needs', null).consecutive).toBe(1);
    });

    it('stores artifacts of a run with business result failure, but not of a crashed run', async () => {
      const failed = await makeRun('failing');
      expect(failed).toMatchObject({ status: 'completed', businessResult: 'failure' });
      expect((await artifactsOf(failed.id)).map((a) => a.type)).toEqual(['log']);
      const crashed = await makeRun('crashing');
      expect(crashed.status).toBe('crashed');
      expect(await artifactsOf(crashed.id)).toEqual([]);
      const detail = await env.request('GET', `/api/v1/runs/${crashed.id}`);
      expect(detail.json.artifacts).toMatchObject({ created: [], report: null });
    });

    it('collects after the completion hook', async () => {
      const run = await makeRun('hooked');
      expect(run).toMatchObject({ status: 'completed', businessResult: 'success' });
      const [late] = await artifactsOf(run.id);
      expect(late).toMatchObject({ type: 'late', size: 10 });
      expect(readFileSync(path.join(env.dataDir, 'artifacts', late!.id, 'content'), 'utf8')).toBe('from-hook\n');
    });

    it('skips an artifact above artifacts_max_size with a warning in the run', async () => {
      const run = await makeRun('tiny');
      expect(run.status).toBe('completed');
      expect(await artifactsOf(run.id)).toEqual([]);
      const detail = await env.request('GET', `/api/v1/runs/${run.id}`);
      expect(detail.json.artifacts.report.warnings).toMatchObject([{ index: 0, reason: 'size_limit' }]);
      expect(detail.json.artifacts.report.message).toMatch(/0 artifact\(s\) stored.*1 not stored \(size_limit\)/);
    });

    it('does not record consumed_by when the run ends with business result failure', async () => {
      const [anyArtifact] = (await env.request('GET', '/api/v1/artifacts?type=log')).json.artifacts as Array<{ id: string }>;
      const start = await env.request('POST', `/api/v1/artifacts/${anyArtifact!.id}/start`, { workflow: 'strict' });
      const run = await env.waitTerminal(start.json.run.id);
      expect(run).toMatchObject({ status: 'completed', businessResult: 'failure' });
      expect((await env.request('GET', `/api/v1/artifacts/${anyArtifact!.id}`)).json.artifact.consumedBy).toEqual([]);
    });
  });
});
