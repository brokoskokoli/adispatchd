import { describe, expect, it } from 'vitest';
import { createProgram, EXIT_NOT_IMPLEMENTED, type CliIo } from './program.js';

function captureIo(): CliIo & { out: string[]; err: string[]; code: number | undefined } {
  const io = {
    out: [] as string[],
    err: [] as string[],
    code: undefined as number | undefined,
    stdout: (t: string) => io.out.push(t),
    stderr: (t: string) => io.err.push(t),
    setExitCode: (c: number) => {
      io.code = c;
    },
  };
  return io;
}

describe('cli program', () => {
  it('declares all spec commands', () => {
    const program = createProgram({}, captureIo());
    const names = program.commands.flatMap((c) =>
      c.commands.length ? c.commands.map((s) => `${c.name()} ${s.name()}`) : [c.name()],
    );
    expect(names).toEqual([
      'init',
      'start',
      'status',
      'pause',
      'resume',
      'drain',
      'cancel-all',
      'config validate',
      'config reload',
      'workflow dry-run',
      'auth hash-password',
      'service install',
      'service status',
      'service uninstall',
    ]);
  });

  it('passes global options to handlers, also when given after the subcommand', async () => {
    const io = captureIo();
    let seen: unknown;
    const program = createProgram(
      {
        workflowDryRun: async (id, opts) => {
          seen = { id, ...opts };
          return 0;
        },
      },
      io,
    );
    await program.parseAsync(['--config-dir', './cfg', 'workflow', 'dry-run', 'coder', '--data-dir', './data'], {
      from: 'user',
    });
    expect(seen).toEqual({ id: 'coder', configDir: './cfg', dataDir: './data' });
  });

  it('passes command options with defaults', async () => {
    const io = captureIo();
    const seen: Record<string, unknown> = {};
    const program = createProgram(
      {
        start: async (opts) => {
          seen.start = opts;
          return 0;
        },
        drain: async (opts) => {
          seen.drain = opts;
          return 0;
        },
        serviceInstall: async (opts) => {
          seen.install = opts;
          return 0;
        },
      },
      io,
    );
    await program.parseAsync(['start', '--config-dir', 'c', '--drain-timeout', '1h'], { from: 'user' });
    expect(seen.start).toEqual({ configDir: 'c', drainTimeout: '1h', cancelTimeout: '2m' });
    await createProgram({ drain: async (o) => ((seen.drain = o), 0) }, io).parseAsync(['drain', '--url', 'http://x:1', '--wait'], { from: 'user' });
    expect(seen.drain).toEqual({ url: 'http://x:1', wait: true });
    await createProgram({ serviceInstall: async (o) => ((seen.install = o), 0) }, io).parseAsync(
      ['service', 'install', '--dry-run', '--config-dir', '/etc/o', '--data-dir', '/var/lib/o', '--create-user'],
      { from: 'user' },
    );
    expect(seen.install).toMatchObject({
      dryRun: true,
      createUser: true,
      user: 'adispatchd',
      name: 'adispatchd',
      unitDir: '/etc/systemd/system',
      drainTimeout: '10m',
      cancelTimeout: '2m',
      configDir: '/etc/o',
      dataDir: '/var/lib/o',
    });
    expect(io.code).toBe(0);
  });

  it('reports unimplemented commands', async () => {
    const io = captureIo();
    await createProgram({}, io).parseAsync(['start'], { from: 'user' });
    expect(io.code).toBe(EXIT_NOT_IMPLEMENTED);
    expect(io.err.join('')).toContain('not implemented');
  });
});
