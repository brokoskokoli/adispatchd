import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger } from '../core/index.js';
import { RotatingCredentials } from './testing/rotating-credentials.js';
import {
  TOKEN_RENEW_BEFORE_MS,
  TokenFileSession,
  isTokenDirInWorkspace,
  removeTokenDirs,
  tokenFileEnvName,
  type TokenFileSessionOptions,
} from './token-files.js';

const MIN = 60_000;

describe('TokenFileSession (WI-18)', () => {
  let root: string;
  let clock: FakeClock;
  let logger: MemoryLogger;
  const sessions: TokenFileSession[] = [];

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'orch-token-files-'));
    clock = new FakeClock('2026-10-19T08:00:00Z');
    logger = new MemoryLogger();
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close();
    rmSync(root, { recursive: true, force: true });
  });

  function session(credentials: RotatingCredentials, extra: Partial<TokenFileSessionOptions> = {}): TokenFileSession {
    const s = new TokenFileSession({
      dir: path.join(root, 'runs', 'run-x', 'secrets'),
      requests: [{ name: 'GH_TOKEN', identity: 'coder' }],
      credentials,
      clock,
      timers: clock,
      logger,
      ...extra,
    });
    sessions.push(s);
    return s;
  }

  function current(s: TokenFileSession, name = 'GH_TOKEN'): string {
    return readFileSync(path.join(s.dir, name), 'utf8');
  }

  /** Every log record as JSON, for "token never logged" checks. */
  function logText(): string {
    return JSON.stringify(logger.records);
  }

  it('writes the token to <dir>/<NAME> (dir 0700, file 0600) and returns <NAME>_FILE', async () => {
    const creds = new RotatingCredentials(clock);
    const s = session(creds);
    const env = await s.open();
    const file = path.join(s.dir, 'GH_TOKEN');
    expect(env).toEqual({ GH_TOKEN_FILE: file });
    expect(tokenFileEnvName('GH_TOKEN')).toBe('GH_TOKEN_FILE');
    expect(current(s)).toBe(creds.last?.token);
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(s.values()).toEqual([creds.last?.token]);
    // Asks for a token that outlives the renewal margin.
    expect(creds.calls[0]?.minValidityMs).toBeGreaterThan(TOKEN_RENEW_BEFORE_MS);
  });

  it('a run longer than the token lifetime always finds a valid token in the file', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds);
    await s.open();
    const end = clock.nowMs() + 3 * 60 * MIN;
    while (clock.nowMs() < end) {
      await clock.advanceAsync(MIN);
      await s.settled();
      const token = current(s);
      const issued = creds.issued.find((t) => t.token === token);
      expect(issued, 'file holds an issued token').toBeDefined();
      expect(issued!.expiresAt.getTime()).toBeGreaterThan(clock.nowMs());
      // Renewed at the latest 10 minutes before expiry (renewal fires exactly at that point).
      expect(issued!.expiresAt.getTime() - clock.nowMs()).toBeGreaterThanOrEqual(TOKEN_RENEW_BEFORE_MS - MIN);
    }
    // 15 min lifetime, renewed every 5 min → ~36 renewals in 3 h.
    expect(creds.issued.length).toBeGreaterThanOrEqual(30);
    expect(logText()).not.toContain('secretvalue');
  });

  it('replaces the file atomically (rename in the same directory, no temp files left)', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds);
    await s.open();
    const before = statSync(path.join(s.dir, 'GH_TOKEN')).ino;
    await clock.advanceAsync(5 * MIN);
    await s.settled();
    const after = statSync(path.join(s.dir, 'GH_TOKEN'));
    expect(after.ino).not.toBe(before); // a new file was renamed over the old one
    expect(after.mode & 0o777).toBe(0o600);
    expect(readdirSync(s.dir)).toEqual(['GH_TOKEN']);
    expect(current(s)).toBe(creds.last?.token);
  });

  it('registers every renewed token for redaction before it is written', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds);
    await s.open();
    const seen: Array<{ value: string; fileAtThatTime: string }> = [];
    s.onAdd((value) => seen.push({ value, fileAtThatTime: current(s) }));
    await clock.advanceAsync(5 * MIN);
    await s.settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.value).toBe(creds.last?.token);
    // The file still held the old token when the listener ran.
    expect(seen[0]?.fileAtThatTime).toBe(creds.issued[0]?.token);
    expect(s.values()).toEqual(creds.issued.map((t) => t.token));
  });

  it('renewal errors are logged without token, retried with backoff; the old file stays', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds, { retryDelayMs: 30_000, maxRetryDelayMs: 60_000 });
    await s.open();
    const first = current(s);
    creds.failNext = 3;
    await clock.advanceAsync(5 * MIN); // renewal due → fails
    await s.settled();
    expect(current(s)).toBe(first);
    const warnings = logger.records.filter((r) => r.msg === 'token file renewal failed; retrying');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ variable: 'GH_TOKEN', identity: 'coder', attempt: 1, retryInMs: 30_000 });
    await clock.advanceAsync(30_000); // 2nd failure, next in 60 s
    await s.settled();
    await clock.advanceAsync(59_000);
    await s.settled();
    expect(logger.records.filter((r) => r.msg === 'token file renewal failed; retrying').map((r) => r.fields.retryInMs)).toEqual([
      30_000, 60_000,
    ]);
    await clock.advanceAsync(1_000); // 3rd failure, capped at 60 s
    await s.settled();
    await clock.advanceAsync(60_000); // success
    await s.settled();
    expect(current(s)).toBe(creds.last?.token);
    expect(current(s)).not.toBe(first);
    expect(creds.calls).toHaveLength(1 + 4);
    expect(logger.records.some((r) => r.msg === 'token file renewed')).toBe(true);
    expect(logText()).not.toContain('secretvalue');
  });

  it('stops renewing (no write, error log without token) when the directory was swapped for a symlink', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds);
    await s.open();
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    renameSync(s.dir, path.join(root, 'moved-away'));
    symlinkSync(elsewhere, s.dir);
    await clock.advanceAsync(5 * MIN);
    await s.settled();
    expect(readdirSync(elsewhere)).toEqual([]); // nothing written through the symlink
    expect(readFileSync(path.join(root, 'moved-away', 'GH_TOKEN'), 'utf8')).toBe(creds.issued[0]?.token);
    expect(logger.records.some((r) => r.level === 'error' && r.msg.startsWith('token directory was replaced'))).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
    await clock.advanceAsync(60 * MIN);
    expect(creds.issued).toHaveLength(2); // the one fetched before the check; no further attempts
    expect(logText()).not.toContain('secretvalue');
  });

  it('stops renewing when the directory was re-created (different inode)', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds);
    await s.open();
    renameSync(s.dir, path.join(root, 'old-dir')); // keeps the old inode allocated, so the new one differs
    mkdirSync(s.dir, { mode: 0o700 });
    await clock.advanceAsync(5 * MIN);
    await s.settled();
    expect(readdirSync(s.dir)).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('identities without expiry are written once (no timer)', async () => {
    const creds = new RotatingCredentials(clock);
    creds.nonExpiring.add('coder');
    const s = session(creds);
    await s.open();
    expect(clock.pendingTimers()).toBe(0);
    await clock.advanceAsync(24 * 60 * MIN);
    expect(creds.calls).toHaveLength(1);
  });

  it('several secrets get separate files and timers', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds, {
      requests: [
        { name: 'GH_TOKEN', identity: 'coder' },
        { name: 'REVIEW_TOKEN', identity: 'reviewer' },
      ],
    });
    const env = await s.open();
    expect(Object.keys(env).sort()).toEqual(['GH_TOKEN_FILE', 'REVIEW_TOKEN_FILE']);
    expect(current(s, 'GH_TOKEN')).toContain('_coder_');
    expect(current(s, 'REVIEW_TOKEN')).toContain('_reviewer_');
    expect(clock.pendingTimers()).toBe(2);
  });

  it('short-lived tokens (lifetime below the margin) are renewed halfway, never in a tight loop', async () => {
    const creds = new RotatingCredentials(clock, 4 * MIN);
    const s = session(creds);
    await s.open();
    await clock.advanceAsync(2 * MIN);
    await s.settled();
    expect(creds.issued).toHaveLength(2);
    expect(current(s)).toBe(creds.last?.token);
  });

  it('close() stops renewals and deletes the directory; a renewal in flight does not write afterwards', async () => {
    const creds = new RotatingCredentials(clock, 15 * MIN);
    const s = session(creds);
    await s.open();
    // Renewal starts, then close() runs while getToken is pending.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = creds.getToken.bind(creds);
    creds.getToken = async (identity, options) => {
      await gate;
      return original(identity, options);
    };
    await clock.advanceAsync(5 * MIN);
    const closing = s.close();
    release();
    await closing;
    expect(() => statSync(s.dir)).toThrow();
    expect(clock.pendingTimers()).toBe(0);
    await s.close(); // idempotent
  });

  it('open() failure removes everything written so far and throws without token', async () => {
    const creds = new RotatingCredentials(clock);
    const s = session(creds, {
      requests: [
        { name: 'GH_TOKEN', identity: 'coder' },
        { name: 'OTHER', identity: 'other' },
      ],
    });
    const original = creds.getToken.bind(creds);
    creds.getToken = (identity, options) => {
      if (identity === 'other') return Promise.reject(new Error('identity "other" not usable'));
      return original(identity, options);
    };
    await expect(s.open()).rejects.toThrow('identity "other" not usable');
    expect(() => statSync(s.dir)).toThrow();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('a stale directory of an earlier attempt is replaced', async () => {
    const dir = path.join(root, 'runs', 'run-x', 'secrets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'OLD'), 'stale');
    const s = session(new RotatingCredentials(clock));
    await s.open();
    expect(readdirSync(dir)).toEqual(['GH_TOKEN']);
  });
});

describe('removeTokenDirs (WI-18)', () => {
  it('removes run and action-attempt token directories, nothing else', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orch-token-dirs-'));
    try {
      const runDir = path.join(root, 'run-x');
      const dirs = [path.join(runDir, 'secrets'), path.join(runDir, 'actions', '3', 'attempt-1', 'secrets'), path.join(runDir, 'actions', '3', 'attempt-2', 'secrets')];
      for (const d of dirs) {
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, 'GH_TOKEN'), 'tok');
      }
      writeFileSync(path.join(runDir, 'context.json'), '{}');
      writeFileSync(path.join(runDir, 'actions', '3', 'attempt-1', 'context.json'), '{}');
      expect(await removeTokenDirs(runDir)).toBe(3);
      for (const d of dirs) expect(() => statSync(d)).toThrow();
      expect(statSync(path.join(runDir, 'context.json')).isFile()).toBe(true);
      expect(statSync(path.join(runDir, 'actions', '3', 'attempt-1', 'context.json')).isFile()).toBe(true);
      expect(await removeTokenDirs(runDir)).toBe(0);
      expect(await removeTokenDirs(path.join(root, 'missing'))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isTokenDirInWorkspace (WI-18)', () => {
  it('compares resolved paths (symlinks followed, missing parts appended)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orch-token-ws-'));
    try {
      const data = path.join(root, 'data');
      mkdirSync(path.join(data, 'runs', 'run-x'), { recursive: true });
      const tokenDir = path.join(data, 'runs', 'run-x', 'secrets');
      // Workspace reached through a symlink pointing at the data dir: textually outside, really inside.
      symlinkSync(data, path.join(root, 'ws-link'));
      expect(await isTokenDirInWorkspace(path.join(root, 'ws-link'), tokenDir)).toBe(true);
      expect(await isTokenDirInWorkspace(path.join(root, 'ws-link', 'runs'), tokenDir)).toBe(true);
      // Not yet existing workspace inside the data dir.
      expect(await isTokenDirInWorkspace(path.join(data, 'runs', 'run-x'), tokenDir)).toBe(true);
      expect(await isTokenDirInWorkspace(path.join(root, 'workspaces', 'wf', 'run-x'), tokenDir)).toBe(false);
      // Sibling with common prefix is not inside.
      expect(await isTokenDirInWorkspace(path.join(data, 'run'), tokenDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
