import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, HUB_SOCKET_ENV, HUB_TRUST_ENV, HUB_WORKSPACE_ENV } from '../core/index.js';
import type { HubWorkspaceConfig } from '../config/index.js';
import { HubError } from './errors.js';
import { WorkspaceSupervisor, type SupervisorOptions } from './supervisor.js';
import { FakeSpawner } from './testing/fakes.js';

const WS = (id: string, port: number, enabled = true): HubWorkspaceConfig => ({ id, configDir: `/cfg/${id}`, dataDir: `/data/${id}`, port, enabled });

let clock: FakeClock;
let spawner: FakeSpawner;
let lines: string[];
let exited: string[];
let controlCalls: Array<[string, string]>;
let controlOk: boolean;
let probeOk: boolean;

function make(extra: Partial<SupervisorOptions> = {}): WorkspaceSupervisor {
  return new WorkspaceSupervisor({
    workspaces: [WS('coder', 8091), WS('docs', 8092), WS('off', 8093, false)],
    slotSocketPath: '/hub/slots.sock',
    spawner,
    probe: async () => probeOk,
    control: async (w, action) => {
      controlCalls.push([w.id, action]);
      return controlOk;
    },
    output: (id, stream, line) => lines.push(`${id}/${stream}: ${line}`),
    onExit: (id) => exited.push(id),
    clock,
    timers: clock,
    drainTimeoutMs: 60_000,
    cancelTimeoutMs: 10_000,
    backoff: { initialMs: 1_000, maxMs: 8_000, stableAfterMs: 30_000 },
    probeIntervalMs: 100,
    killGraceMs: 5_000,
    ...extra,
  });
}

beforeEach(() => {
  clock = new FakeClock();
  spawner = new FakeSpawner();
  lines = [];
  exited = [];
  controlCalls = [];
  controlOk = true;
  probeOk = true;
});

const states = (s: WorkspaceSupervisor): Record<string, string> => Object.fromEntries(s.status().map((w) => [w.id, w.state]));

describe('WorkspaceSupervisor', () => {
  it('starts enabled workspaces with the CLI arguments and the hub environment, and reports running after the probe', async () => {
    const s = make({ baseEnv: { PATH: '/bin', MY_KEY: 'x' } });
    s.startEnabled();
    expect(states(s)).toEqual({ coder: 'starting', docs: 'starting', off: 'stopped' });
    const child = spawner.last('coder');
    expect(child.spec.args).toEqual([
      'start', '--config-dir', '/cfg/coder', '--data-dir', '/data/coder', '--host', '127.0.0.1', '--port', '8091', '--drain-timeout', '1m', '--cancel-timeout', '10s',
    ]);
    expect(child.spec.env).toMatchObject({ PATH: '/bin', MY_KEY: 'x', [HUB_SOCKET_ENV]: '/hub/slots.sock', [HUB_WORKSPACE_ENV]: 'coder' });
    await clock.advanceAsync(100);
    expect(states(s)).toEqual({ coder: 'running', docs: 'running', off: 'stopped' });
    expect(s.statusOfWorkspace('coder')).toMatchObject({ pid: 1000, port: 8091, restarts: 0, crashes: 0, startedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('hands every child a fresh secret on standard input, keeps it out of env, args and status, and forgets it on exit (WI-36)', () => {
    const s = make();
    s.startEnabled();
    const first = spawner.last('coder');
    const token = s.trustTokenOf('coder');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.spec.input).toBe(`${token}\n`);
    expect(first.spec.env[HUB_TRUST_ENV]).toBe('stdin');
    expect(JSON.stringify(first.spec.env)).not.toContain(token as string);
    expect(first.spec.args.join(' ')).not.toContain(token as string);
    expect(JSON.stringify(s.status())).not.toContain(token as string);
    expect(s.trustTokenOf('docs')).not.toBe(token);
    expect(s.trustTokenOf('off')).toBeNull();
    first.exit(1);
    expect(s.trustTokenOf('coder')).toBeNull();
    clock.advance(1_000);
    expect(s.trustTokenOf('coder')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.trustTokenOf('coder')).not.toBe(token);
  });

  it('forwards complete output lines per workspace and stream', () => {
    const s = make();
    s.startEnabled();
    const c = spawner.last('coder');
    c.emit('stdout', 'hel');
    c.emit('stdout', 'lo\nsecond\npart');
    c.emit('stderr', 'oops\n');
    c.exit(0);
    expect(lines).toEqual(['coder/stdout: hello', 'coder/stdout: second', 'coder/stderr: oops', 'coder/stdout: part']);
  });

  it('restarts a crashed child with exponential backoff, counts crashes, and resets after a stable period', async () => {
    const s = make();
    s.startEnabled();
    await clock.advanceAsync(100);
    spawner.last('coder').exit(1);
    expect(exited).toEqual(['coder']);
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'backoff', crashes: 1, nextRestartAt: '2026-01-01T00:00:01.100Z', lastExit: { code: 1 } });
    expect(s.statusOfWorkspace('coder').message).toContain('restarting in 1s');
    // The other workspace is not affected.
    expect(s.statusOfWorkspace('docs').state).toBe('running');
    await clock.advanceAsync(1_000);
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'starting', restarts: 1 });
    // second crash right away: 2 s; third: 4 s; capped at 8 s
    spawner.last('coder').exit(null, 'SIGSEGV');
    expect(s.statusOfWorkspace('coder').nextRestartAt).toBe('2026-01-01T00:00:03.100Z');
    await clock.advanceAsync(2_000);
    spawner.last('coder').exit(1);
    await clock.advanceAsync(4_000);
    spawner.last('coder').exit(1);
    await clock.advanceAsync(8_000);
    spawner.last('coder').exit(1);
    expect(Date.parse(s.statusOfWorkspace('coder').nextRestartAt as string) - clock.nowMs()).toBe(8_000);
    // After a stable run the counter resets.
    await clock.advanceAsync(8_000);
    await clock.advanceAsync(100); // probe → running
    await clock.advanceAsync(30_000);
    spawner.last('coder').exit(1);
    expect(Date.parse(s.statusOfWorkspace('coder').nextRestartAt as string) - clock.nowMs()).toBe(1_000);
    expect(s.statusOfWorkspace('coder').crashes).toBe(6);
  });

  it('does not restart after exit code 78 (failed) or after a clean exit 0 (stopped)', async () => {
    probeOk = false;
    const s = make();
    s.startEnabled();
    spawner.last('coder').exit(78);
    spawner.last('docs').exit(0);
    await clock.advanceAsync(120_000);
    expect(states(s)).toMatchObject({ coder: 'failed', docs: 'stopped' });
    expect(s.statusOfWorkspace('coder').message).toContain('exit code 78');
    expect(spawner.of('coder')).toHaveLength(1);
    // `start` takes a failed workspace up again.
    s.start('coder');
    expect(s.statusOfWorkspace('coder').state).toBe('starting');
  });

  it('marks a workspace failed when the process cannot be started', () => {
    const s = make();
    spawner.failNext = new Error('spawn node ENOENT');
    s.startEnabled();
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'failed', message: 'cannot start the process: spawn node ENOENT' });
    expect(s.statusOfWorkspace('docs').state).toBe('starting');
  });

  it('start/stop/drain are state-checked; unknown workspaces are rejected', async () => {
    const s = make();
    s.startEnabled();
    expect(() => s.start('coder')).toThrow(HubError);
    expect(() => s.start('nope')).toThrow(/Unknown workspace/);
    expect(s.start('off').state).toBe('starting'); // a disabled workspace can be started by hand
  });

  it('drain: asks the control API, the child exits, the workspace stays stopped', async () => {
    const s = make();
    s.startEnabled();
    await clock.advanceAsync(100);
    const p = s.drain('coder');
    await p;
    expect(controlCalls).toEqual([['coder', 'drain']]);
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'running', transition: 'draining' });
    spawner.last('coder').exit(0);
    await clock.advanceAsync(120_000);
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'stopped', transition: null });
    expect(spawner.of('coder')).toHaveLength(1);
    expect(s.statusOfWorkspace('docs').state).toBe('running');
  });

  it('stop: cancel-all through the API; falls back to SIGTERM when the API does not answer; SIGKILL when the child hangs', async () => {
    controlOk = false;
    const s = make();
    s.startEnabled();
    await clock.advanceAsync(100);
    await s.stop('coder');
    expect(controlCalls).toEqual([['coder', 'cancel-all']]);
    expect(spawner.last('coder').signals).toEqual(['SIGTERM', 'SIGTERM']);
    // Hangs: killed after drain + cancel timeout + grace.
    await clock.advanceAsync(60_000 + 10_000 + 5_000);
    expect(spawner.last('coder').signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL']);
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'stopped', crashes: 0 });
  });

  it('stop/drain of a backing-off or failed workspace cancels the restart', async () => {
    const s = make();
    s.startEnabled();
    spawner.last('coder').exit(1);
    expect(s.statusOfWorkspace('coder').state).toBe('backoff');
    await s.stop('coder');
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'stopped', nextRestartAt: null });
    await clock.advanceAsync(60_000);
    expect(spawner.of('coder')).toHaveLength(1);
  });

  it('restart: SIGTERM, then a new child as soon as the old one exited', async () => {
    const s = make();
    s.startEnabled();
    await clock.advanceAsync(100);
    await s.restart('coder');
    expect(s.statusOfWorkspace('coder').transition).toBe('restarting');
    const first = spawner.last('coder');
    expect(first.signals).toEqual(['SIGTERM']);
    first.exit(0);
    expect(spawner.of('coder')).toHaveLength(2);
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'starting', transition: null, crashes: 0 });
  });

  it('shutdown: no restarts, one SIGTERM per child, a second call (cancel) one more; resolves when all exited', async () => {
    const s = make();
    s.startEnabled();
    await clock.advanceAsync(100);
    spawner.last('docs').exit(1); // in backoff
    let done = false;
    const p = s.shutdown('drain').then(() => (done = true));
    expect(spawner.last('coder').signals).toEqual(['SIGTERM']);
    expect(states(s).docs).toBe('stopped');
    void s.shutdown('cancel');
    void s.shutdown('cancel');
    expect(spawner.last('coder').signals).toEqual(['SIGTERM', 'SIGTERM']);
    await Promise.resolve();
    expect(done).toBe(false);
    spawner.last('coder').exit(0);
    await p;
    expect(done).toBe(true);
    expect(() => s.start('coder')).toThrow(/shutting down/);
    await clock.advanceAsync(300_000);
    expect(spawner.of('docs')).toHaveLength(1);
    expect(s.runningCount()).toBe(0);
  });

  it('shutdown kills a child that ignores the signals after the deadline', async () => {
    const s = make();
    s.startEnabled();
    const p = s.shutdown('drain');
    await clock.advanceAsync(60_000 + 10_000 + 5_000);
    await p;
    expect(spawner.of('coder')[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('forceStop sends another SIGTERM and then SIGKILL', async () => {
    const s = make();
    s.startEnabled();
    const p = s.forceStop(1_000);
    expect(spawner.last('coder').signals).toEqual(['SIGTERM']);
    await clock.advanceAsync(1_000);
    await p;
    expect(spawner.last('coder').signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('an asynchronous spawn error (ENOENT) is failed, not a crash loop', async () => {
    const s = make();
    s.startEnabled();
    spawner.last('coder').exit(null, null, 'spawn node ENOENT');
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'failed', crashes: 0, message: 'cannot start the process: spawn node ENOENT' });
    await clock.advanceAsync(120_000);
    expect(spawner.of('coder')).toHaveLength(1);
  });

  it('exit 78 while an instance answers on the port is reported as already running outside the hub', async () => {
    const s = make();
    s.startEnabled();
    spawner.last('coder').exit(78);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.statusOfWorkspace('coder')).toMatchObject({ state: 'failed' });
    expect(s.statusOfWorkspace('coder').message).toContain('already running for this workspace outside the hub');
    probeOk = false;
    spawner.last('docs').exit(78);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.statusOfWorkspace('docs').message).toContain('exit code 78');
  });
});
