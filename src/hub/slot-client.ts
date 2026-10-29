/**
 * Slot client of a workspace instance (WI-35): connects to the hub's Unix
 * socket (`ADISPATCH_HUB_SOCKET`) and implements {@link HubSlots} for the
 * scheduler.
 *
 * - `acquire` asks the hub before an automatic run is reserved; denied (limit,
 *   pause) or hub unreachable/silent → no automatic start (safe side).
 * - Leases are released when the run ends (`attach`) and reconciled against the
 *   database on every heartbeat: active runs without a lease (manual starts,
 *   runs found by recovery) are adopted, leases of runs that are no longer
 *   active are released. After a lost connection the next `hello` re-announces
 *   all leases, so a restarted hub counts the runs that kept running.
 * - Runs that are active never depend on the connection: the client only
 *   decides about *new* starts.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import {
  errorMessage,
  noopLogger,
  systemClock,
  systemTimers,
  type Clock,
  type HubAcquireResult,
  type HubSlotLease,
  type HubSlots,
  type HubSlotsSnapshot,
  type Logger,
  type TimerHandle,
  type Timers,
} from '../core/index.js';
import { DEFAULT_HEARTBEAT_MS } from './slot-server.js';
import {
  LineBuffer,
  SLOT_PROTOCOL_VERSION,
  encodeMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type SlotState,
} from './protocol.js';

/** Options of {@link HubSlotClient}. */
export interface HubSlotClientOptions {
  socketPath: string;
  workspaceId: string;
  /** IDs of the runs that currently occupy a slot (database truth: active runs). */
  activeRunIds: () => string[];
  clock?: Clock;
  timers?: Timers;
  logger?: Logger;
  heartbeatMs?: number;
  /** How long `acquire` waits for the hub. */
  requestTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  /** A granted lease that is never handed to a run is released after this time. */
  unattachedLeaseMs?: number;
  /** Socket factory (tests). */
  connect?: (socketPath: string) => net.Socket;
}

interface LeaseEntry {
  runId: string | null;
  since: number;
}

interface Pending {
  resolve: (r: HubAcquireResult) => void;
  timer: TimerHandle;
  key: string;
}

/** See module docs. */
export class HubSlotClient implements HubSlots {
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly log: Logger;
  private readonly heartbeatMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly unattachedLeaseMs: number;
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly pending = new Map<number, Pending>();
  private socket: net.Socket | undefined;
  private connected = false;
  private started = false;
  private stopped = false;
  private state: SlotState = { active: 0, max: 0, paused: false };
  private nextRequest = 1;
  private lastMessageAt = 0;
  private reconnectDelay: number;
  private reconnectTimer: TimerHandle | undefined;
  private tickTimer: TimerHandle | undefined;
  private outageLogged = false;
  private readonly waiters = new Set<{ resolve: (ok: boolean) => void; timer: TimerHandle | undefined }>();

  constructor(private readonly options: HubSlotClientOptions) {
    this.clock = options.clock ?? systemClock;
    this.timers = options.timers ?? systemTimers;
    this.log = (options.logger ?? noopLogger).child({ component: 'hub-client', workspace: options.workspaceId });
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.reconnectInitialMs = options.reconnectInitialMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5_000;
    this.unattachedLeaseMs = options.unattachedLeaseMs ?? 60_000;
    this.reconnectDelay = this.reconnectInitialMs;
  }

  // --- HubSlots ---------------------------------------------------------------

  snapshot(): HubSlotsSnapshot {
    return { reachable: this.connected, paused: this.state.paused, active: this.state.active, max: this.state.max };
  }

  acquire(): Promise<HubAcquireResult> {
    if (!this.connected) return Promise.resolve({ ok: false, reason: 'hub not reachable (no new automatic runs)' });
    const key = `a:${randomUUID()}`;
    const id = this.nextRequest++;
    this.leases.set(key, { runId: null, since: this.clock.now().getTime() });
    return new Promise<HubAcquireResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.drop(key);
        resolve({ ok: false, reason: 'hub did not answer in time (no new automatic runs)' });
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer, key });
      this.send({ t: 'acquire', id, lease: key });
    });
  }

  adopt(runId: string, done: Promise<unknown>): void {
    const key = `run:${runId}`;
    if (!this.leases.has(key)) {
      this.leases.set(key, { runId, since: this.clock.now().getTime() });
      this.send({ t: 'adopt', lease: key });
    }
    const release = (): void => this.drop(key);
    done.then(release, release);
  }

  // --- lifecycle --------------------------------------------------------------

  /** Begin connecting and heartbeating (idempotent). Never throws; an unreachable hub is retried. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connectNow();
    this.armTick();
  }

  /**
   * Resolve `true` once the hub answered (immediately if it already has), `false` after `timeoutMs`.
   * Used at startup so that the first planning step already knows the hub.
   */
  whenConnected(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = { resolve: (ok: boolean) => resolve(ok), timer: undefined as TimerHandle | undefined };
      waiter.timer = this.timers.setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Say goodbye (frees the slots at once), close the connection and stop all timers. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // With runs still holding slots the hub keeps them until the process exits (or the lease TTL passes).
    if (this.connected && this.leases.size === 0) this.send({ t: 'bye' });
    this.connected = false;
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    if (this.tickTimer) this.timers.clearTimeout(this.tickTimer);
    this.failPending('hub client stopped');
    for (const w of this.waiters) {
      if (w.timer) this.timers.clearTimeout(w.timer);
      w.resolve(false);
    }
    this.waiters.clear();
    this.socket?.destroy();
    this.socket = undefined;
  }

  // --- connection -------------------------------------------------------------

  private connectNow(): void {
    if (this.stopped) return;
    const socket = (this.options.connect ?? ((p) => net.createConnection(p)))(this.options.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');
    const buffer = new LineBuffer();
    let identified = false;
    socket.on('connect', () => {
      this.reconcile();
      this.lastMessageAt = this.clock.now().getTime();
      this.rawSend(socket, {
        t: 'hello',
        v: SLOT_PROTOCOL_VERSION,
        workspace: this.options.workspaceId,
        pid: process.pid,
        leases: [...this.leases.keys()],
      });
    });
    socket.on('data', (chunk: string) => {
      this.lastMessageAt = this.clock.now().getTime();
      try {
        for (const line of buffer.push(chunk)) {
          const msg = parseServerMessage(line);
          if (!msg) continue;
          if (msg.t === 'welcome') identified = true;
          this.onMessage(msg);
        }
      } catch (err) {
        this.log.warn('invalid data from the hub', { error: errorMessage(err) });
        socket.destroy();
      }
    });
    socket.on('error', (err) => {
      if (!this.outageLogged && !this.stopped) {
        this.outageLogged = true;
        this.log.warn('hub not reachable: no new automatic runs until it is back', { error: errorMessage(err) });
      }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const wasConnected = this.connected && identified;
      this.connected = false;
      this.socket = undefined;
      this.failPending('hub connection lost');
      if (wasConnected && !this.stopped) {
        this.outageLogged = true;
        this.log.warn('connection to the hub lost: no new automatic runs until it is back');
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectDelay = Math.min(this.reconnectMaxMs, this.reconnectDelay * 2);
      this.connectNow();
    }, this.reconnectDelay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.state = { active: msg.active, max: msg.max, paused: msg.paused };
        this.connected = true;
        this.reconnectDelay = this.reconnectInitialMs;
        this.log.info('connected to the hub', { max: msg.max, active: msg.active, paused: msg.paused, ...(this.outageLogged ? { recovered: true } : {}) });
        this.outageLogged = false;
        for (const w of this.waiters) {
          if (w.timer) this.timers.clearTimeout(w.timer);
          w.resolve(true);
        }
        this.waiters.clear();
        return;
      case 'state':
        this.state = { active: msg.active, max: msg.max, paused: msg.paused };
        return;
      case 'granted': {
        const p = this.takePending(msg.id);
        if (!p) return;
        p.resolve({ ok: true, lease: this.leaseHandle(p.key) });
        return;
      }
      case 'denied': {
        this.state = { active: msg.active, max: msg.max, paused: msg.paused };
        const p = this.takePending(msg.id);
        if (!p) return;
        this.leases.delete(p.key);
        p.resolve({ ok: false, reason: msg.reason });
        return;
      }
      case 'error':
        this.log.error('hub rejected the connection', { code: msg.code, message: msg.message });
        return;
    }
  }

  private takePending(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    this.timers.clearTimeout(p.timer);
    return p;
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.timers.clearTimeout(p.timer);
      this.leases.delete(p.key);
      p.resolve({ ok: false, reason: `${reason} (no new automatic runs)` });
      this.pending.delete(id);
    }
  }

  private leaseHandle(key: string): HubSlotLease {
    return {
      attach: (runId, done) => {
        // A heartbeat may have adopted the run before it was attached: this lease takes over.
        this.drop(`run:${runId}`);
        const entry = this.leases.get(key);
        if (entry) entry.runId = runId;
        const release = (): void => this.drop(key);
        done.then(release, release);
      },
      release: () => this.drop(key),
    };
  }

  /** Forget a lease and tell the hub (idempotent). */
  private drop(key: string): void {
    if (!this.leases.delete(key)) return;
    this.send({ t: 'release', lease: key });
  }

  private send(message: ClientMessage): void {
    if (this.socket && this.connected) this.rawSend(this.socket, message);
  }

  private rawSend(socket: net.Socket, message: ClientMessage): void {
    if (!socket.destroyed) socket.write(encodeMessage(message));
  }

  // --- heartbeat and reconciliation -------------------------------------------

  private armTick(): void {
    if (this.stopped) return;
    this.tickTimer = this.timers.setTimeout(() => {
      this.tick();
      this.armTick();
    }, this.heartbeatMs);
    (this.tickTimer as { unref?: () => void }).unref?.();
  }

  private tick(): void {
    try {
      this.reconcile();
    } catch (err) {
      this.log.warn('slot reconciliation failed', { error: errorMessage(err) });
    }
    if (!this.connected || !this.socket) return;
    if (this.clock.now().getTime() - this.lastMessageAt > this.heartbeatMs * 3 + this.requestTimeoutMs && this.lastMessageAt > 0) {
      // The hub accepted the connection but stopped talking: treat it as down.
      this.log.warn('the hub stopped answering: closing the connection');
      this.socket.destroy();
      return;
    }
    this.send({ t: 'heartbeat', leases: [...this.leases.keys()] });
  }

  /** Align leases with the active runs in the database. */
  private reconcile(): void {
    const active = new Set(this.options.activeRunIds());
    const now = this.clock.now().getTime();
    const covered = new Set<string>();
    for (const [key, entry] of [...this.leases]) {
      if (entry.runId !== null) {
        if (active.has(entry.runId)) covered.add(entry.runId);
        else this.drop(key);
      } else if (now - entry.since > this.unattachedLeaseMs && !this.isPending(key)) {
        this.drop(key);
      }
    }
    for (const runId of active) {
      if (covered.has(runId)) continue;
      const key = `run:${runId}`;
      this.leases.set(key, { runId, since: now });
      this.send({ t: 'adopt', lease: key });
    }
  }

  private isPending(key: string): boolean {
    for (const p of this.pending.values()) if (p.key === key) return true;
    return false;
  }
}
