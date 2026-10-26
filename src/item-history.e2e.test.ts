/**
 * End-to-end (WI-33): item history of one issue against Fake-GitHub with the
 * complete app – several runs (source, crash → retry block, unblock lifecycle
 * run, manual start by a user), hooks incl. `on_result.approved` with label and
 * project field changes (old → new) and a comment, a UI action, timeline
 * paging, retention gap, the GitHub timeline without duplicated own changes
 * (cached, errors isolated) and the view field `history`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_TOKEN_HEADER } from './api/auth.js';
import { authEnvSetup, AUTH_PASSWORDS, FAST_AUTH, PASSWORD_AUTH_CONFIG } from './api/testing/auth.js';
import { REPO_A, startAppEnv, type AppEnv } from './api/testing/helpers.js';
import type { FakeProject } from './sources/github/testing/index.js';

let env: AppEnv;
let project: FakeProject;
let modeFile: string;
const cookies: Record<string, string> = {};
const as = (user: keyof typeof AUTH_PASSWORDS): Record<string, string> => ({ cookie: cookies[user]! });

beforeAll(async () => {
  env = await startAppEnv(
    {
      configExtra: PASSWORD_AUTH_CONFIG,
      app: { ...FAST_AUTH, uiActionLimits: { actionsPerMinute: 1000, readsPerMinute: 1000 } },
      views: {
        board: ['id: board', 'title: Board', 'sources: [repo_a]', 'fields:', '  - { field: title, label: Title }', '  - { field: history, label: History }', 'sort: [{ field: number }]', ''].join('\n'),
      },
    },
    (e) => {
      authEnvSetup(e);
      const ids = path.join(e.configDir, 'identities.yaml');
      writeFileSync(ids, readFileSync(ids, 'utf8').replace('    private_key_env: MAINTAINER_KEY\n', '    private_key_env: MAINTAINER_KEY\n    ui_actions: true\n'));
      writeFileSync(
        path.join(e.configDir, 'sources.yaml'),
        [
          'sources:',
          '  repo_a:',
          '    type: github',
          '    owner: example',
          '    repository: a',
          '    identity: maintainer',
          '    project: { number: 4, fields: { Status: single_select } }',
          '',
        ].join('\n'),
      );
      project = e.github.createProject('example', { number: 4, fields: [{ name: 'Status', dataType: 'SINGLE_SELECT', options: ['Todo', 'Review'] }] });
      modeFile = path.join(e.marks, 'mode');
      writeFileSync(modeFile, 'ok');
      const worker = e.script(
        'worker.sh',
        [
          `if [ "$(cat ${modeFile})" = crash ]; then echo crashing; exit 3; fi`,
          `printf '{"schema_version":1,"result":"success","outcome":"approved","message":"looks good"}' > "$ADISPATCH_RESULT_FILE"`,
        ].join('\n'),
      );
      writeFileSync(
        path.join(e.configDir, 'workflows', 'coder.yaml'),
        [
          'id: coder',
          'name: Coder',
          'trigger: { type: source, source: repo_a }',
          'identity: coder',
          'filter: { all: [ { field: labels, operator: contains, value: ready } ] }',
          'execute:',
          '  type: shell',
          `  command: ${worker}`,
          'retry: { max_technical_failures: 2 }',
          'on_start:',
          '  - type: source.update',
          '    labels: { add: [coding], remove: [ready] }',
          'on_result:',
          '  approved:',
          '    - id: mark-done',
          '      type: source.update',
          '      labels: { add: [done], remove: [coding] }',
          '      project: { Status: Review }',
          '    - type: source.comment',
          "      message: 'Approved in run {run.id}.'",
          'on_crash:',
          '  - type: source.update',
          '    labels: { add: [ready], remove: [coding] }',
          'on_retry_block:',
          '  - type: source.update',
          '    labels: { add: [agent-blocked], remove: [ready] }',
          'on_retry_unblock:',
          '  - type: source.update',
          '    labels: { add: [ready], remove: [agent-blocked] }',
          '',
        ].join('\n'),
      );
    },
  );
  for (const [name, password] of Object.entries(AUTH_PASSWORDS)) {
    const res = await env.request('POST', '/api/v1/auth/login', { name, password });
    expect(res.status, name).toBe(200);
    cookies[name] = String(res.headers['set-cookie']).split(';')[0]!;
  }
}, 30_000);

afterAll(async () => env?.cleanup());

/** Plan once and wait for the next new run of the workflow. */
async function planAndFinish(known: readonly string[]): Promise<string> {
  expect((await env.request('POST', '/api/v1/scheduler/resume', {}, as('olga'))).status).toBe(200);
  const end = Date.now() + 15_000;
  for (;;) {
    const next = env.app.persistence.runs.list({ workflowId: 'coder' }).runs.find((r) => !known.includes(r.id));
    if (next) return (await env.waitTerminal(next.id)).id;
    if (Date.now() > end) throw new Error('no new run was started');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const history = (query = '', user: keyof typeof AUTH_PASSWORDS = 'victor') => env.request('GET', `/api/v1/items/repo_a/7/history${query}`, undefined, as(user));

describe('end-to-end: item history (WI-33)', () => {
  const runs: string[] = [];

  it('records the way of an item through runs, hooks, a retry block, a UI action and a manual start', async () => {
    env.github.createIssue(REPO_A, { number: 7, title: 'Add <b>search</b>', labels: ['ready'] });
    env.github.addProjectItem(project, REPO_A, 7, { Status: 'Todo' });
    env.github.addRepoLabels(REPO_A, 'needs-review');

    // 1) success with outcome "approved".
    runs.push(await planAndFinish(runs));
    expect(env.github.labels(REPO_A, 7).sort()).toEqual(['done']);
    expect(env.github.projectValues(project, REPO_A, 7)).toMatchObject({ Status: 'Review' });

    // 2) someone puts it back on GitHub, two crashes → retry block.
    env.github.setLabels(REPO_A, 7, ['ready']);
    writeFileSync(modeFile, 'crash');
    runs.push(await planAndFinish(runs));
    runs.push(await planAndFinish(runs));
    expect(env.github.labels(REPO_A, 7)).toEqual(['agent-blocked']);
    const blocks = await env.request('GET', '/api/v1/blocks', undefined, as('victor'));
    const block = blocks.json.blocks[0];
    expect(block).toMatchObject({ itemKey: 'repo_a:7' });

    // 3) removal by olga → lifecycle run (unblock); no planning in between.
    expect((await env.request('POST', '/api/v1/scheduler/pause', {}, as('olga'))).status).toBe(200);
    writeFileSync(modeFile, 'ok');
    const cleared = await env.request('POST', `/api/v1/blocks/${block.id}/clear`, {}, as('olga'));
    expect(cleared.status).toBe(200);
    runs.push((await env.waitTerminal(cleared.json.runId)).id);

    // 4) UI action as alice (maintainer identity).
    const ui = await env.request('POST', '/api/v1/items/repo_a/7/labels', { identity: 'maintainer', add: ['needs-review'] }, as('alice'));
    expect(ui.status).toBe(200);

    // 5) manual start by olga.
    const start = await env.request('POST', '/api/v1/workflows/coder/start', { item: '7' }, as('olga'));
    expect(start.status).toBe(202);
    runs.push((await env.waitTerminal(start.json.run.id)).id);

    // --- History, read as a viewer.
    const res = await history();
    expect(res.status).toBe(200);
    const h = res.json;
    expect(h.item).toMatchObject({ ok: true, title: 'Add <b>search</b>', type: 'issue', state: 'open', repository: 'example/a' });
    expect(h.item.projectFields).toEqual([{ name: 'Status', kind: 'single_select', known: true, value: 'Review', reason: null }]);
    expect(h.item.linked).toMatchObject({ workBranch: { known: true }, workPr: { known: true } });
    expect(h.githubEvents).toBe(true);
    // Path: chronological, one element per run.
    expect(h.runs.map((r: { id: string }) => r.id)).toEqual(runs);
    expect(h.runs.map((r: { triggerType: string }) => r.triggerType)).toEqual(['source', 'source', 'source', 'unblock', 'manual']);
    expect(h.runs.map((r: { outcome: string; resultOutcome: string | null }) => r.resultOutcome ?? r.outcome)).toEqual(['approved', 'technical_error', 'technical_error', 'success', 'approved']);
    expect(h).toMatchObject({ runsTotal: 5, truncated: false, retentionGap: null, nextBefore: null, active: { runs: [], blocks: [] } });

    const entries = h.entries as Array<Record<string, any>>;
    // Newest first.
    const times = entries.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
    const kinds = new Set(entries.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['block_cleared', 'block_created', 'hook', 'run_finished', 'run_started', 'ui_action']);

    const approved = entries.find((e) => e.kind === 'hook' && e.hook === 'on_result.approved' && e.runId === runs[0]);
    expect(approved?.actions).toHaveLength(2);
    expect(approved?.actions[0]).toMatchObject({
      name: 'mark-done',
      type: 'source.update',
      status: 'succeeded',
      effectSource: 'recorded',
      effect: { labelsAdded: ['done'], labelsRemoved: ['coding'], projectFields: [{ name: 'Status', from: 'Todo', to: 'Review' }] },
    });
    expect(approved?.actions[1]).toMatchObject({ type: 'source.comment', status: 'succeeded', effect: { comment: { url: expect.stringContaining('#issuecomment-') } } });
    expect(JSON.stringify(approved)).not.toContain('Approved in run'); // never the comment text

    const onStart = entries.find((e) => e.kind === 'hook' && e.hook === 'on_start' && e.runId === runs[0]);
    expect(onStart?.actions[0].effect).toEqual({ labelsAdded: ['coding'], labelsRemoved: ['ready'] });
    expect(entries.find((e) => e.kind === 'hook' && e.hook === 'on_retry_block')?.actions[0].effect).toEqual({ labelsAdded: ['agent-blocked'], labelsRemoved: ['ready'] });
    expect(entries.find((e) => e.kind === 'hook' && e.hook === 'on_retry_unblock')).toMatchObject({ runId: runs[3] });

    expect(entries.find((e) => e.kind === 'block_created')).toMatchObject({ blockId: block.id, workflowId: 'coder', failureCount: 2, lastStatus: 'crashed', active: false, runId: runs[2] });
    expect(entries.find((e) => e.kind === 'block_cleared')).toMatchObject({ blockId: block.id, clearedBy: 'olga', clearedRunId: runs[3], runId: runs[3] });
    expect(entries.find((e) => e.kind === 'run_started' && e.runId === runs[3])).toMatchObject({ trigger: 'unblock', user: 'olga' });
    expect(entries.find((e) => e.kind === 'run_started' && e.runId === runs[4])).toMatchObject({ trigger: 'manual', user: 'olga', workflowName: 'Coder' });
    expect(entries.find((e) => e.kind === 'run_started' && e.runId === runs[0])).toMatchObject({ trigger: 'source', user: null });
    expect(entries.find((e) => e.kind === 'run_finished' && e.runId === runs[0])).toMatchObject({ status: 'completed', result: 'success', outcome: 'approved', message: 'looks good' });
    expect(entries.find((e) => e.kind === 'run_finished' && e.runId === runs[1])).toMatchObject({ status: 'crashed', result: null });
    expect(entries.find((e) => e.kind === 'ui_action')).toMatchObject({ actor: 'alice', identity: 'maintainer', action: 'labels', result: 'succeeded', effect: { labelsAdded: ['needs-review'] } });
  });

  it('pages the timeline with before/limit without gaps or duplicates', async () => {
    const all = (await history('?limit=500')).json;
    const keys: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 50; i++) {
      const page: any = (await history(`?limit=4${before ? `&before=${encodeURIComponent(before)}` : ''}`)).json;
      expect(page.entries.length).toBeLessThanOrEqual(4);
      if (before) expect(page.item).toBeNull(); // the head only comes with the first page
      keys.push(...page.entries.map((e: { key: string }) => e.key));
      before = page.nextBefore;
      if (!before) break;
    }
    expect(keys).toEqual(all.entries.map((e: { key: string }) => e.key));
    expect(keys.length).toBe(all.entriesTotal);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shows GitHub events without duplicating own changes; cached; errors isolated', async () => {
    const before = env.github.requests.filter((r) => r.path.endsWith('/timeline')).length;
    const res = await env.request('GET', '/api/v1/items/repo_a/7/github-events', undefined, as('victor'));
    expect(res.status).toBe(200);
    const events = res.json.events as Array<{ kind: string; label?: string; actor: string | null; own: boolean; external: boolean }>;
    // The manual change by octocat is external.
    expect(events).toContainEqual(expect.objectContaining({ kind: 'labeled', label: 'ready', actor: 'octocat', own: false, external: true }));
    // Own label changes (actions and the UI action) are merged with the history entries, not shown twice.
    expect(events.filter((e) => e.own && (e.kind === 'labeled' || e.kind === 'unlabeled'))).toEqual([]);
    expect(res.json.hiddenOwn).toBeGreaterThanOrEqual(10);
    expect(res.json).toMatchObject({ cached: false, truncated: false, limit: 300 });
    expect(res.json.notice).toMatch(/project fields/);
    expect(env.github.requests.filter((r) => r.path.endsWith('/timeline')).length).toBe(before + 1);

    const again = await env.request('GET', '/api/v1/items/repo_a/7/github-events', undefined, as('victor'));
    expect(again.json.cached).toBe(true);
    expect(env.github.requests.filter((r) => r.path.endsWith('/timeline')).length).toBe(before + 1);

    // A GitHub error only affects this endpoint; the history still works.
    env.github.failNext({ path: /\/timeline$/ }, { status: 403, body: { message: 'Resource not accessible by integration' } });
    const failed = await env.request('GET', '/api/v1/items/repo_a/7/github-events?refresh=true', undefined, as('victor'));
    expect(failed.status).toBe(502);
    expect(failed.json.error.code).toBe('github_forbidden');
    expect((await history()).status).toBe(200);
    // Errors are not cached.
    const recovered = await env.request('GET', '/api/v1/items/repo_a/7/github-events', undefined, as('victor'));
    expect(recovered.status).toBe(200);
    expect(recovered.json.cached).toBe(false);
  });

  it('the view field history links to the history page', async () => {
    const res = await env.request('GET', '/api/v1/views/board/items?refresh=true', undefined, as('victor'));
    expect(res.status).toBe(200);
    const col = (res.json.columns as Array<{ field: string }>).findIndex((c) => c.field === 'history');
    const row = (res.json.rows as Array<{ itemId: string; cells: Array<{ value: unknown; link: unknown }> }>).find((r) => r.itemId === '7');
    expect(row?.cells[col]).toMatchObject({ value: '#/items/repo_a/7', link: null });
  });

  it('empty items, unreadable items and unknown sources still answer with the stored history', async () => {
    env.github.createIssue(REPO_A, { number: 9, title: 'Untouched' });
    const empty = await env.request('GET', '/api/v1/items/repo_a/9/history', undefined, as('victor'));
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ item: { ok: true, title: 'Untouched' }, runs: [], entries: [], runsTotal: 0, entriesTotal: 0, nextBefore: null, retentionGap: null });

    const missing = await env.request('GET', '/api/v1/items/repo_a/404/history', undefined, as('victor'));
    expect(missing.status).toBe(200);
    expect(missing.json.item).toMatchObject({ ok: false, error: { code: 'item_not_found' } });

    const unknown = await env.request('GET', '/api/v1/items/gone/7/history', undefined, as('victor'));
    expect(unknown.status).toBe(200);
    expect(unknown.json.item).toMatchObject({ ok: false, error: { code: 'source_not_found' } });
    expect((await env.request('GET', '/api/v1/items/gone/7/github-events', undefined, as('victor'))).status).toBe(404);
    expect((await env.request('GET', '/api/v1/items/repo_a/7%2F..%2Fx/history', undefined, as('victor'))).status).toBe(400);
  });

  it('needs a login; the control token is refused', async () => {
    expect((await env.request('GET', '/api/v1/items/repo_a/7/history')).status).toBe(401);
    const token = { [CONTROL_TOKEN_HEADER]: env.app.auth.controlToken };
    const res = await env.request('GET', '/api/v1/items/repo_a/7/history', undefined, token);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('control_token_not_allowed');
  });

  it('keeps the effect of a failed attempt across a manual retry (labels + project field)', async () => {
    env.github.createIssue(REPO_A, { number: 11, title: 'Partial update', labels: ['ready'] });
    env.github.addProjectItem(project, REPO_A, 11, { Status: 'Todo' });
    env.github.denyProjectWrites(project);
    const start = await env.request('POST', '/api/v1/workflows/coder/start', { item: '11' }, as('olga'));
    expect(start.status).toBe(202);
    const runId = start.json.run.id as string;
    await env.waitRun(runId, (r) => r.status === 'completed' && r.lifecycleStatus === 'failed');
    const failed = env.app.persistence.actions.listForRun(runId).find((a) => a.name === 'mark-done')!;
    expect(failed.status).toBe('failed');
    // The labels were applied before the project write failed.
    expect(failed.effect).toEqual({ labelsAdded: ['done'], labelsRemoved: ['coding'] });

    env.github.allowProject(project);
    expect((await env.request('POST', `/api/v1/actions/${failed.id}/retry`, {}, as('olga'))).status).toBe(202);
    await env.waitRun(runId, (r) => r.lifecycleStatus === 'succeeded');
    const h = (await env.request('GET', '/api/v1/items/repo_a/11/history', undefined, as('victor'))).json;
    const hook = (h.entries as Array<Record<string, any>>).find((e) => e.kind === 'hook' && e.hook === 'on_result.approved');
    expect(hook?.actions[0]).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      effect: { labelsAdded: ['done'], labelsRemoved: ['coding'], projectFields: [{ name: 'Status', from: 'Todo', to: 'Review' }] },
    });
    // The GitHub `labeled done` event of the first attempt is merged, not shown as an unmatched own event.
    const events = (await env.request('GET', '/api/v1/items/repo_a/11/github-events', undefined, as('victor'))).json.events as Array<{ kind: string; label?: string; own: boolean }>;
    expect(events.filter((e) => e.own && e.label === 'done')).toEqual([]);
  });

  it('says when retention deleted older runs', async () => {
    expect(env.app.persistence.retention.deleteRun(runs[0]!)).toBe(true);
    const res = await history();
    expect(res.json.retentionGap).toMatchObject({ deletedRuns: 1 });
    expect(res.json.runs.map((r: { id: string }) => r.id)).toEqual(runs.slice(1));
  });
});
