/**
 * Item history (WI-33): the way of one source item (issue/PR) through the
 * workflows – current state (read freshly via the source), the path of its
 * runs, and a timeline of run starts/ends, hook chains with the effect of
 * every action, retry blocks and UI actions (WI-27). Optionally the item's
 * GitHub timeline (external events) without duplicating own changes.
 *
 * Data comes from `runs`, `run_actions` (structured `effect_json` since
 * schema v6; older entries fall back to the journal events), `blocks`,
 * `ui_actions` and `item_history_gaps` (retention). Planning decisions
 * (filters, limits) are not stored per item and therefore not part of it.
 *
 * Security: route role `viewer`. Responses pass the shared redactor; texts
 * are rendered as text by the UI. Comment texts are never stored or returned.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  errorMessage,
  noopLogger,
  redactValue,
  sourceItemKey,
  systemClock,
  type ActionEffect,
  type Clock,
  type FieldResolution,
  type HookName,
  type ItemEvent,
  type Logger,
  type Redactor,
  type SourceAdapter,
  type SourceItem,
  type SourceUpdateApplied,
} from '../core/index.js';
import type { ConfigManager } from '../config/index.js';
import { LIFECYCLE_ACTION_EVENT, updateEffect } from '../lifecycle/index.js';
import type { BlockRecord, Repositories, RunActionRecord, RunRecord, UiActionRecord } from '../persistence/index.js';
import { ApiError } from './errors.js';
import { toRunSummary, type RunSummary } from './serialize.js';
import { githubError, RateLimiter } from './ui-actions.js';

/** Runs shown in the path (the latest ones; older ones are summarised). */
export const HISTORY_PATH_RUNS = 50;
/** Runs read for the timeline (the latest ones). */
export const HISTORY_MAX_RUNS = 1000;
/** Default / max timeline entries per page. */
export const HISTORY_PAGE_DEFAULT = 100;
export const HISTORY_PAGE_MAX = 500;
/** Max GitHub timeline events read. */
export const GITHUB_EVENTS_LIMIT = 300;
/** Cache of the GitHub timeline per item. */
export const GITHUB_EVENTS_CACHE_MS = 60_000;
/** Cache of the freshly read item head per item (protects the rate limit on reloads). */
export const ITEM_HEAD_CACHE_MS = 10_000;
/** An own GitHub event matches an own history entry within this distance. */
const OWN_MATCH_WINDOW_MS = 5 * 60_000;
/** Event type of the WI-26 audit on runs (the user who started a manual run). */
const USER_ACTION_EVENT = 'audit.user_action';

// ---------------------------------------------------------------------------
// Response shapes

/** Kinds of timeline entries (filter checkboxes in the UI). */
export const HISTORY_ENTRY_KINDS = ['run_started', 'run_finished', 'hook', 'block_created', 'block_cleared', 'ui_action'] as const;
export type HistoryEntryKind = (typeof HISTORY_ENTRY_KINDS)[number];

/** One action of a hook chain in the timeline. */
export interface HistoryAction {
  /** Journal ID. */
  id: number;
  /** Configured action ID (`id:` in the workflow), if any. */
  name: string | null;
  type: string;
  status: RunActionRecord['status'];
  attempts: number;
  /** What it changed; `null` = nothing known. */
  effect: ActionEffect | null;
  /** `recorded` = structured (schema v6), `journal` = derived from older journal events (old values unknown). */
  effectSource: 'recorded' | 'journal' | null;
  /** Error message of a failed action (redacted). */
  error: string | null;
  updatedAt: string;
}

interface EntryBase {
  /** Stable ID of the entry. */
  key: string;
  kind: HistoryEntryKind;
  at: string;
  /** Opaque pagination cursor (`before=`). */
  cursor: string;
  runId: string | null;
  workflowId: string | null;
  workflowName: string | null;
}

/** Run reserved/started. */
export interface RunStartedEntry extends EntryBase {
  kind: 'run_started';
  trigger: RunRecord['triggerType'];
  /** User who started a manual run (with a login), or who removed the block of an `unblock` run. */
  user: string | null;
  parameters: Record<string, unknown> | null;
  scheduledFor: string | null;
  reservedAt: string;
  startedAt: string | null;
  active: boolean;
}

/** Run finished. */
export interface RunFinishedEntry extends EntryBase {
  kind: 'run_finished';
  status: RunRecord['status'];
  result: RunRecord['businessResult'];
  outcome: string | null;
  message: string | null;
  reason: string | null;
  durationMs: number | null;
  lifecycleStatus: RunRecord['lifecycleStatus'];
}

/** One hook chain of a run. */
export interface HookEntry extends EntryBase {
  kind: 'hook';
  hook: HookName;
  actions: HistoryAction[];
}

/** Retry block created. */
export interface BlockCreatedEntry extends EntryBase {
  kind: 'block_created';
  blockId: number;
  reason: string;
  failureCount: number;
  lastStatus: string | null;
  active: boolean;
}

/** Retry block removed. */
export interface BlockClearedEntry extends EntryBase {
  kind: 'block_cleared';
  blockId: number;
  clearedBy: string | null;
  /** Lifecycle run (`on_retry_unblock`, WI-30). */
  clearedRunId: string | null;
}

/** UI action (WI-27). */
export interface UiActionEntry extends EntryBase {
  kind: 'ui_action';
  actionId: number;
  actor: string;
  actorVia: string;
  identity: string;
  action: UiActionRecord['kind'];
  result: UiActionRecord['result'];
  errorCode: string | null;
  errorMessage: string | null;
  /** What was changed (labels / project fields; comments: the link). */
  effect: ActionEffect | null;
}

export type HistoryEntry = RunStartedEntry | RunFinishedEntry | HookEntry | BlockCreatedEntry | BlockClearedEntry | UiActionEntry;

/** Retention hint of an item. */
export interface RetentionGap {
  /** Runs of the item deleted by retention (since 0.9.0); `null` = only indirect hints (older versions). */
  deletedRuns: number | null;
  newestDeletedAt: string | null;
}

/** History data from the database (without the item head). */
export interface ItemHistoryData {
  itemKey: string;
  runs: RunSummary[];
  runsTotal: number;
  /** The path shows only the latest {@link HISTORY_PATH_RUNS} runs. */
  truncated: boolean;
  entries: HistoryEntry[];
  entriesTotal: number;
  /** Cursor for the next (older) page, `null` = no more. */
  nextBefore: string | null;
  retentionGap: RetentionGap | null;
  active: { runs: RunSummary[]; blocks: Array<Record<string, unknown>> };
}

// ---------------------------------------------------------------------------
// Building the history

const RANK: Record<HistoryEntryKind, number> = { run_started: 0, hook: 1, block_created: 2, run_finished: 3, block_cleared: 4, ui_action: 5 };

/** Cursor of an entry: sortable `at|rank|key` (entries are ordered by it, newest first). */
function cursorOf(at: string, kind: HistoryEntryKind, key: string): string {
  return `${at}|${RANK[kind]}|${key}`;
}

const snapshotName = (run: RunRecord): string | null => {
  const name = (run.configSnapshot as { workflow?: { name?: unknown } } | null)?.workflow?.name;
  return typeof name === 'string' ? name : null;
};

/** Effect from the journal events of actions journaled before schema v6. */
function journalEffect(action: RunActionRecord, events: ReadonlyMap<number, Record<string, unknown>>): ActionEffect | null {
  const details = events.get(action.id);
  if (!details) return null;
  if (action.type === 'source.update') {
    if (details.changed === false) return { unchanged: true };
    return updateEffect(details.applied as SourceUpdateApplied | undefined);
  }
  if (action.type === 'source.comment') {
    return { comment: { id: action.externalKey, url: typeof details.url === 'string' ? details.url : null, ...(details.reconciled === true ? { reconciled: true } : {}) } };
  }
  if (action.type === 'shell' && typeof details.exitCode === 'number') return { exitCode: details.exitCode };
  return null;
}

/** Effect of a UI action from its audit details. */
function uiActionEffect(a: UiActionRecord): ActionEffect | null {
  if (a.kind === 'comment') return a.result === 'failed' ? null : { comment: { id: a.commentId, url: a.commentUrl } };
  const applied = (a.details as { applied?: SourceUpdateApplied } | null)?.applied;
  if (!applied) return null;
  return updateEffect(applied);
}

function errorText(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

/** Compose the history of `itemKey` from the database. `before`/`limit` page the timeline (newest first). */
export function buildItemHistory(repos: Repositories, itemKey: string, options: { before?: string; limit?: number } = {}): ItemHistoryData {
  const page = repos.runs.list({ sourceItemKey: itemKey, limit: HISTORY_MAX_RUNS });
  // Older runs beyond HISTORY_MAX_RUNS are not part of the timeline (very long histories).
  const runs = [...page.runs].reverse();
  const runIds = runs.map((r) => r.id);
  const actions = repos.actions.listForRuns(runIds);
  const events = repos.events.listTypesForRuns(runIds, [USER_ACTION_EVENT, LIFECYCLE_ACTION_EVENT]);
  const startedBy = new Map<string, string>();
  const succeededDetails = new Map<number, Record<string, unknown>>();
  for (const e of events) {
    if (e.type === USER_ACTION_EVENT && e.payload.action === 'start' && typeof e.payload.actor === 'string' && !startedBy.has(e.runId)) {
      startedBy.set(e.runId, e.payload.actor);
    }
    if (e.type === LIFECYCLE_ACTION_EVENT && e.payload.status === 'succeeded' && typeof e.payload.actionId === 'number') {
      succeededDetails.set(e.payload.actionId, (e.payload.details as Record<string, unknown> | undefined) ?? {});
    }
  }
  const blocks = repos.blocks.listForItem(itemKey);
  const clearedBlockOfRun = new Map<string, BlockRecord>();
  for (const b of blocks) if (b.clearedRunId) clearedBlockOfRun.set(b.clearedRunId, b);
  const uiActions = repos.uiActions.list({ itemKey, limit: 500 }).actions;

  const entries: HistoryEntry[] = [];
  const base = (kind: HistoryEntryKind, key: string, at: string, run: RunRecord | null, workflowId: string | null = run?.workflowId ?? null) => ({
    key,
    kind,
    at,
    cursor: cursorOf(at, kind, key),
    runId: run?.id ?? null,
    workflowId,
    workflowName: run ? snapshotName(run) : null,
  });
  const runById = new Map(runs.map((r) => [r.id, r]));
  for (const run of runs) {
    const summary = toRunSummary(run);
    entries.push({
      ...base('run_started', `run:${run.id}:start`, run.createdAt, run),
      kind: 'run_started',
      trigger: run.triggerType,
      user: run.triggerType === 'unblock' ? (clearedBlockOfRun.get(run.id)?.clearedBy ?? null) : (startedBy.get(run.id) ?? null),
      parameters: run.parameters,
      scheduledFor: run.scheduledFor,
      reservedAt: run.createdAt,
      startedAt: run.startedAt,
      active: summary.active,
    });
    if (!summary.active && run.finishedAt) {
      entries.push({
        ...base('run_finished', `run:${run.id}:end`, run.finishedAt, run),
        kind: 'run_finished',
        status: run.status,
        result: run.businessResult,
        outcome: run.outcome,
        message: summary.resultMessage,
        reason: run.finalReason,
        durationMs: summary.durationMs,
        lifecycleStatus: run.lifecycleStatus,
      });
    }
  }
  // Hook chains: one entry per (run, hook), at the time the journal was created.
  const chains = new Map<string, RunActionRecord[]>();
  for (const a of actions) {
    const k = `${a.runId}\u0000${a.hook}`;
    const list = chains.get(k) ?? [];
    list.push(a);
    chains.set(k, list);
  }
  for (const list of chains.values()) {
    const first = list[0] as RunActionRecord;
    const run = runById.get(first.runId) ?? null;
    const sorted = [...list].sort((a, b) => a.ordinal - b.ordinal);
    entries.push({
      ...base('hook', `hook:${first.runId}:${first.hook}`, sorted.reduce((min, a) => (a.createdAt < min ? a.createdAt : min), first.createdAt), run),
      kind: 'hook',
      hook: first.hook,
      actions: sorted.map((a) => {
        const fallback = a.effect === null && a.status === 'succeeded' ? journalEffect(a, succeededDetails) : null;
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          status: a.status,
          attempts: a.attempts,
          effect: a.effect ?? fallback,
          effectSource: a.effect ? 'recorded' : fallback ? 'journal' : null,
          error: a.status === 'failed' ? errorText(a.lastError) : null,
          updatedAt: a.updatedAt,
        };
      }),
    });
  }
  for (const b of blocks) {
    const run = b.runId ? (runById.get(b.runId) ?? null) : null;
    entries.push({
      ...base('block_created', `block:${b.id}:created`, b.createdAt, run, b.workflowId),
      kind: 'block_created',
      blockId: b.id,
      reason: b.reason,
      failureCount: b.failureCount,
      lastStatus: b.lastStatus,
      active: b.clearedAt === null,
    });
    if (b.clearedAt) {
      const lifecycle = b.clearedRunId ? (runById.get(b.clearedRunId) ?? null) : null;
      entries.push({
        ...base('block_cleared', `block:${b.id}:cleared`, b.clearedAt, lifecycle, b.workflowId),
        runId: b.clearedRunId,
        kind: 'block_cleared',
        blockId: b.id,
        clearedBy: b.clearedBy,
        clearedRunId: b.clearedRunId,
      });
    }
  }
  for (const a of uiActions) {
    entries.push({
      ...base('ui_action', `ui:${a.id}`, a.createdAt, null, null),
      kind: 'ui_action',
      actionId: a.id,
      actor: a.actor,
      actorVia: a.actorVia,
      identity: a.identity,
      action: a.kind,
      result: a.result,
      errorCode: a.errorCode,
      errorMessage: a.errorMessage,
      effect: uiActionEffect(a),
    });
  }
  entries.sort((x, y) => (x.cursor < y.cursor ? 1 : x.cursor > y.cursor ? -1 : 0));
  const limit = Math.min(Math.max(1, options.limit ?? HISTORY_PAGE_DEFAULT), HISTORY_PAGE_MAX);
  const before = options.before;
  const start = before ? entries.findIndex((e) => e.cursor < before) : 0;
  const pageEntries = start < 0 ? [] : entries.slice(start, start + limit);
  const last = pageEntries.at(-1);
  const hasMore = start >= 0 && start + limit < entries.length;

  const gap = repos.retention.itemGap(itemKey);
  // Before 0.9.0 deletions were not counted: a block whose run is gone is a hint.
  const hinted = !gap && blocks.some((b) => b.runId === null && b.failureCount > 0);
  const activeRuns = runs.filter((r) => toRunSummary(r).active).map(toRunSummary);
  return {
    itemKey,
    runs: runs.slice(-HISTORY_PATH_RUNS).map(toRunSummary),
    runsTotal: page.total,
    truncated: page.total > HISTORY_PATH_RUNS,
    entries: pageEntries,
    entriesTotal: entries.length,
    nextBefore: hasMore && last ? last.cursor : null,
    retentionGap: gap ? { deletedRuns: gap.deletedRuns, newestDeletedAt: gap.newestDeletedAt } : hinted ? { deletedRuns: null, newestDeletedAt: null } : null,
    active: {
      runs: activeRuns,
      blocks: blocks.filter((b) => b.clearedAt === null).map((b) => ({ id: b.id, workflowId: b.workflowId, reason: b.reason, createdAt: b.createdAt, runId: b.runId })),
    },
  };
}

// ---------------------------------------------------------------------------
// Own changes vs. GitHub timeline

/** A label change done by adapter-side actions or UI actions, for matching GitHub events. */
interface OwnLabelChange {
  label: string;
  added: boolean;
  at: number;
  used: boolean;
}

function ownLabelChanges(repos: Repositories, itemKey: string): OwnLabelChange[] {
  const runs = repos.runs.list({ sourceItemKey: itemKey, limit: HISTORY_MAX_RUNS }).runs;
  const changes: OwnLabelChange[] = [];
  const add = (effect: ActionEffect | null, at: string): void => {
    const t = Date.parse(at);
    for (const l of effect?.labelsAdded ?? []) changes.push({ label: l.toLowerCase(), added: true, at: t, used: false });
    for (const l of effect?.labelsRemoved ?? []) changes.push({ label: l.toLowerCase(), added: false, at: t, used: false });
  };
  const runIds = runs.map((r) => r.id);
  const details = new Map<number, Record<string, unknown>>();
  for (const e of repos.events.listTypesForRuns(runIds, [LIFECYCLE_ACTION_EVENT])) {
    if (e.payload.status === 'succeeded' && typeof e.payload.actionId === 'number') details.set(e.payload.actionId, (e.payload.details as Record<string, unknown> | undefined) ?? {});
  }
  for (const a of repos.actions.listForRuns(runIds)) {
    if (a.type !== 'source.update') continue;
    add(a.effect ?? (a.status === 'succeeded' ? journalEffect(a, details) : null), a.updatedAt);
  }
  for (const u of repos.uiActions.list({ itemKey, limit: 500 }).actions) add(uiActionEffect(u), u.createdAt);
  return changes;
}

/** An external event as returned by the API. */
export interface HistoryGitHubEvent extends ItemEvent {
  /** Not performed by an own identity. */
  external: boolean;
}

/**
 * Drop own label events that match an own history entry (same label and
 * direction within {@link OWN_MATCH_WINDOW_MS}); everything else stays, own
 * events without a match marked `own`, the rest `external`.
 */
export function mergeGitHubEvents(events: readonly ItemEvent[], own: OwnLabelChange[]): { events: HistoryGitHubEvent[]; hiddenOwn: number } {
  const out: HistoryGitHubEvent[] = [];
  let hiddenOwn = 0;
  for (const e of events) {
    if (e.own && (e.kind === 'labeled' || e.kind === 'unlabeled') && e.label) {
      const t = Date.parse(e.at);
      const label = e.label.toLowerCase();
      const added = e.kind === 'labeled';
      const match = own
        .filter((c) => !c.used && c.label === label && c.added === added && Math.abs(c.at - t) <= OWN_MATCH_WINDOW_MS)
        .sort((a, b) => Math.abs(a.at - t) - Math.abs(b.at - t))[0];
      if (match) {
        match.used = true;
        hiddenOwn += 1;
        continue;
      }
    }
    out.push({ ...e, external: !e.own });
  }
  return { events: out, hiddenOwn };
}

// ---------------------------------------------------------------------------
// Routes

/** What the history routes need. */
export interface ItemHistoryDeps {
  config: ConfigManager;
  repositories: Repositories;
  sources?: (sourceId: string) => SourceAdapter | undefined;
  redact: Redactor;
  logger?: Logger;
  clock?: Clock;
  /** GitHub timeline requests per user and minute (default 30). */
  githubEventsPerMinute?: number;
}

const itemParams = z.object({ source: z.string().min(1).max(200), item: z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/) }).strict();
const historyQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
    before: z.string().min(1).max(400).optional(),
    refresh: z.enum(['true', 'false']).optional(),
  })
  .strict();
const eventsQuery = z.object({ refresh: z.enum(['true', 'false']).optional() }).strict();

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(400, 'invalid_request', `Invalid ${what}`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/** Fresh state of the item for the page head. */
export type ItemHead =
  | {
      ok: true;
      source: string;
      itemId: string;
      key: string;
      url: string;
      type: SourceItem['type'];
      repository: string | null;
      title: string;
      state: string | null;
      labels: string[];
      /** Declared project fields (`null` = the source has no project). */
      projectFields: Array<{ name: string; kind: string; known: boolean; value: unknown; reason: string | null }> | null;
      /** `work_branch` / `work_pr` (WI-21), if the source provides them. */
      linked: { workBranch: FieldResolution; workPr: FieldResolution; workPrUrl: string | null } | null;
    }
  | { ok: false; source: string; itemId: string; key: string; error: { code: string; message: string } };

/** Register `GET /api/v1/items/:source/:item/history` and `…/github-events` (role viewer, see roles.ts). */
export function registerItemHistoryRoutes(app: FastifyInstance, deps: ItemHistoryDeps): void {
  const logger = (deps.logger ?? noopLogger).child({ component: 'item-history' });
  const clock = deps.clock ?? systemClock;
  const repos = deps.repositories;
  const headCache = new Map<string, { at: number; head: Promise<ItemHead> }>();
  const eventsCache = new Map<string, { at: number; value: Promise<{ events: ItemEvent[]; truncated: boolean; fetchedAt: string }> }>();
  const eventsLimiter = new RateLimiter(deps.githubEventsPerMinute ?? 30, clock);

  const adapterOf = (sourceId: string): SourceAdapter | undefined =>
    Object.hasOwn(deps.config.current.sources, sourceId) ? deps.sources?.(sourceId) : undefined;

  const readHead = async (sourceId: string, ref: string): Promise<ItemHead> => {
    const key = sourceItemKey(sourceId, ref);
    const fail = (code: string, message: string): ItemHead => ({ ok: false, source: sourceId, itemId: ref, key, error: { code, message: deps.redact(message) } });
    const adapter = adapterOf(sourceId);
    if (!adapter) return fail('source_not_found', `Source "${sourceId}" is not configured (any more); only the stored history is shown`);
    const itemId = adapter.parseItemRef(ref);
    if (itemId === null || itemId !== ref) return fail('item_not_found', `"${ref}" is not an item of source "${sourceId}"`);
    let item: SourceItem | null;
    try {
      item = await adapter.getItem(itemId);
    } catch (err) {
      const mapped = githubError(err, deps.config.current.sources[sourceId]?.identity ?? 'source', 'source identity');
      return fail(mapped?.code ?? 'read_failed', mapped?.message ?? errorMessage(err));
    }
    if (!item || item.sourceId !== sourceId) return fail('item_not_found', `Item ${itemId} not found in source "${sourceId}" (deleted, transferred or not visible)`);
    const config = deps.config.current.sources[sourceId];
    const declared = config?.project?.fields ?? null;
    const f = item.fields;
    const projectFields = declared
      ? Object.entries(declared).map(([name, kind]) => {
          const fieldKey = `project.${name}`;
          const known = Object.hasOwn(f, fieldKey);
          return { name, kind, known, value: known ? (f[fieldKey] ?? null) : null, reason: known ? null : (item.unknownFields?.[fieldKey] ?? 'not read') };
        })
      : null;
    let linked: Extract<ItemHead, { ok: true }>['linked'] = null;
    const provided = new Set(adapter.fieldDefinitions().map((d) => d.name));
    if (provided.has('work_branch') && provided.has('work_pr')) {
      const names = ['work_branch', 'work_pr', ...(provided.has('work_pr_url') ? ['work_pr_url'] : [])];
      try {
        const res = await adapter.resolveFields(item, names);
        const url = res.work_pr_url;
        linked = {
          workBranch: res.work_branch ?? { known: false, reason: 'not provided' },
          workPr: res.work_pr ?? { known: false, reason: 'not provided' },
          workPrUrl: url?.known && typeof url.value === 'string' && /^https?:\/\//i.test(url.value) ? url.value : null,
        };
      } catch (err) {
        const reason = deps.redact(errorMessage(err));
        linked = { workBranch: { known: false, reason }, workPr: { known: false, reason }, workPrUrl: null };
      }
    }
    return {
      ok: true,
      source: sourceId,
      itemId: item.itemId,
      key: item.key,
      url: /^https?:\/\//i.test(item.url) ? item.url : '',
      type: item.type,
      repository: adapter.repository ?? null,
      title: typeof f.title === 'string' ? f.title : '',
      state: typeof f.state === 'string' ? f.state : null,
      labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === 'string') : [],
      projectFields,
      linked,
    };
  };

  const head = (sourceId: string, ref: string, refresh: boolean): Promise<ItemHead> => {
    const key = sourceItemKey(sourceId, ref);
    const now = clock.now().getTime();
    for (const [k, v] of headCache) if (now - v.at >= ITEM_HEAD_CACHE_MS) headCache.delete(k);
    const cached = headCache.get(key);
    if (cached && !refresh) return cached.head;
    const pending = readHead(sourceId, ref);
    headCache.set(key, { at: now, head: pending });
    pending.then((h) => {
      if (!h.ok) headCache.delete(key);
    }, () => headCache.delete(key));
    return pending;
  };

  app.get('/api/v1/items/:source/:item/history', async (req) => {
    const { source, item } = parse(itemParams, req.params, 'path');
    const q = parse(historyQuery, req.query, 'query');
    const key = sourceItemKey(source, item);
    const data = buildItemHistory(repos, key, { ...(q.before ? { before: q.before } : {}), ...(q.limit ? { limit: q.limit } : {}) });
    // Only the first page carries the item head (later pages only extend the timeline).
    const itemHead = q.before ? null : await head(source, item, q.refresh === 'true');
    return redactValue(
      {
        source,
        itemId: item,
        item: itemHead,
        githubEvents: adapterOf(source)?.listItemEvents !== undefined,
        ...data,
      },
      deps.redact,
    );
  });

  const principalKey = (req: FastifyRequest): string => (req.principal?.name ?? 'anonymous').toLowerCase();

  app.get('/api/v1/items/:source/:item/github-events', async (req, reply) => {
    const { source, item: ref } = parse(itemParams, req.params, 'path');
    const q = parse(eventsQuery, req.query, 'query');
    const adapter = adapterOf(source);
    if (!adapter) throw new ApiError(404, 'source_not_found', `Unknown source "${source}"`);
    if (!adapter.listItemEvents) throw new ApiError(400, 'not_supported', `Source "${source}" does not provide an item timeline`);
    const itemId = adapter.parseItemRef(ref);
    if (itemId === null || itemId !== ref) throw new ApiError(404, 'item_not_found', `"${ref}" is not an item of source "${source}"`);
    const key = sourceItemKey(source, itemId);
    const now = clock.now().getTime();
    for (const [k, v] of eventsCache) if (now - v.at >= GITHUB_EVENTS_CACHE_MS) eventsCache.delete(k);
    const existing = eventsCache.get(key);
    const cached = existing !== undefined && q.refresh !== 'true';
    let pending: Promise<{ events: ItemEvent[]; truncated: boolean; fetchedAt: string }>;
    if (cached) pending = existing.value;
    else {
      const slot = eventsLimiter.take(principalKey(req));
      if (!slot.ok) {
        void reply.header('retry-after', String(Math.max(1, Math.ceil(slot.retryAfterMs / 1000))));
        throw new ApiError(429, 'github_events_throttled', `Too many GitHub timeline requests; try again in ${Math.ceil(slot.retryAfterMs / 1000)}s`, { retryAfterMs: slot.retryAfterMs });
      }
      const listEvents = adapter.listItemEvents.bind(adapter);
      const value = (async () => {
        const item = await adapter.getItem(itemId);
        if (!item || item.sourceId !== source) throw new ApiError(404, 'item_not_found', `Item ${itemId} not found in source "${source}"`);
        const page = await listEvents(item, { limit: GITHUB_EVENTS_LIMIT, ownIdentities: Object.keys(deps.config.current.identities) });
        return { ...page, fetchedAt: clock.now().toISOString() };
      })();
      const entry = { at: now, value };
      eventsCache.set(key, entry);
      // Errors are not cached: the next request asks GitHub again.
      value.catch(() => {
        if (eventsCache.get(key) === entry) eventsCache.delete(key);
      });
      pending = value;
    }
    let page: { events: ItemEvent[]; truncated: boolean; fetchedAt: string };
    try {
      page = await pending;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const mapped = githubError(err, deps.config.current.sources[source]?.identity ?? 'source', 'source identity, used for reading the timeline');
      logger.warn('github timeline failed', { item: key, error: deps.redact(errorMessage(err)) });
      throw mapped ?? new ApiError(502, 'github_unavailable', deps.redact(errorMessage(err)));
    }
    const merged = mergeGitHubEvents(page.events, ownLabelChanges(repos, key));
    return redactValue(
      {
        source,
        itemId,
        events: merged.events,
        hiddenOwn: merged.hiddenOwn,
        truncated: page.truncated,
        limit: GITHUB_EVENTS_LIMIT,
        fetchedAt: page.fetchedAt,
        cached,
        notice: 'Changes of GitHub project fields are not part of the GitHub timeline and therefore not shown here.',
      },
      deps.redact,
    );
  });
}
