/**
 * Test double for the hub's shared slot limit (WI-35): counts like the real
 * hub (granted slots are active until released) and records every call.
 */
import type { HubAcquireResult, HubSlotLease, HubSlots, HubSlotsSnapshot } from '../../core/index.js';

export class FakeHubSlots implements HubSlots {
  reachable = true;
  paused = false;
  max: number;
  /** Slots in use on other workspaces. */
  others = 0;
  /** Slots of this workspace. */
  held = 0;
  acquireCalls = 0;
  released = 0;
  attached: string[] = [];
  adopted: string[] = [];
  /** Deny every acquire with this reason (race: the snapshot was stale). */
  denyWith: string | null = null;
  /** Runs before an acquire resolves (tests: change state while the request is in flight). */
  beforeGrant: (() => void) | null = null;

  constructor(max: number) {
    this.max = max;
  }

  snapshot(): HubSlotsSnapshot {
    return { reachable: this.reachable, paused: this.paused, active: this.others + this.held, max: this.max };
  }

  async acquire(): Promise<HubAcquireResult> {
    this.acquireCalls++;
    await Promise.resolve();
    this.beforeGrant?.();
    if (this.denyWith) return { ok: false, reason: this.denyWith };
    if (!this.reachable) return { ok: false, reason: 'hub not reachable (no new automatic runs)' };
    if (this.others + this.held >= this.max) return { ok: false, reason: `hub limit reached (${this.others + this.held}/${this.max} active)` };
    this.held++;
    let open = true;
    const release = (): void => {
      if (!open) return;
      open = false;
      this.held--;
      this.released++;
    };
    const lease: HubSlotLease = {
      attach: (runId, done) => {
        this.attached.push(runId);
        done.then(release, release);
      },
      release,
    };
    return { ok: true, lease };
  }

  adopt(runId: string, done: Promise<unknown>): void {
    this.adopted.push(runId);
    this.held++;
    const release = (): void => {
      this.held--;
    };
    done.then(release, release);
  }
}
