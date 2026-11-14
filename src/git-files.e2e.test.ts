/**
 * End-to-end (WI-40): complete app with a `git_files` source whose remote is a
 * local bare repository. Planning with filters on frontmatter fields and
 * dependencies (malformed files skipped), item priority on a declared field,
 * placeholders and the worker context (body, comments), `source.update` with
 * `fields`/`labels` and `source.comment` as commits pushed to the remote, a
 * view, UI comment/labels through the same write path, and
 * `adispatch source create-item`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authEnvSetup, AUTH_PASSWORDS, FAST_AUTH, PASSWORD_AUTH_CONFIG } from './api/testing/auth.js';
import { startAppEnv, type AppEnv } from './api/testing/helpers.js';
import { createSourceCreateItemHandler } from './cli/index.js';
import { TestRemote } from './sources/git-files/testing/repo.js';
import type { FetchLike } from './core/index.js';

const ISSUE = (id: number, extra: string, body = 'Body.\n'): string => `---\nid: ${id}\ntitle: Item ${id}\n${extra}---\n${body}`;

let env: AppEnv;
let remote: TestRemote;
let cookie = '';

beforeAll(async () => {
  remote = new TestRemote({ 'README.md': '# Tracker\n' });
  const items = {
    'issues/0001-first.md': ISSUE(1, 'status: todo\npriority: 1\nbranch: wi-1\npr: "#41"\n', 'Fix the first thing.\n\n## Log\n\n### 2026-11-13T09:00:00Z — alice\nPlease keep the API stable.\n'),
    'issues/0002-blocked.md': ISSUE(2, 'status: todo\npriority: 9\nblocked_by: [3]\n'),
    'issues/0003-waiting.md': ISSUE(3, 'status: waiting\n'),
    'issues/0004-unknown-blocker.md': ISSUE(4, 'status: todo\nblocked_by: [99]\n'),
    'issues/0005-done.md': ISSUE(5, 'status: done\n'),
    'issues/0006-broken.md': '---\nid: [6\n---\n',
    'issues/0007-unblocked.md': ISSUE(7, 'status: todo\npriority: 5\nblocked_by: [5]\nlabels: [backend]\n'),
  };
  env = await startAppEnv({ configExtra: PASSWORD_AUTH_CONFIG, app: { ...FAST_AUTH, gitFiles: { minFetchIntervalMs: 0 } } }, (e) => {
    authEnvSetup(e);
    const ids = path.join(e.configDir, 'identities.yaml');
    writeFileSync(ids, readFileSync(ids, 'utf8').replace('    private_key_env: MAINTAINER_KEY\n', '    private_key_env: MAINTAINER_KEY\n    ui_actions: true\n'));
    writeFileSync(
      path.join(e.configDir, 'sources.yaml'),
      [
        'sources:',
        '  issues:',
        '    type: git_files',
        `    repository: ${remote.bare}`,
        '    identity: maintainer',
        '    commit_author: { name: adispatchd-bot, email: bot@example.invalid }',
        '    fields: { priority: number }',
        '    web_url: https://git.example.invalid/acme/app-meta/blob/{ref}/{path}',
        '',
      ].join('\n'),
    );
    const worker = e.script(
      'worker.sh',
      `printf '%s|%s|%s|%s' "$1" "$2" "$3" "$4" > "${e.marks}/args-$ADISPATCH_SOURCE_ITEM_ID.txt"
cp "$ADISPATCH_CONTEXT_FILE" "${e.marks}/context-$ADISPATCH_SOURCE_ITEM_ID.json"
printf '{"schema_version":1,"result":"success","message":"ok"}' > "$ADISPATCH_RESULT_FILE"`,
    );
    writeFileSync(
      path.join(e.configDir, 'workflows', 'coder.yaml'),
      [
        'id: coder',
        'max_concurrent: 1',
        'trigger: { type: source, source: issues }',
        'filter:',
        '  all:',
        '    - { field: status, operator: equals, value: todo }',
        '    - { field: dependencies.blocked_by_open, operator: equals, value: 0 }',
        'item_priority:',
        '  rules:',
        '    - { when: { field: priority, operator: greater_than, value: 3 }, value: 10 }',
        'execute:',
        '  type: shell',
        `  command: ${worker}`,
        "  args: ['{item.number}', '{item.title}', '{item.work_branch}', '{item.work_pr}']",
        'on_start:',
        '  - { type: source.update, fields: { status: coding }, labels: { add: [agent] } }',
        'on_success:',
        "  - { type: source.comment, message: 'Done in {run.id}' }",
        '  - { type: source.update, fields: { status: review }, labels: { remove: [agent] } }',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(e.configDir, 'views', 'board.yaml'),
      'id: board\nsources: [issues]\nfilter: { field: state, operator: in, value: [open, closed] }\nfields:\n  - { field: title, link: url }\n  - { field: status }\n  - { field: priority }\nsort: { field: number }\n',
    );
  });
  const res = await env.request('POST', '/api/v1/auth/login', { name: 'alice', password: AUTH_PASSWORDS.alice });
  expect(res.status).toBe(200);
  cookie = String(res.headers['set-cookie']).split(';')[0] as string;
  // The items arrive after the first planning step of the start (like new issues on GitHub).
  remote.commit(items, 'Add items');
});

afterAll(async () => {
  await env?.cleanup();
  remote?.dispose();
});

describe('git_files source end-to-end', () => {
  it('plans on frontmatter fields and dependencies; unknown blockers fail closed', async () => {
    const dry = await env.request('POST', '/api/v1/workflows/coder/dry-run', undefined, { cookie });
    expect(dry.status).toBe(200);
    const decisions = Object.fromEntries((dry.json.candidates as Array<{ itemKey: string; decision: string }>).map((c) => [c.itemKey, c.decision]));
    expect(decisions).toEqual({
      // max_concurrent: 1 – the higher priority item takes the slot.
      'issues:1': 'workflow_limit',
      'issues:2': 'filtered',
      'issues:3': 'filtered',
      'issues:4': 'filter_unknown',
      'issues:7': 'would_start',
    });
    // Priority rule on the declared field: #7 first.
    expect(env.logger.records.some((r) => r.msg === 'Skipping malformed item file' && r.fields?.file === 'issues/0006-broken.md')).toBe(true);
  });

  it('runs the worker with placeholders and context, writes updates and comments as commits', async () => {
    const report = await env.app.scheduler.planOnce();
    expect(report.startedRunIds).toHaveLength(1);
    const runId = report.startedRunIds[0] as string;
    expect((await env.waitTerminal(runId)).status).toBe('completed');
    const second = await env.app.scheduler.planOnce();
    expect(second.startedRunIds).toHaveLength(1);
    const runId1 = second.startedRunIds[0] as string;
    expect((await env.waitTerminal(runId1)).status).toBe('completed');

    expect(readFileSync(path.join(env.marks, 'args-1.txt'), 'utf8')).toBe('1|Item 1|wi-1|41');
    expect(readFileSync(path.join(env.marks, 'args-7.txt'), 'utf8')).toBe('7|Item 7||');
    const context = JSON.parse(readFileSync(path.join(env.marks, 'context-1.json'), 'utf8')) as { source: { attributes: Record<string, unknown> } };
    expect(context.source.attributes).toMatchObject({
      body: 'Fix the first thing.',
      comments: [{ at: '2026-11-13T09:00:00Z', author: 'alice', text: 'Please keep the API stable.' }],
      priority: 1,
    });

    const file = remote.file('issues/0001-first.md');
    expect(file.startsWith('---\nid: 1\ntitle: Item 1\nstatus: review\npriority: 1\nbranch: wi-1\npr: "#41"\nlabels: []\n---\nFix the first thing.\n\n## Log\n\n### 2026-11-13T09:00:00Z — alice\nPlease keep the API stable.\n')).toBe(true);
    expect(file).toMatch(new RegExp(`### \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ — maintainer\\n\\nDone in ${runId1}\\n\\n<!-- adispatchd:${runId1}:`));
    const log = remote.log();
    expect(log.filter((m) => m.startsWith('issues #1: '))).toHaveLength(3);
    expect(log.find((m) => m.startsWith('issues #1: labels -agent; status: coding → review'))).toContain(`Adispatchd-Run: ${runId1}`);
    expect(remote.lastAuthor()).toBe('adispatchd-bot <bot@example.invalid>');
    // Nothing secret in the clone's config: no remote URL, no token.
    const cloneConfig = readFileSync(path.join(env.dataDir, 'sources', 'issues', '.git', 'config'), 'utf8');
    expect(cloneConfig).not.toContain('remote');
    expect(cloneConfig).not.toMatch(/ghs_|token/i);

    // The journal recorded the frontmatter change as effect (item history).
    const history = await env.request('GET', '/api/v1/items/issues/1/history', undefined, { cookie });
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.json)).toContain('"fields":[{"name":"status","from":"coding","to":"review"}]');
  });

  it('shows the items in a view, including closed ones', async () => {
    const view = await env.request('GET', '/api/v1/views/board/items?refresh=1', undefined, { cookie });
    expect(view.status).toBe(200);
    const rows = view.json.rows as Array<{ itemId: string; url: string; cells: Array<{ value: unknown; link: string | null }> }>;
    expect(rows.map((r) => r.itemId)).toEqual(['1', '2', '3', '4', '5', '7']);
    expect(rows[0]?.cells.map((c) => c.value)).toEqual(['Item 1', 'review', 1]);
    expect(rows[0]?.cells[0]?.link).toBe('https://git.example.invalid/acme/app-meta/blob/main/issues/0001-first.md');
  });

  it('UI comment and labels go through the same write path', async () => {
    const details = await env.request('GET', '/api/v1/items/issues/7', undefined, { cookie });
    expect(details.status).toBe(200);
    expect(details.json).toMatchObject({ itemId: '7', title: 'Item 7', state: 'open', project: null });
    expect(details.json.availableLabels).toEqual(['backend']);
    const comment = await env.request('POST', '/api/v1/items/issues/7/comment', { identity: 'maintainer', body: 'Looks good <!-- sneaky -->' }, { cookie });
    expect(comment.status).toBe(200);
    expect(comment.json.comment.id).toMatch(/^[0-9a-f]{40}$/);
    const labels = await env.request('POST', '/api/v1/items/issues/7/labels', { identity: 'maintainer', add: ['ready'], remove: ['backend'], create: true }, { cookie });
    expect(labels.status).toBe(200);
    expect(labels.json.applied).toEqual({ labelsAdded: ['ready'], labelsRemoved: ['backend'] });
    const file = remote.file('issues/0007-unblocked.md');
    expect(file).toContain('labels: [ready]\n');
    expect(file).toContain('— maintainer\n\nLooks good &lt;!-- sneaky -->\n');
  });

  it('creates items from scripts with the next free number', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const handler = createSourceCreateItemHandler(
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      { env: env.env, fetch: env.github.fetch as FetchLike, stdin: async () => 'Failed twice.\n' },
    );
    const code = await handler('issues', {
      configDir: env.configDir,
      dataDir: env.dataDir,
      title: 'Flaky: test y',
      bodyFile: '-',
      field: ['status=todo', 'priority=2'],
      label: ['flaky'],
      identity: 'ci',
      json: true,
    });
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    const created = JSON.parse(out.join('')) as { item: string; file: string };
    expect(Number(created.item)).toBeGreaterThanOrEqual(8);
    expect(remote.file(created.file)).toMatch(
      new RegExp(`^---\\nid: ${created.item}\\ntitle: "Flaky: test y"\\nstatus: todo\\npriority: 2\\nlabels: \\[flaky\\]\\ncreated_at: \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z\\n---\\n\\nFailed twice\\.\\n$`),
    );
    expect(remote.log()[0]).toContain('Adispatchd-Identity: ci');
    const bad = await handler('issues', { configDir: env.configDir, title: 'x', field: ['state=closed'] });
    expect(bad).toBe(2);
  });
});
