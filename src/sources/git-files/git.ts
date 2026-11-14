/**
 * Git plumbing of the `git_files` source (WI-40): the daemon's own clone of
 * the repository, fetch/reset as a mirror, commit and push.
 *
 * Security:
 * - The remote URL is passed on every fetch/push and never stored in the
 *   clone's config (no `origin` remote), so nothing in `.git/config` names it.
 * - A token is handed to git only through the environment of the child
 *   process (`ADISPATCH_GIT_TOKEN`), read by an inline credential helper that
 *   contains no secret itself. It never appears in a URL, an argument, the
 *   clone's config, a log line or an error message (messages are scrubbed).
 * - Git runs with a minimal environment, without system/global git config,
 *   without hooks and without terminal prompts.
 */
import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { SourceError } from '../../core/index.js';
import { abortReason } from './lock.js';

/** Environment variable of the git child process that carries the token. */
export const GIT_TOKEN_ENV = 'ADISPATCH_GIT_TOKEN';

/** Local branch of the clone (always reset to the remote branch). */
export const LOCAL_BRANCH = 'adispatchd';

/**
 * Inline credential helper: answers `get` with the token from the
 * environment. Contains no secret (the value is expanded by the shell git
 * starts for `!` helpers). User name `x-access-token` works for GitHub App
 * installation tokens and personal access tokens alike.
 */
export const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; }; f`;

/** Default timeout of one git command. */
export const GIT_TIMEOUT_MS = 120_000;

/** Result of a git command. */
export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Failed git command (message scrubbed, exit code and stderr kept for classification). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    /** Error output (stderr, then stdout). */
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Runs git (injectable for tests); an aborted `signal` terminates the process. */
export type GitExec = (args: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }) => Promise<GitResult>;

/** Default {@link GitExec}: `git` from `PATH`. */
export const execGit: GitExec = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          if (options.signal?.aborted) {
            reject(abortReason(options.signal));
            return;
          }
          const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : null;
          // stdout too: `push --porcelain` reports rejected refs there.
          reject(new GitCommandError(err.killed ? 'git timed out' : `git exited with ${code ?? 'an error'}`, code, `${String(stderr ?? '')}\n${String(stdout ?? '')}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** Options of {@link GitClone}. */
export interface GitCloneOptions {
  /** Directory of the clone (created on first use). */
  dir: string;
  /** Remote URL or path (never containing credentials). */
  remote: string;
  branch: string;
  /** Token for fetch/push, or `null` (local path, ssh with an agent, public repository). */
  token: (signal?: AbortSignal) => Promise<string | null>;
  /** Scrub secrets from texts (the shared redactor; the token is scrubbed in any case). */
  redact?: (text: string) => string;
  exec?: GitExec;
  /** Base environment (default `process.env`): only PATH, HOME, ssh agent and proxy variables are taken over. */
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

/** Variables taken over from the daemon's environment (everything else is dropped). */
const PASSED_ENV = ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'TMPDIR'];

/** Settings for every git command (no hooks, no signing, no prompts, deterministic output). */
const BASE_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.quotepath=false',
  '-c', 'advice.detachedHead=false',
  '-c', 'init.defaultBranch=adispatchd',
  '-c', 'gc.auto=0',
];

/** Classified outcome of a failed push. */
export type PushFailure = 'rejected' | 'other';

/** The daemon's clone of a `git_files` repository. */
export class GitClone {
  private readonly exec: GitExec;
  private readonly timeoutMs: number;
  private readonly baseEnv: Record<string, string>;

  constructor(private readonly options: GitCloneOptions) {
    this.exec = options.exec ?? execGit;
    this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    const source = options.env ?? process.env;
    const env: Record<string, string> = {};
    for (const name of PASSED_ENV) {
      const value = source[name];
      if (typeof value === 'string' && value !== '') env[name] = value;
    }
    this.baseEnv = {
      ...env,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ASKPASS: '/bin/false',
      SSH_ASKPASS: '/bin/false',
      // No interactive ssh prompts (host keys, passphrases) unless the operator configured ssh explicitly.
      GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    };
  }

  get dir(): string {
    return this.options.dir;
  }

  /**
   * Run git in the clone; `remote: true` adds the credential helper and the
   * token (fetch/push). An aborted `signal` terminates git and rejects with
   * the abort reason (only passed for fetches of reads: local steps are short,
   * and a push must not be cut off, or its outcome is unknown).
   */
  async git(args: readonly string[], options: { remote?: boolean; cwd?: string; signal?: AbortSignal } = {}): Promise<GitResult> {
    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);
    const env: Record<string, string> = { ...this.baseEnv };
    let token: string | null = null;
    const credential: string[] = [];
    if (options.remote) {
      token = await this.options.token(signal);
      if (signal?.aborted) throw abortReason(signal);
      // An empty helper first resets any helper from other config levels; redirects never carry credentials elsewhere.
      credential.push('-c', 'credential.helper=', '-c', 'http.followRedirects=false');
      const origin = credentialOrigin(this.options.remote);
      if (token && origin) {
        // Scoped to the origin of the repository: the token is never offered to another host.
        credential.push('-c', `credential.${origin}.helper=${CREDENTIAL_HELPER}`);
        env[GIT_TOKEN_ENV] = token;
      }
    }
    try {
      return await this.exec([...BASE_CONFIG, ...credential, ...args], {
        cwd: options.cwd ?? this.options.dir,
        env,
        timeoutMs: this.timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw abortReason(signal);
      if (err instanceof GitCommandError) {
        const scrub = (text: string): string => this.scrub(text, token);
        throw new GitCommandError(scrub(`git ${args[0] ?? ''}: ${err.message}: ${lastLines(err.stderr)}`), err.exitCode, scrub(err.stderr));
      }
      throw err;
    }
  }

  /** Remove the token, credentials in URLs and known secrets from a text. */
  scrub(text: string, token: string | null = null): string {
    let out = token ? text.split(token).join('[REDACTED]') : text;
    out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1[REDACTED]@');
    return this.options.redact ? this.options.redact(out) : out;
  }

  /** Create the clone directory and repository if needed. */
  async ensure(): Promise<void> {
    const gitDir = path.join(this.options.dir, '.git');
    if (await exists(gitDir)) return;
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await this.git(['init', '-q', '.']);
  }

  /**
   * Fetch the remote branch and reset the working tree to it (the clone is a
   * mirror: unpushed local commits and stray files are discarded). An aborted
   * `signal` stops the fetch (git removes its lock files on termination).
   */
  async sync(signal?: AbortSignal): Promise<void> {
    await this.ensure();
    try {
      await this.git(['fetch', '-q', '--no-tags', '--prune', '--', this.options.remote, `+refs/heads/${this.options.branch}:refs/remotes/upstream/${this.options.branch}`], {
        remote: true,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw classifyFetchError(err, this.options.branch);
    }
    // The reset is local and short; it is not cut off (no half-reset working tree).
    await this.reset();
  }

  /** Reset the local branch and working tree to the last fetched remote state. */
  async reset(): Promise<void> {
    await this.git(['checkout', '-q', '--force', '-B', LOCAL_BRANCH, `refs/remotes/upstream/${this.options.branch}`]);
    // -x: also files the repository ignores (the clone is a mirror of the remote branch, nothing else).
    await this.git(['clean', '-q', '-ffdx']);
  }

  /** Commit the given paths (relative to the repository root). */
  async commit(paths: readonly string[], message: string, author: { name: string; email: string }): Promise<string> {
    await this.git(['add', '-f', '--', ...paths]);
    await this.git(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '--no-verify', '-m', message, '--', ...paths]);
    return this.head();
  }

  /** SHA of HEAD. */
  async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Push HEAD to the remote branch; resolves `null` on success, else the classified failure. */
  async push(): Promise<{ failure: PushFailure; error: GitCommandError } | null> {
    try {
      await this.git(['push', '-q', '--porcelain', '--', this.options.remote, `HEAD:refs/heads/${this.options.branch}`], { remote: true });
      return null;
    } catch (err) {
      if (!(err instanceof GitCommandError)) throw err;
      const text = err.stderr;
      const rejected = /\[rejected\]|non-fast-forward|fetch first|\(stale info\)|failed to update ref|cannot lock ref|incorrect old value/i.test(text);
      return { failure: rejected ? 'rejected' : 'other', error: err };
    }
  }

  /** Oldest commit that added `needle` to `file` (pickaxe), or `null`. */
  async commitAdding(needle: string, file: string): Promise<string | null> {
    const out = (await this.git(['log', '--format=%H', '--reverse', '-S', needle, `refs/remotes/upstream/${this.options.branch}`, '--', file])).stdout.trim();
    return out === '' ? null : (out.split('\n')[0] ?? null);
  }
}

/** `scheme://host[:port]` of an http(s) repository URL (scope of the credential helper), else `null`. */
export function credentialOrigin(remote: string): string | null {
  try {
    const url = new URL(remote);
    return url.protocol === 'https:' || url.protocol === 'http:' ? `${url.protocol}//${url.host}` : null;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function lastLines(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines.slice(-3).join(' | ').slice(0, 500);
}

/** Map a failed fetch to a {@link SourceError}. */
export function classifyFetchError(err: unknown, branch: string): unknown {
  if (!(err instanceof GitCommandError)) return err;
  const text = err.stderr;
  if (/couldn't find remote ref|could not find remote ref/i.test(text)) {
    return new SourceError('not_found', `Branch "${branch}" does not exist in the repository: ${err.message}`, { retryable: false });
  }
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|403|401/i.test(text)) {
    return new SourceError('auth', `The repository rejected the credentials: ${err.message}`, { retryable: false });
  }
  if (/repository not found|does not appear to be a git repository|not found/i.test(text)) {
    return new SourceError('not_found', `Repository not found or not accessible: ${err.message}`, { retryable: false });
  }
  return new SourceError('transient', `Fetching the repository failed: ${err.message}`);
}
