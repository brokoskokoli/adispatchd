/**
 * Read access to the persistent scheduling state (active runs, locks, blocks,
 * cron firings). The planning step and the dry-run only read through this
 * interface; reservations go through the repositories directly.
 */
import type { CronFiringRecord, Repositories } from '../persistence/index.js';

/** Read-only view on runs/locks/blocks used for planning and dry-runs. */
export interface SchedulingState {
  /** Active runs (all triggers incl. manual and `recovery_pending`), optionally per workflow. */
  countActive(workflowId?: string): number;
  /** Run holding the item lock of `workflowId`, or `null`. */
  activeRunForItem(workflowId: string, itemKey: string): { id: string } | null;
  /** Active retry block for workflow/item (`itemKey = null` → workflow scope), or `null`. */
  activeBlock(workflowId: string, itemKey: string | null): { id: number; reason: string } | null;
  /** Recent cron firings of a workflow, newest slot first. */
  recentCronFirings(workflowId: string, limit: number): CronFiringRecord[];
}

/** {@link SchedulingState} over the repositories. */
export function repositoryState(repos: Pick<Repositories, 'runs' | 'blocks' | 'cronFirings'>): SchedulingState {
  return {
    countActive: (workflowId) => repos.runs.countActive(workflowId),
    activeRunForItem: (workflowId, itemKey) => {
      const run = repos.runs.activeRunForItem(workflowId, itemKey);
      return run ? { id: run.id } : null;
    },
    activeBlock: (workflowId, itemKey) => {
      const block = repos.blocks.activeFor(workflowId, itemKey);
      return block ? { id: block.id, reason: block.reason } : null;
    },
    recentCronFirings: (workflowId, limit) => repos.cronFirings.listForWorkflow(workflowId, limit),
  };
}

/** Empty state (no database available, e.g. a local CLI dry-run without data dir). */
export function emptyState(): SchedulingState {
  return {
    countActive: () => 0,
    activeRunForItem: () => null,
    activeBlock: () => null,
    recentCronFirings: () => [],
  };
}
