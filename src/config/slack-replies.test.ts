/** WI-39: `slack` channels, the `notify` action, `on_reply` and `reply_check` (schema, normalization, validation). */
import { afterEach, describe, expect, it } from 'vitest';
import { formatConfigIssue, loadConfig, snapshotWorkflow, toPublicConfig, type LoadConfigResult, type LoadedConfig } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

const SLACK_CONFIG = `notifications:
  on: [retry_block_created, lifecycle_action_failed, recovery_failed]
  channels:
    - id: team
      type: slack
      bot_token_env: SLACK_BOT_TOKEN
      app_token_env: SLACK_APP_TOKEN
      channel: C0123456789
      allowed_users: [U0123456789]
    - id: ops
      type: webhook
      url_env: OPS_WEBHOOK_URL
`;

async function load(workflow: string, options: { config?: string; extra?: Record<string, string> } = {}): Promise<LoadConfigResult> {
  const t = await createTempConfigDir({
    ...BASE_FILES,
    'config.yaml': options.config ?? SLACK_CONFIG,
    'filters/needs-maintainer.yaml': 'id: needs-maintainer\nfilter: { field: labels, operator: contains, value: needs-maintainer }\n',
    ...(options.extra ?? {}),
    'workflows/wf.yaml': workflow,
  });
  temps.push(t);
  return loadConfig(t.dir, { dataDir: t.dataDir });
}

function expectOk(result: LoadConfigResult): LoadedConfig {
  if (!result.ok) throw new Error(`expected valid config:\n${result.errors.map(formatConfigIssue).join('\n')}`);
  return result.config;
}

const errors = (result: LoadConfigResult): string[] => (result.ok ? [] : result.errors).map((i) => `${i.path}: ${i.message}`);
const warnings = (result: LoadConfigResult): string[] =>
  result.warnings.map((i) => `${i.path}: ${i.message}`).filter((w) => !w.includes('is not used by any workflow or view'));

const SOURCE_WF = (extra: string): string =>
  ['id: wf', 'trigger: { type: source, source: repo_a }', 'execute: { type: shell, command: /bin/true }', extra].join('\n');
const CRON_WF = (extra: string): string =>
  ['id: wf', "trigger: { type: schedule, cron: '0 3 * * *' }", 'execute: { type: shell, command: /bin/true }', extra].join('\n');

const EXAMPLE_HOOKS = `on_result:
  needs_maintainer:
    - type: notify
      channel: team
      message: "{item.title}: {result.message}"
      remind_after: 4h
      remind_while: needs-maintainer
reply_check:
  command: /bin/true
  timeout: 30s
on_reply:
  - type: source.comment
    identity: maintainer
    message: "{reply.text}"
  - type: source.update
    labels: { remove: [needs-maintainer] }
`;

describe('slack channels and replies configuration (WI-39)', () => {
  it('accepts the examples of the work item and normalizes them', async () => {
    const result = await load(SOURCE_WF(EXAMPLE_HOOKS));
    const config = expectOk(result);
    expect(warnings(result)).toEqual([]);
    const team = config.global.notifications.channels[0];
    expect(team).toEqual({
      id: 'team',
      type: 'slack',
      botTokenEnv: 'SLACK_BOT_TOKEN',
      appTokenEnv: 'SLACK_APP_TOKEN',
      channel: 'C0123456789',
      allowedUsers: ['U0123456789'],
      on: ['retry_block_created', 'lifecycle_action_failed', 'recovery_failed'],
    });
    expect(config.global.retention.notificationThreadsMs).toBe(90 * 86_400_000);
    const wf = config.workflows.wf!;
    expect(wf.hooks['on_result.needs_maintainer']).toEqual([
      expect.objectContaining({
        id: 'on_result.needs_maintainer.0',
        type: 'notify',
        channel: 'team',
        thread: 'item',
        remindAfterMs: 4 * 3_600_000,
        remindWhile: { field: 'labels', operator: 'contains', value: 'needs-maintainer' },
      }),
    ]);
    expect(wf.hooks.on_reply?.map((a) => a.type)).toEqual(['source.comment', 'source.update']);
    expect(wf.replyCheck).toEqual({ command: '/bin/true', args: [], timeoutMs: 30_000 });
    expect(snapshotWorkflow(config, 'wf').workflow.replyCheck).toEqual(wf.replyCheck);
    // The public config shows variable names only.
    expect(JSON.stringify(toPublicConfig(config))).toContain('SLACK_BOT_TOKEN');
  });

  it('keeps workflow hashes of workflows without the new keys', async () => {
    const plain = expectOk(await load(SOURCE_WF('')));
    expect(plain.workflows.wf!.hooks.on_reply).toBeUndefined();
    expect('replyCheck' in plain.workflows.wf!).toBe(false);
  });

  it('rejects notify on a webhook channel and unknown channels', async () => {
    const result = await load(
      SOURCE_WF(`on_success:
  - type: notify
    channel: ops
    message: done
  - type: notify
    channel: teem
    message: done
`),
    );
    expect(errors(result)).toEqual([
      'on_success[0].channel: "notify" needs a channel of type "slack"; "ops" is of type "webhook"',
      'on_success[1].channel: Unknown notification channel "teem" (config.yaml notifications.channels) (did you mean "team"?)',
    ]);
  });

  it('allows {reply.*} only in on_reply and reply_check', async () => {
    const result = await load(
      SOURCE_WF(`on_success:
  - type: source.comment
    message: 'From {reply.user}'
  - type: notify
    channel: team
    message: '{reply.text}'
reply_check:
  command: /bin/true
  args: ['{reply.user}', '{reply.ts}', '{result.status}']
on_reply:
  - type: shell
    command: /bin/echo
    args: ['{reply.text}', '{reply.user_name}', '{reply.permalink}', '{reply.channel}', '{run.trigger}']
  - type: source.comment
    message: '{result.message}'
`),
    );
    expect(errors(result).sort()).toEqual([
      'on_reply[1].message: Placeholder "{result.message}" is not available in this context',
      'on_success[0].message: Placeholder "{reply.user}" is only available in "on_reply" and "reply_check"',
      'on_success[1].message: Placeholder "{reply.text}" is only available in "on_reply" and "reply_check"',
      'reply_check.args[2]: Placeholder "{result.status}" is not available in this context',
    ]);
  });

  it('rejects remind_while with an unknown filter, without remind_after, and reminders without item', async () => {
    const bad = await load(
      SOURCE_WF(`on_success:
  - type: notify
    channel: team
    message: x
    remind_after: 1h
    remind_while: needs-maintainr
  - type: notify
    channel: team
    message: x
    remind_while: { field: labels, operator: contains, value: a }
  - type: notify
    channel: team
    message: x
    remind_after: 1h
    remind_while: { field: lables, operator: contains, value: a }
`),
    );
    const list = errors(bad);
    expect(list.some((e) => e.startsWith('on_success[0].remind_while') && e.includes('needs-maintainr'))).toBe(true);
    expect(list).toContain('on_success[1].remind_while: "remind_while" needs "remind_after"');
    expect(list.some((e) => e.startsWith('on_success[2].remind_while') && e.includes('lables'))).toBe(true);

    const cron = await load(CRON_WF(`on_success:
  - type: notify
    channel: team
    message: 'nightly run {run.id} done'
  - type: notify
    channel: team
    message: x
    remind_after: 1h
`));
    expect(errors(cron)).toEqual([
      'on_success[1].remind_after: "remind_after" needs a source item (the reminder goes into the thread of the item); the workflow has no source trigger',
    ]);
  });

  it('refuses tokens in the YAML instead of the environment', async () => {
    const literal = await load(SOURCE_WF(''), {
      config: `notifications:
  channels:
    - id: team
      type: slack
      bot_token_env: SLACK_BOT_TOKEN
      bot_token: xoxb-123456789-abcdefghij
      channel: C0123456789
`,
    });
    expect(errors(literal)).toEqual([
      'notifications.channels[0].bot_token: Tokens must not be written into config.yaml: set "bot_token_env" to the name of an environment variable that holds the token',
    ]);
    const asName = await load(SOURCE_WF(''), {
      config: `notifications:
  channels:
    - { id: team, type: slack, bot_token_env: xoxb-123456789-abcdefghij, app_token_env: xapp-1-A0-123-abc, channel: C0123456789 }
`,
    });
    const list = errors(asName);
    expect(list).toHaveLength(2);
    for (const e of list) expect(e).toContain('Looks like a token');
    // The token never appears in a message.
    expect(JSON.stringify([...errors(literal), ...errors(asName)])).not.toMatch(/xoxb-1|xapp-1/);
  });

  it('rejects channel names and invalid user IDs', async () => {
    const result = await load(SOURCE_WF(''), {
      config: `notifications:
  channels:
    - { id: team, type: slack, bot_token_env: SLACK_BOT_TOKEN, channel: '#team', allowed_users: [alice] }
`,
    });
    expect(errors(result).sort()).toEqual([
      'notifications.channels[0].allowed_users[0]: Expected a Slack user ID such as U0123456789',
      'notifications.channels[0].channel: Expected a Slack channel ID such as C0123456789 (not the channel name)',
    ]);
  });

  it('warns when replies cannot arrive and about an unused reply_check', async () => {
    const sendOnly = await load(SOURCE_WF(`on_success:
  - { type: notify, channel: team, message: x }
on_reply:
  - { type: source.update, labels: { remove: [x] } }
`), {
      config: `notifications:
  channels:
    - { id: team, type: slack, bot_token_env: SLACK_BOT_TOKEN, channel: C0123456789 }
`,
    });
    expect(warnings(sendOnly)).toEqual(['on_reply: "on_reply" never runs: channel(s) "team" have no "app_token_env" (send only, no replies)']);

    const noUsers = await load(SOURCE_WF(`on_reply:
  - { type: source.update, labels: { remove: [x] } }
`), {
      config: `notifications:
  channels:
    - { id: team, type: slack, bot_token_env: SLACK_BOT_TOKEN, app_token_env: SLACK_APP_TOKEN, channel: C0123456789 }
`,
    });
    expect(warnings(noUsers)).toEqual([
      'notifications.channels[0].allowed_users: No "allowed_users": replies in the threads of this channel are ignored',
      'on_reply: "on_reply" never runs: channel(s) "team" have no "allowed_users"',
    ]);

    const unused = await load(SOURCE_WF(`reply_check: { command: /bin/true }`));
    expect(warnings(unused)).toEqual(['reply_check: "reply_check" is unused: the workflow has no "on_reply" actions']);

    const cron = await load(CRON_WF(`on_reply:
  - { type: shell, command: /bin/true }
`));
    expect(warnings(cron)).toEqual([
      'on_reply: "on_reply" never runs: replies arrive only in threads of items, and the workflow has no source trigger (trigger is "schedule")',
    ]);
  });

  it('rejects the same variable for bot and app token', async () => {
    const result = await load(SOURCE_WF(''), {
      config: `notifications:
  channels:
    - { id: team, type: slack, bot_token_env: SLACK_TOKEN, app_token_env: SLACK_TOKEN, channel: C0123456789, allowed_users: [U0123456789] }
`,
    });
    expect(errors(result)).toEqual([
      'notifications.channels[0].app_token_env: "app_token_env" and "bot_token_env" must name different variables (xapp-… vs. xoxb-… token)',
    ]);
  });
});
