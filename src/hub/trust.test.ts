import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../core/index.js';
import { newHubToken, readHubToken } from './trust.js';
import { processSpawner } from './spawner.js';
import { HUB_TOKEN_PATTERN } from '../api/index.js';

describe('hub secret', () => {
  it('generates distinct tokens of the expected format', () => {
    const a = newHubToken();
    expect(a).toMatch(HUB_TOKEN_PATTERN);
    expect(newHubToken()).not.toBe(a);
  });

  it('reads the first line, also when it arrives in pieces', async () => {
    const token = newHubToken();
    const input = new PassThrough();
    const p = readHubToken(input, 1_000);
    input.write(token.slice(0, 10));
    input.write(`${token.slice(10)}\nrest`);
    await expect(p).resolves.toBe(token);
  });

  it('accepts a last line without newline at the end of the input', async () => {
    const token = newHubToken();
    const input = new PassThrough();
    const p = readHubToken(input, 1_000);
    input.end(token);
    await expect(p).resolves.toBe(token);
  });

  it('times out through the injected timers', async () => {
    const clock = new FakeClock();
    const p = readHubToken(new PassThrough(), 5_000, clock);
    const result = expect(p).rejects.toThrow(/within 5000 ms/);
    await clock.advanceAsync(5_000);
    await result;
  });

  it('rejects garbage, a closed input and silence', async () => {
    const garbage = new PassThrough();
    const p1 = readHubToken(garbage, 1_000);
    garbage.write('not-a-token\n');
    await expect(p1).rejects.toThrow(/invalid secret/);
    const closed = new PassThrough();
    const p2 = readHubToken(closed, 1_000);
    closed.end();
    await expect(p2).rejects.toThrow(/ended before/);
    await expect(readHubToken(new PassThrough(), 30)).rejects.toThrow(/within 30 ms/);
    const long = new PassThrough();
    const p3 = readHubToken(long, 1_000);
    long.write('x'.repeat(300));
    await expect(p3).rejects.toThrow(/invalid secret/);
  });
});

describe('processSpawner input', () => {
  it('writes the input to the child standard input and keeps it out of arguments and environment', async () => {
    const secret = newHubToken();
    const code = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('in:'+s.trim()+'|args:'+process.argv.slice(1).join(',')+'|envhit:'+Object.values(process.env).some(v=>String(v).includes('"+secret+"')))});";
    const spawner = processSpawner({ execArgv: [], entry: '-e' });
    // `node -e <code> …`: the spawner passes `entry` first, then the args.
    const child = spawner.spawn({ workspaceId: 'x', args: [code, 'arg1'], env: { PATH: process.env.PATH }, input: `${secret}\n` });
    let out = '';
    child.onOutput((_s, c) => (out += c));
    await new Promise<void>((resolve) => child.onExit(() => resolve()));
    expect(out).toBe(`in:${secret}|args:arg1|envhit:false`);
  });

  it('does not connect standard input without an input', async () => {
    const code = "process.stdin.on('data',()=>{}).on('end',()=>process.stdout.write('eof'));process.stdin.resume();";
    const child = processSpawner({ execArgv: [], entry: '-e' }).spawn({ workspaceId: 'x', args: [code], env: { PATH: process.env.PATH } });
    let out = '';
    child.onOutput((_s, c) => (out += c));
    await new Promise<void>((resolve) => child.onExit(() => resolve()));
    expect(out).toBe('eof');
  });
});
