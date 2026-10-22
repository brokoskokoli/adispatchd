/**
 * Lock-key semantics for the active-run uniqueness constraint
 * `(workflow_id, lock_key)` (Spec §7, §11, §12).
 *
 * - Item-bound runs (trigger `source`, or `manual` with an item):
 *   `item:<sourceItemKey>` → at most one active run per workflow and item,
 *   also for manual starts (Spec §7: manual starts never bypass the lock).
 * - Cron runs without item: `cron:<scheduled_for ISO>` → at most one run per
 *   cron slot (in addition to the `cron_firings` unique key). Overlap of
 *   different slots of the same workflow is governed by `max_concurrent`.
 * - Manual runs without item: `manual:<runId>` → unique per run, never conflicts.
 * - Lifecycle runs of removed blocks (trigger `unblock`, WI-30): `item:<key>`
 *   for item-scoped blocks (holds the item lock while `on_retry_unblock`
 *   runs), `unblock:<runId>` for workflow-scoped blocks.
 *
 * Prefixes keep the namespaces disjoint (a source could be named `cron`).
 * The retry-block / failure-counter scope is separate: the source item key,
 * or the whole workflow for sourceless runs (see {@link blockScopeKey}).
 */
import { iso } from './sqlite.js';
import type { TriggerType } from '../core/index.js';

/** Inputs determining a run's lock key. */
export interface LockKeyInput {
  triggerType: TriggerType;
  runId: string;
  sourceItemKey?: string | null;
  /** Cron slot; required for `schedule` runs without item. */
  scheduledFor?: Date | string | null;
}

/** Compute the lock key for a run (see module docs). */
export function lockKeyFor(input: LockKeyInput): string {
  if (input.sourceItemKey) return `item:${input.sourceItemKey}`;
  switch (input.triggerType) {
    case 'source':
      throw new TypeError('Source-triggered runs require a sourceItemKey');
    case 'schedule':
      if (input.scheduledFor === undefined || input.scheduledFor === null) {
        throw new TypeError('Scheduled runs without item require scheduledFor');
      }
      return `cron:${iso(input.scheduledFor)}`;
    case 'manual':
      return `manual:${input.runId}`;
    case 'unblock':
      // Lifecycle run of a removed workflow-scoped block (WI-30); item-scoped ones take the item lock above.
      return `unblock:${input.runId}`;
  }
}

/**
 * Internal non-null scope key for failure counters/blocks: the item key, or
 * `''` for workflow scope (sourceless runs).
 */
export function blockScopeKey(itemKey: string | null | undefined): string {
  return itemKey ?? '';
}
