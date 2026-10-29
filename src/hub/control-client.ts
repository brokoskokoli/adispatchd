/** Client of the hub's control socket (WI-36); used by the `adispatch hub …` commands. */
import http from 'node:http';
import { errorMessage } from '../core/index.js';
import type { HubStatus } from './hub.js';

/** The hub could not be reached (no socket, connection refused, timeout). */
export class HubUnreachableError extends Error {
  constructor(
    readonly socketPath: string,
    cause: unknown,
  ) {
    super(`cannot reach the hub at ${socketPath} (${errorMessage(cause)}) – is it running? Use --data-dir of the hub`);
    this.name = 'HubUnreachableError';
  }
}

/** The hub answered with an error. */
export class HubResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubResponseError';
  }
}

export class HubControlClient {
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 30_000,
  ) {}

  status(): Promise<HubStatus> {
    return this.request('GET', '/status');
  }

  pause(): Promise<HubStatus> {
    return this.request('POST', '/pause');
  }

  resume(): Promise<HubStatus> {
    return this.request('POST', '/resume');
  }

  stopAll(): Promise<HubStatus> {
    return this.request('POST', '/stop-all');
  }

  drainAll(): Promise<HubStatus> {
    return this.request('POST', '/drain-all');
  }

  workspace(id: string, action: 'start' | 'stop' | 'restart' | 'drain'): Promise<HubStatus> {
    return this.request('POST', `/workspaces/${encodeURIComponent(id)}/${action}`);
  }

  private request(method: 'GET' | 'POST', path: string): Promise<HubStatus> {
    return new Promise<HubStatus>((resolve, reject) => {
      const req = http.request(
        { socketPath: this.socketPath, method, path, timeout: this.timeoutMs, headers: method === 'POST' ? { 'content-length': '0' } : {} },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let body: any = null;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              // handled below
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300 && body?.status) return resolve(body.status as HubStatus);
            reject(new HubResponseError(status, body?.error?.code ?? `http_${status}`, body?.error?.message ?? `unexpected answer (HTTP ${status})`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => reject(new HubUnreachableError(this.socketPath, err)));
      req.end();
    });
  }
}
