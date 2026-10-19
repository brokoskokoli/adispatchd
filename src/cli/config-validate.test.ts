import { afterEach, describe, expect, it } from 'vitest';
import { BASE_FILES, createTempConfigDir, EXAMPLE_CONFIG_DIR, type TempConfigDir } from '../config/testing/fixtures.js';
import { createProgram, type CliIo } from './program.js';
import { createConfigValidateHandler } from './config-validate.js';

const temps: TempConfigDir[] = [];
afterEach(async () => {
  while (temps.length) await temps.pop()?.cleanup();
});

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

async function run(args: string[]): Promise<ReturnType<typeof captureIo>> {
  const io = captureIo();
  await createProgram({ configValidate: createConfigValidateHandler(io) }, io).parseAsync(args, { from: 'user' });
  return io;
}

describe('config validate', () => {
  it('exits 0 for examples/config', async () => {
    const io = await run(['config', 'validate', '--config-dir', EXAMPLE_CONFIG_DIR]);
    expect(io.code).toBe(0);
    expect(io.out).toMatch(/is valid: 4 workflow\(s\), 2 view\(s\), 1 named filter\(s\), 2 source\(s\), 3 identities/);
    expect(io.err).toBe('');
  });

  it('exits 1 and lists errors with file, line and path', async () => {
    const t = await createTempConfigDir({
      ...BASE_FILES,
      'workflows/wf.yaml': 'id: wf\ntrigger: { type: schedule, cron: "nope" }\nexecute:\n  type: shell\n  command: /bin/true\n',
    });
    temps.push(t);
    const io = await run(['config', 'validate', '--config-dir', t.dir]);
    expect(io.code).toBe(1);
    expect(io.err).toMatch(/invalid, 1 error\(s\):\n {2}workflows\/wf\.yaml:2: trigger\.cron: Invalid cron expression "nope"/);
  });

  it('exits 0 with a warning for an unused named filter (WI-15)', async () => {
    const t = await createTempConfigDir({
      ...BASE_FILES,
      'filters/spare.yaml': 'id: spare\nfilter: { field: labels, operator: contains, value: x }\n',
    });
    temps.push(t);
    const io = await run(['config', 'validate', '--config-dir', t.dir]);
    expect(io.code).toBe(0);
    expect(io.err).toMatch(/1 warning\(s\):\n {2}filters\/spare\.yaml:1: warning: id: Named filter "spare" is not used by any workflow or view/);
    expect(io.out).toMatch(/1 named filter\(s\)/);
  });

  it('exits 1 without --config-dir', async () => {
    const io = await run(['config', 'validate']);
    expect(io.code).toBe(1);
    expect(io.err).toMatch(/--config-dir is required/);
  });
});
