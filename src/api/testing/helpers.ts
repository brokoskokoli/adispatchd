/**
 * Test helpers for app/API tests (excluded from the build): a complete app
 * on a temp config/data dir with Fake-GitHub (real GitHub App auth), real
 * shell scripts and an injectable webhook `fetch`.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeTreeWritable } from '../../artifacts/index.js';
import { isTerminalStatus, MemoryLogger, type FetchLike } from '../../core/index.js';
import { FakeGitHub } from '../../sources/github/testing/index.js';
import { createApp, type App, type AppOptions } from '../../app.js';
import { FakeProbe } from '../../monitoring/testing/fake-probe.js';
import type { RunRecord } from '../../persistence/index.js';
import { CSRF_HEADER } from '../server.js';

export interface AppEnvOptions {
  /** `workflows/<id>.yaml` contents. */
  workflows?: Record<string, string>;
  /** `views/<id>.yaml` contents. */
  views?: Record<string, string>;
  /** Extra YAML appended to config.yaml (e.g. `notifications:` / `retention:`). */
  configExtra?: string;
  app?: Partial<AppOptions>;
  /** `server.allowed_hosts`. */
  allowedHosts?: string[];
  /** Default true: `start()` and wait until ready. */
  start?: boolean;
}

export interface AppEnv {
  root: string;
  configDir: string;
  dataDir: string;
  workspaces: string;
  marks: string;
  github: FakeGitHub;
  env: Record<string, string>;
  logger: MemoryLogger;
  app: App;
  /** Write an executable script, returns its path. */
  script(name: string, body: string): string;
  /** `fastify.inject` with the CSRF header on mutating requests. */
  request(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; headers: Record<string, unknown> }>;
  /** Wait for a run predicate (polling the DB). */
  waitRun(id: string, pred: (r: RunRecord) => boolean, timeoutMs?: number): Promise<RunRecord>;
  waitTerminal(id: string): Promise<RunRecord>;
  /** Create a second app on the same dirs (restart simulation). */
  createApp(extra?: Partial<AppOptions>): Promise<App>;
  appOptions(extra?: Partial<AppOptions>): AppOptions;
  cleanup(): Promise<void>;
}

export const REPO_A = 'example/a';
export const REPO_B = 'example/b';

export async function createAppEnv(options: AppEnvOptions = {}): Promise<AppEnv> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orch-app-'));
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const workspaces = path.join(root, 'workspaces');
  const marks = path.join(root, 'marks');
  const scripts = path.join(root, 'scripts');
  for (const d of [configDir, dataDir, workspaces, marks, scripts, path.join(configDir, 'workflows'), path.join(configDir, 'views')]) {
    mkdirSync(d, { recursive: true });
  }
  const github = new FakeGitHub();
  const maintainer = github.createApp({ login: 'maintainer[bot]' });
  const coder = github.createApp({ login: 'coder[bot]' });
  const env: Record<string, string> = { MAINTAINER_KEY: maintainer.privateKeyPem, CODER_KEY: coder.privateKeyPem };
  writeFileSync(
    path.join(configDir, 'identities.yaml'),
    [
      'identities:',
      '  maintainer:',
      '    type: github_app',
      `    app_id: ${maintainer.appId}`,
      `    installation_id: ${maintainer.installationId}`,
      '    private_key_env: MAINTAINER_KEY',
      '  coder:',
      '    type: github_app',
      `    app_id: ${coder.appId}`,
      `    installation_id: ${coder.installationId}`,
      '    private_key_env: CODER_KEY',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(configDir, 'sources.yaml'),
    [
      'sources:',
      '  repo_a: { type: github, owner: example, repository: a, identity: maintainer }',
      '  repo_b: { type: github, owner: example, repository: b, identity: maintainer }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(configDir, 'config.yaml'),
    [
      `server: { host: 127.0.0.1, port: 8787, allowed_hosts: [${(options.allowedHosts ?? []).join(', ')}] }`,
      'scheduler:',
      '  polling_interval: 1h',
      '  max_concurrent: 4',
      'workspace:',
      `  base_dir: ${workspaces}`,
      '  cleanup: on_success',
      'lifecycle:',
      '  action_retry: { max_attempts: 1, delay: 10ms }',
      options.configExtra ?? '',
      '',
    ].join('\n'),
  );
  for (const [id, yaml] of Object.entries(options.workflows ?? {})) writeFileSync(path.join(configDir, 'workflows', `${id}.yaml`), yaml);
  for (const [id, yaml] of Object.entries(options.views ?? {})) writeFileSync(path.join(configDir, 'views', `${id}.yaml`), yaml);

  const logger = new MemoryLogger();
  const appOptions = (extra: Partial<AppOptions> = {}): AppOptions => ({
    configDir,
    dataDir,
    port: 0,
    fetch: github.fetch as FetchLike,
    env,
    logger,
    retentionInitialDelayMs: 60 * 60_000,
    drainTimeoutMs: 5_000,
    cancelTimeoutMs: 5_000,
    sse: { heartbeatMs: 200 },
    controller: { recoveryGraceMs: 300, recoveryKillConfirmMs: 2_000 },
    // No real `ps`/`vm_stat` in API tests (WI-23); tests that need samples inject their own probe.
    monitoring: { probe: new FakeProbe() },
    ...options.app,
    ...extra,
  });
  // `script()` must work before the app is created (workflow YAML references scripts).
  const apps: App[] = [];
  const envObj: AppEnv = {
    root,
    configDir,
    dataDir,
    workspaces,
    marks,
    github,
    env,
    logger,
    app: undefined as unknown as App,
    script(name, body) {
      const file = path.join(scripts, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    },
    async request(method, url, body, headers = {}) {
      const mutating = method !== 'GET' && method !== 'HEAD';
      const res = await envObj.app.http.inject({
        method: method as 'GET',
        url,
        headers: {
          ...(mutating ? { [CSRF_HEADER]: '1' } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
      let json: unknown = null;
      try {
        json = res.json();
      } catch {
        json = res.body;
      }
      return { status: res.statusCode, json, headers: res.headers };
    },
    async waitRun(id, pred, timeoutMs = 15_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const run = envObj.app.persistence.runs.get(id);
        if (run && pred(run)) return run;
        if (Date.now() > end) throw new Error(`timeout waiting for run ${id} (status ${run?.status})`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    waitTerminal(id) {
      return envObj.waitRun(id, (r) => isTerminalStatus(r.status) && r.lifecycleStatus !== 'running');
    },
    async createApp(extra = {}) {
      const app = await createApp(appOptions(extra));
      apps.push(app);
      return app;
    },
    appOptions,
    async cleanup() {
      for (const app of apps) {
        await app.shutdown({ mode: 'cancel', cancelTimeoutMs: 3_000 }).catch(() => undefined);
      }
      // Kept workspaces may hold a read-only artifact input (WI-35), which a non-root user cannot empty.
      await makeTreeWritable(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return envObj;
}

/** Create, start and wait for readiness. */
export async function startAppEnv(options: AppEnvOptions = {}, before?: (env: AppEnv) => void): Promise<AppEnv> {
  const env = await createAppEnv(options);
  before?.(env);
  env.app = await env.createApp();
  if (options.start !== false) {
    await env.app.start();
    await env.app.ready;
    // `ready` resolves as soon as the scheduler has started, while its first planning step
    // (an async poll of the sources) is still running. Without waiting, a test that creates
    // items right away races that step: whether the step sees the new items depends on the
    // timing of the event loop (on Node 22 it usually did, on Node 24 usually not), and the
    // step then reads/starts concurrently with the test's own dry-run or `planOnce()`.
    await env.app.scheduler.whenIdle();
  }
  return env;
}

/** Minimal SSE client over real HTTP; collects parsed messages. */
export interface SseMessage {
  id: string | null;
  event: string;
  data: any;
}

export interface SseClient {
  messages: SseMessage[];
  /** Resolve when a message matching `pred` arrived. */
  waitFor(pred: (m: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
  close(): void;
  closed: Promise<void>;
}

export function connectSse(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE status ${res.statusCode}`));
        res.resume();
        return;
      }
      res.setEncoding('utf8');
      const messages: SseMessage[] = [];
      const waiters: Array<{ pred: (m: SseMessage) => boolean; resolve: (m: SseMessage) => void }> = [];
      let buffer = '';
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let id: string | null = null;
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length === 0) continue;
          const m: SseMessage = { id, event, data: JSON.parse(data.join('\n')) };
          messages.push(m);
          for (const w of [...waiters]) {
            if (w.pred(m)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(m);
            }
          }
        }
      });
      const closed = new Promise<void>((r) => res.on('close', () => r()));
      resolve({
        messages,
        closed,
        waitFor(pred, timeoutMs = 15_000) {
          const found = messages.find(pred);
          if (found) return Promise.resolve(found);
          return new Promise((res2, rej) => {
            const t = setTimeout(() => rej(new Error('SSE message timeout')), timeoutMs);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                res2(m);
              },
            });
          });
        },
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
  });
}
