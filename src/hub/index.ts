/**
 * Component `hub` – public API (WI-35): slot protocol, slot server/client and
 * the hub itself (workspace supervision, control socket).
 */
export { SlotLedger } from './ledger.js';
export { HubSlotClient, type HubSlotClientOptions } from './slot-client.js';
export { SlotServer, DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_TTL_MS, MAX_SOCKET_PATH_BYTES, type SlotServerOptions } from './slot-server.js';
export { SLOT_PROTOCOL_VERSION, type SlotState } from './protocol.js';
export { HubError } from './errors.js';
export { ControlServer, type HubControl, type ControlServerOptions } from './control-server.js';
export {
  WorkspaceSupervisor,
  DEFAULT_BACKOFF,
  type BackoffPolicy,
  type SupervisorOptions,
  type WorkspaceControl,
  type WorkspaceProbe,
  type WorkspaceState,
  type WorkspaceStatus,
  type WorkspaceTransition,
} from './supervisor.js';
export { processSpawner, type ChildHandle, type ProcessSpawnerOptions, type SpawnSpec, type WorkspaceSpawner } from './spawner.js';
export { httpWorkspaceControl, httpWorkspaceProbe } from './workspace-control.js';
export {
  createHub,
  HUB_CONTROL_SOCKET,
  HUB_DEFAULT_CANCEL_TIMEOUT_MS,
  HUB_DEFAULT_DRAIN_TIMEOUT_MS,
  HUB_SLOT_SOCKET,
  type Hub,
  type HubOptions,
  type HubShutdownOptions,
  type HubStatus,
  type HubStopResult,
  type HubWorkspaceStatus,
} from './hub.js';
export { HubControlClient, HubResponseError, HubUnreachableError } from './control-client.js';
