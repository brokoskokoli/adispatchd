import { describe, expect, it } from 'vitest';
import { SourceError } from '../../core/index.js';
import { classifyFetchError, GitCommandError, isAuthFailure } from './git.js';

const kind = (stderr: string): string => {
  const err = classifyFetchError(new GitCommandError('git fetch: git exited with 128', 128, stderr), 'main');
  return err instanceof SourceError ? `${err.kind}${err.retryable ? '' : ' (permanent)'}` : 'other';
};

describe('classifyFetchError (WI-40)', () => {
  it.each([
    ["fatal: Authentication failed for 'https://github.com/acme/x.git/'", 'auth (permanent)'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth (permanent)'],
    ['remote: Invalid username or password.\nfatal: Authentication failed', 'auth (permanent)'],
    ["remote: Permission to acme/x.git denied to bot.\nfatal: unable to access 'https://github.com/acme/x.git/': The requested URL returned error: 403", 'auth (permanent)'],
    ["fatal: unable to access 'https://git.example.invalid/x.git/': The requested URL returned error: 401", 'auth (permanent)'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth (permanent)'],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/acme/x.git/' not found", 'not_found (permanent)'],
    ["fatal: '/srv/repos/missing.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'not_found (permanent)'],
    ["fatal: unable to access 'https://git.example.invalid/x.git/': The requested URL returned error: 404", 'not_found (permanent)'],
    ["fatal: couldn't find remote ref refs/heads/main", 'not_found (permanent)'],
  ])('classifies %j', (stderr, expected) => {
    expect(kind(stderr)).toBe(expected);
  });

  it.each([
    // Numbers and words that only look like an auth or not-found message.
    "fatal: unable to access 'https://git.example.invalid/srv/x401/repo.git/': Could not resolve host: git.example.invalid",
    "fatal: unable to access 'https://git.example.invalid/x.git/': The requested URL returned error: 503",
    'error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly: PROTOCOL_ERROR (err 1); 403 bytes received',
    'fatal: the remote end hung up unexpectedly (branch fix-not-found-403)',
    "error: unable to create file issues/0001-a.md: Permission denied\nfatal: cannot lock ref 'refs/remotes/upstream/main'",
    'ssh: connect to host git.example.invalid port 22: Connection timed out',
  ])('keeps %j transient', (stderr) => {
    expect(kind(stderr)).toBe('transient');
  });

  it('isAuthFailure is the same test for pushes', () => {
    expect(isAuthFailure("fatal: Authentication failed for 'https://github.com/acme/x.git/'")).toBe(true);
    expect(isAuthFailure('To /srv/x403.git\n ! [remote rejected] HEAD -> main (pre-receive hook declined)')).toBe(false);
  });
});
