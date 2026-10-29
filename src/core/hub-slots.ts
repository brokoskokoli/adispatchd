/**
 * Contract between the scheduler of a workspace instance and the hub's shared
 * slot limit (WI-35). The scheduler only sees this interface; the client that
 * talks to the hub over the Unix socket lives in `src/hub/`.
 */

/** Environment variable carrying the hub's slot socket path into a workspace instance. */
export const HUB_SOCKET_ENV = 'ADISPATCH_HUB_SOCKET';
/** Environment variable carrying the workspace ID into a workspace instance. */
export const HUB_WORKSPACE_ENV = 'ADISPATCH_HUB_WORKSPACE';
/**
 * Set to `stdin` by the hub (WI-36): the instance reads the hub's secret (one line)
 * from its standard input before it starts. The secret itself never appears in
 * the environment or in arguments (same-user processes can read both).
 */
export const HUB_TRUST_ENV = 'ADISPATCH_HUB_TRUST';

/** Synchronous view on the hub as last reported (never blocks). */
export interface HubSlotsSnapshot {
  /** True while the slot connection is established and the hub answers. */
  reachable: boolean;
  /** Hub-wide pause (`hub pause`): no new automatic runs. */
  paused: boolean;
  /** Slots in use across all workspaces (last known value). */
  active: number;
  /** Hub-wide limit (`hub.max_concurrent`); 0 while never connected. */
  max: number;
}

/** A slot held for one run. */
export interface HubSlotLease {
  /**
   * Hand the slot over to a started run: it is released when `done` settles.
   * Without a call the holder must {@link release} the slot itself.
   */
  attach(runId: string, done: Promise<unknown>): void;
  /** Give the slot back (idempotent). */
  release(): void;
}

/** Result of {@link HubSlots.acquire}. */
export type HubAcquireResult = { ok: true; lease: HubSlotLease } | { ok: false; reason: string };

/** Shared slot limit of a hub as seen by one workspace. */
export interface HubSlots {
  /** Last known state; used for synchronous pre-checks and diagnostics. */
  snapshot(): HubSlotsSnapshot;
  /**
   * Ask the hub for a slot for an automatic run. Denied when the hub limit is
   * reached, the hub is paused or not reachable (safe side: nothing starts).
   */
  acquire(): Promise<HubAcquireResult>;
  /**
   * Register a run that starts regardless of the limit (manual start); it
   * occupies a slot until `done` settles, but is never denied.
   */
  adopt(runId: string, done: Promise<unknown>): void;
}
