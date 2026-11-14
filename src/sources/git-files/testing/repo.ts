/**
 * Test helpers for the `git_files` source (WI-40): a local bare repository as
 * remote plus a helper clone to commit "concurrent" changes. Not part of the build.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Human', '-c', 'user.email=human@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: ENV,
    encoding: 'utf8',
  });
}

/** A bare remote repository with a helper working clone. */
export class TestRemote {
  readonly root: string;
  readonly bare: string;
  private readonly work: string;

  constructor(files: Record<string, string>, readonly branch = 'main') {
    this.root = mkdtempSync(path.join(tmpdir(), 'adispatchd-gitfiles-'));
    this.bare = path.join(this.root, 'remote.git');
    this.work = path.join(this.root, 'work');
    git(this.root, 'init', '-q', '--bare', '-b', branch, this.bare);
    // init + remote instead of cloning the empty bare repository (no "empty repository" warning).
    git(this.root, 'init', '-q', '-b', branch, this.work);
    git(this.work, 'remote', 'add', 'origin', this.bare);
    this.commit(files, 'Seed');
  }

  /** Write files (relative paths) in the helper clone, commit and push them. `null` deletes a file. */
  commit(files: Record<string, string | null>, message = 'Human change'): void {
    if (git(this.root, '--git-dir', this.bare, 'branch', '--list', this.branch).trim() !== '') git(this.work, 'pull', '-q', '--rebase', 'origin', this.branch);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(this.work, rel);
      if (content === null) {
        rmSync(abs, { force: true });
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    git(this.work, 'add', '-A');
    git(this.work, 'commit', '-q', '--allow-empty', '-m', message);
    git(this.work, 'push', '-q', 'origin', `HEAD:refs/heads/${this.branch}`);
  }

  /** Commit a symbolic link `rel` → `target` (absolute). */
  symlink(rel: string, target: string): void {
    symlinkSync(target, path.join(this.work, rel));
    git(this.work, 'add', '-A');
    git(this.work, 'commit', '-q', '-m', 'Add symlink');
    git(this.work, 'push', '-q', 'origin', `HEAD:refs/heads/${this.branch}`);
  }

  /** Content of a file on the remote branch. */
  file(rel: string): string {
    return git(this.root, '--git-dir', this.bare, 'show', `${this.branch}:${rel}`);
  }

  /** Subjects and bodies of the remote commits, newest first. */
  log(): string[] {
    return git(this.root, '--git-dir', this.bare, 'log', '--format=%B%x00', this.branch)
      .split('\u0000')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }

  /** Author of the newest remote commit (`name <email>`). */
  lastAuthor(): string {
    return git(this.root, '--git-dir', this.bare, 'log', '-1', '--format=%an <%ae>', this.branch).trim();
  }

  read(abs: string): string {
    return readFileSync(abs, 'utf8');
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
