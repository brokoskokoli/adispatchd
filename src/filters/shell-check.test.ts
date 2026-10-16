import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock, type SourceItem } from '../core/index.js';
import { buildCheckContext, CHECK_CONTEXT_ENV, ShellCheckRunner } from './shell-check.js';

let dir: string;
let tempDir: string;

async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

const hostEnv = { PATH: '/usr/bin:/bin', HOME: '/home/test', LANG: 'C', SECRET_TOKEN: 'leak-me' };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wi04-scripts-'));
  tempDir = await mkdtemp(join(tmpdir(), 'wi04-ctx-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(tempDir, { recursive: true, force: true });
});

describe('ShellCheckRunner', () => {
  const runner = () => new ShellCheckRunner({ hostEnv, tempDir, killGraceMs: 200 });

  it('exit 0 = true, exit 1 = false, exit 2 = unknown with detail', async () => {
    const r = runner();
    const ok = await r.run({ command: await script('ok.sh', 'exit 0'), timeoutMs: 5000 }, {});
    expect(ok).toMatchObject({ value: true, exitCode: 0, timedOut: false, cached: false });
    expect(ok.error).toBeUndefined();
    const no = await r.run({ command: await script('no.sh', 'exit 1'), timeoutMs: 5000 }, {});
    expect(no).toMatchObject({ value: false, exitCode: 1 });
    const err = await r.run({ command: await script('err.sh', 'echo broken >&2; exit 2'), timeoutMs: 5000 }, {});
    expect(err).toMatchObject({ value: 'unknown', exitCode: 2, error: 'check error: exit code 2', stderr: 'broken\n' });
  });

  it('timeout → unknown and the process group is killed', async () => {
    const marker = join(dir, 'timeout-marker');
    const cmd = await script('slow.sh', `sleep 5 & wait; touch "${marker}"`);
    const started = Date.now();
    const res = await runner().run({ command: cmd, timeoutMs: 200 }, {});
    expect(res).toMatchObject({ value: 'unknown', timedOut: true });
    expect(res.error).toMatch(/timed out after 200ms/);
    expect(Date.now() - started).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 300));
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('non-existent command → unknown with spawn error', async () => {
    const res = await runner().run({ command: join(dir, 'does-not-exist'), timeoutMs: 1000 }, {});
    expect(res.value).toBe('unknown');
    expect(res.error).toMatch(/spawn failed: .*ENOENT/);
  });

  it('signal → unknown', async () => {
    const res = await runner().run({ command: await script('kill.sh', 'kill -9 $$'), timeoutMs: 5000 }, {});
    expect(res).toMatchObject({ value: 'unknown', signal: 'SIGKILL' });
  });

  it('passes args as a list without shell interpretation', async () => {
    const cmd = await script('args.sh', 'printf "%s|" "$@"; [ "$1" = \'$(echo x); rm -rf /\' ]');
    const res = await runner().run({ command: cmd, args: ['$(echo x); rm -rf /', 'b c'], timeoutMs: 5000 }, {});
    expect(res.value).toBe(true);
    expect(res.stdout).toBe('$(echo x); rm -rf /|b c|');
  });

  it('runs through /bin/sh only when shell: true is configured', async () => {
    const res = await runner().run({ command: 'test "$1" = hi && exit 1', args: ['hi'], shell: true, timeoutMs: 5000 }, {});
    expect(res.value).toBe(false);
  });

  it('provides the context file and a minimal env (no controller env leak); removes the file', async () => {
    const out = join(dir, 'env-out');
    const cmd = await script('ctx.sh', `env > "${out}"; cat "$${CHECK_CONTEXT_ENV}"`);
    const item: SourceItem = {
      sourceId: 'project_a',
      itemId: '7',
      key: 'project_a:7',
      url: 'https://github.com/o/r/issues/7',
      type: 'issue',
      createdAt: '2026-01-01T00:00:00Z',
      fields: { title: 'T', labels: ['a'] },
    };
    const ctx = buildCheckContext('item_condition', 'coder', item, 'github');
    const res = await runner().run({ command: cmd, env: { EXTRA: 'yes' }, timeoutMs: 5000 }, ctx);
    expect(res.value).toBe(true);
    expect(JSON.parse(res.stdout)).toEqual({
      schema_version: 1,
      kind: 'item_condition',
      workflow: { id: 'coder' },
      source: {
        id: 'project_a',
        type: 'github',
        item_id: '7',
        item_key: 'project_a:7',
        url: 'https://github.com/o/r/issues/7',
        item_type: 'issue',
        created_at: '2026-01-01T00:00:00Z',
        attributes: { title: 'T', labels: ['a'] },
      },
    });
    const env = await readFile(out, 'utf8');
    expect(env).toContain('EXTRA=yes');
    expect(env).toContain('HOME=/home/test');
    expect(env).toContain(`${CHECK_CONTEXT_ENV}=`);
    expect(env).not.toContain('SECRET_TOKEN');
    expect(await readdir(tempDir)).toEqual([]);
  });

  it('limits captured output', async () => {
    const r = new ShellCheckRunner({ hostEnv, tempDir, maxOutputBytes: 100 });
    const res = await r.run({ command: await script('big.sh', 'i=0; while [ $i -lt 200 ]; do echo 0123456789; i=$((i+1)); done'), timeoutMs: 5000 }, {});
    expect(res.value).toBe(true);
    expect(res.stdout.length).toBe(100);
    expect(res.outputTruncated).toBe(true);
  });

  it('does not hang on background children holding the output pipe', async () => {
    const started = Date.now();
    const res = await runner().run({ command: await script('bg.sh', 'sleep 5 & exit 0'), timeoutMs: 10_000 }, {});
    expect(res).toMatchObject({ value: true, exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('abort signal → unknown', async () => {
    const ac = new AbortController();
    const p = runner().run({ command: await script('sleep.sh', 'sleep 5'), timeoutMs: 10_000 }, {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect(await p).toMatchObject({ value: 'unknown', error: 'aborted' });
  });
});

describe('ShellCheckRunner cache', () => {
  it('caches results for the TTL (clock based), then re-runs', async () => {
    const counter = join(dir, 'count');
    await writeFile(counter, '');
    const cmd = await script('count.sh', `echo x >> "${counter}"; exit 0`);
    const clock = new FakeClock('2026-01-01T00:00:00Z');
    const r = new ShellCheckRunner({ clock, hostEnv, tempDir });
    const spec = { command: cmd, timeoutMs: 5000 };
    const runs = async () => (await readFile(counter, 'utf8')).split('\n').filter(Boolean).length;

    expect(await r.runCached('wf:0', 60_000, spec, {})).toMatchObject({ value: true, cached: false });
    clock.advance(59_999);
    expect(await r.runCached('wf:0', 60_000, spec, {})).toMatchObject({ value: true, cached: true });
    expect(await runs()).toBe(1);
    clock.advance(1);
    expect(await r.runCached('wf:0', 60_000, spec, {})).toMatchObject({ value: true, cached: false });
    expect(await runs()).toBe(2);
    // Different key, TTL 0 and plain run are not cached.
    await r.runCached('wf:1', 60_000, spec, {});
    await r.runCached('wf:0', 0, spec, {});
    await r.run(spec, {});
    expect(await runs()).toBe(5);
    r.invalidate('wf:0');
    expect(await r.runCached('wf:0', 60_000, spec, {})).toMatchObject({ cached: false });
    expect(await runs()).toBe(6);
  });

  it('does not cache unknown results; concurrent calls share one execution', async () => {
    const counter = join(dir, 'count2');
    await writeFile(counter, '');
    const failing = await script('count-fail.sh', `echo x >> "${counter}"; exit 3`);
    const r = new ShellCheckRunner({ clock: new FakeClock(), hostEnv, tempDir });
    await r.runCached('k', 60_000, { command: failing, timeoutMs: 5000 }, {});
    await r.runCached('k', 60_000, { command: failing, timeoutMs: 5000 }, {});
    expect((await readFile(counter, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);

    const slowCounter = join(dir, 'count3');
    await writeFile(slowCounter, '');
    const slow = await script('count-slow.sh', `echo x >> "${slowCounter}"; sleep 0.2; exit 1`);
    const results = await Promise.all([
      r.runCached('s', 60_000, { command: slow, timeoutMs: 5000 }, {}),
      r.runCached('s', 60_000, { command: slow, timeoutMs: 5000 }, {}),
    ]);
    expect(results.map((x) => x.value)).toEqual([false, false]);
    expect((await readFile(slowCounter, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
  });
});
