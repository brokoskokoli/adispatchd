/**
 * UI actions (WI-27): a logged-in admin acts on an issue/PR as a configured
 * identity (`identities.yaml` → `ui_actions: true`) – comment, add/remove
 * labels, set project fields – plus the item details for the panel and the
 * audit (`ui_actions` table, kept for `retention.ui_actions`).
 *
 * Security:
 * - Route role `admin` (roles.ts); additionally `auth.mode` ≠ none and a REAL
 *   login (`password` / `trusted_header`). The local CLI control token is
 *   refused: workers run as the same service user and can read it, so it
 *   must not let a worker post as a (more privileged) app identity.
 * - CSRF/Host/Origin rules as for every write (server.ts hooks); per-user
 *   rate limits for actions and item reads.
 * - The identity must be enabled for UI actions; the item must belong to the
 *   source (read freshly; transferred items are not found).
 * - Comments are never changed silently: a text that looks like it contains
 *   a secret is rejected (`comment_contains_secret`, best effort). HTML
 *   comment openers are neutralised (no forged orchestrator markers). Sent
 *   exactly once (no automatic retries); an identical comment by the same
 *   user on the same item within 60 s is refused. The text is never stored.
 * - New labels are only created with an explicit `create: true`.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  errorMessage,
  noopLogger,
  redactValue,
  SourceError,
  systemClock,
  type Clock,
  type Logger,
  type ProjectFieldUpdateValue,
  type Redactor,
  type SourceAdapter,
  type SourceItem,
} from '../core/index.js';
import type { ConfigManager } from '../config/index.js';
import { neutralizeHtmlComments } from '../lifecycle/index.js';
import type { Repositories, UiActionKind, UiActionRecord, UiActionResult } from '../persistence/index.js';
import { valueProblem } from '../sources/index.js';
import { isInteractive, type Principal } from './auth.js';
import { ApiError } from './errors.js';
import { describeFindings, maskSecrets, scanSecrets, type SecretFinding } from './secret-scan.js';

/** Max length of a comment as sent (GitHub's limit). */
export const MAX_COMMENT_LENGTH = 65_536;
/** Max label names per request (add + remove each). */
const MAX_LABELS = 50;
/** Max length of a label name (GitHub's limit). */
const MAX_LABEL_LENGTH = 50;
/** Max audit entries embedded in the item details. */
const ITEM_RECENT_ACTIONS = 20;

/** Per-user limits (token buckets; capacity = requests per minute). */
export const UI_ACTION_LIMITS: Readonly<{ actionsPerMinute: number; readsPerMinute: number; duplicateCommentMs: number }> = {
  /** Comments, label and project changes per user and minute. */
  actionsPerMinute: 20,
  /** Item reads (`GET /items/…`, resolve) per user and minute. */
  readsPerMinute: 60,
  /** An identical comment (user, item, text) is refused for this long. */
  duplicateCommentMs: 60_000,
};

/** Per-user limits of UI actions. */
export type UiActionLimits = { [K in keyof typeof UI_ACTION_LIMITS]: number };

/** What the UI action routes need. */
export interface UiActionDeps {
  config: ConfigManager;
  repositories: Repositories;
  /** Source adapters by ID (absent = UI actions report every source as unknown). */
  sources?: (sourceId: string) => SourceAdapter | undefined;
  redact: Redactor;
  logger?: Logger;
  clock?: Clock;
  /** Overrides of {@link UI_ACTION_LIMITS} (tests). */
  limits?: Partial<UiActionLimits>;
  /** True if `auth.mode` ≠ none. */
  authEnabled(): boolean;
}

// ---------------------------------------------------------------------------
// Secrets in comments

/**
 * Secrets in a comment text (best effort): values known to the shared
 * redactor (installation tokens, keys, token identities) and common token
 * formats (see secret-scan.ts). Only kinds and counts, never values.
 */
export function commentSecrets(text: string, redact: Redactor): SecretFinding[] {
  const findings = scanSecrets(text);
  const redacted = redact(text);
  if (redacted !== text) {
    const count = (s: string) => s.split('[REDACTED]').length - 1;
    findings.unshift({ kind: 'secret known to adispatchd', count: Math.max(1, count(redacted) - count(text)) });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rate limits

/** Token bucket per key (refills `capacity` tokens per minute). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly capacity: number,
    private readonly clock: Clock,
  ) {}

  /** Take one token; returns the wait in ms when none is left. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.clock.now().getTime();
    const ratePerMs = this.capacity / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * ratePerMs);
    b.at = now;
    if (this.buckets.size > 10_000) this.buckets.clear();
    this.buckets.set(key, b);
    if (b.tokens < 1) return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / ratePerMs) };
    b.tokens -= 1;
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Request schemas

const itemParams = z.object({ source: z.string().min(1).max(200), item: z.string().min(1).max(20) }).strict();
const identityField = z.string().min(1).max(200);
// The final body (after neutralising HTML comments) is checked against MAX_COMMENT_LENGTH separately.
const commentBody = z.object({ identity: identityField, body: z.string().max(MAX_COMMENT_LENGTH) }).strict();
const labelName = z.string().trim().min(1).max(MAX_LABEL_LENGTH);
const labelsBody = z
  .object({
    identity: identityField,
    add: z.array(labelName).max(MAX_LABELS).default([]),
    remove: z.array(labelName).max(MAX_LABELS).default([]),
    /** Create labels in `add` that do not exist in the repository yet (GitHub creates them on the fly). */
    create: z.boolean().default(false),
  })
  .strict();
const projectValue = z.union([z.string().max(1024), z.number().finite(), z.null()]);
const projectBody = z.object({ identity: identityField, fields: z.record(z.string().min(1).max(200), projectValue) }).strict();
const listQuery = z
  .object({
    source: z.string().max(200).optional(),
    item: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
const resolveQuery = z.object({ ref: z.string().trim().min(1).max(2000) }).strict();

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(400, 'invalid_request', `Invalid ${what}`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// GitHub errors → API errors

/**
 * Understandable API error for a failed GitHub call. GitHub's 401/403 are
 * reported as 502 so the UI does not confuse them with its own login/role.
 */
export function githubError(err: unknown, identity: string, note?: string): ApiError | null {
  if (!(err instanceof SourceError)) return null;
  const detail = err.message;
  const who = `identity "${identity}"${note ? ` (${note})` : ''}`;
  switch (err.kind) {
    case 'auth':
      return new ApiError(502, 'github_auth_failed', `GitHub rejected the credentials of ${who}: ${detail}`);
    case 'forbidden':
      return new ApiError(502, 'github_forbidden', `GitHub refused the request of ${who} (missing app permission, or the conversation is locked): ${detail}`);
    case 'not_found':
      return new ApiError(404, 'github_not_found', `GitHub did not find the item or project for ${who}: ${detail}`);
    case 'rate_limited':
      return new ApiError(429, 'github_rate_limited', `GitHub rate limit reached for ${who}; try again later: ${detail}`, {
        ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      });
    case 'transient':
      return err.outcomeUnknown
        ? new ApiError(502, 'github_outcome_unknown', `The request may have reached GitHub; check the item on GitHub before sending again: ${detail}`)
        : new ApiError(502, 'github_unavailable', `GitHub is not reachable or answered with an error: ${detail}`);
    case 'invalid':
      return new ApiError(422, 'github_rejected', `GitHub rejected the request: ${detail}`);
  }
}

const retryAfter = (reply: FastifyReply, ms: number): void => {
  void reply.header('retry-after', String(Math.max(1, Math.ceil(ms / 1000))));
};

// ---------------------------------------------------------------------------

/** Register the UI action routes on `app` (roles: see roles.ts). */
export function registerUiActionRoutes(app: FastifyInstance, deps: UiActionDeps): void {
  const logger = (deps.logger ?? noopLogger).child({ component: 'ui-actions' });
  const repos = deps.repositories;
  const clock = deps.clock ?? systemClock;
  const limits: UiActionLimits = { ...UI_ACTION_LIMITS, ...deps.limits };
  const actionLimiter = new RateLimiter(limits.actionsPerMinute, clock);
  const readLimiter = new RateLimiter(limits.readsPerMinute, clock);
  /** Recently sent (or being sent) comments: key → time. */
  const recentComments = new Map<string, number>();
  /** Audit details never carry secrets: known values and token formats are masked. */
  const scrub = (value: Record<string, unknown>): Record<string, unknown> =>
    redactValue(value, (s) => maskSecrets(deps.redact(s))) as Record<string, unknown>;

  const requireEnabled = (): void => {
    if (!deps.authEnabled()) {
      throw new ApiError(403, 'ui_actions_disabled', 'UI actions need a login (auth.mode password or trusted_header); they are disabled with auth.mode none');
    }
  };

  /** Only a real logged-in admin (never the control token, never without auth), within the user's rate limit. */
  const requireUser = (req: FastifyRequest, reply: FastifyReply, limiter: RateLimiter): Principal => {
    requireEnabled();
    const p = req.principal;
    if (!p || p.via === 'anonymous') throw new ApiError(401, 'authentication_required', 'Login required');
    if (!isInteractive(p)) {
      throw new ApiError(403, 'user_login_required', 'UI actions need a logged-in user; the local control token is not accepted');
    }
    if (p.role !== 'admin') throw new ApiError(403, 'forbidden', `This action requires the role "admin" (your role: "${p.role}")`, { requiredRole: 'admin', role: p.role });
    const slot = limiter.take(p.name.toLowerCase());
    if (!slot.ok) {
      retryAfter(reply, slot.retryAfterMs);
      throw new ApiError(429, 'ui_actions_throttled', `Too many UI requests; try again in ${Math.ceil(slot.retryAfterMs / 1000)}s`, { retryAfterMs: slot.retryAfterMs });
    }
    return p;
  };

  const enabledIdentities = (): Array<{ id: string; type: string }> =>
    Object.values(deps.config.current.identities)
      .filter((i) => i.uiActions === true)
      .map((i) => ({ id: i.id, type: i.type }))
      .sort((a, b) => a.id.localeCompare(b.id));

  const requireIdentity = (id: string): void => {
    const identity = deps.config.current.identities[id];
    if (!identity || identity.uiActions !== true) {
      throw new ApiError(403, 'identity_not_allowed', `Identity "${id}" is not enabled for UI actions (identities.yaml: ui_actions: true)`);
    }
  };

  const requireSource = (sourceId: string): SourceAdapter => {
    const adapter = Object.hasOwn(deps.config.current.sources, sourceId) ? deps.sources?.(sourceId) : undefined;
    if (!adapter) throw new ApiError(404, 'source_not_found', `Unknown source "${sourceId}"`);
    return adapter;
  };

  /** The item, read freshly with the source identity; it must belong to the source (like a manual start). */
  const loadItem = async (adapter: SourceAdapter, sourceId: string, ref: string): Promise<SourceItem> => {
    const itemId = adapter.parseItemRef(ref);
    if (itemId === null || itemId !== ref) throw new ApiError(404, 'item_not_found', `"${ref}" is not an item of source "${sourceId}"`);
    let item: SourceItem | null;
    try {
      item = await adapter.getItem(itemId);
    } catch (err) {
      const readIdentity = deps.config.current.sources[sourceId]?.identity ?? 'source';
      throw githubError(err, readIdentity, 'source identity, used for reading the item') ?? err;
    }
    if (!item || item.sourceId !== sourceId) throw new ApiError(404, 'item_not_found', `Item ${itemId} not found in source "${sourceId}"`);
    return item;
  };

  /** Outcome of an action body. */
  interface ActionOutcome {
    body: Record<string, unknown>;
    commentId?: string;
    commentUrl?: string;
    details?: Record<string, unknown>;
  }

  /**
   * Run one action with audit: every failure after the login check, and the
   * success. The success audit runs outside the action's error handling: if
   * it fails after GitHub accepted the change, the API still answers 2xx with
   * `auditWarning` (and logs the problem) – never 500 for a done action.
   */
  const perform = async (
    req: FastifyRequest,
    reply: FastifyReply,
    user: Principal,
    kind: UiActionKind,
    identity: string,
    details: Record<string, unknown>,
    fn: (adapter: SourceAdapter, item: SourceItem) => Promise<ActionOutcome>,
  ): Promise<Record<string, unknown>> => {
    const { source, item: ref } = parse(itemParams, req.params, 'path');
    let item: SourceItem | null = null;
    const audit = (result: UiActionResult, extra: Partial<UiActionRecord>): UiActionRecord => {
      const record = repos.uiActions.record({
        actor: user.name,
        actorVia: user.via,
        identity,
        sourceId: source,
        itemId: item?.itemId ?? ref,
        itemKey: item?.key ?? `${source}:${ref}`,
        itemUrl: item?.url ?? null,
        kind,
        result,
        ...extra,
        ...(extra.details ? { details: scrub(extra.details) } : {}),
      });
      logger.info('ui action', { actor: user.name, identity, item: record.itemKey, kind, result, ...(record.errorCode ? { error: record.errorCode } : {}) });
      return record;
    };
    let out: ActionOutcome;
    try {
      requireIdentity(identity);
      const adapter = requireSource(source);
      item = await loadItem(adapter, source, ref);
      out = await fn(adapter, item);
    } catch (err) {
      const mapped = err instanceof ApiError ? err : githubError(err, identity);
      const unknown = err instanceof SourceError && err.outcomeUnknown;
      const applied = err instanceof SourceError ? (err.details?.applied as Record<string, unknown> | undefined) : undefined;
      try {
        audit(unknown ? 'unknown' : 'failed', {
          errorCode: mapped?.code ?? 'internal_error',
          errorMessage: maskSecrets(deps.redact(errorMessage(err))).slice(0, 1000),
          details: applied ? { ...details, applied } : details,
        });
      } catch (auditErr) {
        logger.error('ui action audit failed', { actor: user.name, identity, kind, error: errorMessage(auditErr) });
      }
      if (mapped?.code === 'github_rate_limited' && typeof mapped.details?.retryAfterMs === 'number') retryAfter(reply, mapped.details.retryAfterMs);
      throw mapped ?? err;
    }
    try {
      const action = audit('succeeded', {
        details: out.details ?? details,
        ...(out.commentId ? { commentId: out.commentId } : {}),
        ...(out.commentUrl ? { commentUrl: out.commentUrl } : {}),
      });
      return { ...out.body, action };
    } catch (auditErr) {
      logger.error('ui action audit failed after a successful GitHub write', { actor: user.name, identity, kind, item: item?.key, error: errorMessage(auditErr) });
      return { ...out.body, action: null, auditWarning: 'The action was carried out on GitHub, but it could not be recorded in the audit log (see the daemon log).' };
    }
  };

  // --- Item details for the panel -------------------------------------------
  app.get('/api/v1/items/resolve', async (req, reply) => {
    requireUser(req, reply, readLimiter);
    const { ref } = parse(resolveQuery, req.query, 'query');
    const sourceIds = Object.keys(deps.config.current.sources).sort();
    const prefixed = /^([^:/\s]+):(.+)$/.exec(ref);
    if (prefixed && sourceIds.includes(prefixed[1] as string)) {
      const adapter = requireSource(prefixed[1] as string);
      const itemId = adapter.parseItemRef(prefixed[2] as string);
      if (itemId === null) throw new ApiError(404, 'item_not_found', `"${prefixed[2]}" is not an item reference of source "${prefixed[1]}"`);
      return { source: prefixed[1], item: itemId };
    }
    const matches = sourceIds.flatMap((id) => {
      const itemId = deps.sources?.(id)?.parseItemRef(ref) ?? null;
      return itemId === null ? [] : [{ source: id, item: itemId }];
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ApiError(400, 'ambiguous_item_ref', `"${ref}" matches several sources (${matches.map((m) => m.source).join(', ')}); use a URL, owner/repo#number or <source>:<number>`);
    }
    throw new ApiError(404, 'item_not_found', `"${ref}" is not an item of any configured source (use a URL, owner/repo#number or <source>:<number>)`);
  });

  app.get('/api/v1/items/:source/:item', async (req, reply) => {
    requireUser(req, reply, readLimiter);
    const { source, item: ref } = parse(itemParams, req.params, 'path');
    const adapter = requireSource(source);
    const item = await loadItem(adapter, source, ref);
    const config = deps.config.current.sources[source];
    const declared = config?.project?.fields ?? {};
    let projectFields: Array<Record<string, unknown>> | null = null;
    let projectError: string | null = null;
    if (config?.project) {
      let options: Awaited<ReturnType<NonNullable<SourceAdapter['projectFieldOptions']>>> = [];
      try {
        options = (await adapter.projectFieldOptions?.()) ?? [];
      } catch (err) {
        projectError = deps.redact(errorMessage(err));
      }
      projectFields = Object.entries(declared).map(([name, kind]) => {
        const key = `project.${name}`;
        const known = Object.hasOwn(item.fields, key);
        const option = options.find((o) => o.name === name);
        return {
          name,
          kind,
          known,
          value: known ? (item.fields[key] ?? null) : null,
          reason: known ? null : (item.unknownFields?.[key] ?? 'not read'),
          choices: option?.choices ?? [],
          problem: option?.problem ?? null,
        };
      });
    }
    let availableLabels: string[] | null = null;
    let labelsError: string | null = null;
    try {
      availableLabels = (await adapter.listLabels?.()) ?? null;
    } catch (err) {
      labelsError = deps.redact(errorMessage(err));
    }
    const f = item.fields;
    return {
      source,
      itemId: item.itemId,
      key: item.key,
      url: item.url,
      type: item.type,
      repository: adapter.repository ?? null,
      title: typeof f.title === 'string' ? f.title : '',
      state: typeof f.state === 'string' ? f.state : null,
      labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === 'string') : [],
      project: config?.project ? { owner: config.project.owner, number: config.project.number, fields: projectFields, error: projectError } : null,
      availableLabels,
      labelsError,
      identities: enabledIdentities(),
      recentActions: repos.uiActions.list({ itemKey: item.key, limit: ITEM_RECENT_ACTIONS }).actions,
    };
  });

  // --- Actions ----------------------------------------------------------------
  app.post('/api/v1/items/:source/:item/comment', async (req, reply) => {
    const user = requireUser(req, reply, actionLimiter);
    const body = parse(commentBody, req.body, 'body');
    const { source, item: ref } = parse(itemParams, req.params, 'path');
    if (body.body.trim() === '') throw new ApiError(400, 'invalid_request', 'The comment is empty');
    // Never change a comment silently: reject it when it looks like it contains a secret (best effort).
    const findings = commentSecrets(body.body, deps.redact);
    if (findings.length > 0) {
      logger.warn('ui comment rejected: looks like it contains a secret', { actor: user.name, kinds: findings.map((f) => f.kind) });
      throw new ApiError(400, 'comment_contains_secret', `The comment looks like it contains a secret (${describeFindings(findings)}); remove it and send again`, { findings });
    }
    // Like orchestrator comments: no HTML comment can survive, so no idempotency marker can be forged.
    const text = neutralizeHtmlComments(body.body);
    if (text.length > MAX_COMMENT_LENGTH) {
      throw new ApiError(400, 'comment_too_long', `The comment is ${text.length} characters as sent (HTML comments are escaped); GitHub allows at most ${MAX_COMMENT_LENGTH}`);
    }
    // The same text by the same user on the same item within 60 s is refused (double click, second tab).
    const now = clock.now().getTime();
    for (const [k, at] of recentComments) if (now - at >= limits.duplicateCommentMs) recentComments.delete(k);
    const dupKey = `${user.name.toLowerCase()}\0${source}:${ref}\0${createHash('sha256').update(text).digest('hex')}`;
    if (recentComments.has(dupKey)) {
      throw new ApiError(409, 'duplicate_comment', 'The same comment was just sent to this item; check the item on GitHub before sending it again');
    }
    recentComments.set(dupKey, now);
    // The text itself is never stored, only its length.
    try {
      return await perform(req, reply, user, 'comment', body.identity, { length: text.length }, async (adapter, item) => {
        if (!adapter.postUserComment) throw new ApiError(400, 'not_supported', `Source "${item.sourceId}" does not support comments from the UI`);
        const posted = await adapter.postUserComment(item, text, body.identity);
        return {
          body: { comment: { id: posted.id, url: posted.url ?? null } },
          commentId: posted.id,
          ...(posted.url ? { commentUrl: posted.url } : {}),
        };
      });
    } catch (err) {
      // Definitely not posted: the user may send it again right away.
      if (!(err instanceof ApiError && err.code === 'github_outcome_unknown')) recentComments.delete(dupKey);
      throw err;
    }
  });

  app.post('/api/v1/items/:source/:item/labels', async (req, reply) => {
    const user = requireUser(req, reply, actionLimiter);
    const body = parse(labelsBody, req.body, 'body');
    if (body.add.length === 0 && body.remove.length === 0) throw new ApiError(400, 'invalid_request', 'Nothing to change: add or remove at least one label');
    const requested = { add: body.add, remove: body.remove };
    return perform(req, reply, user, 'labels', body.identity, { ...requested, create: body.create }, async (adapter, item) => {
      if (body.add.length > 0 && !body.create) {
        // GitHub creates unknown labels on the fly: only with an explicit `create: true`.
        let existing: string[];
        try {
          existing = (await adapter.listLabels?.()) ?? [];
        } catch (err) {
          throw githubError(err, deps.config.current.sources[item.sourceId]?.identity ?? 'source', 'source identity, used for reading the repository labels') ?? err;
        }
        const known = new Set(existing.map((l) => l.toLowerCase()));
        const missing = body.add.filter((l) => !known.has(l.toLowerCase()));
        if (missing.length > 0) {
          throw new ApiError(400, 'label_not_found', `Label(s) not defined in the repository: ${missing.join(', ')}; send create: true to create them`, { labels: missing });
        }
      }
      const result = await adapter.applyUpdate(item, { labels: requested }, body.identity, { exactIdentity: true });
      return { body: { changed: result.changed, applied: result.applied ?? {} }, details: { ...requested, create: body.create, applied: result.applied ?? {} } };
    });
  });

  app.post('/api/v1/items/:source/:item/project', async (req, reply) => {
    const user = requireUser(req, reply, actionLimiter);
    const body = parse(projectBody, req.body, 'body');
    const { source } = parse(itemParams, req.params, 'path');
    const names = Object.keys(body.fields);
    if (names.length === 0) throw new ApiError(400, 'invalid_request', 'Nothing to change: give at least one field');
    // An unknown source is reported (and audited) by perform().
    const known = Object.hasOwn(deps.config.current.sources, source);
    const project = known ? deps.config.current.sources[source]?.project : undefined;
    if (known && !project) {
      throw new ApiError(400, 'project_not_configured', `Source "${source}" has no GitHub project (sources.yaml: project)`);
    }
    const problems: string[] = [];
    const fields: Record<string, ProjectFieldUpdateValue> = {};
    for (const [name, value] of Object.entries(body.fields)) {
      if (!project) {
        fields[name] = value;
        continue;
      }
      const kind = Object.hasOwn(project.fields, name) ? project.fields[name] : undefined;
      if (!kind) {
        problems.push(`project field "${name}" is not declared in project.fields of source "${source}"`);
        continue;
      }
      const problem = valueProblem(kind, value);
      if (problem) problems.push(`project field "${name}": ${problem}`);
      fields[name] = value;
    }
    if (problems.length > 0) throw new ApiError(400, 'invalid_project_fields', problems.join('; '), { problems });
    return perform(req, reply, user, 'project', body.identity, { fields }, async (adapter, item) => {
      const result = await adapter.applyUpdate(item, { project: fields }, body.identity, { exactIdentity: true });
      return { body: { changed: result.changed, applied: result.applied ?? {} }, details: { fields, applied: result.applied ?? {} } };
    });
  });

  // --- Audit ------------------------------------------------------------------
  app.get('/api/v1/ui-actions', async (req) => {
    requireEnabled();
    const q = parse(listQuery, req.query, 'query');
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    const page = repos.uiActions.list({
      ...(q.source ? { sourceId: q.source } : {}),
      ...(q.item ? { itemKey: q.item } : {}),
      limit,
      offset,
    });
    return { enabled: true, identities: enabledIdentities(), actions: page.actions, total: page.total, limit, offset };
  });
}
