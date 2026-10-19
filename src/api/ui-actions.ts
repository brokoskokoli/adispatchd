/**
 * UI actions (WI-27): a logged-in admin acts on an issue/PR as a configured
 * identity (`identities.yaml` → `ui_actions: true`) – comment, add/remove
 * labels, set project fields – plus the item details for the panel and the
 * persistent audit (`ui_actions` table).
 *
 * Security:
 * - Route role `admin` (roles.ts); additionally `auth.mode` ≠ none and a REAL
 *   login (`password` / `trusted_header`). The local CLI control token is
 *   refused: workers run as the same service user and can read it, so it
 *   must not let a worker post as a (more privileged) app identity.
 * - CSRF/Host/Origin rules as for every write (server.ts hooks).
 * - The identity must be enabled for UI actions; the item must belong to the
 *   source (read freshly; transferred items are not found).
 * - Comment texts are redacted (known secrets, GitHub token formats, PEM
 *   private keys) before sending, sent exactly once (no automatic retries)
 *   and never stored; the audit keeps only the comment URL.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  errorMessage,
  noopLogger,
  SourceError,
  type Logger,
  type ProjectFieldUpdateValue,
  type Redactor,
  type SourceAdapter,
  type SourceItem,
} from '../core/index.js';
import type { ConfigManager } from '../config/index.js';
import type { Repositories, UiActionKind, UiActionRecord, UiActionResult } from '../persistence/index.js';
import { valueProblem } from '../sources/index.js';
import type { Principal } from './auth.js';
import { ApiError } from './errors.js';

/** Max length of a comment (GitHub's limit). */
export const MAX_COMMENT_LENGTH = 65_536;
/** Max label names per request (add + remove each). */
const MAX_LABELS = 50;
/** Max audit entries embedded in the item details. */
const ITEM_RECENT_ACTIONS = 20;

/** What the UI action routes need. */
export interface UiActionDeps {
  config: ConfigManager;
  repositories: Repositories;
  /** Source adapters by ID (absent = UI actions report every source as unknown). */
  sources?: (sourceId: string) => SourceAdapter | undefined;
  redact: Redactor;
  logger?: Logger;
  /** True if `auth.mode` ≠ none. */
  authEnabled(): boolean;
}

// ---------------------------------------------------------------------------
// Redaction of comment texts

/** Token formats redacted in comment texts even if the token is not known to this instance. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
];

/**
 * Redact a comment text before it is sent: values known to the shared
 * redactor (installation tokens, keys, token identities) and common token
 * formats. Returns the text and whether anything was replaced.
 */
export function redactCommentText(text: string, redact: Redactor): { text: string; redacted: boolean } {
  let out = redact(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return { text: out, redacted: out !== text };
}

// ---------------------------------------------------------------------------
// Request schemas

const itemParams = z.object({ source: z.string().min(1).max(200), item: z.string().min(1).max(20) }).strict();
const identityField = z.string().min(1).max(200);
const commentBody = z.object({ identity: identityField, body: z.string().max(MAX_COMMENT_LENGTH) }).strict();
const labelName = z.string().trim().min(1).max(100);
const labelsBody = z
  .object({ identity: identityField, add: z.array(labelName).max(MAX_LABELS).default([]), remove: z.array(labelName).max(MAX_LABELS).default([]) })
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
export function githubError(err: unknown, identity: string): ApiError | null {
  if (!(err instanceof SourceError)) return null;
  const detail = err.message;
  switch (err.kind) {
    case 'auth':
      return new ApiError(502, 'github_auth_failed', `GitHub rejected the credentials of identity "${identity}": ${detail}`);
    case 'forbidden':
      return new ApiError(502, 'github_forbidden', `GitHub refused the action for identity "${identity}" (missing app permission, or the conversation is locked): ${detail}`);
    case 'not_found':
      return new ApiError(404, 'github_not_found', `GitHub did not find the item or project for identity "${identity}": ${detail}`);
    case 'rate_limited':
      return new ApiError(429, 'github_rate_limited', `GitHub rate limit reached for identity "${identity}"; try again later: ${detail}`, {
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

// ---------------------------------------------------------------------------

/** Register the UI action routes on `app` (roles: see roles.ts). */
export function registerUiActionRoutes(app: FastifyInstance, deps: UiActionDeps): void {
  const logger = (deps.logger ?? noopLogger).child({ component: 'ui-actions' });
  const repos = deps.repositories;

  /** Only a real logged-in user (never the control token, never without auth). */
  const requireUser = (req: FastifyRequest): Principal => {
    if (!deps.authEnabled()) {
      throw new ApiError(403, 'ui_actions_disabled', 'UI actions need a login (auth.mode password or trusted_header); they are disabled with auth.mode none');
    }
    const p = req.principal;
    if (!p || p.via === 'anonymous') throw new ApiError(401, 'authentication_required', 'Login required');
    if (p.via !== 'password' && p.via !== 'trusted_header') {
      throw new ApiError(403, 'user_login_required', 'UI actions need a logged-in user; the local control token is not accepted');
    }
    if (p.role !== 'admin') throw new ApiError(403, 'forbidden', `This action requires the role "admin" (your role: "${p.role}")`, { requiredRole: 'admin', role: p.role });
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

  /** The item, read freshly; it must belong to the source (like a manual start). */
  const loadItem = async (adapter: SourceAdapter, sourceId: string, ref: string, identity: string | null): Promise<SourceItem> => {
    const itemId = adapter.parseItemRef(ref);
    if (itemId === null || itemId !== ref) throw new ApiError(404, 'item_not_found', `"${ref}" is not an item of source "${sourceId}"`);
    let item: SourceItem | null;
    try {
      item = await adapter.getItem(itemId);
    } catch (err) {
      throw githubError(err, identity ?? 'source') ?? err;
    }
    if (!item || item.sourceId !== sourceId) throw new ApiError(404, 'item_not_found', `Item ${itemId} not found in source "${sourceId}"`);
    return item;
  };

  /** Run one action with audit (success and every failure after the login check). */
  const perform = async <T extends Record<string, unknown>>(
    req: FastifyRequest,
    reply: FastifyReply,
    kind: UiActionKind,
    identity: string,
    details: Record<string, unknown>,
    fn: (adapter: SourceAdapter, item: SourceItem) => Promise<{ body: T; commentId?: string; commentUrl?: string; details?: Record<string, unknown> }>,
  ): Promise<unknown> => {
    const user = requireUser(req);
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
      });
      logger.info('ui action', { actor: user.name, identity, item: record.itemKey, kind, result, ...(record.errorCode ? { error: record.errorCode } : {}) });
      return record;
    };
    try {
      requireIdentity(identity);
      const adapter = requireSource(source);
      item = await loadItem(adapter, source, ref, identity);
      const out = await fn(adapter, item);
      const action = audit('succeeded', {
        details: out.details ?? details,
        ...(out.commentId ? { commentId: out.commentId } : {}),
        ...(out.commentUrl ? { commentUrl: out.commentUrl } : {}),
      });
      return { ...out.body, action };
    } catch (err) {
      const mapped = err instanceof ApiError ? err : githubError(err, identity);
      const unknown = err instanceof SourceError && err.outcomeUnknown;
      const applied = err instanceof SourceError ? (err.details?.applied as Record<string, unknown> | undefined) : undefined;
      audit(unknown ? 'unknown' : 'failed', {
        errorCode: mapped?.code ?? 'internal_error',
        errorMessage: deps.redact(errorMessage(err)).slice(0, 1000),
        details: applied ? { ...details, applied } : details,
      });
      if (mapped?.code === 'github_rate_limited' && typeof mapped.details?.retryAfterMs === 'number') {
        void reply.header('retry-after', String(Math.max(1, Math.ceil(mapped.details.retryAfterMs / 1000))));
      }
      throw mapped ?? err;
    }
  };

  // --- Item details for the panel -------------------------------------------
  app.get('/api/v1/items/resolve', async (req) => {
    requireUser(req);
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

  app.get('/api/v1/items/:source/:item', async (req) => {
    requireUser(req);
    const { source, item: ref } = parse(itemParams, req.params, 'path');
    const adapter = requireSource(source);
    const item = await loadItem(adapter, source, ref, null);
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
    requireUser(req);
    const body = parse(commentBody, req.body, 'body');
    if (body.body.trim() === '') throw new ApiError(400, 'invalid_request', 'The comment is empty');
    const redacted = redactCommentText(body.body, deps.redact);
    // The text itself is never stored, only its length.
    return perform(req, reply, 'comment', body.identity, { length: body.body.length, redacted: redacted.redacted }, async (adapter, item) => {
      if (!adapter.postUserComment) throw new ApiError(400, 'not_supported', `Source "${item.sourceId}" does not support comments from the UI`);
      const ref = await adapter.postUserComment(item, redacted.text, body.identity);
      return {
        body: { comment: { id: ref.id, url: ref.url ?? null }, redacted: redacted.redacted },
        commentId: ref.id,
        ...(ref.url ? { commentUrl: ref.url } : {}),
      };
    });
  });

  app.post('/api/v1/items/:source/:item/labels', async (req, reply) => {
    requireUser(req);
    const body = parse(labelsBody, req.body, 'body');
    if (body.add.length === 0 && body.remove.length === 0) throw new ApiError(400, 'invalid_request', 'Nothing to change: add or remove at least one label');
    const requested = { add: body.add, remove: body.remove };
    return perform(req, reply, 'labels', body.identity, requested, async (adapter, item) => {
      const result = await adapter.applyUpdate(item, { labels: requested }, body.identity, { exactIdentity: true });
      return { body: { changed: result.changed, applied: result.applied ?? {} }, details: { ...requested, applied: result.applied ?? {} } };
    });
  });

  app.post('/api/v1/items/:source/:item/project', async (req, reply) => {
    requireUser(req);
    const body = parse(projectBody, req.body, 'body');
    const { source } = parse(itemParams, req.params, 'path');
    const names = Object.keys(body.fields);
    if (names.length === 0) throw new ApiError(400, 'invalid_request', 'Nothing to change: give at least one field');
    requireSource(source);
    const project = deps.config.current.sources[source]?.project;
    if (!project) {
      throw new ApiError(400, 'project_not_configured', `Source "${source}" has no GitHub project (sources.yaml: project)`);
    }
    const problems: string[] = [];
    const fields: Record<string, ProjectFieldUpdateValue> = {};
    for (const [name, value] of Object.entries(body.fields)) {
      const kind = project && Object.hasOwn(project.fields, name) ? project.fields[name] : undefined;
      if (!kind) {
        problems.push(`project field "${name}" is not declared in project.fields of source "${source}"`);
        continue;
      }
      const problem = valueProblem(kind, value);
      if (problem) problems.push(`project field "${name}": ${problem}`);
      fields[name] = value;
    }
    if (problems.length > 0) throw new ApiError(400, 'invalid_project_fields', problems.join('; '), { problems });
    return perform(req, reply, 'project', body.identity, { fields }, async (adapter, item) => {
      const result = await adapter.applyUpdate(item, { project: fields }, body.identity, { exactIdentity: true });
      return { body: { changed: result.changed, applied: result.applied ?? {} }, details: { fields, applied: result.applied ?? {} } };
    });
  });

  // --- Audit ------------------------------------------------------------------
  app.get('/api/v1/ui-actions', async (req) => {
    const q = parse(listQuery, req.query, 'query');
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    const page = repos.uiActions.list({
      ...(q.source ? { sourceId: q.source } : {}),
      ...(q.item ? { itemKey: q.item } : {}),
      limit,
      offset,
    });
    return {
      enabled: deps.authEnabled(),
      identities: enabledIdentities(),
      actions: page.actions,
      total: page.total,
      limit,
      offset,
    };
  });
}
