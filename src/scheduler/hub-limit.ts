/**
 * Decision about the shared run limit of a hub (WI-35), used by the scheduler
 * and the dry-run.
 */
import type { HubSlotsSnapshot } from '../core/index.js';

/** Why the hub does not allow a new automatic run right now (`null` = it does). */
export function hubLimitReason(hub: HubSlotsSnapshot): string | null {
  if (!hub.reachable) return 'hub not reachable (no new automatic runs)';
  if (hub.paused) return 'hub paused (no new automatic runs)';
  if (hub.active >= hub.max) return `hub limit reached (${hub.active}/${hub.max} active)`;
  return null;
}
