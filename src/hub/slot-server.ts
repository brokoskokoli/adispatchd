/**
 * Slot server of the hub (WI-35): listens on a Unix socket (mode 0600) in the
 * hub data dir and hands out the shared run slots (see `protocol.ts`).
 *
 * Lifetime of a workspace's leases: they live as long as the workspace
 * connection is healthy. A connection that stays silent for `leaseTtlMs`
 * (missing heartbeats) is closed; a closed connection keeps its leases for
 * `leaseTtlMs` so a restarting hub client can reconnect (its `hello` lists the
 * leases it still holds), then they expire. A `bye` or {@link SlotServer.dropWorkspace}
 * (the hub saw the child process exit) frees them at once.
 */
import { rmSync } from 'node:fs';
import net from 'node:net';
import { errorMessage, noopLogger, systemClock, systemTimers, type Clock, type Logger, type TimerHandle, type Timers } from '../core/index.js';
import { SlotLedger } from './ledger.js';
import { listenPrivate } from './private-listen.js';
import {
  LineBuffer,
  LineTooLongError,
  SLOT_PROTOCOL_VERSION,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type SlotState,
} from './protocol.js';

/** Default time without heartbeat after which leases expire. */
export const DEFAULT_LEASE_TTL_MS = 15_000;
/** Longest usable Unix socket path (sockaddr_un.sun_path is 104 bytes on macOS, 108 on Linux). */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Options of {@link SlotServer}. */
export interface SlotServerOptions {
  socketPath: string;
  ledger: SlotLedger;
  /** IDs of the workspaces that may connect. */
  workspaceIds: () => ReadonlySet<string>;
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  /** Time without a message after which a connection is closed and its leases expire. */
  leaseTtlMs?: number;
  /** Called after every change of the ledger (WI-36: live updates). */
  onChange?: () => void;
}

interface Connection {
  socket: net.Socket;
  workspace: string | null;
  lastSeen: number;
  buffer: LineBuffer;
}

/** See module docs. */
export class SlotServer {
  private server: net.Server | undefined;
  private readonly connections = new Set<Connection>();
  private readonly byWorkspace = new Map<string, Connection>();
  private readonly expiry = new Map<string, TimerHandle>();
  private sweepTimer: TimerHandle | undefined;
  private closed = false;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly log: Logger;
  private readonly leaseTtlMs: number;

  constructor(private readonly options: SlotServerOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.log = (options.logger ?? noopLogger).child({ component: 'hub-slots' });
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Current hub-wide state. */
  state(): SlotState {
    return { active: this.options.ledger.active, max: this.options.ledger.max, paused: this.options.ledger.paused };
  }

  /** Workspaces with an established, identified connection. */
  connectedWorkspaces(): string[] {
    return [...this.byWorkspace.keys()].sort();
  }

  /** Create the socket (an old socket file of a dead hub is removed; the instance lock guarantees exclusivity). */
  async listen(): Promise<void> {
    const p = this.options.socketPath;
    if (Buffer.byteLength(p) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`slot socket path is too long (${Buffer.byteLength(p)} > ${MAX_SOCKET_PATH_BYTES} bytes): ${p} – use a shorter hub data dir`);
    }
    rmSync(p, { force: true });
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await listenPrivate(server, p);
    server.on('error', (err) => this.log.error('slot socket error', { error: errorMessage(err) }));
    this.armSweep();
    this.log.info('slot server listening', { max: this.options.ledger.max });
  }

  /** Stop accepting, close all connections and remove the socket file. Leases are dropped. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) this.timers.clearTimeout(this.sweepTimer);
    for (const t of this.expiry.values()) this.timers.clearTimeout(t);
    this.expiry.clear();
    for (const c of [...this.connections]) c.socket.destroy();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.options.socketPath, { force: true });
  }

  /** Pause/resume the hub (denies new automatic runs). */
  setPaused(paused: boolean): void {
    if (this.options.ledger.paused === paused) return;
    this.options.ledger.paused = paused;
    this.changed();
  }

  /** The workspace's process ended (or was stopped): free its slots at once and close its connection. */
  dropWorkspace(workspace: string): void {
    this.cancelExpiry(workspace);
    const conn = this.byWorkspace.get(workspace);
    conn?.socket.destroy();
    this.byWorkspace.delete(workspace);
    const n = this.options.ledger.drop(workspace);
    if (n > 0) {
      this.log.info('slots of workspace released', { workspace, slots: n });
      this.changed();
    }
  }

  // --- connections ------------------------------------------------------------

  private accept(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const conn: Connection = { socket, workspace: null, lastSeen: this.clock.now().getTime(), buffer: new LineBuffer() };
    this.connections.add(conn);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      conn.lastSeen = this.clock.now().getTime();
      try {
        for (const line of conn.buffer.push(chunk)) this.handleLine(conn, line);
      } catch (err) {
        if (err instanceof LineTooLongError) this.fail(conn, 'line_too_long', err.message);
        else this.log.error('slot message failed', { error: errorMessage(err) });
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => this.onClose(conn));
  }

  private onClose(conn: Connection): void {
    this.connections.delete(conn);
    const ws = conn.workspace;
    if (ws === null || this.byWorkspace.get(ws) !== conn) return; // replaced by a newer connection
    this.byWorkspace.delete(ws);
    if (this.closed || this.options.ledger.activeOf(ws) === 0) return;
    // Keep the leases for a grace period: the client reconnects and re-announces them.
    this.cancelExpiry(ws);
    this.expiry.set(
      ws,
      this.timers.setTimeout(() => {
        this.expiry.delete(ws);
        if (this.byWorkspace.has(ws)) return;
        const n = this.options.ledger.drop(ws);
        if (n > 0) {
          this.log.warn('slots of workspace expired (connection lost)', { workspace: ws, slots: n });
          this.changed();
        }
      }, this.leaseTtlMs),
    );
  }

  private fail(conn: Connection, code: string, message: string): void {
    this.send(conn, { t: 'error', code, message });
    conn.socket.destroy();
  }

  private send(conn: Connection, message: ServerMessage): void {
    if (!conn.socket.destroyed) conn.socket.write(encodeMessage(message));
  }

  private handleLine(conn: Connection, line: string): void {
    const msg = parseClientMessage(line);
    if (!msg) return this.fail(conn, 'bad_message', 'malformed message');
    if (msg.t === 'hello') return this.hello(conn, msg);
    const ws = conn.workspace;
    if (ws === null) return this.fail(conn, 'hello_required', 'send "hello" first');
    const ledger = this.options.ledger;
    switch (msg.t) {
      case 'acquire': {
        const res = ledger.tryAcquire(ws, msg.lease);
        if (res.ok) {
          this.send(conn, { t: 'granted', id: msg.id });
          this.changed();
        } else {
          this.send(conn, { t: 'denied', id: msg.id, reason: res.reason, ...this.state() });
        }
        return;
      }
      case 'adopt':
        ledger.adopt(ws, msg.lease);
        this.changed();
        return;
      case 'release':
        if (ledger.release(ws, msg.lease)) this.changed();
        return;
      case 'heartbeat':
        if (ledger.retain(ws, msg.leases) > 0) this.changed();
        else this.send(conn, { t: 'state', ...this.state() });
        return;
      case 'bye':
        this.dropWorkspace(ws);
        return;
    }
  }

  private hello(conn: Connection, msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (msg.v !== SLOT_PROTOCOL_VERSION) return this.fail(conn, 'unsupported_version', `protocol version ${msg.v} is not supported (expected ${SLOT_PROTOCOL_VERSION})`);
    if (!this.options.workspaceIds().has(msg.workspace)) return this.fail(conn, 'unknown_workspace', `workspace "${msg.workspace}" is not part of this hub`);
    const previous = this.byWorkspace.get(msg.workspace);
    if (previous && previous !== conn) {
      this.byWorkspace.delete(msg.workspace);
      previous.workspace = null;
      previous.socket.destroy();
    }
    this.cancelExpiry(msg.workspace);
    conn.workspace = msg.workspace;
    this.byWorkspace.set(msg.workspace, conn);
    // The workspace's own list is authoritative (runs that survived a hub restart count again).
    this.options.ledger.replace(msg.workspace, msg.leases);
    this.log.info('workspace connected', { workspace: msg.workspace, pid: msg.pid, leases: msg.leases.length });
    this.send(conn, { t: 'welcome', ...this.state() });
    this.changed();
  }

  private cancelExpiry(workspace: string): void {
    const t = this.expiry.get(workspace);
    if (t) this.timers.clearTimeout(t);
    this.expiry.delete(workspace);
  }

  /** Push the new state to every identified connection. */
  private changed(): void {
    const line = encodeMessage({ t: 'state', ...this.state() });
    for (const c of this.byWorkspace.values()) if (!c.socket.destroyed) c.socket.write(line);
    this.options.onChange?.();
  }

  // --- liveness ---------------------------------------------------------------

  private armSweep(): void {
    if (this.closed) return;
    this.sweepTimer = this.timers.setTimeout(() => {
      const now = this.clock.now().getTime();
      for (const c of [...this.connections]) {
        if (now - c.lastSeen > this.leaseTtlMs) {
          this.log.warn('connection silent: closing', { workspace: c.workspace });
          c.socket.destroy();
        }
      }
      this.armSweep();
    }, Math.max(250, Math.floor(this.leaseTtlMs / 3)));
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }
}
