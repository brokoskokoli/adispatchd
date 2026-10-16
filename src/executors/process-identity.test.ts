import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessStartIdentity } from '../core/index.js';
import {
  checkProcessIdentity,
  createDarwinInspector,
  createLinuxInspector,
  defaultProcessInspector,
  getStartIdentity,
  isSameProcess,
  killProcessGroupIfSame,
  parseProcStat,
  parsePsOutput,
  processGroupExists,
  terminateProcessGroupIfSame,
  type ProcessInspector,
} from './process-identity.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

describe('parseProcStat', () => {
  it('extracts state, pgrp (field 5) and starttime (field 22)', () => {
    const fields = ['S', '1', '4242', '1', '0', '-1', '4194560', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', '987654', '1000'];
    const stat = `4243 (my (weird) cmd) ${fields.join(' ')}\n`;
    expect(parseProcStat(stat)).toEqual({ state: 'S', pgrp: 4242, starttime: '987654' });
  });

  it('rejects malformed content', () => {
    expect(() => parseProcStat('garbage')).toThrow();
    expect(() => parseProcStat('1 (x) S 1')).toThrow();
  });
});

describe('linux inspector (simulated procfs)', () => {
  const stat = (pgrp: number, start: string) =>
    `100 (sh) S 1 ${pgrp} ${pgrp} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000 10\n`;

  it('builds a boot-id + starttime token', async () => {
    const files: Record<string, string> = {
      '/proc/100/stat': stat(100, '5555'),
      '/proc/sys/kernel/random/boot_id': 'boot-1\n',
    };
    const inspector = createLinuxInspector(async (p) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return v;
    });
    expect(await inspector.probe(100)).toEqual({ pgid: 100, token: 'linux:boot-1:5555' });
    expect(await inspector.probe(101)).toBeNull();
  });

  it('ignores zombies when checking for live group members', async () => {
    const files: Record<string, string> = {
      '/proc/200/stat': stat(100, '1').replace('(sh) S', '(sleep) Z'),
      '/proc/201/stat': stat(300, '1'),
    };
    const read = async (p: string) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return v;
    };
    const inspector = createLinuxInspector(read, async () => ['self', '200', '201', '202']);
    expect(await inspector.groupHasLiveMembers?.(100)).toBe(false);
    expect(await inspector.groupHasLiveMembers?.(300)).toBe(true);
    files['/proc/202/stat'] = stat(100, '2');
    expect(await inspector.groupHasLiveMembers?.(100)).toBe(true);
  });

  it('propagates unexpected read errors (→ unknown, never signal)', async () => {
    const inspector = createLinuxInspector(async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    await expect(inspector.probe(100)).rejects.toThrow('denied');
    expect(await checkProcessIdentity({ pid: 100, pgid: 100, token: 'linux:x:1' }, inspector)).toBe('unknown');
  });
});

describe('darwin inspector (simulated ps)', () => {
  it('parses pgid and lstart', async () => {
    const inspector = createDarwinInspector(async () => ({ code: 0, stdout: '  4242 Fri Oct 16 21:49:48 2026\n' }));
    expect(await inspector.probe(4242)).toEqual({ pgid: 4242, token: 'darwin:Fri Oct 16 21:49:48 2026' });
  });

  it('reports a missing process as null', async () => {
    const inspector = createDarwinInspector(async () => ({ code: 1, stdout: '' }));
    expect(await inspector.probe(4242)).toBeNull();
  });

  it('parsePsOutput rejects unexpected output', () => {
    expect(() => parsePsOutput('abc')).toThrow();
    expect(parsePsOutput('\n')).toBeNull();
  });
});

describe('unsupported platform', () => {
  it('never yields an identity', async () => {
    const inspector = defaultProcessInspector('win32');
    expect(await getStartIdentity(1234, inspector)).toBeUndefined();
    expect(await checkProcessIdentity({ pid: 1234, pgid: 1234, token: 'x' }, inspector)).toBe('unknown');
  });
});

describe.runIf(supported)('real processes', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const c of children.splice(0)) {
      try {
        if (c.pid) process.kill(-c.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  async function startSleeper(): Promise<ChildProcess & { pid: number }> {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return child as ChildProcess & { pid: number };
  }

  function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
    return new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
  }

  it('captures a stable identity with pgid = pid for a detached child', async () => {
    const child = await startSleeper();
    const a = await getStartIdentity(child.pid);
    const b = await getStartIdentity(child.pid);
    expect(a).toBeDefined();
    expect(a).toEqual(b);
    expect(a?.pgid).toBe(child.pid);
    expect(a?.token.startsWith(`${process.platform}:`)).toBe(true);
    expect(await isSameProcess(child.pid, a as ProcessStartIdentity)).toBe(true);
    expect(await checkProcessIdentity(a as ProcessStartIdentity)).toBe('same');
  });

  it('does NOT kill a process with the same PID but a different start identity (PID reuse)', async () => {
    const child = await startSleeper();
    const real = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
    // Simulates a persisted identity of an earlier process that had the same PID.
    const stale: ProcessStartIdentity = { ...real, token: `${real.token}-earlier-process` };

    expect(await checkProcessIdentity(stale)).toBe('different');
    expect(await isSameProcess(child.pid, stale)).toBe(false);
    expect(await killProcessGroupIfSame(child.pid, stale, 'SIGKILL')).toEqual({ signalled: false, reason: 'different' });
    expect(processGroupExists(child.pid)).toBe(true);
    expect(child.exitCode).toBeNull();
  });

  it('does not signal on unknown identity or pgid mismatch', async () => {
    const child = await startSleeper();
    const real = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
    const failing: ProcessInspector = { platform: 'test', probe: () => Promise.reject(new Error('boom')) };
    const kills: number[] = [];
    const kill = (pid: number) => kills.push(pid);

    expect(await killProcessGroupIfSame(child.pid, real, 'SIGKILL', { inspector: failing, kill })).toEqual({
      signalled: false,
      reason: 'unknown',
    });
    expect(await killProcessGroupIfSame(child.pid + 1, real, 'SIGKILL', { kill })).toEqual({
      signalled: false,
      reason: 'pgid_mismatch',
    });
    expect(await killProcessGroupIfSame(child.pid, { ...real, pgid: 1 }, 'SIGKILL', { kill })).toMatchObject({
      signalled: false,
    });
    expect(kills).toEqual([]);
    expect(processGroupExists(child.pid)).toBe(true);
  });

  it('kills the group when the identity matches', async () => {
    const child = await startSleeper();
    const real = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
    const exit = exited(child);
    expect(await killProcessGroupIfSame(child.pid, real, 'SIGTERM')).toEqual({ signalled: true });
    expect(await exit).toBe('SIGTERM');
  });

  it('reports gone processes', async () => {
    const child = await startSleeper();
    const real = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
    const exit = exited(child);
    process.kill(-child.pid, 'SIGKILL');
    await exit;
    expect(await getStartIdentity(child.pid)).toBeUndefined();
    expect(await checkProcessIdentity(real)).toBe('gone');
    expect(await killProcessGroupIfSame(child.pid, real, 'SIGKILL')).toEqual({ signalled: false, reason: 'gone' });
    expect(processGroupExists(child.pid)).toBe(false);
  });

  async function startShell(script: string): Promise<ChildProcess & { pid: number }> {
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return child as ChildProcess & { pid: number };
  }

  function firstLine(child: ChildProcess): Promise<string> {
    return new Promise((resolve) => {
      let buf = '';
      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('\n')) resolve(buf.split('\n')[0] as string);
      });
    });
  }

  describe('terminateProcessGroupIfSame (recovery)', () => {
    it('terminates a verified group including background members', async () => {
      const child = await startShell('sleep 30 & echo $!; wait');
      const bg = Number(await firstLine(child));
      const identity = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
      expect(await terminateProcessGroupIfSame(identity, 500)).toBe('terminated');
      expect(processGroupExists(child.pid)).toBe(false);
      expect(() => process.kill(bg, 0)).toThrow();
    });

    it('escalates to SIGKILL when SIGTERM is ignored', async () => {
      const child = await startShell("trap '' TERM; sleep 30 & echo ready; wait; wait");
      await firstLine(child);
      const identity = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
      const before = Date.now();
      expect(await terminateProcessGroupIfSame(identity, 150)).toBe('terminated');
      expect(Date.now() - before).toBeGreaterThanOrEqual(100);
      expect(processGroupExists(child.pid)).toBe(false);
    });

    it('does not touch a process with the same PID but another identity', async () => {
      const child = await startSleeper();
      const real = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
      expect(await terminateProcessGroupIfSame({ ...real, token: 'linux:other:1' }, 100)).toBe('not_same');
      expect(processGroupExists(child.pid)).toBe(true);
      const failing: ProcessInspector = { platform: 'test', probe: () => Promise.reject(new Error('boom')) };
      expect(await terminateProcessGroupIfSame(real, 100, { inspector: failing })).toBe('unknown');
      expect(processGroupExists(child.pid)).toBe(true);
    });

    it('reports a live group whose leader is gone as unverifiable and does not signal it', async () => {
      // Leader waits for stdin, then exits and leaves its background member behind.
      const child = await startShell('sleep 30 & echo $!; read x; exit 0');
      const bg = Number(await firstLine(child));
      const identity = (await getStartIdentity(child.pid)) as ProcessStartIdentity;
      const exit = exited(child);
      child.stdin?.end('go\n');
      await exit;
      expect(await terminateProcessGroupIfSame(identity, 100)).toBe('group_alive_unverifiable');
      expect(() => process.kill(bg, 0)).not.toThrow();
    });

    it('reports gone groups and kill failures', async () => {
      const gone = await startSleeper();
      const goneIdentity = (await getStartIdentity(gone.pid)) as ProcessStartIdentity;
      const exit = exited(gone);
      process.kill(-gone.pid, 'SIGKILL');
      await exit;
      expect(await terminateProcessGroupIfSame(goneIdentity, 100)).toBe('gone');

      const stuck = await startSleeper();
      const identity = (await getStartIdentity(stuck.pid)) as ProcessStartIdentity;
      const result = await terminateProcessGroupIfSame(identity, 30, { kill: () => undefined, killConfirmMs: 60 });
      expect(result).toBe('kill_failed');
      expect(processGroupExists(stuck.pid)).toBe(true);
    });
  });

  it('rejects dangerous pids', async () => {
    expect(await getStartIdentity(0)).toBeUndefined();
    expect(await getStartIdentity(1)).toBeUndefined();
    expect(processGroupExists(0)).toBe(false);
    expect(await killProcessGroupIfSame(1, { pid: 1, pgid: 1, token: 'x' }, 'SIGKILL')).toMatchObject({ signalled: false });
  });
});
