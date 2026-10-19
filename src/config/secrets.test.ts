/** WI-18: `secrets` with `delivery` for `execute` and `shell` actions – schema, normalization and validation. */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, snapshotWorkflow, type ConfigIssue, type LoadConfigResult } from './index.js';
import { BASE_FILES, createTempConfigDir, type TempConfigDir } from './testing/fixtures.js';

const text = (i: ConfigIssue): string => `${i.file}: ${i.path}: ${i.message}`;

function workflow(execute: string, hooks = ''): string {
  return `id: w
trigger: { type: source, source: repo_a }
execute:
  type: shell
  command: /bin/true
${execute}
${hooks}`;
}

describe('secrets delivery (WI-18)', () => {
  const temps: TempConfigDir[] = [];
  afterEach(async () => {
    while (temps.length) await temps.pop()?.cleanup();
  });

  async function load(wf: string): Promise<LoadConfigResult> {
    const t = await createTempConfigDir({ ...BASE_FILES, 'workflows/w.yaml': wf });
    temps.push(t);
    return loadConfig(t.dir, { dataDir: t.dataDir });
  }

  async function errors(wf: string): Promise<string[]> {
    const res = await load(wf);
    return res.ok ? [] : res.errors.map(text);
  }

  it('defaults to env and accepts file, for execute and shell actions', async () => {
    const res = await load(
      workflow(
        ['  secrets:', '    GH_TOKEN: { identity: coder }', '    REVIEW_TOKEN: { identity: maintainer, delivery: file }'].join('\n'),
        [
          'on_success:',
          '  - type: shell',
          '    command: /bin/true',
          '    secrets:',
          '      GH_TOKEN: { identity: coder, delivery: file }',
          '  - type: shell',
          '    command: /bin/true',
        ].join('\n'),
      ),
    );
    expect(res.ok, res.ok ? '' : res.errors.map(text).join('\n')).toBe(true);
    if (!res.ok) return;
    const wf = res.config.workflows.w!;
    expect(wf.execute.secrets).toEqual({
      GH_TOKEN: { identity: 'coder', delivery: 'env' },
      REVIEW_TOKEN: { identity: 'maintainer', delivery: 'file' },
    });
    const [first, second] = wf.hooks.on_success;
    expect(first?.type === 'shell' && first.secrets).toEqual({ GH_TOKEN: { identity: 'coder', delivery: 'file' } });
    expect(second?.type === 'shell' && second.secrets).toEqual({});
    expect(snapshotWorkflow(res.config, 'w').identityRefs).toEqual(['coder', 'maintainer']);
  });

  it('rejects an unknown delivery with a suggestion', async () => {
    const errs = await errors(workflow('  secrets:\n    GH_TOKEN: { identity: coder, delivery: fiel }'));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/workflows\/w\.yaml: execute\.secrets\.GH_TOKEN\.delivery: .*"env".*"file".*\(did you mean "file"\?\)/);
  });

  it('rejects unknown identities with path and suggestion (execute and actions)', async () => {
    const errs = await errors(
      workflow(
        '  secrets:\n    GH_TOKEN: { identity: codr, delivery: file }',
        'on_failure:\n  - type: shell\n    command: /bin/true\n    secrets:\n      T: { identity: nobody-at-all }',
      ),
    );
    expect(errs).toEqual([
      'workflows/w.yaml: execute.secrets.GH_TOKEN.identity: Unknown identity "codr" (did you mean "coder"?)',
      'workflows/w.yaml: on_failure[0].secrets.T.identity: Unknown identity "nobody-at-all"',
    ]);
  });

  it('<NAME>_FILE must not clash with env or other secret names', async () => {
    const errs = await errors(
      workflow(
        [
          '  env:',
          '    GH_TOKEN_FILE: /tmp/x',
          '  secrets:',
          '    GH_TOKEN: { identity: coder, delivery: file }',
          '    OTHER: { identity: coder, delivery: file }',
          '    OTHER_FILE: { identity: coder }',
        ].join('\n'),
        [
          'on_success:',
          '  - type: shell',
          '    command: /bin/true',
          '    env: { A_FILE: x }',
          '    secrets:',
          '      A: { identity: coder, delivery: file }',
          '      B: { identity: coder }',
          '    ',
        ].join('\n'),
      ),
    );
    expect(errs).toEqual([
      'workflows/w.yaml: execute.secrets.GH_TOKEN.delivery: "delivery: file" sets "GH_TOKEN_FILE", which is also defined in "env"',
      'workflows/w.yaml: execute.secrets.OTHER.delivery: "delivery: file" sets "OTHER_FILE", which is also a secret name',
      'workflows/w.yaml: on_success[0].secrets.A.delivery: "delivery: file" sets "A_FILE", which is also defined in "env"',
    ]);
  });

  it('applies the env/secret rules to shell actions too (reserved prefix, duplicate in env)', async () => {
    const errs = await errors(
      workflow(
        '',
        [
          'on_success:',
          '  - type: shell',
          '    command: /bin/true',
          '    env: { GH_TOKEN: x }',
          '    secrets:',
          '      GH_TOKEN: { identity: coder }',
          '      ADISPATCH_TOKEN: { identity: coder }',
        ].join('\n'),
      ),
    );
    expect(errs.sort()).toEqual([
      'workflows/w.yaml: on_success[0].secrets.ADISPATCH_TOKEN: Environment variables with prefix "ADISPATCH_" are reserved',
      'workflows/w.yaml: on_success[0].secrets.GH_TOKEN: "GH_TOKEN" is defined both in "env" and "secrets"',
    ]);
  });

  it('a secret entry with an unknown key is rejected', async () => {
    const errs = await errors(workflow('  secrets:\n    GH_TOKEN: { identity: coder, mode: file }'));
    expect(errs).toEqual(['workflows/w.yaml: execute.secrets.GH_TOKEN: Unknown key(s): "mode"']);
  });
});
