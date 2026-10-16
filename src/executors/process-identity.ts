/**
 * Process start identity (Spec §13): PID alone is not enough, PID reuse must
 * never lead to signalling a foreign process.
 *
 * Platform-specific parts are encapsulated in {@link ProcessInspector}:
 * - Linux: `/proc/<pid>/stat` field 22 (`starttime`, clock ticks since boot)
 *   plus the boot ID (`/proc/sys/kernel/random/boot_id`); token
 *   `linux:<boot-id>:<starttime>`.
 * - macOS: `ps -o pgid=,lstart= -p <pid>` with `LC_ALL=C` and `TZ=UTC` for a
 *   stable format; token `darwin:<lstart>` (second resolution).
 *
 * Rule: whenever the identity cannot be verified, nothing is signalled.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { systemTimers, type ProcessStartIdentity, type Timers } from '../core/index.js';

/** Raw identity data of a live process. */
export interface ProcessProbe {
  pgid: number;
  token: string;
}

/**
 * Platform adapter. `probe` returns `null` if the process does not exist and
 * throws if the state cannot be determined.
 */
export interface ProcessInspector {
  readonly platform: string;
  probe(pid: number): Promise<ProcessProbe | null>;
  /**
   * Optional precise check whether group `pgid` has members that are not
   * zombies. Without it, a signal-0 probe is used (zombies count as alive).
   */
  groupHasLiveMembers?(pgid: number): Promise<boolean>;
}

/** Result of comparing a live process with a persisted identity. */
export type IdentityCheck =
  /** Same process (start token and process group match). */
  | 'same'
  /** A different process uses this PID now (PID reuse). */
  | 'different'
  /** No process with this PID exists. */
  | 'gone'
  /** Could not be determined (error, unsupported platform, changed group) — never signal. */
  | 'unknown';

/** Outcome of {@link killProcessGroupIfSame}. */
export type KillIfSameResult = { signalled: true } | { signalled: false; reason: Exclude<IdentityCheck, 'same'> | 'pgid_mismatch' | 'signal_failed'; error?: string };

/**
 * Parse the content of `/proc/<pid>/stat`. The command name (field 2) may
 * contain spaces and parentheses, so fields are counted after the last `)`.
 * Returns process group (field 5) and start time (field 22).
 */
export function parseProcStat(content: string): { state: string; pgrp: number; starttime: string } {
  const close = content.lastIndexOf(')');
  if (close === -1) throw new Error('malformed /proc stat: missing ")"');
  // Fields after comm start with field 3 (state).
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]); // field 5
  const starttime = fields[19]; // field 22
  if (!state || !Number.isInteger(pgrp) || !starttime || !/^\d+$/.test(starttime)) {
    throw new Error('malformed /proc stat: unexpected field layout');
  }
  return { state, pgrp, starttime };
}

/** Linux implementation based on procfs. */
export function createLinuxInspector(
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
  list: (path: string) => Promise<string[]> = (p) => readdir(p),
): ProcessInspector {
  let bootId: string | undefined;
  return {
    platform: 'linux',
    // Zombies (e.g. orphans while PID 1 in a container does not reap) do not count.
    async groupHasLiveMembers(pgid) {
      for (const entry of await list('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const { state, pgrp } = parseProcStat(await read(`/proc/${entry}/stat`));
          if (pgrp === pgid && state !== 'Z' && state !== 'X') return true;
        } catch {
          // Process vanished between listing and reading.
        }
      }
      return false;
    },
    async probe(pid) {
      let stat: string;
      try {
        stat = await read(`/proc/${pid}/stat`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') return null;
        throw err;
      }
      const { pgrp, starttime } = parseProcStat(stat);
      bootId ??= (await read('/proc/sys/kernel/random/boot_id')).trim();
      if (!bootId) throw new Error('empty boot id');
      return { pgid: pgrp, token: `linux:${bootId}:${starttime}` };
    },
  };
}

/** Parse the output of `ps -o pgid=,lstart= -p <pid>`. */
export function parsePsOutput(output: string): ProcessProbe | null {
  const line = output.split('\n').find((l) => l.trim() !== '');
  if (!line) return null;
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
  if (!m?.[1] || !m[2]) throw new Error(`unexpected ps output: ${line}`);
  return { pgid: Number(m[1]), token: `darwin:${m[2].replace(/\s+/g, ' ')}` };
}

/** Runs a command, resolving with exit code and stdout. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' }, timeout: 5000 },
      (err, stdout) => {
        if (err && typeof (err as { code?: unknown }).code !== 'number') {
          reject(err);
          return;
        }
        resolve({ code: err ? Number((err as { code?: unknown }).code) : 0, stdout: String(stdout) });
      },
    );
  });

/** macOS implementation based on `ps` (lstart = process start time). */
export function createDarwinInspector(run: CommandRunner = defaultRunner): ProcessInspector {
  return {
    platform: 'darwin',
    async probe(pid) {
      const { code, stdout } = await run('/bin/ps', ['-o', 'pgid=,lstart=', '-p', String(pid)]);
      const probe = parsePsOutput(stdout);
      if (code !== 0 || probe === null) {
        // ps exits 1 with empty output when the PID does not exist.
        if (stdout.trim() === '') return null;
        throw new Error(`ps exited with code ${code}`);
      }
      return probe;
    },
  };
}

/** Inspector for the current platform; probing fails on unsupported platforms. */
export function defaultProcessInspector(platform: NodeJS.Platform = process.platform): ProcessInspector {
  if (platform === 'linux') return createLinuxInspector();
  if (platform === 'darwin') return createDarwinInspector();
  return {
    platform,
    probe: () => Promise.reject(new Error(`process identity not supported on ${platform}`)),
  };
}

/**
 * Capture the start identity of `pid`. Returns `undefined` if the process
 * does not exist (anymore) or the identity cannot be determined.
 */
export async function getStartIdentity(
  pid: number,
  inspector: ProcessInspector = defaultProcessInspector(),
): Promise<ProcessStartIdentity | undefined> {
  if (!isValidPid(pid)) return undefined;
  try {
    const probe = await inspector.probe(pid);
    return probe ? { pid, pgid: probe.pgid, token: probe.token } : undefined;
  } catch {
    return undefined;
  }
}

/** Compare the live process `identity.pid` with the persisted identity. */
export async function checkProcessIdentity(
  identity: ProcessStartIdentity,
  inspector: ProcessInspector = defaultProcessInspector(),
): Promise<IdentityCheck> {
  if (!isValidPid(identity.pid) || !isValidPid(identity.pgid) || !identity.token) return 'unknown';
  let probe: ProcessProbe | null;
  try {
    probe = await inspector.probe(identity.pid);
  } catch {
    return 'unknown';
  }
  if (probe === null) return 'gone';
  if (probe.token !== identity.token) return 'different';
  // Same process but it moved to another group: group target is uncertain.
  if (probe.pgid !== identity.pgid) return 'unknown';
  return 'same';
}

/** True only if `pid` is verifiably the process described by `identity`. */
export async function isSameProcess(
  pid: number,
  identity: ProcessStartIdentity,
  inspector: ProcessInspector = defaultProcessInspector(),
): Promise<boolean> {
  if (pid !== identity.pid) return false;
  return (await checkProcessIdentity(identity, inspector)) === 'same';
}

/** Signal sender, injectable for tests (default `process.kill`). */
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

/**
 * Send `signal` to process group `pgid`, but only if its leader
 * (`identity.pid`) is verifiably the same process as recorded in `identity`
 * (Spec §13). Never signals on doubt.
 *
 * Note: if the leader is gone while other group members still run, the group
 * cannot be verified and is not signalled (reason `gone`); use
 * {@link processGroupExists} to detect that case and report it.
 */
export async function killProcessGroupIfSame(
  pgid: number,
  identity: ProcessStartIdentity,
  signal: NodeJS.Signals,
  deps: { inspector?: ProcessInspector; kill?: KillFn } = {},
): Promise<KillIfSameResult> {
  if (!isValidPid(pgid) || pgid !== identity.pgid) return { signalled: false, reason: 'pgid_mismatch' };
  const check = await checkProcessIdentity(identity, deps.inspector ?? defaultProcessInspector());
  if (check !== 'same') return { signalled: false, reason: check };
  try {
    (deps.kill ?? defaultKill)(-pgid, signal);
    return { signalled: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { signalled: false, reason: 'gone' };
    return { signalled: false, reason: 'signal_failed', error: (err as Error).message };
  }
}

/** True if at least one process is in group `pgid` (signal 0 probe; EPERM counts as existing). */
export function processGroupExists(pgid: number): boolean {
  if (!isValidPid(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True if group `pgid` still has live (non-zombie) members. Falls back to the
 * signal-0 probe if the platform has no precise check or it fails.
 */
export async function processGroupAlive(
  pgid: number,
  inspector: ProcessInspector = defaultProcessInspector(),
): Promise<boolean> {
  if (!processGroupExists(pgid)) return false;
  if (!inspector.groupHasLiveMembers) return true;
  try {
    return await inspector.groupHasLiveMembers(pgid);
  } catch {
    return true;
  }
}

/** Outcome of {@link terminateProcessGroupIfSame}. */
export type TerminateResult =
  /** Identity verified, group signalled and confirmed gone. */
  | 'terminated'
  /** Identity verified and signalled, but the group is still alive after SIGKILL. */
  | 'kill_failed'
  /** A different process uses the leader PID now; nothing signalled. */
  | 'not_same'
  /** Leader and group are gone; nothing to do. */
  | 'gone'
  /** Identity could not be determined (or pgid mismatch); nothing signalled. */
  | 'unknown'
  /**
   * The leader is gone but members of the group are still alive. They cannot
   * be verified, so nothing is signalled — caller should set `recovery_pending`.
   */
  | 'group_alive_unverifiable';

/** Options of {@link terminateProcessGroupIfSame}. */
export interface TerminateOptions {
  inspector?: ProcessInspector;
  kill?: KillFn;
  timers?: Timers;
  /** Wait after SIGKILL before reporting `kill_failed`. Default 5 s. */
  killConfirmMs?: number;
  /** Poll interval while waiting for the group to vanish. Default 25 ms. */
  pollIntervalMs?: number;
}

/**
 * Recovery helper (Spec §13, §14 variant A): verify the start identity of the
 * group leader, then SIGTERM the group, SIGKILL after `graceMs` and confirm
 * that no live member remains. Never signals on doubt.
 */
export async function terminateProcessGroupIfSame(
  identity: ProcessStartIdentity,
  graceMs: number,
  options: TerminateOptions = {},
): Promise<TerminateResult> {
  const inspector = options.inspector ?? defaultProcessInspector();
  const kill = options.kill ?? defaultKill;
  const timers = options.timers ?? systemTimers;
  const pgid = identity.pgid;
  if (!isValidPid(pgid) || !isValidPid(identity.pid)) return 'unknown';

  const check = await checkProcessIdentity(identity, inspector);
  switch (check) {
    case 'different':
      return 'not_same';
    case 'unknown':
      return 'unknown';
    case 'gone':
      return (await processGroupAlive(pgid, inspector)) ? 'group_alive_unverifiable' : 'gone';
    case 'same':
      break;
  }

  const send = (signal: NodeJS.Signals): void => {
    try {
      kill(-pgid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  };
  const waitGone = async (ms: number): Promise<boolean> => {
    const step = Math.max(1, options.pollIntervalMs ?? 25);
    for (let waited = 0; ; waited += step) {
      if (!(await processGroupAlive(pgid, inspector))) return true;
      if (waited >= ms) return false;
      await new Promise<void>((resolve) => timers.setTimeout(resolve, Math.min(step, ms - waited)));
    }
  };

  try {
    send('SIGTERM');
  } catch {
    return 'kill_failed';
  }
  if (await waitGone(graceMs)) return 'terminated';
  // The group existed continuously since verification, so its PGID cannot have been reused.
  try {
    send('SIGKILL');
  } catch {
    return 'kill_failed';
  }
  return (await waitGone(options.killConfirmMs ?? 5000)) ? 'terminated' : 'kill_failed';
}

function isValidPid(pid: number): boolean {
  // pid 0/1 and negative values would address the own group, init or all processes.
  return Number.isInteger(pid) && pid > 1;
}
