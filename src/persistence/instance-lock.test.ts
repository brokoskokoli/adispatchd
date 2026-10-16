import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceLockedError } from './errors.js';
import { acquireInstanceLock } from './instance-lock.js';
import { tempDataDir } from './testing/helpers.js';

/** Child fixture running the real `acquireInstanceLock` (via tsx). */
const CHILD = fileURLToPath(new URL('./testing/lock-child.ts', import.meta.url));

function childArgs(dataDir: string, mode: string, extra: string[] = []): string[] {
  return [...extra, '--import', 'tsx', CHILD, dataDir, mode];
}

/** Try to take the lock from a fresh process; resolves `locked` or `busy`. */
function probeFromChild(dataDir: string): Promise<string> {
  const child = spawn(process.execPath, childArgs(dataDir, 'probe'), { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.once('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`probe failed (${code}): ${err}`))));
  });
}

/** Start a child that acquires and holds the lock until killed. */
function startHolder(dataDir: string, mode: 'hold' | 'hold-gc' = 'hold'): Promise<ChildProcess> {
  const extra = mode === 'hold-gc' ? ['--expose-gc'] : [];
  const child = spawn(process.execPath, childArgs(dataDir, mode, extra), { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout!.once('data', () => resolve(child));
    child.once('exit', (code) => reject(new Error(`holder exited early (${code}): ${stderr}`)));
  });
}

describe('acquireInstanceLock', () => {
  let tmp = tempDataDir();
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
    tmp.cleanup();
    tmp = tempDataDir();
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
    expect(await probeFromChild(tmp.dir)).toBe('busy');
    lock.release();
    expect(await probeFromChild(tmp.dir)).toBe('locked');
  });

  it('rejects while another live process holds the lock', async () => {
    children.push(await startHolder(tmp.dir));
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
    expect(await probeFromChild(tmp.dir)).toBe('busy');
  });

  it('keeps the lock when the holder drops its handle and GC runs', async () => {
    children.push(await startHolder(tmp.dir, 'hold-gc'));
    expect(await probeFromChild(tmp.dir)).toBe('busy');
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
  });

  it('takes over the lock left by a killed process (stale lock)', async () => {
    const child = await startHolder(tmp.dir);
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
