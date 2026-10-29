/**
 * Server-Sent Events hub (Spec §15): `/api/v1/events` (optionally `?run=<id>`).
 *
 * - Every SSE message carries `event: <type>` and `data: {type, time, payload}`;
 *   persisted run events (`run.event`, incl. every status transition) also
 *   carry `id: <event id>` – the global, strictly increasing `run_events.id`.
 * - Reconnect: with `Last-Event-ID` (header, sent automatically by
 *   `EventSource`) or `?lastEventId=` the missed persisted events are
 *   replayed from SQLite before live events continue (no gaps, no
 *   duplicates). Too many missed events → `stream.reset` (client reloads via REST).
 * - Live-only events (`run.output` log chunks, `run.action`, `block.*`,
 *   `artifact.created`, `artifact.deleted`, `system.status`, `notification`,
 *   `config.reloaded`, ...) have no `id`.
 * - Heartbeat comments keep proxies from closing idle streams.
 * - Slow clients: the socket buffer per client is bounded; a client whose
 *   unsent data exceeds the limit is disconnected (it reconnects with
 *   `Last-Event-ID`). Publishing never waits for a client, so log capture is
 *   never blocked.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type Logger,
  type TimerHandle,
  type Timers,
  type Unsubscribe,
} from '../core/index.js';
import type { EventRepository } from '../persistence/index.js';
import type { BusEvent, RunEventBus } from '../runs/index.js';

/** Default heartbeat interval. */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
/** Default max. unsent bytes per client before it is disconnected. */
export const DEFAULT_SSE_MAX_BUFFER_BYTES = 1024 * 1024;
/** Default max. number of replayed events on reconnect. */
export const DEFAULT_SSE_MAX_REPLAY = 5_000;

/** One message on the stream. */
export interface StreamEvent {
  /** Only for persisted run events. */
  id?: number;
  type: string;
  time: string;
  /** Run the event belongs to (filtering for `?run=`), `null` = system-wide. */
  runId: string | null;
  payload: unknown;
}

/** Options of {@link EventHub}. */
export interface EventHubOptions {
  bus: RunEventBus;
  events: Pick<EventRepository, 'listSince' | 'latestId'>;
  /** ID of the last persisted event already published live (`PersistedEventPublisher.lastPublishedId`). */
  lastPublishedId: () => number;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  heartbeatMs?: number;
  maxBufferBytes?: number;
  maxReplay?: number;
  /** Reconnect delay suggested to the client (`retry:`), default 3000 ms. */
  retryMs?: number;
}

interface Client {
  id: number;
  res: ServerResponse;
  runId: string | null;
  lastSentId: number;
  closed: boolean;
}

/** See module docs. */
export class EventHub {
  private readonly clients = new Set<Client>();
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly heartbeatMs: number;
  private readonly maxBuffer: number;
  private readonly maxReplay: number;
  private readonly retryMs: number;
  private readonly unsubscribe: Unsubscribe;
  private heartbeat: TimerHandle | undefined;
  private nextClientId = 1;
  private closed = false;

  constructor(private readonly options: EventHubOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.logger = (options.logger ?? noopLogger).child({ component: 'sse' });
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
    this.maxBuffer = options.maxBufferBytes ?? DEFAULT_SSE_MAX_BUFFER_BYTES;
    this.maxReplay = options.maxReplay ?? DEFAULT_SSE_MAX_REPLAY;
    this.retryMs = options.retryMs ?? 3_000;
    this.unsubscribe = options.bus.subscribe((event) => this.broadcast(fromBus(event, this.clock)));
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Publish an application-level (non-persisted) event to all clients. */
  publish(type: string, payload: unknown, runId: string | null = null): void {
    this.broadcast({ type, time: this.clock.now().toISOString(), runId, payload });
  }

  /**
   * Serve one SSE connection on a raw Node response (the HTTP framework must
   * have handed over the response, e.g. Fastify `reply.hijack()`).
   */
  handle(req: IncomingMessage, res: ServerResponse, options: { runId?: string | null; lastEventId?: number | null } = {}): void {
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
    const client: Client = {
      id: this.nextClientId++,
      res,
      runId: options.runId ?? null,
      lastSentId: 0,
      closed: false,
    };
    const remove = (): void => {
      client.closed = true;
      this.clients.delete(client);
      this.updateHeartbeat();
    };
    req.on('close', remove);
    res.on('close', remove);
    res.on('error', remove);

    // Everything below runs synchronously: no live event can interleave with the replay.
    this.write(client, `retry: ${this.retryMs}\n\n`);
    const baseline = this.options.lastPublishedId();
    const lastEventId = options.lastEventId ?? null;
    if (lastEventId === null) {
      client.lastSentId = baseline;
      this.send(client, { id: baseline, type: 'stream.open', time: this.now(), runId: null, payload: { lastEventId: baseline, replayed: 0 } }, true);
    } else {
      client.lastSentId = lastEventId;
      this.send(client, { type: 'stream.open', time: this.now(), runId: null, payload: { lastEventId, replayed: null } }, true);
      const latest = this.options.events.latestId();
      if (lastEventId > latest) {
        // Unknown future ID (e.g. data dir replaced/restored): resynchronize instead of silently skipping events.
        client.lastSentId = latest;
        this.send(
          client,
          { id: latest, type: 'stream.reset', time: this.now(), runId: null, payload: { reason: 'unknown_last_event_id', lastEventId: latest } },
          true,
        );
      } else {
        this.replay(client, lastEventId);
      }
    }
    if (client.closed) return;
    this.clients.add(client);
    this.updateHeartbeat();
  }

  /** Close all streams and stop the heartbeat (server shutdown). Idempotent. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    if (this.heartbeat) this.timers.clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of [...this.clients]) {
      client.closed = true;
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private replay(client: Client, afterId: number): void {
    let sent = 0;
    let cursor = afterId;
    const runFilter = client.runId ?? undefined;
    for (;;) {
      const batch = this.options.events.listSince(cursor, { ...(runFilter ? { runId: runFilter } : {}), limit: 1000 });
      if (batch.length === 0) break;
      if (sent + batch.length > this.maxReplay) {
        const latest = this.options.events.latestId();
        client.lastSentId = Math.max(client.lastSentId, latest);
        this.send(
          client,
          { id: client.lastSentId, type: 'stream.reset', time: this.now(), runId: null, payload: { reason: 'too_many_missed_events', lastEventId: client.lastSentId } },
          true,
        );
        return;
      }
      for (const event of batch) {
        cursor = event.id;
        this.send(client, { id: event.id, type: 'run.event', time: event.timestamp, runId: event.runId, payload: event });
        sent++;
        if (client.closed) return;
      }
    }
  }

  private broadcast(event: StreamEvent): void {
    for (const client of [...this.clients]) {
      if (client.runId !== null && event.runId !== null && event.runId !== client.runId) continue;
      if (client.runId !== null && event.runId === null && !SYSTEM_EVENTS_FOR_RUN_STREAMS.has(event.type)) continue;
      this.send(client, event);
    }
  }

  private send(client: Client, event: StreamEvent, force = false): void {
    if (client.closed) return;
    if (event.id !== undefined && !force) {
      if (event.id <= client.lastSentId) return; // already replayed
      client.lastSentId = event.id;
    }
    const data = JSON.stringify({ type: event.type, time: event.time, ...(event.id !== undefined ? { id: event.id } : {}), payload: event.payload });
    const frame = `${event.id !== undefined ? `id: ${event.id}\n` : ''}event: ${event.type}\ndata: ${data}\n\n`;
    this.write(client, frame);
  }

  private write(client: Client, chunk: string): void {
    if (client.closed) return;
    if (client.res.writableLength > this.maxBuffer) {
      this.logger.warn('disconnecting slow SSE client', { client: client.id, bufferedBytes: client.res.writableLength });
      client.closed = true;
      this.clients.delete(client);
      client.res.destroy();
      return;
    }
    try {
      client.res.write(chunk);
    } catch (err) {
      this.logger.debug('SSE write failed', { client: client.id, error: errorMessage(err) });
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
      for (const client of [...this.clients]) this.write(client, `: heartbeat ${this.now()}\n\n`);
      this.updateHeartbeat();
    }, this.heartbeatMs);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }
}

/** System-wide events that are also delivered on run-filtered streams. */
const SYSTEM_EVENTS_FOR_RUN_STREAMS: ReadonlySet<string> = new Set(['system.status']);

function fromBus(event: BusEvent, clock: Clock): StreamEvent {
  switch (event.type) {
    case 'run.event':
      return { id: event.event.id, type: 'run.event', time: event.event.timestamp, runId: event.event.runId, payload: event.event };
    case 'run.output':
      return {
        type: 'run.output',
        time: event.at,
        runId: event.runId,
        payload: { runId: event.runId, stream: event.stream, data: event.data, at: event.at },
      };
    case 'run.action':
      return { type: 'run.action', time: clock.now().toISOString(), runId: event.action.runId, payload: event.action };
    case 'block.created':
    case 'block.cleared':
      return { type: event.type, time: clock.now().toISOString(), runId: event.block.runId, payload: event.block };
    case 'artifact.created':
    case 'artifact.deleted':
      // System-wide (no run filter); the producing run is part of the payload.
      return { type: event.type, time: clock.now().toISOString(), runId: null, payload: event.artifact };
    case 'system.status':
      return { type: 'system.status', time: clock.now().toISOString(), runId: null, payload: event.status };
  }
}
