/**
 * Component `hub` – public API (WI-35): slot protocol, slot server/client and
 * the hub itself (workspace supervision, control socket).
 */
export { SlotLedger } from './ledger.js';
export { HubSlotClient, type HubSlotClientOptions } from './slot-client.js';
export { SlotServer, DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_TTL_MS, MAX_SOCKET_PATH_BYTES, type SlotServerOptions } from './slot-server.js';
export { SLOT_PROTOCOL_VERSION, type SlotState } from './protocol.js';
