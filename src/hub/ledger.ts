/**
 * Slot ledger of the hub (WI-36): who holds how many of the `max` slots.
 * Pure bookkeeping without I/O; the invariant is that {@link SlotLedger.tryAcquire}
 * never grants a slot while `active >= max` (or while paused). Adopted leases
 * (manual starts, runs found after a hub or workspace restart) are real runs
 * that cannot be refused, so `active` may exceed `max` until they end – new
 * automatic runs are then denied.
 */
import { MAX_LEASES_PER_WORKSPACE } from './protocol.js';

/** Why an acquire was denied. */
export type DenyReason = { code: 'limit'; reason: string } | { code: 'paused'; reason: string } | { code: 'too_many'; reason: string };

export class SlotLedger {
  paused = false;
  private readonly leases = new Map<string, Set<string>>();

  constructor(readonly max: number) {}

  /** Slots in use across all workspaces. */
  get active(): number {
    let n = 0;
    for (const set of this.leases.values()) n += set.size;
    return n;
  }

  /** Slots held by one workspace. */
  activeOf(workspace: string): number {
    return this.leases.get(workspace)?.size ?? 0;
  }

  /** Workspaces holding at least one slot, with their counts. */
  byWorkspace(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, set] of this.leases) if (set.size > 0) out[id] = set.size;
    return out;
  }

  /** Grant a slot if one is free. Idempotent for a key the workspace already holds. */
  tryAcquire(workspace: string, key: string): { ok: true } | ({ ok: false } & DenyReason) {
    const held = this.leases.get(workspace);
    if (held?.has(key)) return { ok: true };
    if (this.paused) return { ok: false, code: 'paused', reason: 'hub paused (no new automatic runs)' };
    const active = this.active;
    if (active >= this.max) return { ok: false, code: 'limit', reason: `hub limit reached (${active}/${this.max} active)` };
    if ((held?.size ?? 0) >= MAX_LEASES_PER_WORKSPACE) return { ok: false, code: 'too_many', reason: 'too many leases for this workspace' };
    this.set(workspace).add(key);
    return { ok: true };
  }

  /** Register a lease regardless of the limit. */
  adopt(workspace: string, key: string): void {
    const held = this.set(workspace);
    if (held.size < MAX_LEASES_PER_WORKSPACE) held.add(key);
  }

  /** Free a lease; returns whether it was held. */
  release(workspace: string, key: string): boolean {
    const held = this.leases.get(workspace);
    const had = held?.delete(key) ?? false;
    if (held?.size === 0) this.leases.delete(workspace);
    return had;
  }

  /** Make the workspace's leases exactly `keys` (new ones are adopted); returns the number of changes. */
  replace(workspace: string, keys: readonly string[]): number {
    const next = new Set(keys.slice(0, MAX_LEASES_PER_WORKSPACE));
    const held = this.leases.get(workspace) ?? new Set<string>();
    let changes = 0;
    for (const key of held) if (!next.has(key)) changes++;
    for (const key of next) if (!held.has(key)) changes++;
    if (next.size === 0) this.leases.delete(workspace);
    else this.leases.set(workspace, next);
    return changes;
  }

  /** Free the leases of the workspace that are not in `keys` (unknown keys are ignored); returns how many were freed. */
  retain(workspace: string, keys: readonly string[]): number {
    const held = this.leases.get(workspace);
    if (!held) return 0;
    const keep = new Set(keys);
    let freed = 0;
    for (const key of [...held]) {
      if (!keep.has(key)) {
        held.delete(key);
        freed++;
      }
    }
    if (held.size === 0) this.leases.delete(workspace);
    return freed;
  }

  /** Free all leases of a workspace; returns how many were held. */
  drop(workspace: string): number {
    const n = this.leases.get(workspace)?.size ?? 0;
    this.leases.delete(workspace);
    return n;
  }

  private set(workspace: string): Set<string> {
    let held = this.leases.get(workspace);
    if (!held) {
      held = new Set();
      this.leases.set(workspace, held);
    }
    return held;
  }
}
