/**
 * Control interface of the hub (WI-35): a small JSON-over-HTTP API on a Unix
 * socket (`<hub-data-dir>/hub.sock`, mode 0600, owner = hub user). Used by the
 * `adispatch hub …` commands; WI-36 builds the web UI on the same
 * {@link HubControl} object.
 *
 * | Request | Effect |
 * |---|---|
 * | `GET /status` | {@link HubStatus} |
 * | `POST /pause`, `POST /resume` | no new automatic runs hub-wide / allow them again |
 * | `POST /stop-all`, `POST /drain-all` | cancel-all / drain every workspace |
 * | `POST /workspaces/:id/start\|stop\|restart\|drain` | one workspace |
 *
 * Every successful answer is `200 {ok: true, status}`; errors are
 * `{error: {code, message}}` with 404 (unknown workspace), 409 (wrong state)
 * or 400.
 */
import { chmodSync, rmSync } from 'node:fs';
import http from 'node:http';
import { errorMessage, noopLogger, type Logger } from '../core/index.js';
import { HubError } from './errors.js';
import type { HubStatus } from './hub.js';

/** The operations of a hub (shared by the control socket and, later, the web UI). */
export interface HubControl {
  status(): HubStatus;
  pause(): HubStatus;
  resume(): HubStatus;
  stopAll(): Promise<HubStatus>;
  drainAll(): Promise<HubStatus>;
  workspace(id: string, action: 'start' | 'stop' | 'restart' | 'drain'): Promise<HubStatus>;
}

const WORKSPACE_ACTIONS = new Set(['start', 'stop', 'restart', 'drain']);

/** Options of {@link ControlServer}. */
export interface ControlServerOptions {
  socketPath: string;
  control: HubControl;
  logger?: Logger;
}

/** See module docs. */
export class ControlServer {
  private server: http.Server | undefined;
  private readonly log: Logger;

  constructor(private readonly options: ControlServerOptions) {
    this.log = (options.logger ?? noopLogger).child({ component: 'hub-control' });
  }

  async listen(): Promise<void> {
    rmSync(this.options.socketPath, { force: true });
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.options.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(this.options.socketPath, { force: true });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Drain a (small) body so keep-alive connections stay usable; its content is not used.
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 64 * 1024) throw new HubError('bad_request', 'Request body too large', 400);
      }
      const url = new URL(req.url ?? '/', 'http://hub');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      const { control } = this.options;
      if (method === 'GET' && url.pathname === '/status') return this.send(res, 200, { ok: true, status: control.status() });
      if (method !== 'POST') throw new HubError('not_found', `No such resource: ${method} ${url.pathname}`, 404);
      let status: HubStatus;
      if (parts.length === 1 && parts[0] === 'pause') status = control.pause();
      else if (parts.length === 1 && parts[0] === 'resume') status = control.resume();
      else if (parts.length === 1 && parts[0] === 'stop-all') status = await control.stopAll();
      else if (parts.length === 1 && parts[0] === 'drain-all') status = await control.drainAll();
      else if (parts.length === 3 && parts[0] === 'workspaces' && WORKSPACE_ACTIONS.has(parts[2] as string)) {
        status = await control.workspace(decodeURIComponent(parts[1] as string), parts[2] as 'start' | 'stop' | 'restart' | 'drain');
      } else throw new HubError('not_found', `No such resource: ${method} ${url.pathname}`, 404);
      this.send(res, 200, { ok: true, status });
    } catch (err) {
      if (err instanceof HubError) return this.send(res, err.status, { error: { code: err.code, message: err.message } });
      this.log.error('control request failed', { error: errorMessage(err) });
      this.send(res, 500, { error: { code: 'internal_error', message: 'Internal error' } });
    }
  }
}
