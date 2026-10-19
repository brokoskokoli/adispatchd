/**
 * Last status of shell checks per workflow for the UI/API (WI-24), in memory:
 *
 * - Workflow conditions: the last evaluation of every condition (planning
 *   step or cron slot), incl. time, duration, cache hit and the first stderr
 *   line (sanitized and redacted before it is shortened).
 * - Item conditions and the shell filter: a summary of the last planning
 *   step (ok / not now / error / not evaluated, counted over the checked items).
 *
 * Entries of changed or removed workflows are dropped on reload ({@link forget}).
 */
import { displayText, sanitizeDisplayText, type Redactor } from '../core/index.js';
import type { ShellCheckResult } from '../filters/index.js';
import type { CheckDiagnosis, CandidateDiagnosis } from './types.js';

/** Status of one evaluation: exit 0 / exit 1 / check error / not executed (an earlier condition decided). */
export type ConditionStatus = 'ok' | 'not_now' | 'error' | 'skipped';

/** Max. length of the stored first stderr line. */
export const MAX_STDERR_LINE = 200;

/** Last evaluation of one workflow condition. */
export interface LastConditionCheck {
  status: ConditionStatus;
  /** When the scheduler asked for the result. */
  checkedAt: string;
  /** Start of the execution that produced the result (older than `checkedAt` for cache hits); `null` if not executed. */
  ranAt: string | null;
  durationMs: number | null;
  cached: boolean;
  exitCode: number | null;
  /** Error detail (`error` status), e.g. `timed out after 15000ms`. */
  error: string | null;
  /** First non-empty stderr line: control/bidi characters removed, redacted, shortened. */
  stderr: string | null;
}

/** Counted outcomes of one item-bound check over the items of a planning step. */
export interface CheckCounts {
  ok: number;
  notNow: number;
  error: number;
  notEvaluated: number;
}

/** Item conditions / shell filter in the last planning step of a workflow. */
export interface ItemCheckSummary {
  at: string;
  /** Items whose item conditions were evaluated (reached step 5d). */
  items: number;
  /** Per item condition (configuration order). */
  itemConditions: CheckCounts[];
  /** Shell filter (`null` = the workflow has none). */
  shellFilter: (CheckCounts & { items: number }) | null;
}

/** Status of one workflow. */
export interface WorkflowConditionStatus {
  /** Per workflow condition (configuration order); `null` = never evaluated. */
  workflow: Array<LastConditionCheck | null>;
  items: ItemCheckSummary | null;
}

/** First non-empty stderr line: sanitized (ANSI/control/bidi), redacted, then shortened. */
function firstLine(text: string, redact: Redactor): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (sanitizeDisplayText(line) !== '') return displayText(line, MAX_STDERR_LINE, redact);
  }
  return null;
}

function statusOf(value: CheckDiagnosis['value']): ConditionStatus {
  if (value === true) return 'ok';
  if (value === false) return 'not_now';
  if (value === 'not_evaluated') return 'skipped';
  return 'error';
}

function emptyCounts(): CheckCounts {
  return { ok: 0, notNow: 0, error: 0, notEvaluated: 0 };
}

function count(counts: CheckCounts, value: CheckDiagnosis['value']): void {
  const s = statusOf(value);
  if (s === 'ok') counts.ok++;
  else if (s === 'not_now') counts.notNow++;
  else if (s === 'error') counts.error++;
  else counts.notEvaluated++;
}

/**
 * Summary of item conditions / shell filter over the candidates of one
 * planning step of a workflow (all candidates, before the diagnosis is cut).
 */
export function summarizeItemChecks(
  at: string,
  itemConditionCount: number,
  hasShellFilter: boolean,
  candidates: readonly CandidateDiagnosis[],
): ItemCheckSummary {
  const itemConditions = Array.from({ length: itemConditionCount }, emptyCounts);
  const shellFilter = hasShellFilter ? { ...emptyCounts(), items: 0 } : null;
  let items = 0;
  for (const c of candidates) {
    if (c.itemConditions.length > 0) {
      items++;
      for (const d of c.itemConditions) {
        const counts = itemConditions[d.index];
        if (counts) count(counts, d.value);
      }
    }
    if (shellFilter && c.shellFilter) {
      shellFilter.items++;
      count(shellFilter, c.shellFilter.value);
    }
  }
  return { at, items, itemConditions, shellFilter };
}

/** See module docs. */
export class ConditionStatusStore {
  private readonly workflows = new Map<string, Array<LastConditionCheck | null>>();
  private readonly items = new Map<string, ItemCheckSummary>();

  /**
   * @param now clock
   * @param onChange called when a status (not only its time) changed – e.g. for an SSE update
   */
  constructor(
    private readonly now: () => Date,
    private readonly onChange?: (workflowId: string) => void,
    /** Redaction of stderr lines and errors (applied before shortening). */
    private readonly redact: Redactor = (s) => s,
  ) {}

  /** Record one workflow condition result (see `WorkflowConditionObserver`). */
  recordWorkflowCondition(workflowId: string, conditionCount: number, diag: CheckDiagnosis, result: ShellCheckResult | null): void {
    let list = this.workflows.get(workflowId);
    if (!list || list.length !== conditionCount) {
      list = Array.from({ length: conditionCount }, (_, i) => list?.[i] ?? null);
      this.workflows.set(workflowId, list);
    }
    if (diag.index < 0 || diag.index >= conditionCount) return;
    const previous = list[diag.index] ?? null;
    const status = statusOf(diag.value);
    const entry: LastConditionCheck = {
      status,
      checkedAt: this.now().toISOString(),
      ranAt: result ? result.startedAt : null,
      durationMs: result ? result.durationMs : null,
      cached: result ? result.cached : false,
      exitCode: result ? result.exitCode : null,
      error: status === 'error' ? displayText(diag.error ?? 'check error', MAX_STDERR_LINE, this.redact) : null,
      stderr: result ? firstLine(result.stderr, this.redact) : null,
    };
    list[diag.index] = entry;
    if (previous?.status !== status || previous.error !== entry.error) this.emit(workflowId);
  }

  /** Record the item-check summary of a planning step. */
  recordItemSummary(workflowId: string, summary: ItemCheckSummary): void {
    const previous = this.items.get(workflowId);
    this.items.set(workflowId, summary);
    const key = (s: ItemCheckSummary | undefined): string =>
      s ? JSON.stringify({ items: s.items, itemConditions: s.itemConditions, shellFilter: s.shellFilter }) : '';
    if (key(previous) !== key(summary)) this.emit(workflowId);
  }

  /** Drop the status of workflows (changed or removed by a reload). */
  forget(workflowIds: readonly string[]): void {
    for (const id of workflowIds) {
      const had = this.workflows.delete(id) || this.items.has(id);
      this.items.delete(id);
      if (had) this.emit(id);
    }
  }

  /** Status of a workflow with `conditionCount` workflow conditions. */
  get(workflowId: string, conditionCount: number): WorkflowConditionStatus {
    const list = this.workflows.get(workflowId) ?? [];
    return {
      workflow: Array.from({ length: conditionCount }, (_, i) => list[i] ?? null),
      items: this.items.get(workflowId) ?? null,
    };
  }

  private emit(workflowId: string): void {
    try {
      this.onChange?.(workflowId);
    } catch {
      // informational only
    }
  }
}
