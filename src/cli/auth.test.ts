/**
 * WI-26 on the CLI side: control commands against an instance with
 * authentication (control token from the data dir), `auth hash-password`.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parsePasswordHash, verifyPassword } from '../api/index.js';
import { authEnvSetup, FAST_AUTH, PASSWORD_AUTH_CONFIG } from '../api/testing/auth.js';
import { startAppEnv, type AppEnv } from '../api/testing/helpers.js';
import { createHashPasswordHandler, type PasswordInput } from './auth.js';
import { createConfigReloadHandler, createSchedulerHandler, createShutdownHandler, createStatusHandler } from './control.js';
import { ApiClient, isLoopbackUrl, resolveControlToken } from './http-client.js';
import { createProgram, type CliHandlers, type CliIo } from './program.js';
import { createWorkflowDryRunHandler } from './workflow-dry-run.js';

function captureIo(): CliIo & { out: string; err: string; code: number | undefined } {
  const io = {
    out: '',
    err: '',
    code: undefined as number | undefined,
    stdout: (t: string) => {
      io.out += t;
    },
    stderr: (t: string) => {
      io.err += t;
    },
    setExitCode: (c: number) => {
      io.code = c;
    },
  };
  return io;
}

async function cli(args: string[], make: (io: CliIo) => CliHandlers) {
  const io = captureIo();
  await createProgram(make(io), io).parseAsync(args, { from: 'user' });
  return io;
}

const handlers = (io: CliIo): CliHandlers => ({
  status: createStatusHandler(io),
  pause: createSchedulerHandler('pause', io),
  resume: createSchedulerHandler('resume', io),
  drain: createShutdownHandler('drain', io, { pollIntervalMs: 20 }),
  configReload: createConfigReloadHandler(io),
  workflowDryRun: createWorkflowDryRunHandler(io),
});

describe('control commands with auth.mode: password', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv(
      {
        configExtra: PASSWORD_AUTH_CONFIG,
        app: FAST_AUTH,
        workflows: { hello: 'id: hello\nname: Hello\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/echo, args: [hi] }\n' },
      },
      authEnvSetup,
    );
  });
  afterAll(async () => env?.cleanup());

  it('status, pause, resume, config reload and dry-run work with the control token of --data-dir', async () => {
    const base = ['--url', env.app.url!, '--data-dir', env.dataDir];
    const status = await cli(['status', ...base], handlers);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain('scheduler:');
    expect((await cli(['pause', ...base], handlers)).code).toBe(0);
    expect(env.app.controller.status.paused).toBe(true);
    expect((await cli(['resume', ...base], handlers)).code).toBe(0);
    expect((await cli(['config', 'reload', ...base], handlers)).code).toBe(0);
    const dry = await cli(['workflow', 'dry-run', 'hello', ...base], handlers);
    expect(dry.code, dry.err).toBe(0);
    // Audit: the CLI appears as "control-token" in the daemon log.
    expect(env.logger.records.some((r) => r.msg === 'api write' && r.fields.actor === 'control-token' && r.fields.via === 'control_token')).toBe(true);
  });

  it('without the token: 401 with a hint (exit 1); the token never goes to remote URLs', async () => {
    const io = await cli(['status', '--url', env.app.url!, '--data-dir', `${env.root}/no-such-dir`], handlers);
    expect(io.code).toBe(1);
    expect(io.err).toContain('HTTP 401, authentication_required');
    expect(io.err).toMatch(/hint: .*--data-dir/);
    expect(resolveControlToken(env.app.url!, { dataDir: env.dataDir })?.token).toBe(env.app.auth.controlToken);
    expect(resolveControlToken('https://adispatchd.example.com', { dataDir: env.dataDir })).toBeNull();
    expect(isLoopbackUrl('http://[::1]:8787')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1')).toBe(true);
    expect(isLoopbackUrl('http://127.evil.example')).toBe(false);
    const seen: Array<Record<string, string>> = [];
    const fake = async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response('{}', { status: 200 });
    };
    await new ApiClient('https://remote.example.com', { fetch: fake, controlToken: 'secret' }).get('/x');
    await new ApiClient('http://127.0.0.1:9', { fetch: fake, controlToken: 'secret' }).get('/x');
    expect(seen[0]).not.toHaveProperty('x-adispatch-control-token');
    expect(seen[1]).toHaveProperty('x-adispatch-control-token', 'secret');
  });

  it('a stale token gives a clear hint', async () => {
    const original = env.app.auth.controlToken;
    const io = captureIo();
    const res = await createStatusHandler(io, {
      fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-adispatch-control-token': `${original.slice(0, -1)}x` } }),
    })({ url: env.app.url!, dataDir: env.dataDir });
    expect(res).toBe(1);
    expect(io.err).toContain('invalid_control_token');
    expect(io.err).toMatch(/hint: the control token is outdated/);
  });
});

/** Fake terminal: emits the keystrokes once raw mode is on. */
class FakeTty extends EventEmitter implements PasswordInput {
  isTTY = true;
  raw: boolean[] = [];
  constructor(private readonly answers: string[]) {
    super();
  }
  setRawMode(mode: boolean): void {
    this.raw.push(mode);
    if (mode) {
      const next = this.answers.shift();
      if (next !== undefined) setImmediate(() => this.emit('data', Buffer.from(next)));
    }
  }
  resume(): void {}
  pause(): void {}
}

describe('auth hash-password', () => {
  it('terminal: asks twice without echo, prints only the hash', async () => {
    const io = captureIo();
    const tty = new FakeTty(['correct horse battery\r', 'correct horse battery\r']);
    const code = await createHashPasswordHandler(io, { stdin: tty })();
    expect(code).toBe(0);
    expect(tty.raw).toEqual([true, false, true, false]);
    const hash = io.out.trim();
    expect(hash).toMatch(/^scrypt:32768:8:1:/);
    expect(await verifyPassword('correct horse battery', parsePasswordHash(hash)!)).toBe(true);
    expect(io.out + io.err).not.toContain('correct horse');
    expect(io.err).toContain('Password: ');
  });

  it('terminal: mismatch → 1, Ctrl-C → 130, backspace edits', async () => {
    const hash = vi.fn(async (pw: string) => `H(${pw.length})`);
    const mismatch = captureIo();
    expect(await createHashPasswordHandler(mismatch, { stdin: new FakeTty(['password-1\r', 'password-2\r']), hash })()).toBe(1);
    expect(mismatch.err).toContain('do not match');
    expect(await createHashPasswordHandler(captureIo(), { stdin: new FakeTty(['\u0003']), hash })()).toBe(130);
    const edited = captureIo();
    expect(await createHashPasswordHandler(edited, { stdin: new FakeTty(['passwordX\u007f1\r', 'password1\r']), hash })()).toBe(0);
    expect(hash).toHaveBeenLastCalledWith('password1');
  });

  it('pipe: first line of stdin; rejects short and multi-line input', async () => {
    const run = async (input: string) => {
      const stdin = new PassThrough();
      const io = captureIo();
      const p = createHashPasswordHandler(io, { stdin: stdin as unknown as PasswordInput, hash: async (pw) => `H:${pw}` })();
      stdin.end(input);
      return { code: await p, io };
    };
    const ok = await run('long-enough-pw\n');
    expect(ok.code).toBe(0);
    expect(ok.io.out).toBe('H:long-enough-pw\n');
    expect((await run('short\n')).code).toBe(1);
    expect((await run('line-one-long\nline-two-long\n')).code).toBe(1);
  });

  it('is part of the command tree', async () => {
    const io = await cli(['auth', 'hash-password'], () => ({}));
    expect(io.code).toBe(70);
    expect(io.err).toContain('"auth hash-password" is not implemented');
  });
});
