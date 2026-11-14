/**
 * WI-39: Socket Mode client – hello/disconnect/reconnect with backoff, ack
 * of every `events_api` envelope before processing, status; plus one test
 * against a minimal real WebSocket server (node:http upgrade, no dependency)
 * with the global `WebSocket` of Node.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor } from '../core/index.js';
import { SlackWebClient } from './slack-api.js';
import { SocketModeClient, type SocketEnvelope, type SocketStatus } from './slack-socket.js';
import { FAKE_SLACK_URL, FakeSlack, FakeSocketFactory, messageEnvelope } from './testing/fake-slack.js';

const BOT = 'xoxb-test-bot-token-0000';
const APP = 'xapp-test-app-token-0000';

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('SocketModeClient (WI-39)', () => {
  const setup = (options: { appToken?: string | undefined; onEvent?: (e: SocketEnvelope) => (() => void) | void } = {}) => {
    const clock = new FakeClock('2026-11-14T10:00:00.000Z');
    const slack = new FakeSlack({ bot: BOT, app: APP });
    const redactor = new SecretRedactor();
    const logger = new MemoryLogger(redactor.asRedactor);
    const api = new SlackWebClient({ fetch: slack.fetch, timers: clock, redactor, baseUrl: FAKE_SLACK_URL });
    const sockets = new FakeSocketFactory();
    const order: string[] = [];
    const statuses: SocketStatus[] = [];
    const client = new SocketModeClient({
      api,
      appToken: () => ('appToken' in options ? options.appToken : APP),
      onEvent:
        options.onEvent ??
        ((e) => {
          order.push(`handle:${e.envelope_id}`);
          return () => order.push(`after:${e.envelope_id}`);
        }),
      onStatus: (s) => statuses.push(s),
      webSocket: (url) => {
        const s = sockets.create(url);
        const send = s.send.bind(s);
        s.send = (data: string) => {
          order.push(`ack:${(JSON.parse(data) as { envelope_id: string }).envelope_id}`);
          send(data);
        };
        return s;
      },
      clock,
      timers: clock,
      logger,
      redactor,
      helloTimeoutMs: 10_000,
    });
    return { clock, slack, sockets, client, order, statuses, logger, redactor };
  };

  it('hello → connected; events_api is handled, acknowledged, then processed', async () => {
    const { client, sockets, order, slack } = setup();
    client.start();
    await flush();
    expect(slack.callsOf('apps.connections.open')).toHaveLength(1);
    expect(slack.callsOf('apps.connections.open')[0]?.token).toBe(APP);
    expect(client.status().state).toBe('connecting');
    sockets.last.hello();
    expect(client.status()).toMatchObject({ state: 'connected', connects: 1, lastError: null });
    sockets.last.push(messageEnvelope('env-1', { channel: 'C0123456789', ts: '1.2', thread_ts: '1.1', user: 'U0123456789', text: 'ok' }));
    expect(order).toEqual(['handle:env-1', 'ack:env-1', 'after:env-1']);
    // Other envelopes with an ID are acknowledged without processing.
    sockets.last.push({ envelope_id: 'env-2', type: 'slash_commands', payload: {} });
    expect(sockets.last.acks()).toEqual(['env-1', 'env-2']);
    client.stop();
    expect(client.status().state).toBe('stopped');
  });

  it('does not acknowledge an envelope whose recording failed (Slack delivers it again)', async () => {
    const { client, sockets, logger } = setup({
      onEvent: () => {
        throw new Error('database is locked');
      },
    });
    client.start();
    await flush();
    sockets.last.hello();
    sockets.last.push(messageEnvelope('env-1', {}));
    expect(sockets.last.acks()).toEqual([]);
    expect(logger.records.some((r) => r.msg.includes('not acknowledged'))).toBe(true);
    client.stop();
  });

  it('disconnect → reconnects at once; a lost connection → reconnect with backoff 1 s, 2 s, …; hello resets it', async () => {
    const { client, sockets, clock, slack } = setup();
    client.start();
    await flush();
    sockets.last.hello();
    sockets.last.push({ type: 'disconnect', reason: 'refresh_requested' });
    await flush();
    expect(sockets.sockets[0]?.closed).not.toBeNull();
    expect(sockets.sockets).toHaveLength(2);
    sockets.last.hello();
    expect(client.status().state).toBe('connected');

    sockets.last.drop(1006);
    expect(client.status()).toMatchObject({ state: 'disconnected', lastError: 'connection closed (code 1006)' });
    expect(client.status().nextAttemptAt).toBe('2026-11-14T10:00:01.000Z');
    clock.advance(999);
    await flush();
    expect(sockets.sockets).toHaveLength(2);
    clock.advance(1);
    await flush();
    expect(sockets.sockets).toHaveLength(3);
    sockets.last.hello();
    // Lost again (1 s), then opening fails twice → 2 s, then 4 s.
    slack.failNext('apps.connections.open', { status: 503 }, { status: 503 });
    sockets.last.drop();
    clock.advance(1_000);
    await flush();
    expect(client.status().lastError).toContain('apps.connections.open failed: Slack API apps.connections.open failed: http_503');
    expect(client.status().nextAttemptAt).toBe(new Date(clock.now().getTime() + 2_000).toISOString());
    clock.advance(2_000);
    await flush();
    expect(client.status().nextAttemptAt).toBe(new Date(clock.now().getTime() + 4_000).toISOString());
    clock.advance(4_000);
    await flush();
    expect(sockets.sockets).toHaveLength(4);
    sockets.last.hello();
    expect(client.status().state).toBe('connected');
    sockets.last.drop();
    expect(client.status().nextAttemptAt).toBe(new Date(clock.now().getTime() + 1_000).toISOString());
    client.stop();
  });

  it('caps the backoff at 60 s and reconnects when no hello arrives', async () => {
    const { client, sockets, clock, slack } = setup();
    slack.failNext('apps.connections.open', ...Array.from({ length: 10 }, () => ({ network: 'getaddrinfo ENOTFOUND slack.com' })));
    client.start();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      await flush();
      const next = Date.parse(client.status().nextAttemptAt ?? '');
      delays.push(next - clock.now().getTime());
      clock.set(new Date(next));
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    await flush();
    clock.set(new Date(Date.parse(client.status().nextAttemptAt ?? '')));
    await flush();
    // Connected socket without hello → dropped after the hello timeout.
    const before = sockets.sockets.length;
    expect(before).toBeGreaterThan(0);
    clock.advance(10_000);
    await flush();
    expect(sockets.sockets[before - 1]?.closed).not.toBeNull();
    expect(client.status().lastError).toBe('no hello within 10000 ms');
    client.stop();
  });

  it('without an app token: disconnected with an error, never logs a token or the ticket URL', async () => {
    const missing = setup({ appToken: undefined });
    missing.client.start();
    await flush();
    expect(missing.client.status()).toMatchObject({ state: 'disconnected' });
    expect(missing.client.status().lastError).toContain('app-level token is not set');
    missing.client.stop();

    const { client, sockets, logger, slack } = setup();
    slack.failNext('apps.connections.open', { network: `connect failed for Bearer ${APP}` });
    client.start();
    await flush();
    expect(client.status().lastError).not.toContain(APP);
    const all = JSON.stringify(logger.records);
    expect(all).not.toContain(APP);
    expect(all).not.toContain('secret-ticket');
    void sockets;
    client.stop();
  });
});

/** Minimal WebSocket server (RFC 6455 text frames, no extensions) for the integration test. */
class TinyWsServer {
  readonly server: Server;
  readonly received: string[] = [];
  private socket: Socket | undefined;
  private onReceive: (() => void) | undefined;

  constructor() {
    this.server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.server.on('upgrade', (req, socket: Socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
      this.socket = socket;
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const frame = readFrame(buffer);
          if (!frame) break;
          buffer = buffer.subarray(frame.length);
          if (frame.opcode === 1) {
            this.received.push(frame.payload.toString('utf8'));
            this.onReceive?.();
          } else if (frame.opcode === 8) {
            socket.end();
          }
        }
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as { port: number }).port;
  }

  connected(): boolean {
    return this.socket !== undefined;
  }

  send(obj: unknown): void {
    const payload = Buffer.from(JSON.stringify(obj));
    const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
    this.socket?.write(Buffer.concat([header, payload]));
  }

  waitForMessage(): Promise<void> {
    return new Promise((resolve) => {
      this.onReceive = resolve;
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function readFrame(buf: Buffer): { opcode: number; payload: Buffer; length: number } | null {
  if (buf.length < 2) return null;
  const opcode = (buf[0] as number) & 0x0f;
  const masked = ((buf[1] as number) & 0x80) !== 0;
  let len = (buf[1] as number) & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  return { opcode, payload, length: offset + maskLen + len };
}

const hasGlobalWebSocket = typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function';

describe.runIf(hasGlobalWebSocket)('SocketModeClient with the global WebSocket (WI-39)', () => {
  let ws: TinyWsServer | undefined;
  afterEach(async () => {
    await ws?.close();
    ws = undefined;
  });

  it('connects to a real WebSocket server, gets hello and acknowledges an event', async () => {
    ws = new TinyWsServer();
    const port = await ws.listen();
    const handled: string[] = [];
    let status: SocketStatus | undefined;
    const client = new SocketModeClient({
      api: { openConnection: async () => `ws://127.0.0.1:${port}/link` },
      appToken: () => APP,
      onEvent: (e) => {
        handled.push(e.envelope_id);
      },
      onStatus: (s) => {
        status = s;
      },
    });
    client.start();
    const deadline = Date.now() + 5_000;
    while (!ws.connected() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    ws.send({ type: 'hello' });
    while (status?.state !== 'connected' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(status?.state).toBe('connected');
    const acked = ws.waitForMessage();
    ws.send(messageEnvelope('real-1', { text: 'hi' }));
    await acked;
    expect(handled).toEqual(['real-1']);
    expect(ws.received.map((m) => JSON.parse(m) as unknown)).toEqual([{ envelope_id: 'real-1' }]);
    client.stop();
  });
});
