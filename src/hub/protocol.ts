/**
 * Slot protocol between a workspace instance (client) and the hub (server)
 * over a Unix socket (WI-35, docs/worker-protocol.md "Slot-Protokoll").
 *
 * Framing: one JSON object per line (`\n`), at most {@link MAX_LINE_BYTES}
 * bytes. The workspace announces itself with `hello` (workspace ID and the
 * leases it already holds) and then asks for a slot before every automatic run
 * start (`acquire`), gives it back at the end (`release`) and refreshes all of
 * its leases with `heartbeat` (keep-alive; leases the hub holds that are
 * missing from the list are freed, unknown entries are ignored – a lease is
 * only ever added by `acquire`, `adopt` or `hello`). A lease is an opaque
 * client-chosen key. After a reconnect the `hello` list is authoritative.
 */

/** Protocol version sent in `hello`. */
export const SLOT_PROTOCOL_VERSION = 1;
/** Default heartbeat interval of clients. */
export const DEFAULT_HEARTBEAT_MS = 2_000;
/** Maximum size of one protocol line. */
export const MAX_LINE_BYTES = 64 * 1024;
/** Maximum number of leases a workspace may hold (bounds memory per connection). */
export const MAX_LEASES_PER_WORKSPACE = 1024;
/** Allowed lease keys. */
export const LEASE_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

/** Hub-wide state pushed to every connection. */
export interface SlotState {
  /** Slots in use across all workspaces. */
  active: number;
  /** Hub limit. */
  max: number;
  paused: boolean;
}

/** Messages from a workspace to the hub. */
export type ClientMessage =
  | { t: 'hello'; v: number; workspace: string; pid: number; leases: string[] }
  | { t: 'acquire'; id: number; lease: string }
  | { t: 'adopt'; lease: string }
  | { t: 'release'; lease: string }
  | { t: 'heartbeat'; leases: string[] }
  | { t: 'bye' };

/** Messages from the hub to a workspace. */
export type ServerMessage =
  | ({ t: 'welcome' } & SlotState)
  | { t: 'granted'; id: number }
  | ({ t: 'denied'; id: number; reason: string } & SlotState)
  | ({ t: 'state' } & SlotState)
  | { t: 'error'; code: string; message: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isLeaseKey(v: unknown): v is string {
  return typeof v === 'string' && LEASE_KEY_PATTERN.test(v);
}

function leaseList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_LEASES_PER_WORKSPACE || !v.every(isLeaseKey)) return null;
  return [...new Set(v)];
}

/** Parse and validate a client line; `null` if malformed. */
export function parseClientMessage(line: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(m)) return null;
  switch (m.t) {
    case 'hello': {
      const leases = leaseList(m.leases ?? []);
      if (typeof m.workspace !== 'string' || !leases || typeof m.v !== 'number') return null;
      return { t: 'hello', v: m.v, workspace: m.workspace, pid: typeof m.pid === 'number' ? m.pid : 0, leases };
    }
    case 'acquire':
      return typeof m.id === 'number' && Number.isSafeInteger(m.id) && isLeaseKey(m.lease) ? { t: 'acquire', id: m.id, lease: m.lease } : null;
    case 'adopt':
      return isLeaseKey(m.lease) ? { t: 'adopt', lease: m.lease } : null;
    case 'release':
      return isLeaseKey(m.lease) ? { t: 'release', lease: m.lease } : null;
    case 'heartbeat': {
      const leases = leaseList(m.leases);
      return leases ? { t: 'heartbeat', leases } : null;
    }
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse and validate a hub line; `null` if malformed. */
export function parseServerMessage(line: string): ServerMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(m)) return null;
  const active = num(m.active);
  const max = num(m.max);
  const state = active !== null && max !== null && typeof m.paused === 'boolean' ? { active, max, paused: m.paused } : null;
  switch (m.t) {
    case 'welcome':
      return state ? { t: 'welcome', ...state } : null;
    case 'state':
      return state ? { t: 'state', ...state } : null;
    case 'granted':
      return typeof m.id === 'number' ? { t: 'granted', id: m.id } : null;
    case 'denied':
      return state && typeof m.id === 'number' && typeof m.reason === 'string' ? { t: 'denied', id: m.id, reason: m.reason, ...state } : null;
    case 'error':
      return typeof m.code === 'string' && typeof m.message === 'string' ? { t: 'error', code: m.code, message: m.message } : null;
    default:
      return null;
  }
}

/** Encode a message as one line. */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Thrown by {@link LineBuffer} when a line exceeds {@link MAX_LINE_BYTES}. */
export class LineTooLongError extends Error {
  constructor() {
    super(`protocol line longer than ${MAX_LINE_BYTES} bytes`);
    this.name = 'LineTooLongError';
  }
}

/** Splits a byte stream into lines. */
export class LineBuffer {
  private pending = '';

  /** Feed a chunk; returns the completed lines. @throws LineTooLongError */
  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    if (this.pending.length > MAX_LINE_BYTES || lines.some((l) => l.length > MAX_LINE_BYTES)) throw new LineTooLongError();
    return lines.filter((l) => l.trim() !== '');
  }
}
