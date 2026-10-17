import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startAppEnv, type AppEnv } from '../api/testing/helpers.js';
import type { DryRunResult } from '../scheduler/index.js';
import { createConfigReloadHandler, createSchedulerHandler, createShutdownHandler, createStatusHandler } from './control.js';
import { ApiClient, EXIT_UNREACHABLE, resolveBaseUrl, urlForBind } from './http-client.js';
import { createProgram, type CliHandlers, type CliIo } from './program.js';
import { createWorkflowDryRunHandler } from './workflow-dry-run.js';

const envs: AppEnv[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
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

async function cli(args: string[], make: (io: CliIo) => CliHandlers) {
  const io = captureIo();
  await createProgram(make(io), io).parseAsync(args, { from: 'user' });
  return io;
}

const allHandlers = (io: CliIo): CliHandlers => ({
  status: createStatusHandler(io),
  pause: createSchedulerHandler('pause', io),
  resume: createSchedulerHandler('resume', io),
  drain: createShutdownHandler('drain', io, { pollIntervalMs: 20 }),
  cancelAll: createShutdownHandler('cancel-all', io, { pollIntervalMs: 20 }),
  configReload: createConfigReloadHandler(io),
  workflowDryRun: createWorkflowDryRunHandler(io),
});

async function start(): Promise<AppEnv & { url: string }> {
  const env = await startAppEnv({
    workflows: {
      hello: 'id: hello\nname: Hello\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/echo, args: [hi] }\n',
    },
  });
  envs.push(env);
  const url = env.app.url;
  if (!url) throw new Error('app not listening');
  return Object.assign(env, { url });
}

describe('cli control commands over HTTP', () => {
  it('status, pause, resume and config reload talk to the running instance', async () => {
    const env = await start();
    let io = await cli(['status', '--url', env.url], allHandlers);
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('ready:      yes');
    expect(io.out).toContain('scheduler:  running');

    io = await cli(['status', '--url', env.url, '--json'], allHandlers);
    expect(JSON.parse(io.out)).toMatchObject({ version: '0.1.0', scheduler: { state: 'running' } });

    io = await cli(['pause', '--url', env.url], allHandlers);
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('paused');
    expect(env.app.controller.status.paused).toBe(true);
    io = await cli(['resume', '--url', env.url], allHandlers);
    expect(io.code).toBe(0);
    expect(env.app.controller.status.paused).toBe(false);

    // Reload: valid change is applied …
    writeFileSync(path.join(env.configDir, 'workflows', 'second.yaml'), 'id: second\ntrigger: { type: manual }\nexecute: { type: shell, command: /bin/true }\n');
    io = await cli(['config', 'reload', '--url', env.url], allHandlers);
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('configuration reloaded');
    expect(env.app.config.getWorkflow('second')).toBeDefined();
    // … invalid YAML is rejected and the active configuration stays (Szenario 11).
    const hash = env.app.config.current.hash;
    writeFileSync(path.join(env.configDir, 'workflows', 'broken.yaml'), 'id: broken\ntrigger: { type: nope }\n');
    io = await cli(['config', 'reload', '--url', env.url], allHandlers);
    expect(io.code).toBe(1);
    expect(io.err).toContain('the active configuration was kept');
    expect(io.err).toContain('workflows/broken.yaml');
    expect(env.app.config.current.hash).toBe(hash);
  });

  it('workflow dry-run uses the running instance (live gate)', async () => {
    const env = await start();
    await cli(['pause', '--url', env.url], allHandlers);
    const io = await cli(['workflow', 'dry-run', 'hello', '--url', env.url, '--json'], allHandlers);
    expect(io.code, io.err).toBe(0);
    const result = JSON.parse(io.out) as DryRunResult;
    expect(result.workflowId).toBe('hello');
    expect(result.gate).toMatchObject({ canStartAutomatically: false });
    const text = await cli(['workflow', 'dry-run', 'hello', '--url', env.url], allHandlers);
    expect(text.out).toContain("Dry-run of workflow 'hello'");
    const unknown = await cli(['workflow', 'dry-run', 'nope', '--url', env.url], allHandlers);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown workflow 'nope'");
  });

  it('drain --wait returns once the instance has stopped with exit 0', async () => {
    const env = await start();
    const io = await cli(['drain', '--url', env.url, '--wait', '--timeout', '20s'], allHandlers);
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('drain started');
    expect(io.out).toContain('instance stopped');
    expect((await env.app.stopped).exitCode).toBe(0);
  });

  it('cancel-all cancels active runs and stops the instance', async () => {
    const env = await start();
    const script = env.script('long.sh', 'sleep 30');
    writeFileSync(path.join(env.configDir, 'workflows', 'long.yaml'), `id: long\ntrigger: { type: manual }\nexecute: { type: shell, command: ${script}, cancel_grace: 1s }\n`);
    expect((await env.app.reloadConfig()).ok).toBe(true);
    const started = await env.request('POST', '/api/v1/workflows/long/start');
    expect(started.status).toBe(202);
    const runId = started.json.run.id as string;
    await env.waitRun(runId, (r) => r.status === 'running');
    const io = await cli(['cancel-all', '--url', env.url, '--reason', 'maintenance', '--wait'], allHandlers);
    expect(io.code, io.err).toBe(0);
    expect(io.out).toContain('cancelling 1 active run(s)');
    expect(io.out).toContain(runId);
    expect((await env.app.stopped).exitCode).toBe(0);
  });

  it('reports an unreachable instance with exit 3 and usage errors with 2', async () => {
    const env = await start();
    const url = env.url;
    await env.app.shutdown();
    let io = await cli(['status', '--url', url], allHandlers);
    expect(io.code).toBe(EXIT_UNREACHABLE);
    expect(io.err).toContain(`cannot reach the orchestrator at ${url}`);
    io = await cli(['workflow', 'dry-run', 'hello', '--url', url], allHandlers);
    expect(io.code).toBe(EXIT_UNREACHABLE);
    io = await cli(['drain', '--url', url, '--timeout', '1s'], allHandlers);
    expect(io.code).toBe(2);
    io = await cli(['status', '--url', 'ftp://x'], allHandlers);
    expect(io.code).toBe(2);
    io = await cli(['status', '--url', 'http://admin:s3cret@proxy.example.com'], allHandlers);
    expect(io.code).toBe(2);
    expect(io.err).toContain('credentials in the URL');
    expect(io.err).not.toContain('s3cret');
    expect(io.err).not.toContain('admin');
    io = await cli(['status', '--url', 'http://admin:s3cret@[bad'], allHandlers);
    expect(io.code).toBe(2);
    expect(io.err).not.toContain('s3cret');
  });
});

describe('cli http client', () => {
  it('derives the URL from config.yaml and maps wildcard binds to loopback', async () => {
    expect(urlForBind('0.0.0.0', 8787)).toBe('http://127.0.0.1:8787');
    expect(urlForBind('::', 9000)).toBe('http://[::1]:9000');
    expect(urlForBind('10.0.0.5', 80)).toBe('http://10.0.0.5:80');
    expect((await resolveBaseUrl({})).url).toBe('http://127.0.0.1:8787');
    expect((await resolveBaseUrl({ url: 'http://h:1/' })).url).toBe('http://h:1');
    const root = mkdtempSync(path.join(os.tmpdir(), 'orch-url-'));
    roots.push(root);
    writeFileSync(path.join(root, 'config.yaml'), 'server: { host: 0.0.0.0, port: 18123 }\n');
    expect((await resolveBaseUrl({ configDir: root })).url).toBe('http://127.0.0.1:18123');
    writeFileSync(path.join(root, 'config.yaml'), 'server: { port: nope }\n');
    const bad = await resolveBaseUrl({ configDir: root });
    expect(bad.url).toBe('http://127.0.0.1:8787');
    expect(bad.note).toContain('invalid');
    if (process.getuid?.() !== 0) {
      writeFileSync(path.join(root, 'config.yaml'), 'server: { port: 18124 }\n', { mode: 0o000 });
      chmodSync(path.join(root, 'config.yaml'), 0o000);
      const unreadable = await resolveBaseUrl({ configDir: root });
      expect(unreadable.url).toBe('http://127.0.0.1:8787');
      expect(unreadable.note).toContain('not readable');
      expect(unreadable.note).toContain('--url');
    }
  });

  it('sends the CSRF header and JSON only on mutating requests', async () => {
    const seen: Array<{ method: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push({ method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = new ApiClient('http://127.0.0.1:1', { fetch: fetchFn });
    await api.get('/api/v1/status');
    await api.post('/api/v1/scheduler/pause');
    await api.post('/api/v1/shutdown/cancel-all', { reason: 'x' });
    expect(seen[0]?.headers['x-orchestrator-request']).toBeUndefined();
    expect(seen[1]?.headers['x-orchestrator-request']).toBe('1');
    expect(seen[1]?.headers['content-type']).toBeUndefined();
    expect(seen[2]?.headers['content-type']).toBe('application/json');
    expect(seen[2]?.body).toBe('{"reason":"x"}');
    expect(seen.every((s) => !('origin' in s.headers))).toBe(true);
  });
});
