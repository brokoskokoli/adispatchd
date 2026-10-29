/**
 * Server-Sent Events of the hub (WI-36): `GET /api/v1/hub/events`.
 *
 * Every message carries `event: <type>` and `data: {type, time, payload}`.
 * Types: `stream.open` (first message), `hub.snapshot` (the complete status,
 * right after connecting), `hub.status` (state, pause, slots – on change),
 * `hub.workspace` (one workspace – on change), `hub.resources` (a new server
 * resource sample). No message has an `id`: a client that reconnects gets a
 * new snapshot instead of a replay. Heartbeat comments keep proxies from
 * closing idle streams; a client with too much unsent data is disconnected.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorMessage, noopLogger, systemClock, systemTimers, type Clock, type Logger, type TimerHandle, type Timers } from '../../core/index.js';

/** Default heartbeat interval. */
export const HUB_SSE_HEARTBEAT_MS = 15_000;
/** Unsent bytes per client before it is disconnected. */
export const HUB_SSE_MAX_BUFFER_BYTES = 512 * 1024;

/** Options of {@link HubEventStream}. */
export interface HubEventStreamOptions {
  /** The complete current status (sent to every new client). */
  snapshot(): unknown;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  heartbeatMs?: number;
  maxBufferBytes?: number;
}

interface Client {
  res: ServerResponse;
  closed: boolean;
}

/** See module docs. */
export class HubEventStream {
  private readonly clients = new Set<Client>();
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly log: Logger;
  private heartbeat: TimerHandle | undefined;
  private closed = false;

  constructor(private readonly options: HubEventStreamOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.log = (options.logger ?? noopLogger).child({ component: 'hub-sse' });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Serve one connection on a raw response. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.closed) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'shutting_down', message: 'Server is shutting down' } }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.flushHeaders?.();
    const client: Client = { res, closed: false };
    const remove = (): void => {
      client.closed = true;
      this.clients.delete(client);
      this.updateHeartbeat();
    };
    req.on('close', remove);
    res.on('close', remove);
    res.on('error', remove);
    this.write(client, 'retry: 3000\n\n');
    this.send(client, 'stream.open', {});
    this.send(client, 'hub.snapshot', this.options.snapshot());
    if (client.closed) return;
    this.clients.add(client);
    this.updateHeartbeat();
  }

  publish(type: string, payload: unknown): void {
    for (const client of [...this.clients]) this.send(client, type, payload);
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) this.timers.clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of [...this.clients]) {
      client.closed = true;
      try {
        client.res.end();
      } catch {
        // gone
      }
    }
    this.clients.clear();
  }

  private send(client: Client, type: string, payload: unknown): void {
    const data = JSON.stringify({ type, time: this.clock.now().toISOString(), payload });
    this.write(client, `event: ${type}\ndata: ${data}\n\n`);
  }

  private write(client: Client, chunk: string): void {
    if (client.closed) return;
    if (client.res.writableLength > (this.options.maxBufferBytes ?? HUB_SSE_MAX_BUFFER_BYTES)) {
      this.log.warn('disconnecting slow SSE client', { bufferedBytes: client.res.writableLength });
      client.closed = true;
      this.clients.delete(client);
      client.res.destroy();
      return;
    }
    try {
      client.res.write(chunk);
    } catch (err) {
      this.log.debug('SSE write failed', { error: errorMessage(err) });
      client.closed = true;
      this.clients.delete(client);
    }
  }

  private updateHeartbeat(): void {
    if (this.clients.size === 0 || this.closed) {
      if (this.heartbeat) this.timers.clearTimeout(this.heartbeat);
      this.heartbeat = undefined;
      return;
    }
    if (this.heartbeat) return;
    this.heartbeat = this.timers.setTimeout(() => {
      this.heartbeat = undefined;
      for (const client of [...this.clients]) this.write(client, `: heartbeat ${this.clock.now().toISOString()}\n\n`);
      this.updateHeartbeat();
    }, this.options.heartbeatMs ?? HUB_SSE_HEARTBEAT_MS);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }
}
