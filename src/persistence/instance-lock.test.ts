import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceLockedError } from './errors.js';
import { acquireInstanceLock } from './instance-lock.js';
import { tempDataDir } from './testing/helpers.js';

/** Child process that takes the lock (same SQLite mechanism) and holds it until killed. */
const HOLDER_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 0');
db.exec('PRAGMA locking_mode = EXCLUSIVE');
db.exec('BEGIN EXCLUSIVE');
db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, hostname TEXT NOT NULL, acquired_at TEXT NOT NULL)');
db.exec('DELETE FROM holder');
db.prepare('INSERT INTO holder VALUES (?, ?, ?)').run(process.pid, 'child', new Date().toISOString());
db.exec('COMMIT');
process.stdout.write('locked\\n');
setInterval(() => {}, 1000);
`;

/** Run a child that tries to take the lock once; resolves `locked` or `busy`. */
function probeFromChild(lockPath: string): Promise<string> {
  const script = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
try {
  db.exec('PRAGMA busy_timeout = 0');
  db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec('BEGIN EXCLUSIVE');
  process.stdout.write('locked');
} catch (e) {
  process.stdout.write(/locked|busy/i.test(e.message) ? 'busy' : 'error:' + e.message);
}
`;
  const child = spawn(process.execPath, ['-e', script, lockPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.once('exit', () => resolve(out));
  });
}

function startHolder(lockPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout!.once('data', () => resolve(child));
    child.once('exit', (code) => reject(new Error(`holder exited early (${code}): ${stderr}`)));
  });
}

describe('acquireInstanceLock', () => {
  const tmp = tempDataDir();
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children) c.kill('SIGKILL');
    tmp.cleanup();
  });

  it('rejects a second instance in the same process and allows re-acquire after release', () => {
    const lock = acquireInstanceLock(tmp.dir);
    expect(lock.held).toBe(true);
    expect(JSON.parse(readFileSync(`${lock.path}.json`, 'utf8'))).toMatchObject({ pid: process.pid });
    let error: unknown;
    try {
      acquireInstanceLock(tmp.dir);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(InstanceLockedError);
    expect((error as InstanceLockedError).message).toContain(`pid ${process.pid}`);
    lock.release();
    lock.release(); // idempotent
    expect(lock.held).toBe(false);
    const again = acquireInstanceLock(tmp.dir);
    again.release();
  });

  it('a failed in-process attempt does not weaken the held lock for other processes', async () => {
    const lock = acquireInstanceLock(tmp.dir);
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
    expect(await probeFromChild(lock.path)).toBe('busy');
    lock.release();
    expect(await probeFromChild(lock.path)).toBe('locked');
  });

  it('rejects while another live process holds the lock', async () => {
    const lock = acquireInstanceLock(tmp.dir);
    const lockPath = lock.path;
    lock.release();
    const child = await startHolder(lockPath);
    children.push(child);
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
    // repeated attempts never succeed while the holder lives
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
  });

  it('takes over the lock left by a killed process (stale lock)', async () => {
    const probe = acquireInstanceLock(tmp.dir);
    const lockPath = probe.path;
    probe.release();
    const child = await startHolder(lockPath);
    children.push(child);
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    const lock = acquireInstanceLock(tmp.dir);
    expect(lock.held).toBe(true);
    lock.release();
  });
});
