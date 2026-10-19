import { describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor, commentMarker, type SourceItem } from '../core/index.js';
import { FakeGitHub, createFakeGitHubSource } from '../sources/github/testing/index.js';
import { CompositeCredentialProvider, GitHubAppCredentialProvider, GitHubTokenCredentialProvider } from './index.js';

const REPO = 'example/project-a';

describe('GitHubTokenCredentialProvider', () => {
  it('reads the token from the environment, registers it for redaction and never expires it', async () => {
    const redactor = new SecretRedactor();
    const provider = new GitHubTokenCredentialProvider({ reader: { tokenEnv: 'READER_TOKEN' } }, { env: { READER_TOKEN: ' ghp_secretvalue123 \n' }, redactor });
    // Registered at construction, before the first use.
    expect(redactor.redact('token=ghp_secretvalue123')).not.toContain('ghp_secretvalue123');
    const token = await provider.getToken('reader');
    expect(token.token).toBe('ghp_secretvalue123');
    expect(token.expiresAt.getTime()).toBeGreaterThan(new Date('9000-01-01').getTime());
    expect(provider.describe('reader')).toEqual({ kind: 'github_token' });
    expect(provider.describe('other')).toBeUndefined();
  });

  it('missing or empty variable: clear error at start (logged) and on use; never logs the token', async () => {
    const logger = new MemoryLogger();
    const provider = new GitHubTokenCredentialProvider(
      { a: { tokenEnv: 'A_TOKEN' }, b: { tokenEnv: 'B_TOKEN' }, ok: { tokenEnv: 'OK_TOKEN' } },
      { env: { B_TOKEN: '   ', OK_TOKEN: 'ghp_ok' }, logger },
    );
    expect(logger.records.filter((r) => r.level === 'error').map((r) => r.fields.identity)).toEqual(['a', 'b']);
    expect(logger.records.map((r) => String(r.fields.error)).join('\n')).toContain('environment variable A_TOKEN is not set or empty');
    expect(JSON.stringify(logger.records)).not.toContain('ghp_ok');
    await expect(provider.getToken('a')).rejects.toMatchObject({ kind: 'auth', retryable: false, message: expect.stringContaining('A_TOKEN') });
    await expect(provider.getToken('b')).rejects.toMatchObject({ kind: 'auth' });
    await expect(provider.getToken('nobody')).rejects.toMatchObject({ kind: 'auth', message: 'Unknown identity "nobody"' });
  });

  it('invalidate re-reads the variable (token rotation)', async () => {
    const env: Record<string, string> = { T: 'ghp_one' };
    const provider = new GitHubTokenCredentialProvider({ t: { tokenEnv: 'T' } }, { env });
    expect((await provider.getToken('t')).token).toBe('ghp_one');
    env.T = 'ghp_two';
    expect((await provider.getToken('t')).token).toBe('ghp_one');
    provider.invalidate('t');
    expect((await provider.getToken('t')).token).toBe('ghp_two');
  });
});

describe('CompositeCredentialProvider', () => {
  it('routes by identity to the provider of its kind', async () => {
    const clock = new FakeClock('2026-10-19T12:00:00Z');
    const github = new FakeGitHub({ clock });
    const app = github.createApp();
    const apps = new GitHubAppCredentialProvider(
      { coder: { appId: app.appId, installationId: app.installationId, privateKeyEnv: 'KEY' } },
      { clock, fetch: github.fetch, env: { KEY: app.privateKeyPem } },
    );
    const tokens = new GitHubTokenCredentialProvider({ pat: { tokenEnv: 'PAT' } }, { env: { PAT: 'ghp_x' } });
    const composite = new CompositeCredentialProvider({ coder: apps, pat: tokens });
    expect((await composite.getToken('coder')).token).toMatch(/^ghs_fake/);
    expect((await composite.getToken('pat')).token).toBe('ghp_x');
    expect(composite.describe('coder')).toEqual({ kind: 'github_app', appId: app.appId });
    expect(composite.describe('pat')).toEqual({ kind: 'github_token' });
    expect(composite.describe('nobody')).toBeUndefined();
    await expect(composite.getToken('nobody')).rejects.toMatchObject({ kind: 'auth' });
    composite.invalidate('nobody'); // no-op
  });
});

describe('source.comment markers with github_token identities', () => {
  it('a marker counts only when the comment author is the token user (GET /user, cached)', async () => {
    const clock = new FakeClock('2026-10-19T12:00:00Z');
    const github = new FakeGitHub({ clock });
    const token = github.createUserToken('octo-user');
    const redactor = new SecretRedactor();
    const logger = new MemoryLogger(redactor.asRedactor);
    const credentials = new GitHubTokenCredentialProvider({ commenter: { tokenEnv: 'PAT' } }, { env: { PAT: token }, redactor, logger });
    const adapter = createFakeGitHubSource(github, { clock, credentials, identity: 'commenter', logger });
    github.createIssue(REPO);
    const item = (await adapter.getItem('1')) as SourceItem;
    const marker = commentMarker('run-1', 'a1');

    // Same marker from another user (or a bot) does not count.
    github.addComment(REPO, 1, `<!-- ${marker} -->`, 'someone-else');
    github.addComment(REPO, 1, `<!-- ${marker} -->`, 'other-bot[bot]', { type: 'Bot' });
    expect(await adapter.findCommentByMarker(item, marker, 'commenter')).toBeNull();

    const ref = await adapter.postComment(item, 'hello', marker, 'commenter');
    expect(github.comments(REPO, 1).at(-1)).toMatchObject({ author: 'octo-user', authorType: 'User' });
    expect(await adapter.findCommentByMarker(item, marker, 'commenter')).toEqual(ref);
    // Login looked up once and cached.
    expect(github.requests.filter((r) => r.path === '/user')).toHaveLength(1);
    expect(JSON.stringify(logger.records)).not.toContain(token);
  });

  it('a 401 (credential invalidation) drops the cached login', async () => {
    const clock = new FakeClock('2026-10-19T12:00:00Z');
    const github = new FakeGitHub({ clock });
    const env: Record<string, string> = { PAT: github.createUserToken('first-user') };
    const credentials = new GitHubTokenCredentialProvider({ commenter: { tokenEnv: 'PAT' } }, { env });
    const adapter = createFakeGitHubSource(github, { clock, credentials, identity: 'commenter' });
    github.createIssue(REPO);
    const item = (await adapter.getItem('1')) as SourceItem;
    const marker = commentMarker('run-1', 'a1');
    github.addComment(REPO, 1, `<!-- ${marker} -->`, 'second-user');
    expect(await adapter.findCommentByMarker(item, marker, 'commenter')).toBeNull();
    expect(github.requests.filter((r) => r.path === '/user')).toHaveLength(1);

    // Token rotated to another user; the old token is rejected once → invalidate → new token, new login.
    env.PAT = github.createUserToken('second-user');
    github.failNext({ path: /\/comments$/ }, { status: 401, body: { message: 'Bad credentials' } });
    expect(await adapter.findCommentByMarker(item, marker, 'commenter')).not.toBeNull();
    expect(github.requests.filter((r) => r.path === '/user')).toHaveLength(2);
  });

  it('a failing GET /user fails the lookup and is retried next time', async () => {
    const clock = new FakeClock('2026-10-19T12:00:00Z');
    const github = new FakeGitHub({ clock });
    const token = github.createUserToken('octo-user');
    const credentials = new GitHubTokenCredentialProvider({ commenter: { tokenEnv: 'PAT' } }, { env: { PAT: token } });
    const adapter = createFakeGitHubSource(github, { clock, credentials, identity: 'commenter' });
    github.createIssue(REPO);
    const item = (await adapter.getItem('1')) as SourceItem;
    github.failNext({ path: '/user' }, { status: 502 });
    await expect(adapter.findCommentByMarker(item, commentMarker('run-1', 'a1'), 'commenter')).rejects.toMatchObject({ kind: 'transient' });
    expect(await adapter.findCommentByMarker(item, commentMarker('run-1', 'a1'), 'commenter')).toBeNull();
    expect(github.requests.filter((r) => r.path === '/user')).toHaveLength(2);
  });
});
