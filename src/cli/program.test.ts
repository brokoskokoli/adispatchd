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
      'config validate',
      'config reload',
      'workflow dry-run',
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
    expect(io.code).toBe(0);
  });

  it('reports unimplemented commands', async () => {
    const io = captureIo();
    await createProgram({}, io).parseAsync(['start'], { from: 'user' });
    expect(io.code).toBe(EXIT_NOT_IMPLEMENTED);
    expect(io.err.join('')).toContain('not implemented');
  });
});
