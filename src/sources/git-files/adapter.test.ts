import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, SourceError, type CredentialProvider, type LogFields, type Logger, type SourceItem } from '../../core/index.js';
import { GitFilesSourceAdapter, listedStates, type GitFilesAdapterConfig, type GitFilesAdapterOptions } from './adapter.js';
import { execGit, GIT_TOKEN_ENV, type GitExec } from './git.js';
import { TestRemote } from './testing/repo.js';

const ISSUE = (id: number, extra: string, body = 'Body.\n'): string => `---\nid: ${id}\ntitle: Item ${id}\n${extra}---\n${body}`;

const TOKEN = 'ghs_test_token_value_123456';

class MemoryLogger implements Logger {
  readonly records: Array<{ level: string; msg: string; fields?: LogFields }> = [];
  debug(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'debug', msg, ...(fields ? { fields } : {}) });
  }
  info(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'info', msg, ...(fields ? { fields } : {}) });
  }
  warn(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'warn', msg, ...(fields ? { fields } : {}) });
  }
  error(msg: string, fields?: LogFields): void {
    this.records.push({ level: 'error', msg, ...(fields ? { fields } : {}) });
  }
  child(): Logger {
    return this;
  }
}

const credentials: CredentialProvider = { getToken: async () => ({ token: TOKEN, expiresAt: new Date(Date.now() + 3600_000) }) };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup(
  files: Record<string, string>,
  config: Partial<GitFilesAdapterConfig> = {},
  options: Partial<GitFilesAdapterOptions> = {},
): { remote: TestRemote; adapter: GitFilesSourceAdapter; logger: MemoryLogger; clock: FakeClock; cloneDir: string } {
  const remote = new TestRemote(files);
  const cloneDir = mkdtempSync(path.join(tmpdir(), 'adispatchd-clone-'));
  cleanups.push(() => remote.dispose(), () => rmSync(cloneDir, { recursive: true, force: true }));
  const logger = new MemoryLogger();
  const clock = new FakeClock(new Date('2026-11-14T10:00:00.000Z'));
  const adapter = new GitFilesSourceAdapter(
    'issues',
    {
      repository: remote.bare,
      branch: 'main',
      path: 'issues',
      identity: 'bot',
      commitAuthor: { name: 'bot', email: 'bot@example.invalid' },
      closedWhen: { status: ['done', 'closed'] },
      commentsHeading: '## Log',
      fields: { priority: 'number' },
      webUrl: 'https://git.example.invalid/acme/app-meta/blob/{ref}/{path}',
      location: 'acme/app-meta',
      ...config,
    },
    { credentials, logger, clock },
    { cloneDir: path.join(cloneDir, 'issues'), minFetchIntervalMs: 0, ...options },
  );
  return { remote, adapter, logger, clock, cloneDir: path.join(cloneDir, 'issues') };
}

const item = (adapter: GitFilesSourceAdapter, id: string): Promise<SourceItem> =>
  adapter.getItem(id).then((i) => {
    if (!i) throw new Error(`item ${id} missing`);
    return i;
  });

describe('GitFilesSourceAdapter – reading', () => {
  it('lists open items with built-in, declared and free fields', async () => {
    const { adapter } = setup({
      'issues/0001-first.md': ISSUE(1, 'status: todo\nlabels: [bug, ui]\npriority: 2\nmilestone: M1\nbranch: wi-1\npr: https://github.com/acme/app/pull/77\nowner: alice\ncreated: 2026-11-01\n', 'Body one.\n\n## Log\n\n### 2026-11-13T09:00:00Z — alice\nHi.\n'),
      'issues/0002-second.md': ISSUE(2, 'status: done\n'),
      'issues/0003-third.md': ISSUE(3, 'status: todo\nblocked_by: [1, "#2"]\n'),
      'issues/README.md': '# not an item\n',
      'other/0009-x.md': ISSUE(9, ''),
    });
    const items = await adapter.listCandidates();
    expect(items.map((i) => i.itemId)).toEqual(['1', '3']);
    const first = items[0] as SourceItem;
    expect(first.key).toBe('issues:1');
    expect(first.url).toBe('https://git.example.invalid/acme/app-meta/blob/main/issues/0001-first.md');
    expect(first.createdAt).toBe('2026-11-01');
    expect(first.fields).toMatchObject({
      number: 1,
      id: 1,
      title: 'Item 1',
      state: 'open',
      status: 'todo',
      labels: ['bug', 'ui'],
      milestone: 'M1',
      priority: 2,
      branch: 'wi-1',
      work_branch: 'wi-1',
      pr: 77,
      work_pr: 77,
      work_pr_url: 'https://github.com/acme/app/pull/77',
      owner: 'alice',
      body: 'Body one.',
      comments: [{ at: '2026-11-13T09:00:00Z', author: 'alice', text: 'Hi.' }],
      path: 'issues/0001-first.md',
      'dependencies.blocked_by_total': 0,
      'dependencies.blocked_by_open': 0,
      'dependencies.status': 'ok',
    });
    expect(items[1]?.fields).toMatchObject({ blocked_by: ['1', '2'], 'dependencies.blocked_by_total': 2, 'dependencies.blocked_by_open': 1, 'dependencies.blocked': true });
  });

  it('lists closed items with a top-level state selector', async () => {
    const { adapter } = setup({ 'issues/0001-a.md': ISSUE(1, 'status: todo\n'), 'issues/0002-b.md': ISSUE(2, 'status: Closed\n') });
    expect((await adapter.listCandidates({ filter: { field: 'state', operator: 'equals', value: 'closed' } })).map((i) => i.itemId)).toEqual(['2']);
    expect((await adapter.listCandidates({ filter: { all: [{ field: 'state', operator: 'in', value: ['open', 'closed'] }] } })).map((i) => i.itemId)).toEqual(['1', '2']);
    expect(listedStates({ any: [{ field: 'state', operator: 'equals', value: 'closed' }] })).toEqual(new Set(['open']));
  });

  it('skips malformed files with one warning each and makes dependent fields unknown', async () => {
    const { adapter, logger } = setup({
      'issues/0001-ok.md': ISSUE(1, 'blocked_by: [2, 4, 5]\npriority: high\n'),
      'issues/0002-broken.md': '---\ntitle: [unclosed\n---\n',
      'issues/0003-mismatch.md': ISSUE(4, ''),
      'issues/0005-a.md': ISSUE(5, ''),
      'issues/0005-b.md': ISSUE(5, ''),
      'issues/0006-nofm.md': 'no frontmatter\n',
    });
    const items = await adapter.listCandidates();
    expect(items.map((i) => i.itemId)).toEqual(['1']);
    const first = items[0] as SourceItem;
    expect(first.fields['dependencies.blocked_by_total']).toBe(3);
    expect(first.fields['dependencies.status']).toBe('unknown');
    expect(first.fields).not.toHaveProperty('dependencies.blocked_by_open');
    expect(first.unknownFields?.['dependencies.blocked_by_open']).toContain('#2, #4, #5');
    expect(first.unknownFields?.priority).toContain('not a number');
    const warnings = logger.records.filter((r) => r.level === 'warn');
    expect(warnings.map((w) => w.fields?.file).sort()).toEqual([
      'issues/0002-broken.md',
      'issues/0003-mismatch.md',
      'issues/0005-a.md',
      'issues/0005-b.md',
      'issues/0006-nofm.md',
    ]);
    // A second poll does not warn again.
    await adapter.listCandidates();
    expect(logger.records.filter((r) => r.level === 'warn')).toHaveLength(5);
    expect((await adapter.problems()).length).toBe(5);
  });

  it('parses item references', () => {
    const { adapter } = setup({ 'issues/0001-a.md': ISSUE(1, '') });
    expect(adapter.parseItemRef('42')).toBe('42');
    expect(adapter.parseItemRef('#0042')).toBe('42');
    expect(adapter.parseItemRef('issues/0042-fix.md')).toBe('42');
    expect(adapter.parseItemRef('https://git.example.invalid/acme/app-meta/blob/main/issues/0042-fix.md')).toBe('42');
    expect(adapter.parseItemRef('other/0042-fix.md')).toBeNull();
    expect(adapter.parseItemRef('0')).toBeNull();
    expect(adapter.parseItemRef('abc')).toBeNull();
  });

  it('fetches at most once per interval', async () => {
    const calls: string[] = [];
    const exec: GitExec = (args, options) => {
      const sub = args.find((a, i) => i > 0 && args[i - 1] !== '-c' && a !== '-c');
      if (sub) calls.push(sub);
      return execGit(args, options);
    };
    const { adapter, remote, clock } = setup({ 'issues/0001-a.md': ISSUE(1, '') }, {}, { exec, minFetchIntervalMs: 5_000 });
    await adapter.listCandidates();
    await Promise.all([adapter.listCandidates(), adapter.getItem('1'), adapter.listLabels()]);
    expect(calls.filter((c) => c === 'fetch')).toHaveLength(1);
    remote.commit({ 'issues/0002-b.md': ISSUE(2, '') });
    expect((await adapter.listCandidates()).length).toBe(1);
    clock.advance(5_000);
    expect((await adapter.listCandidates()).length).toBe(2);
    expect(calls.filter((c) => c === 'fetch')).toHaveLength(2);
  });

  it('reports an unreachable repository as source error', async () => {
    const { adapter } = setup({ 'issues/0001-a.md': ISSUE(1, '') }, { repository: '/nonexistent/repo.git' });
    await expect(adapter.listCandidates()).rejects.toBeInstanceOf(SourceError);
  });
});

describe('GitFilesSourceAdapter – writing', () => {
  it('updates labels and fields in the frontmatter only, idempotently, one commit each', async () => {
    const body = 'Body.\n\nHuman text   with  spacing.\n';
    const { adapter, remote } = setup({ 'issues/0001-a.md': ISSUE(1, 'status: todo   # state\nlabels: [ready]\n', body) });
    const it1 = await item(adapter, '1');
    const result = await adapter.applyUpdate(it1, { labels: { add: ['coding'], remove: ['ready'] }, fields: { status: 'coding', priority: 3 } }, 'coder', {
      origin: { runId: 'run-1', actionId: 'on_start.0' },
    });
    expect(result).toEqual({
      changed: true,
      applied: { labelsAdded: ['coding'], labelsRemoved: ['ready'], fields: { status: 'coding', priority: 3 }, fieldsPrevious: { status: 'todo', priority: null } },
    });
    const text = remote.file('issues/0001-a.md');
    expect(text).toBe(`---\nid: 1\ntitle: Item 1\nstatus: coding # state\nlabels: [coding]\npriority: 3\n---\n${body}`);
    const [message] = remote.log();
    expect(message).toContain('issues #1: labels +coding -ready; status: todo → coding; priority: 3');
    expect(message).toContain('Adispatchd-Run: run-1');
    expect(message).toContain('Adispatchd-Action: on_start.0');
    expect(message).toContain('Adispatchd-Identity: coder');
    expect(remote.lastAuthor()).toBe('bot <bot@example.invalid>');

    const again = await adapter.applyUpdate(it1, { labels: { add: ['coding'], remove: ['ready'] }, fields: { status: 'coding' } }, 'coder');
    expect(again).toEqual({ changed: false });
    expect(remote.log()).toHaveLength(2);
    expect((await item(adapter, '1')).fields.status).toBe('coding');
  });

  it('rejects fields that cannot be written', async () => {
    const { adapter } = setup({ 'issues/0001-a.md': ISSUE(1, '') });
    const it1 = await item(adapter, '1');
    await expect(adapter.applyUpdate(it1, { fields: { state: 'closed' } }, 'x')).rejects.toThrow('cannot be set');
    await expect(adapter.applyUpdate(it1, { fields: { priority: 'high' } }, 'x')).rejects.toThrow('expected a number');
    await expect(adapter.applyUpdate(it1, { project: { Status: 'x' } }, 'x')).rejects.toThrow('no GitHub project');
  });

  it('appends comments with a marker and finds them again', async () => {
    const { adapter, remote } = setup({ 'issues/0001-a.md': ISSUE(1, 'status: todo\n') }, { commentsHeading: '## Verlauf' });
    const it1 = await item(adapter, '1');
    const marker = 'adispatchd:run-20261114T100000000Z-abcdef12:on_success.0';
    expect(await adapter.findCommentByMarker(it1, marker)).toBeNull();
    const ref = await adapter.postComment(it1, 'Done: all tests green.', marker, 'reviewer');
    expect(ref.id).toMatch(/^[0-9a-f]{40}$/);
    expect(ref.url).toBe(`https://git.example.invalid/acme/app-meta/blob/${ref.id}/issues/0001-a.md`);
    expect(remote.file('issues/0001-a.md')).toBe(
      `${ISSUE(1, 'status: todo\n')}\n## Verlauf\n\n### 2026-11-14T10:00:00Z — reviewer\n\nDone: all tests green.\n\n<!-- ${marker} -->\n`,
    );
    expect(remote.log()[0]).toContain('Adispatchd-Run: run-20261114T100000000Z-abcdef12');
    expect(await adapter.findCommentByMarker(it1, marker)).toEqual(ref);
    // Posting again with the same marker does not duplicate it.
    expect(await adapter.postComment(it1, 'Done again.', marker, 'reviewer')).toEqual(ref);
    expect((await item(adapter, '1')).fields.comments).toEqual([{ at: '2026-11-14T10:00:00Z', author: 'reviewer', text: 'Done: all tests green.' }]);
    const ui = await adapter.postUserComment(it1, 'From the UI', '');
    expect(ui.id).not.toBe(ref.id);
    expect((await item(adapter, '1')).fields.comments).toHaveLength(2);
    expect(remote.file('issues/0001-a.md')).toContain('— bot\n\nFrom the UI\n');
  });

  it('resolves a rejected push by fetching and applying the change again', async () => {
    let remote: TestRemote | undefined;
    let raced = false;
    const exec: GitExec = async (args, options) => {
      if (!raced && args.includes('push')) {
        raced = true;
        // A human pushes an edit of the body in between.
        const current = remote?.file('issues/0001-a.md') ?? '';
        remote?.commit({ 'issues/0001-a.md': current.replace('Body.', 'Body edited by a human.'), 'issues/0002-b.md': ISSUE(2, '') });
      }
      return execGit(args, options);
    };
    const setupResult = setup({ 'issues/0001-a.md': ISSUE(1, 'status: todo\n') }, {}, { exec });
    remote = setupResult.remote;
    const { adapter, logger } = setupResult;
    const it1 = await item(adapter, '1');
    const result = await adapter.applyUpdate(it1, { fields: { status: 'coding' } }, 'coder');
    expect(result.changed).toBe(true);
    expect(remote.file('issues/0001-a.md')).toBe(ISSUE(1, 'status: coding\n', 'Body edited by a human.\n'));
    expect(logger.records.some((r) => r.msg.includes('Push rejected'))).toBe(true);
    expect((await adapter.listCandidates()).map((i) => i.itemId)).toEqual(['1', '2']);
  });

  it('gives up after the bounded number of rejected pushes', async () => {
    let remote: TestRemote | undefined;
    let n = 0;
    const exec: GitExec = async (args, options) => {
      if (args.includes('push')) remote?.commit({ [`noise-${n++}.txt`]: 'x' });
      return execGit(args, options);
    };
    const s = setup({ 'issues/0001-a.md': ISSUE(1, '') }, {}, { exec, maxPushAttempts: 2 });
    remote = s.remote;
    const err = await s.adapter.applyUpdate(await item(s.adapter, '1'), { fields: { status: 'x' } }, 'c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as SourceError).retryable).toBe(true);
    expect((err as SourceError).message).toContain('rejected 2 times');
  });

  it('creates items with the next free number', async () => {
    const { adapter, remote } = setup({ 'issues/0007-a.md': ISSUE(7, ''), 'issues/0009-broken.md': 'broken' });
    const created = await adapter.createItem({ title: 'Flaky: test x', body: 'Seen twice.', labels: ['flaky'], fields: { status: 'todo', priority: 1 } }, 'ci');
    expect(created).toMatchObject({ itemId: '10', file: 'issues/0010-flaky-test-x.md' });
    expect(remote.file('issues/0010-flaky-test-x.md')).toBe('---\nid: 10\ntitle: "Flaky: test x"\nstatus: todo\npriority: 1\nlabels: [flaky]\n---\n\nSeen twice.\n');
    expect(remote.log()[0]).toContain('issues #10: create "Flaky: test x"');
    expect((await item(adapter, '10')).fields.labels).toEqual(['flaky']);
  });
});

describe('GitFilesSourceAdapter – credentials', () => {
  it('passes the token only through the environment of fetch/push, never in arguments or the clone config', async () => {
    const seen: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const exec: GitExec = (args, options) => {
      seen.push({ args, env: options.env });
      return execGit(args, options);
    };
    const { adapter, cloneDir } = setup({ 'issues/0001-a.md': ISSUE(1, '') }, {}, { exec, env: { PATH: process.env.PATH, HOME: tmpdir(), SECRET_OF_DAEMON: 'x' } });
    await adapter.applyUpdate(await item(adapter, '1'), { labels: { add: ['x'] } }, 'c');
    for (const call of seen) expect(call.args.join(' ')).not.toContain(TOKEN);
    const remoteCalls = seen.filter((c) => c.args.includes('fetch') || c.args.includes('push'));
    expect(remoteCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of remoteCalls) {
      expect(call.env[GIT_TOKEN_ENV]).toBe(TOKEN);
      expect(call.args.some((a) => a.startsWith('credential.helper=!'))).toBe(true);
    }
    for (const call of seen.filter((c) => !c.args.includes('fetch') && !c.args.includes('push'))) expect(call.env[GIT_TOKEN_ENV]).toBeUndefined();
    for (const call of seen) {
      expect(call.env.SECRET_OF_DAEMON).toBeUndefined();
      expect(call.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    }
    expect(readFileSync(path.join(cloneDir, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(path.join(cloneDir, '.git', 'config'), 'utf8')).not.toContain('remote');
  });

  it('works without identity (no credentials)', async () => {
    const { adapter } = setup({ 'issues/0001-a.md': ISSUE(1, '') }, { identity: null });
    expect((await adapter.listCandidates()).length).toBe(1);
  });

  it('scrubs the token from error messages', async () => {
    const exec: GitExec = async () => {
      const { GitCommandError } = await import('./git.js');
      throw new GitCommandError('git exited with 128', 128, `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/acme/app-meta.git/': error`);
    };
    const { adapter } = setup({ 'issues/0001-a.md': ISSUE(1, '') }, {}, { exec });
    const err = (await adapter.listCandidates().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('[REDACTED]');
  });
});
