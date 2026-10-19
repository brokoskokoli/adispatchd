import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, startAppEnv, type AppEnv } from './testing/helpers.js';

const ITEM_URL = `https://github.com/${REPO_A}/issues/7`;

let env: AppEnv;
let release: string;

beforeAll(async () => {
  env = await startAppEnv(
    {
      allowedHosts: ['adispatchd.example.com', 'proxy.example.com:8443'],
      configExtra: [
        'notifications:',
        '  channels:',
        '    - id: ops',
        '      type: webhook',
        '      url: https://hooks.example.test/T0/LITERAL-SECRET-URL',
        '',
      ].join('\n'),
      app: {
        notificationFetch: async () => new Response(null, { status: 204 }),
      },
    },
    (e) => {
      release = path.join(e.marks, 'release');
      const ok = e.script(
        'ok.sh',
        `echo "hello stdout"; echo "oops" >&2; echo '@@ADISPATCH_EVENT {"type":"status","message":"working"}'; printf '{"schema_version":1,"result":"success","message":"done %s"}' "$1" > "$ADISPATCH_RESULT_FILE"`,
      );
      const slow = e.script('slow.sh', `while [ ! -f "${release}" ]; do sleep 0.05; done`);
      const crash = e.script('crash.sh', 'exit 3');
      const wf = (id: string, trigger: string, command: string, extra = '') =>
        writeFileSync(
          path.join(e.configDir, 'workflows', `${id}.yaml`),
          `id: ${id}\nname: ${id} workflow\ntrigger: ${trigger}\nexecute:\n  type: shell\n  command: ${command}\n  cancel_grace: 300ms\n${extra}`,
        );
      wf(
        'coder',
        '{ type: source, source: repo_a }',
        ok,
        [
          '  args: ["{item.number}"]',
          'identity: coder',
          'enabled: false # only manual starts in these tests',
          'filter: { field: labels, operator: contains, value: ready }',
          'on_start:',
          '  - type: source.update',
          '    labels: { add: [coding], remove: [ready] }',
          'on_success:',
          '  - type: source.comment',
          "    message: 'Done: {result.message}'",
          '',
        ].join('\n'),
      );
      wf('slow', '{ type: source, source: repo_a }', slow, 'enabled: false\n');
      wf('crasher', '{ type: manual }', crash, 'retry: { max_technical_failures: 1 }\n');
      wf(
        'deploy',
        '{ type: manual }',
        ok,
        ['parameters:', '  environment: { type: enum, values: [staging, production], required: true }', ''].join('\n'),
      );
      e.github.createIssue(REPO_A, { number: 7, title: 'Issue seven', labels: ['ready'] });
      e.github.createIssue(REPO_A, { number: 8, title: 'Issue eight', labels: [] });
    },
  );
});

afterAll(async () => {
  if (!existsSync(release)) writeFileSync(release, '');
  await env.cleanup();
});

describe('health, readiness, status', () => {
  it('GET /health, /ready, /api/v1/status', async () => {
    expect((await env.request('GET', '/health')).json.status).toBe('ok');
    const ready = await env.request('GET', '/ready');
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ ready: true, checks: { database: true, recovery: true, scheduler: true } });
    const status = await env.request('GET', '/api/v1/status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      scheduler: { state: 'running', paused: false },
      limits: { maxConcurrent: 4, configuredMaxConcurrent: 4, override: null },
      usage: { activeRuns: 0 },
      server: { host: '127.0.0.1', loopback: true },
    });
    expect(status.json.usage.byWorkflow.coder).toEqual({ active: 0, max: 1 });
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('unknown routes → 404 in the error format', async () => {
    const res = await env.request('GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });
});

describe('CSRF protection', () => {
  it('rejects mutating requests without the CSRF header', async () => {
    const res = await env.app.http.inject({ method: 'POST', url: '/api/v1/scheduler/pause' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_header_missing');
    expect(env.app.controller.status.paused).toBe(false);
  });

  it('rejects foreign origins, cross-site fetches, non-JSON bodies and preflights', async () => {
    const foreign = await env.request('POST', '/api/v1/scheduler/pause', undefined, { origin: 'https://evil.example', host: '127.0.0.1:8787' });
    expect(foreign.status).toBe(403);
    expect(foreign.json.error.code).toBe('origin_not_allowed');
    const crossSite = await env.request('POST', '/api/v1/scheduler/pause', undefined, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    const text = await env.app.http.inject({
      method: 'POST',
      url: '/api/v1/scheduler/pause',
      headers: { 'x-adispatch-request': '1', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(text.statusCode).toBe(415);
    const preflight = await env.app.http.inject({ method: 'OPTIONS', url: '/api/v1/scheduler/pause', headers: { origin: 'https://evil.example' } });
    expect(preflight.statusCode).toBe(403); // foreign origin rejected before anything else
    const localPreflight = await env.app.http.inject({ method: 'OPTIONS', url: '/api/v1/scheduler/pause' });
    expect(localPreflight.statusCode).toBe(405);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const sameOrigin = await env.request('POST', '/api/v1/scheduler/pause', undefined, { origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' });
    expect(sameOrigin.status).toBe(200);
    await env.request('POST', '/api/v1/scheduler/resume');
    expect(env.app.controller.status.paused).toBe(false);
  });
});

describe('DNS-rebinding protection (Host / Origin allowlist)', () => {
  it('rejects foreign Host headers for every method, incl. GET, SSE and unknown routes', async () => {
    const evil = { host: 'attacker.example:8787' };
    for (const [method, url] of [
      ['GET', '/api/v1/config/files'],
      ['GET', '/api/v1/status'],
      ['GET', '/health'],
      ['GET', '/api/v1/events'],
      ['GET', '/nope'],
      ['POST', '/api/v1/scheduler/pause'],
    ] as const) {
      const res = await env.request(method, url, undefined, evil);
      expect(res.status, `${method} ${url}`).toBe(421);
      expect(res.json.error.code).toBe('host_not_allowed');
    }
    expect(env.app.controller.status.paused).toBe(false);
    // Rebinding attack: Host and Origin both point to the attacker's name.
    const both = await env.request('POST', '/api/v1/scheduler/pause', undefined, { host: 'attacker.example:8787', origin: 'http://attacker.example:8787' });
    expect(both.status).toBe(421);
    expect(env.app.controller.status.paused).toBe(false);
  });

  it('accepts loopback names on any port and configured allowed_hosts', async () => {
    for (const host of ['localhost', '127.0.0.1:8787', '[::1]:9999', 'LOCALHOST:1234', 'adispatchd.example.com', 'adispatchd.example.com:443', 'proxy.example.com:8443']) {
      expect((await env.request('GET', '/health', undefined, { host })).status, host).toBe(200);
    }
    expect((await env.request('GET', '/health', undefined, { host: 'proxy.example.com:8080' })).status).toBe(421);
    expect((await env.request('GET', '/health', undefined, { host: 'adispatchd.example.com.attacker.example' })).status).toBe(421);
  });

  it('requires the Origin to name an allowed host as well', async () => {
    const res = await env.request('GET', '/api/v1/status', undefined, { host: 'localhost', origin: 'https://attacker.example' });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('origin_not_allowed');
    const viaProxy = await env.request('POST', '/api/v1/scheduler/resume', undefined, { host: 'adispatchd.example.com', origin: 'https://adispatchd.example.com' });
    expect(viaProxy.status).toBe(200);
    expect((await env.request('GET', '/health', undefined, { origin: 'null' })).status).toBe(403);
    // Same-origin exactly (host AND port): another local origin (e.g. a dev server on :3000) is refused.
    const otherPort = await env.request('POST', '/api/v1/scheduler/pause', undefined, { host: '127.0.0.1:8787', origin: 'http://localhost:3000' });
    expect(otherPort.status).toBe(403);
    expect((await env.request('GET', '/api/v1/status', undefined, { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:3000' })).status).toBe(403);
    expect((await env.request('GET', '/api/v1/status', undefined, { host: 'localhost:8787', origin: 'http://localhost:8787' })).status).toBe(200);
    expect(env.app.controller.status.paused).toBe(false);
  });
});

describe('scheduler control', () => {
  it('pause / resume / global runtime limit', async () => {
    expect((await env.request('POST', '/api/v1/scheduler/pause', {})).json.scheduler).toMatchObject({ paused: true, state: 'paused' });
    expect((await env.request('POST', '/api/v1/scheduler/resume')).json.scheduler.paused).toBe(false);
    const set = await env.request('PATCH', '/api/v1/scheduler/runtime', { maxConcurrent: 2 });
    expect(set.json.limits).toMatchObject({ maxConcurrent: 2, override: 2 });
    expect((await env.request('PATCH', '/api/v1/scheduler/runtime', { maxConcurrent: 0 })).status).toBe(400);
    expect((await env.request('PATCH', '/api/v1/scheduler/runtime', { maxConcurrent: null })).json.limits.override).toBeNull();
    expect((await env.request('POST', '/api/v1/scheduler/pause', { bogus: 1 })).status).toBe(400);
    // Invalid shutdown bodies are rejected before anything happens.
    const drain = await env.request('POST', '/api/v1/shutdown/drain', { now: true });
    expect(drain.status).toBe(400);
    expect((await env.request('POST', '/api/v1/shutdown/cancel-all', { reason: 42 })).status).toBe(400);
    expect(env.app.controller.status.draining).toBe(false);
  });
});

describe('workflows', () => {
  it('lists workflows, shows details and applies / resets runtime overrides', async () => {
    const list = await env.request('GET', '/api/v1/workflows');
    expect(list.json.workflows.map((w: { id: string }) => w.id)).toEqual(['coder', 'crasher', 'deploy', 'slow']);
    const deploy = list.json.workflows.find((w: { id: string }) => w.id === 'deploy');
    expect(deploy.parameters.environment).toMatchObject({ type: 'enum', values: ['staging', 'production'], required: true });
    const detail = await env.request('GET', '/api/v1/workflows/coder');
    expect(detail.json).toMatchObject({ id: 'coder', name: 'coder workflow', trigger: { type: 'source', source: 'repo_a' } });
    expect(detail.json.filter).toBeTruthy();
    expect((await env.request('GET', '/api/v1/workflows/nope')).status).toBe(404);

    const patched = await env.request('PATCH', '/api/v1/workflows/slow/runtime', { enabled: false, priority: 5, maxConcurrent: 3 });
    expect(patched.json).toMatchObject({ enabled: false, priority: 5, maxConcurrent: 3, overrides: { enabled: false, priority: 5, maxConcurrent: 3 } });
    const reset = await env.request('PATCH', '/api/v1/workflows/slow/runtime', { priority: null, maxConcurrent: null });
    expect(reset.json).toMatchObject({ enabled: false, priority: 0, maxConcurrent: 1, overrides: { enabled: false } });
    expect((await env.request('PATCH', '/api/v1/workflows/slow/runtime', { enabled: 'yes' })).status).toBe(400);
    expect((await env.request('PATCH', '/api/v1/workflows/nope/runtime', { enabled: true })).status).toBe(404);
    await env.request('PATCH', '/api/v1/workflows/slow/runtime', { enabled: null });
  });

  it('dry-run', async () => {
    const res = await env.request('POST', '/api/v1/workflows/coder/dry-run');
    expect(res.status).toBe(200);
    expect(res.json.workflowId).toBe('coder');
    expect(res.json.candidates.map((c: { itemKey: string }) => c.itemKey)).toContain('repo_a:7');
    expect((await env.request('POST', '/api/v1/workflows/nope/dry-run')).status).toBe(404);
  });
});

describe('runs', () => {
  let runId: string;

  it('manual start → 202, run details with all fields, logs and events', async () => {
    const res = await env.request('POST', '/api/v1/workflows/coder/start', { item: ITEM_URL });
    expect(res.status).toBe(202);
    runId = res.json.run.id;
    expect(res.json.run).toMatchObject({ workflowId: 'coder', triggerType: 'manual', sourceUrl: ITEM_URL });
    const run = await env.waitTerminal(runId);
    expect(run.status).toBe('completed');

    const detail = (await env.request('GET', `/api/v1/runs/${runId}`)).json;
    expect(detail).toMatchObject({
      id: runId,
      workflowId: 'coder',
      workflowName: 'coder workflow',
      identity: 'coder',
      triggerType: 'manual',
      status: 'completed',
      outcome: 'success',
      businessResult: 'success',
      exitCode: 0,
      sourceUrl: ITEM_URL,
      resultMessage: 'done 7',
      statusMessage: 'working',
      lifecycleStatus: 'succeeded',
      lifecycleFailed: false,
    });
    expect(detail.command).toMatchObject({ args: ['7'] });
    expect(detail.workingDirectory).toContain(path.join(env.workspaces, 'coder', runId));
    expect(detail.input).toMatchObject({ run: { id: runId } });
    expect(detail.result).toMatchObject({ result: 'success', message: 'done 7' });
    expect(detail.actions.map((a: { hook: string; status: string }) => [a.hook, a.status])).toEqual([
      ['on_start', 'succeeded'],
      ['on_success', 'succeeded'],
    ]);
    expect(detail.actions[0].attemptsDetail).toHaveLength(1);
    expect(detail.events.some((e: { type: string }) => e.type === 'run.status')).toBe(true);
    expect(detail.logs.stdout.size).toBeGreaterThan(0);
    expect(JSON.stringify(detail)).not.toContain('BEGIN PRIVATE KEY');
    expect(env.github.comments(REPO_A, 7).some((c) => c.body.includes('Done: done 7'))).toBe(true);

    const logs = await env.request('GET', `/api/v1/runs/${runId}/logs?stream=stdout&offset=0&limit=6`);
    expect(logs.json).toMatchObject({ stream: 'stdout', offset: 0, length: 6, data: 'hello ', eof: false });
    const next = await env.request('GET', `/api/v1/runs/${runId}/logs?stream=stdout&offset=${logs.json.nextOffset}`);
    expect(next.json.data.startsWith('stdout\n')).toBe(true);
    const stderr = await env.request('GET', `/api/v1/runs/${runId}/logs?stream=stderr&tail=100`);
    expect(stderr.json.data).toBe('oops\n');
    expect((await env.request('GET', `/api/v1/runs/${runId}/logs?stream=other`)).status).toBe(400);

    const events = await env.request('GET', `/api/v1/runs/${runId}/events?after=0&limit=2`);
    expect(events.json.events).toHaveLength(2);
    expect(events.json.hasMore).toBe(true);
  });

  it('lists runs with filters and paging', async () => {
    const all = await env.request('GET', '/api/v1/runs?workflow=coder&limit=10');
    expect(all.json.total).toBeGreaterThanOrEqual(1);
    expect(all.json.runs[0]).toMatchObject({ workflowId: 'coder' });
    expect((await env.request('GET', '/api/v1/runs?status=completed&trigger=manual')).json.runs.length).toBeGreaterThanOrEqual(1);
    expect((await env.request('GET', '/api/v1/runs?active=true&workflow=coder')).json.total).toBe(0);
    expect((await env.request('GET', '/api/v1/runs?status=bogus')).status).toBe(400);
    expect((await env.request('GET', '/api/v1/runs?limit=0')).status).toBe(400);
    expect((await env.request('GET', '/api/v1/runs/run-20260101T000000000Z-00000000')).status).toBe(404);
  });

  it('start errors: missing item, invalid parameters, unknown workflow, lock conflict; cancel 202/409', async () => {
    expect((await env.request('POST', '/api/v1/workflows/coder/start', {})).json.error.code).toBe('manual_item_required');
    const badParams = await env.request('POST', '/api/v1/workflows/deploy/start', { parameters: { environment: 'moon' } });
    expect(badParams.status).toBe(400);
    expect(badParams.json.error.code).toBe('invalid_parameters');
    expect((await env.request('POST', '/api/v1/workflows/nope/start', {})).status).toBe(404);
    const unknownItem = await env.request('POST', '/api/v1/workflows/coder/start', { item: `https://github.com/${REPO_A}/issues/999` });
    expect(unknownItem.status).toBe(404);

    const first = await env.request('POST', '/api/v1/workflows/slow/start', { item: '8' });
    expect(first.status).toBe(202);
    const id = first.json.run.id;
    await env.waitRun(id, (r) => r.status === 'running');
    const conflict = await env.request('POST', '/api/v1/workflows/slow/start', { item: '8' });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toMatchObject({ code: 'lock_conflict', details: { holderRunId: id } });

    const cancel = await env.request('POST', `/api/v1/runs/${id}/cancel`, { reason: 'test' });
    expect(cancel.status).toBe(202);
    expect(cancel.json.status).toBe('cancelling');
    const done = await env.waitTerminal(id);
    expect(done.status).toBe('cancelled');
    const again = await env.request('POST', `/api/v1/runs/${id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('run_not_active');
  });

  it('recovery retry: 409 for normal runs, 202 for recovery_pending', async () => {
    expect((await env.request('POST', `/api/v1/runs/${runId}/recovery/retry`, {})).status).toBe(409);
    const repos = env.app.persistence;
    const snapshot = env.app.config.snapshotWorkflow('crasher');
    const run = repos.runs.reserve({ workflowId: 'crasher', triggerType: 'manual', configSnapshot: snapshot });
    repos.runs.transition(run.id, 'starting');
    repos.runs.transition(run.id, 'running', { update: { pid: 999_999 } });
    repos.runs.transition(run.id, 'recovery_pending');
    const res = await env.request('POST', `/api/v1/runs/${run.id}/recovery/retry`, { assumeGone: true });
    expect(res.status).toBe(202);
    expect((await env.waitTerminal(run.id)).status).toBe('crashed');
  });
});

describe('blocks and failed actions', () => {
  it('lists blocks and clears them', async () => {
    const start = await env.request('POST', '/api/v1/workflows/crasher/start', {});
    await env.waitTerminal(start.json.run.id);
    const blocks = await env.request('GET', '/api/v1/blocks');
    const block = blocks.json.blocks.find((b: { workflowId: string }) => b.workflowId === 'crasher');
    expect(block).toMatchObject({ active: true, itemKey: null, workflowName: 'crasher workflow' });
    expect(block.affectedRunIds).toContain(start.json.run.id);
    const cleared = await env.request('POST', `/api/v1/blocks/${block.id}/clear`, { clearedBy: 'tester' });
    expect(cleared.json.block).toMatchObject({ active: false, clearedBy: 'tester' });
    expect((await env.request('GET', '/api/v1/blocks')).json.blocks.some((b: { id: number }) => b.id === block.id)).toBe(false);
    expect((await env.request('POST', '/api/v1/blocks/99999/clear')).status).toBe(404);
    expect((await env.request('POST', '/api/v1/blocks/abc/clear')).status).toBe(400);
  });

  it('lists failed actions, retries (202) and rejects invalid retries (409/404)', async () => {
    env.github.failNext({ method: 'POST', path: /\/comments$/ }, { status: 422, body: { message: 'nope' } });
    env.github.setLabels(REPO_A, 7, ['ready']);
    const start = await env.request('POST', '/api/v1/workflows/coder/start', { item: '7' });
    const run = await env.waitTerminal(start.json.run.id);
    expect(run.lifecycleStatus).toBe('failed');
    const failed = await env.request('GET', '/api/v1/actions/failed');
    const action = failed.json.actions.find((a: { runId: string }) => a.runId === run.id);
    expect(action).toMatchObject({ hook: 'on_success', type: 'source.comment', status: 'failed', busy: false });
    expect(action.run).toMatchObject({ id: run.id, lifecycleFailed: true, outcome: 'success' });
    expect(action.attemptsDetail).toHaveLength(1);

    const retry = await env.request('POST', `/api/v1/actions/${action.id}/retry`);
    expect(retry.status).toBe(202);
    await env.waitRun(run.id, (r) => r.lifecycleStatus === 'succeeded');
    const again = await env.request('POST', `/api/v1/actions/${action.id}/retry`);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('lifecycle_not_retryable');
    expect((await env.request('POST', `/api/v1/actions/${action.id}/skip`)).status).toBe(400);
    expect((await env.request('POST', '/api/v1/actions/99999/retry')).status).toBe(404);
  });
});

describe('configuration and notifications', () => {
  it('shows the redacted config and YAML files, validates and reloads', async () => {
    const cfg = await env.request('GET', '/api/v1/config');
    expect(cfg.json.config.global.notifications.channels[0].url).toBe('[REDACTED]');
    expect(JSON.stringify(cfg.json)).not.toContain('LITERAL-SECRET-URL');
    const files = await env.request('GET', '/api/v1/config/files');
    const config = files.json.files.find((f: { file: string }) => f.file === 'config.yaml');
    expect(config.content).toContain('[REDACTED]');
    expect(config.content).not.toContain('LITERAL-SECRET-URL');
    expect(files.json.files.map((f: { file: string }) => f.file)).toContain('workflows/coder.yaml');
    // Named filters (WI-15): listed in the config (expanded) and shown as files.
    expect(cfg.json.config.filters).toEqual({});
    mkdirSync(path.join(env.configDir, 'filters'), { recursive: true });
    writeFileSync(path.join(env.configDir, 'filters', 'spare.yaml'), 'id: spare\nfilter: { field: number, operator: equals, value: 1 }\n');
    expect((await env.request('GET', '/api/v1/config/files')).json.files.map((f: { file: string }) => f.file)).toContain('filters/spare.yaml');
    rmSync(path.join(env.configDir, 'filters'), { recursive: true });
    expect((await env.request('POST', '/api/v1/config/validate')).json.ok).toBe(true);

    // A secret added on disk without reload is not known to any redactor – the structural redaction still masks it.
    const configFile = path.join(env.configDir, 'config.yaml');
    const { readFileSync } = await import('node:fs');
    const original = readFileSync(configFile, 'utf8');
    writeFileSync(
      configFile,
      original.replace(
        'LITERAL-SECRET-URL',
        'LITERAL-SECRET-URL\n      headers_env: { Authorization: HOOK_AUTH_ENV }\n    - id: fresh\n      type: webhook\n      url: https://hooks.example.test/T1/NEW-UNLOADED-SECRET # see https://docs.example.test/path?token=COMMENT-SECRET',
      ) + 'api_token: plain-token-value\n',
    );
    const wfFile = path.join(env.configDir, 'workflows', 'notify.yaml');
    writeFileSync(
      wfFile,
      'id: notify\nname: notify\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: /bin/true\n  env:\n    SLACK_WEBHOOK: https://hooks.slack.com/services/T/B/x\n    PLAIN: https://example.test\n',
    );
    try {
      const fresh = (await env.request('GET', '/api/v1/config/files')).json.files.find((f: { file: string }) => f.file === 'config.yaml');
      expect(fresh.content).not.toContain('NEW-UNLOADED-SECRET');
      expect(fresh.content).not.toContain('COMMENT-SECRET');
      expect(fresh.content).not.toContain('plain-token-value');
      expect(fresh.content).not.toContain('HOOK_AUTH_ENV');
      expect(fresh.content).toContain('id: fresh');
      expect(fresh.content).toContain('https://docs.example.test/[REDACTED]');
      const notify = (await env.request('GET', '/api/v1/config/files')).json.files.find((f: { file: string }) => f.file === 'workflows/notify.yaml');
      expect(notify.content).toContain('SLACK_WEBHOOK: https://hooks.slack.com/[REDACTED]');
      expect(notify.content).not.toContain('services/T/B/x');
      expect(notify.content).toContain('PLAIN: https://example.test');
      writeFileSync(configFile, 'server: { host: [unclosed\nurl: https://hooks.example.test/RAW-SECRET\n');
      const broken = (await env.request('GET', '/api/v1/config/files')).json.files.find((f: { file: string }) => f.file === 'config.yaml');
      expect(broken.content).toBeNull();
      expect(broken.error).toMatch(/cannot be displayed/);
      expect(JSON.stringify(broken)).not.toContain('RAW-SECRET');
    } finally {
      writeFileSync(configFile, original);
      (await import('node:fs')).rmSync(wfFile, { force: true });
    }

    const version = env.app.config.current.version;
    const reload = await env.request('POST', '/api/v1/config/reload');
    expect(reload.json).toMatchObject({ ok: true, version: version + 1, changed: false });

    const file = path.join(env.configDir, 'workflows', 'broken.yaml');
    writeFileSync(file, 'id: broken\ntrigger: { type: nope }\n');
    try {
      expect((await env.request('POST', '/api/v1/config/validate')).json.ok).toBe(false);
      const bad = await env.request('POST', '/api/v1/config/reload');
      expect(bad.status).toBe(422);
      expect(bad.json.error.code).toBe('config_invalid');
      expect(bad.json.error.details.errors.length).toBeGreaterThan(0);
      expect(env.app.config.current.version).toBe(version + 1);
    } finally {
      writeFileSync(file, '');
      const { rmSync } = await import('node:fs');
      rmSync(file);
    }
  });

  it('lists notifications with deliveries (block notification from the crasher run)', async () => {
    await new Promise((r) => setTimeout(r, 100));
    await env.app.notifications.whenIdle();
    const res = await env.request('GET', '/api/v1/notifications');
    const n = res.json.notifications.find((x: { eventType: string }) => x.eventType === 'retry_block_created');
    expect(n).toBeTruthy();
    expect(n.deliveries).toMatchObject([{ channelId: 'ops', state: 'delivered' }]);
    expect((await env.request('POST', `/api/v1/notifications/${n.id}/retry`)).json.requeued).toBe(0);
    expect((await env.request('POST', '/api/v1/notifications/99999/retry')).status).toBe(404);
    expect((await env.request('GET', '/api/v1/notifications?state=nope')).status).toBe(400);
  });

  it('views endpoints: 404 for unknown views', async () => {
    expect((await env.request('GET', '/api/v1/views')).json.views).toEqual([]);
    expect((await env.request('GET', '/api/v1/views/nope')).status).toBe(404);
    expect((await env.request('GET', '/api/v1/views/nope/items')).status).toBe(404);
  });
});
