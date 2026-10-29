/** Test doubles for the hub's HTTP server (excluded from the build with the other `testing/` directories). */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HUB_ROLE_HEADER, HUB_TOKEN_HEADER, HUB_USER_HEADER } from '../../../api/index.js';
import type { HubStatus, HubWorkspaceStatus } from '../../hub.js';
import { HubError } from '../../errors.js';
import type { HubHttpSource } from '../server.js';

/** What a fake workspace instance received. */
export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A stand-in for a workspace instance: checks the hub's secret like the real
 * one, records requests and offers a few behaviours (echo, SSE, redirect,
 * cookies, a status document for the overview).
 */
export class FakeInstance {
  /** Requests of clients (the hub's own status polls are in `polls`). */
  readonly seen: SeenRequest[] = [];
  readonly polls: SeenRequest[] = [];
  readonly sse = new Set<http.ServerResponse>();
  closedStreams = 0;
  private server: http.Server;
  port = 0;
  statusBody: unknown;

  constructor(
    readonly name: string,
    readonly token: string,
  ) {
    this.statusBody = {
      version: '1.2.3',
      scheduler: { state: 'running', paused: false, draining: false },
      limits: { maxConcurrent: 4 },
      usage: { activeRuns: 2, supervisedRuns: 2, recoveryPending: 0 },
      counts: { activeBlocks: 1, failedActions: 3, notifications: { pending: 0, delivered: 5, failed: 1 } },
    };
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = req.url ?? '';
        (url === '/api/v1/status' ? this.polls : this.seen).push({ method: req.method ?? '', url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const isApi = url.startsWith('/api/');
        if (isApi && req.headers[HUB_TOKEN_HEADER] !== this.token) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'invalid_hub_token', message: 'no' } }));
          return;
        }
        this.handle(req, res, url, Buffer.concat(chunks).toString('utf8'));
      });
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, url: string, body: string): void {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'upstream=1; Path=/', 'content-security-policy': "default-src 'none'" });
      res.end(`<html>instance ${this.name}</html>`);
    } else if (url === '/api/v1/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.statusBody));
    } else if (url.startsWith('/api/v1/echo')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b' });
      res.end(JSON.stringify({ method: req.method, url, body, name: this.name }));
    } else if (url === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: stream.open\ndata: {}\n\n');
      this.sse.add(res);
      res.on('close', () => {
        this.sse.delete(res);
        this.closedStreams++;
      });
    } else if (url === '/redir') {
      res.writeHead(302, { location: '/dir/' });
      res.end();
    } else if (url === '/redir-out') {
      res.writeHead(302, { location: 'https://evil.example/' });
      res.end();
    } else if (url === '/slow') {
      // never answers
    } else if (url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(300_000, 97));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: url } }));
    }
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const r of this.sse) r.end();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Identity the hub sent with a request (by index). */
  identity(i: number): { token?: string; role?: string; user?: string } {
    const h = this.seen[i]?.headers ?? {};
    return {
      ...(h[HUB_TOKEN_HEADER] ? { token: String(h[HUB_TOKEN_HEADER]) } : {}),
      ...(h[HUB_ROLE_HEADER] ? { role: String(h[HUB_ROLE_HEADER]) } : {}),
      ...(h[HUB_USER_HEADER] ? { user: String(h[HUB_USER_HEADER]) } : {}),
    };
  }
}

/** A hub whose workspaces are the given fake instances. */
export class FakeHubSource implements HubHttpSource {
  paused = false;
  readonly calls: string[] = [];
  private readonly listeners = new Set<() => void>();
  readonly states = new Map<string, Partial<HubWorkspaceStatus>>();
  failNext: HubError | null = null;

  constructor(readonly instances: FakeInstance[]) {}

  trustTokenOf(id: string): string | null {
    const w = this.status().workspaces.find((x) => x.id === id);
    return w && w.state === 'running' ? (this.instances.find((i) => i.name === id)?.token ?? null) : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Change a workspace and notify subscribers. */
  set(id: string, patch: Partial<HubWorkspaceStatus>): void {
    this.states.set(id, { ...(this.states.get(id) ?? {}), ...patch });
    for (const l of [...this.listeners]) l();
  }

  status(): HubStatus {
    return {
      version: 'test',
      pid: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      time: '2026-01-01T00:00:10.000Z',
      state: this.paused ? 'paused' : 'running',
      paused: this.paused,
      slots: { max: 4, active: 2, byWorkspace: { a: 2 } },
      server: { host: '127.0.0.1', port: 8090 },
      workspaces: this.instances.map((i): HubWorkspaceStatus & { url: string; slots: number; connected: boolean } => ({
        id: i.name,
        enabled: true,
        state: 'running',
        transition: null,
        pid: 100,
        port: i.port,
        configDir: '/cfg',
        dataDir: '/data',
        startedAt: '2026-01-01T00:00:00.000Z',
        restarts: 0,
        crashes: 0,
        lastExit: null,
        nextRestartAt: null,
        message: null,
        url: `http://127.0.0.1:${i.port}`,
        slots: i.name === 'a' ? 2 : 0,
        connected: true,
        ...(this.states.get(i.name) ?? {}),
      })),
    };
  }

  pause(): HubStatus {
    this.calls.push('pause');
    this.paused = true;
    return this.status();
  }

  resume(): HubStatus {
    this.calls.push('resume');
    this.paused = false;
    return this.status();
  }

  async stopAll(): Promise<HubStatus> {
    this.calls.push('stop-all');
    return this.status();
  }

  async drainAll(): Promise<HubStatus> {
    this.calls.push('drain-all');
    return this.status();
  }

  async workspace(id: string, action: 'start' | 'stop' | 'restart' | 'drain'): Promise<HubStatus> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (!this.instances.some((i) => i.name === id)) throw new HubError('unknown_workspace', `Unknown workspace "${id}"`, 404);
    this.calls.push(`${id}:${action}`);
    return this.status();
  }
}
