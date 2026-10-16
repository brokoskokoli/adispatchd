/**
 * HTTP API (Spec §15) on Fastify: `/health`, `/ready` and `/api/v1/*`
 * (documented in docs/api.md).
 *
 * Security (Spec §15, §20): no built-in authentication – bind to loopback
 * (default) or run behind an authenticating proxy/VPN. Mutating requests
 * (POST/PATCH/PUT/DELETE) require the header `X-Orchestrator-Request: 1`,
 * a JSON body (or none), and – if the browser sends an `Origin` – an origin
 * matching the `Host` (or an allowed origin); cross-site fetches
 * (`Sec-Fetch-Site: cross-site`) are refused. No CORS headers are ever sent,
 * so browsers cannot read API responses cross-origin and the custom header
 * forces a (failing) preflight for cross-origin writes.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACTIVE_STATUSES,
  TECHNICAL_STATUSES,
  dataPaths,
  errorMessage,
  isValidRunId,
  noopLogger,
  redactValue,
  systemClock,
  type Clock,
  type Logger,
  type Redactor,
  type TechnicalStatus,
} from '../core/index.js';
import { loadConfig, toPublicConfig, type ConfigManager, type ReloadResult } from '../config/index.js';
import type { LifecycleEngine } from '../lifecycle/index.js';
import type { NotificationService } from '../notifications/index.js';
import type { Repositories, RunRecord } from '../persistence/index.js';
import type { RetentionService, RunController } from '../runs/index.js';
import type { Scheduler } from '../scheduler/index.js';
import type { ViewService } from '../views/index.js';
import { ApiError, toErrorResponse } from './errors.js';
import { readLogPage } from './logs.js';
import { runDetailFields, toBlockView, toRunSummary, toWorkflowView, type ActionView } from './serialize.js';
import type { EventHub } from './sse.js';

/** Header that every mutating request must carry (CSRF protection). */
export const CSRF_HEADER = 'x-orchestrator-request';
/** Max size of `context.json`/`result.json` returned in run details. */
const MAX_JSON_FILE_BYTES = 1024 * 1024;
/** Max events embedded in the run detail (more via `/runs/:id/events`). */
const DETAIL_EVENT_LIMIT = 500;

/** Readiness of the instance (`/ready`). */
export interface ReadinessReport {
  ready: boolean;
  checks: { database: boolean; recovery: boolean; config: boolean; scheduler: boolean; shuttingDown: boolean };
}

/** Everything the API needs from the application. */
export interface ApiDeps {
  config: ConfigManager;
  repositories: Repositories;
  controller: RunController;
  scheduler: Scheduler;
  lifecycle: LifecycleEngine;
  views: ViewService;
  notifications: NotificationService;
  retention?: RetentionService;
  events: EventHub;
  dataDir: string;
  clock?: Clock;
  logger?: Logger;
  /** Redaction of error texts (shared `SecretRedactor`). */
  redact?: Redactor;
  readiness(): ReadinessReport;
  /** Start a shutdown (drain or cancel-all) in the background; repeated calls escalate. */
  shutdown(mode: 'drain' | 'cancel', reason?: string): void;
  /** Reload the configuration (app also rebuilds adapters, invalidates caches, plans). */
  reloadConfig(): Promise<ReloadResult>;
  /** Track a background operation started by a request (awaited/aborted on shutdown). */
  background(what: string, start: (signal: AbortSignal) => Promise<unknown>): Promise<unknown>;
  /** Static info for `/status`. */
  info: { version: string; startedAt: string; host: string; port: () => number | null };
  /** Additional allowed `Origin`s for mutating requests (besides the request's own host). */
  allowedOrigins?: readonly string[];
  /** Directory with static web UI assets (WI-11), served at `/` if present. */
  uiDir?: string;
}

// ---------------------------------------------------------------------------
// Request schemas (zod)

const idParam = z.object({ id: z.string().min(1).max(200) });
const numericIdParam = z.object({ id: z.coerce.number().int().positive() });
const nullableOverride = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const runtimeBody = z
  .object({
    enabled: nullableOverride(z.boolean()),
    priority: nullableOverride(z.number().finite()),
    maxConcurrent: nullableOverride(z.number().int().min(1)),
  })
  .strict();
const globalRuntimeBody = z.object({ maxConcurrent: z.number().int().min(1).nullable() }).strict();
const startBody = z
  .object({
    item: z.string().min(1).max(2000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const cancelBody = z.object({ reason: z.string().max(500).optional() }).strict();
const recoveryBody = z.object({ assumeGone: z.boolean().optional() }).strict();
const clearBody = z.object({ clearedBy: z.string().max(200).optional() }).strict();
const emptyBody = z.object({}).strict();
const runsQuery = z
  .object({
    workflow: z.string().optional(),
    status: z.string().optional(),
    trigger: z.enum(['source', 'schedule', 'manual']).optional(),
    item: z.string().optional(),
    result: z.enum(['success', 'failure']).optional(),
    active: z.enum(['true', 'false']).optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
const eventsQuery = z
  .object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() })
  .strict();
const logsQuery = z
  .object({
    stream: z.enum(['stdout', 'stderr']).default('stdout'),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).optional(),
    tail: z.coerce.number().int().min(0).optional(),
  })
  .strict();
const sseQuery = z
  .object({ run: z.string().optional(), lastEventId: z.coerce.number().int().min(0).optional() })
  .strict();

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(400, 'invalid_request', `Invalid ${what}`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/** Wait one macrotask: errors thrown synchronously at the start of `p` (validation, busy) surface here. */
async function earlyError(p: Promise<unknown>): Promise<unknown> {
  let failed = false;
  let error: unknown;
  p.catch((err: unknown) => {
    failed = true;
    error = err;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return failed ? (error ?? new Error('failed')) : undefined;
}

/** Read a JSON file (bounded); returns `{value}` or `{error}`; `null` if missing. */
async function readJsonFile(file: string): Promise<{ value: unknown } | { error: string } | null> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return { error: 'not a regular file' };
    if (st.size > MAX_JSON_FILE_BYTES) return { error: `file too large (${st.size} bytes)` };
    return { value: JSON.parse(await readFile(file, 'utf8')) as unknown };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { error: errorMessage(err) };
  }
}

async function fileSize(file: string): Promise<number | null> {
  try {
    const st = await stat(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/** Create the Fastify instance with all routes (not listening yet). */
export async function createApiServer(deps: ApiDeps): Promise<FastifyInstance> {
  const logger = (deps.logger ?? noopLogger).child({ component: 'api' });
  const clock = deps.clock ?? systemClock;
  const redact = deps.redact ?? ((s: string) => s);
  const repos = deps.repositories;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, return503OnClosing: true });

  // Only JSON bodies (an empty body is allowed); no text/plain or form parsers (CSRF "simple requests").
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
    }
  });

  // --- Security hooks -------------------------------------------------------
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.method === 'OPTIONS') throw new ApiError(405, 'method_not_allowed', 'CORS preflight is not supported');
    if (req.headers[CSRF_HEADER] !== '1') {
      throw new ApiError(403, 'csrf_header_missing', `Mutating requests require the header "X-Orchestrator-Request: 1"`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, 'cross_site_request', 'Cross-site requests are not allowed');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null') {
      const host = req.headers.host;
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      const allowed = (deps.allowedOrigins ?? []).includes(origin) || (host !== undefined && originHost === host);
      if (!allowed) throw new ApiError(403, 'origin_not_allowed', 'Request origin is not allowed');
    } else if (origin === 'null') {
      throw new ApiError(403, 'origin_not_allowed', 'Request origin is not allowed');
    }
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (hasBody && type !== 'application/json') {
      throw new ApiError(415, 'unsupported_media_type', 'Request bodies must be application/json');
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (req.url.startsWith('/api/') || req.url === '/health' || req.url === '/ready') reply.header('cache-control', 'no-store');
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err, redact);
    if (status >= 500) logger.error('request failed', { method: req.method, url: req.url, error: err });
    else logger.debug('request rejected', { method: req.method, url: req.url, code: body.error.code });
    void reply.status(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found` } });
  });

  // --- Helpers --------------------------------------------------------------
  const requireRun = (id: string): RunRecord => {
    const run = repos.runs.get(id);
    if (!run) throw new ApiError(404, 'not_found', `Run '${id}' not found`);
    return run;
  };
  const accepted = (reply: FastifyReply, body: unknown): unknown => reply.status(202).send(body);
  const runPaths = (id: string) => {
    if (!isValidRunId(id)) return null;
    return dataPaths(deps.dataDir).run(id);
  };

  // --- Health / readiness ---------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', time: clock.now().toISOString() }));
  app.get('/ready', async (_req, reply) => {
    const r = deps.readiness();
    return reply.status(r.ready ? 200 : 503).send(r);
  });

  // --- Status / scheduler / shutdown ----------------------------------------
  app.get('/api/v1/status', async () => statusBody());

  function statusBody(): Record<string, unknown> {
    const s = deps.controller.status;
    const cfg = deps.config.current;
    const byWorkflow: Record<string, { active: number; max: number }> = {};
    for (const wf of deps.config.listWorkflows()) {
      byWorkflow[wf.config.id] = { active: repos.runs.countActive(wf.config.id), max: wf.maxConcurrent };
    }
    const recoveryPending = repos.runs.list({ statuses: ['recovery_pending'], limit: 1 }).total;
    const last = deps.scheduler.lastPlanningStep();
    const overrides = deps.config.getOverrides();
    const state = !s.ready ? 'recovering' : s.stopping ? 'stopping' : s.draining ? 'draining' : s.paused ? 'paused' : 'running';
    const host = deps.info.host;
    return {
      version: deps.info.version,
      startedAt: deps.info.startedAt,
      time: clock.now().toISOString(),
      readiness: deps.readiness(),
      scheduler: {
        state,
        ready: s.ready,
        paused: s.paused,
        draining: s.draining,
        stopping: s.stopping,
        pollingIntervalMs: cfg.global.scheduler.pollingIntervalMs,
        lastPlanningStep: last
          ? { startedAt: last.startedAt, finishedAt: last.finishedAt, skipped: last.skipped, startedRunIds: last.startedRunIds }
          : null,
      },
      limits: {
        maxConcurrent: deps.config.maxConcurrent,
        configuredMaxConcurrent: cfg.global.scheduler.maxConcurrent,
        override: overrides.global.maxConcurrent ?? null,
      },
      usage: {
        activeRuns: repos.runs.countActive(),
        supervisedRuns: s.activeRuns,
        recoveryPending,
        byWorkflow,
      },
      counts: {
        activeBlocks: repos.blocks.listActive().length,
        failedActions: repos.actions.listFailed().length,
        notifications: repos.notifications.countByState(),
      },
      config: { version: cfg.version, hash: cfg.hash, loadedAt: cfg.loadedAt, configDir: cfg.configDir },
      server: { host, port: deps.info.port(), loopback: isLoopbackHost(host) },
      sse: { clients: deps.events.clientCount },
      retention: deps.retention?.lastReport
        ? {
            lastRunAt: deps.retention.lastReport.finishedAt,
            deletedRuns: deps.retention.lastReport.deletedRuns,
            errors: deps.retention.lastReport.errors.length,
          }
        : null,
    };
  }

  app.post('/api/v1/scheduler/pause', async (req) => {
    parse(emptyBody, req.body, 'body');
    deps.controller.pause();
    return statusBody();
  });
  app.post('/api/v1/scheduler/resume', async (req) => {
    parse(emptyBody, req.body, 'body');
    deps.controller.resume();
    void deps.scheduler.planOnce().catch((err: unknown) => logger.warn('planning after resume failed', { error: errorMessage(err) }));
    return statusBody();
  });
  app.patch('/api/v1/scheduler/runtime', async (req) => {
    const body = parse(globalRuntimeBody, req.body, 'body');
    deps.config.setGlobalMaxConcurrent(body.maxConcurrent ?? undefined);
    void deps.scheduler.planOnce().catch(() => undefined);
    return statusBody();
  });
  app.post('/api/v1/shutdown/drain', async (req, reply) => {
    parse(emptyBody, req.body, 'body');
    deps.shutdown('drain');
    return accepted(reply, { accepted: true, mode: 'drain', activeRuns: deps.controller.activeRunIds() });
  });
  app.post('/api/v1/shutdown/cancel-all', async (req, reply) => {
    parse(cancelBody, req.body, 'body');
    const body = (req.body ?? {}) as { reason?: string };
    deps.shutdown('cancel', body.reason);
    return accepted(reply, { accepted: true, mode: 'cancel', activeRuns: deps.controller.activeRunIds() });
  });

  // --- Workflows ------------------------------------------------------------
  const workflowView = (id: string, detail: boolean): Record<string, unknown> => {
    const wf = deps.config.getWorkflow(id);
    if (!wf) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${id}"`);
    const cron = deps.scheduler.cronStatus().find((c) => c.workflowId === id) ?? null;
    const diagnosis = deps.scheduler.lastDiagnosis(id);
    const view = toWorkflowView(wf, {
      activeRuns: repos.runs.countActive(id),
      activeBlocks: repos.blocks.listForWorkflow(id).filter((b) => b.clearedAt === null).length,
      cron,
      diagnosis,
    });
    return detail ? { ...view, diagnosis: diagnosis ?? null, filter: wf.config.filter, hooks: wf.config.hooks } : view;
  };
  app.get('/api/v1/workflows', async () => ({
    workflows: deps.config.listWorkflows().map((wf) => workflowView(wf.config.id, false)),
    overrides: deps.config.getOverrides(),
  }));
  app.get('/api/v1/workflows/:id', async (req) => workflowView(parse(idParam, req.params, 'path').id, true));
  app.patch('/api/v1/workflows/:id/runtime', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(runtimeBody, req.body, 'body');
    if (!deps.config.getWorkflow(id)) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${id}"`);
    const overrides: Record<string, unknown> = {};
    for (const key of ['enabled', 'priority', 'maxConcurrent'] as const) {
      if (key in body) overrides[key] = body[key] ?? undefined; // null resets to the YAML value
    }
    deps.config.setWorkflowOverrides(id, overrides);
    void deps.scheduler.planOnce().catch(() => undefined);
    return workflowView(id, false);
  });
  app.post('/api/v1/workflows/:id/start', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(startBody, req.body, 'body');
    const result = await deps.scheduler.startManual(id, {
      ...(body.item !== undefined ? { itemRef: body.item } : {}),
      ...(body.parameters !== undefined ? { parameters: body.parameters } : {}),
    });
    result.done.catch((err: unknown) => logger.warn('manual run supervision failed', { runId: result.run.id, error: errorMessage(err) }));
    return accepted(reply, { run: toRunSummary(repos.runs.get(result.run.id) ?? result.run) });
  });
  app.post('/api/v1/workflows/:id/dry-run', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    parse(emptyBody, req.body, 'body');
    if (!deps.config.getWorkflow(id)) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${id}"`);
    return deps.scheduler.dryRun(id);
  });

  // --- Runs -----------------------------------------------------------------
  app.get('/api/v1/runs', async (req) => {
    const q = parse(runsQuery, req.query, 'query');
    let statuses: TechnicalStatus[] | undefined;
    if (q.status) {
      statuses = q.status.split(',').map((s) => s.trim()) as TechnicalStatus[];
      const invalid = statuses.filter((s) => !(TECHNICAL_STATUSES as readonly string[]).includes(s));
      if (invalid.length > 0) throw new ApiError(400, 'invalid_request', `Unknown status: ${invalid.join(', ')}`);
    }
    if (q.active === 'true') statuses = statuses ? statuses.filter((s) => ACTIVE_STATUSES.includes(s as never)) : [...ACTIVE_STATUSES];
    if (q.active === 'false') {
      const terminal = TECHNICAL_STATUSES.filter((s) => !(ACTIVE_STATUSES as readonly string[]).includes(s));
      statuses = statuses ? statuses.filter((s) => terminal.includes(s)) : [...terminal];
    }
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    if (statuses && statuses.length === 0) return { runs: [], total: 0, limit, offset };
    const page = repos.runs.list({
      ...(q.workflow ? { workflowId: q.workflow } : {}),
      ...(statuses ? { statuses } : {}),
      ...(q.trigger ? { triggerType: q.trigger } : {}),
      ...(q.item ? { sourceItemKey: q.item } : {}),
      ...(q.result ? { businessResult: q.result } : {}),
      ...(q.before ? { createdBefore: q.before } : {}),
      limit,
      offset,
    });
    return { runs: page.runs.map(toRunSummary), total: page.total, limit, offset };
  });

  app.get('/api/v1/runs/:id', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const run = requireRun(id);
    const paths = runPaths(id);
    const [input, resultFile, stdoutSize, stderrSize] = paths
      ? await Promise.all([readJsonFile(paths.contextFile), readJsonFile(paths.resultFile), fileSize(paths.stdoutLog), fileSize(paths.stderrLog)])
      : [null, null, null, null];
    const actions: ActionView[] = repos.actions.listForRun(id).map((a) => ({ ...a, attemptsDetail: repos.actions.listAttempts(a.id) }));
    const allEvents = repos.events.listForRun(id);
    const events = allEvents.slice(0, DETAIL_EVENT_LIMIT + 1);
    const truncatedStreams = new Set(
      allEvents
        .filter((e) => e.type === 'diagnostic.log_truncated')
        .map((e) => String(e.payload.stream ?? (e.payload.details as { stream?: unknown } | undefined)?.stream ?? '')),
    );
    const block = repos.blocks.activeFor(run.workflowId, run.sourceItemKey);
    return redactValue(
      {
        ...toRunSummary(run),
        ...runDetailFields(run),
        input: input && 'value' in input ? input.value : null,
        inputError: input && 'error' in input ? input.error : null,
        resultFile: resultFile && 'value' in resultFile ? resultFile.value : null,
        resultFileError: resultFile && 'error' in resultFile ? resultFile.error : null,
        actions,
        events: events.slice(0, DETAIL_EVENT_LIMIT),
        eventsTruncated: events.length > DETAIL_EVENT_LIMIT,
        logs: {
          stdout: { size: stdoutSize, truncated: truncatedStreams.has('stdout') },
          stderr: { size: stderrSize, truncated: truncatedStreams.has('stderr') },
        },
        block: block ? toBlockView(block, { affectedRunIds: repos.blocks.affectedRunIds(block.id), sourceUrl: run.sourceUrl, workflowName: null }) : null,
        supervised: deps.controller.activeRunIds().includes(id),
      },
      redact,
    );
  });

  app.get('/api/v1/runs/:id/events', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const q = parse(eventsQuery, req.query, 'query');
    requireRun(id);
    const limit = q.limit ?? 1000;
    const events = repos.events.listForRun(id, { afterSequence: q.after ?? 0, limit: limit + 1 });
    const page = events.slice(0, limit);
    return { events: page, hasMore: events.length > limit, nextAfter: page.at(-1)?.sequence ?? q.after ?? 0 };
  });

  app.get('/api/v1/runs/:id/logs', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const q = parse(logsQuery, req.query, 'query');
    const run = requireRun(id);
    const paths = runPaths(id);
    if (!paths) throw new ApiError(404, 'not_found', 'No logs for this run');
    const file = q.stream === 'stdout' ? paths.stdoutLog : paths.stderrLog;
    const page = await readLogPage(file, q.stream, {
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.tail !== undefined ? { tail: q.tail } : {}),
    });
    return { runId: id, active: (ACTIVE_STATUSES as readonly string[]).includes(run.status), ...page };
  });

  app.post('/api/v1/runs/:id/cancel', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(cancelBody, req.body, 'body');
    requireRun(id);
    const r = deps.controller.requestCancel(id, { reason: body.reason ?? 'cancelled via API' });
    return accepted(reply, { runId: r.runId, status: r.status, run: toRunSummary(requireRun(id)) });
  });

  app.post('/api/v1/runs/:id/recovery/retry', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(recoveryBody, req.body, 'body');
    requireRun(id);
    const op = deps.background(`recovery retry ${id}`, () => deps.controller.retryRecovery(id, { assumeGone: body.assumeGone === true }));
    const error = await earlyError(op);
    if (error) throw error;
    return accepted(reply, { accepted: true, run: toRunSummary(requireRun(id)) });
  });

  // --- Blocks ---------------------------------------------------------------
  const blockView = (blockId: number) => {
    const block = repos.blocks.get(blockId);
    if (!block) throw new ApiError(404, 'not_found', `Block ${blockId} not found`);
    const run = block.runId ? repos.runs.get(block.runId) : null;
    const wf = deps.config.getWorkflow(block.workflowId);
    return toBlockView(block, {
      affectedRunIds: repos.blocks.affectedRunIds(block.id),
      sourceUrl: run?.sourceUrl ?? null,
      workflowName: wf?.config.name ?? null,
    });
  };
  app.get('/api/v1/blocks', async (req) => {
    const q = parse(z.object({ workflow: z.string().optional() }).strict(), req.query, 'query');
    const blocks = repos.blocks.listActive().filter((b) => !q.workflow || b.workflowId === q.workflow);
    return { blocks: blocks.map((b) => blockView(b.id)) };
  });
  app.post('/api/v1/blocks/:id/clear', async (req) => {
    const { id } = parse(numericIdParam, req.params, 'path');
    const body = parse(clearBody, req.body, 'body');
    if (!repos.blocks.get(id)) throw new ApiError(404, 'not_found', `Block ${id} not found`);
    deps.controller.clearBlock(id, body.clearedBy ?? 'api');
    void deps.scheduler.planOnce().catch(() => undefined);
    return { block: blockView(id) };
  });

  // --- Lifecycle actions ----------------------------------------------------
  app.get('/api/v1/actions/failed', async () => ({
    actions: repos.actions.listFailed().map((a) => {
      const run = repos.runs.get(a.runId);
      return {
        ...a,
        attemptsDetail: repos.actions.listAttempts(a.id),
        run: run ? toRunSummary(run) : null,
        busy: deps.lifecycle.isBusy(a.runId),
      };
    }),
  }));
  const actionOp = async (req: FastifyRequest, reply: FastifyReply, kind: 'retry' | 'skip') => {
    const { id } = parse(numericIdParam, req.params, 'path');
    parse(emptyBody, req.body, 'body');
    const action = repos.actions.get(id);
    if (!action) throw new ApiError(404, 'not_found', `Action ${id} not found`);
    const op = deps.background(`action ${kind} ${id}`, (signal) =>
      kind === 'retry' ? deps.lifecycle.retryAction(id, { signal }) : deps.lifecycle.skipAction(id, { signal }),
    );
    const error = await earlyError(op);
    if (error) throw error;
    return accepted(reply, { accepted: true, action: repos.actions.get(id) });
  };
  app.post('/api/v1/actions/:id/retry', async (req, reply) => actionOp(req, reply, 'retry'));
  app.post('/api/v1/actions/:id/skip', async (req, reply) => actionOp(req, reply, 'skip'));

  // --- Views ----------------------------------------------------------------
  app.get('/api/v1/views', async () => ({ views: deps.views.list() }));
  app.get('/api/v1/views/:id', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const view = deps.views.get(id);
    if (!view) throw new ApiError(404, 'view_not_found', `Unknown view "${id}"`);
    return view;
  });
  app.get('/api/v1/views/:id/items', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const q = parse(z.object({ refresh: z.enum(['true', 'false', '1', '0']).optional() }).strict(), req.query, 'query');
    return deps.views.items(id, { refresh: q.refresh === 'true' || q.refresh === '1' });
  });

  // --- Configuration --------------------------------------------------------
  app.get('/api/v1/config', async () => {
    const cfg = toPublicConfig(deps.config.current);
    return { config: cfg, overrides: deps.config.getOverrides() };
  });
  app.get('/api/v1/config/files', async () => ({ files: await readConfigFiles(deps.config.current.configDir, redact) }));
  app.post('/api/v1/config/validate', async (req) => {
    parse(emptyBody, req.body, 'body');
    const res = await loadConfig(deps.config.current.configDir, { dataDir: deps.dataDir, version: deps.config.current.version + 1 });
    return res.ok ? { ok: true, errors: [], warnings: res.warnings, hash: res.config.hash } : { ok: false, errors: res.errors, warnings: res.warnings };
  });
  app.post('/api/v1/config/reload', async (req, reply) => {
    parse(emptyBody, req.body, 'body');
    const res = await deps.reloadConfig();
    if (!res.ok) {
      return reply.status(422).send({
        error: { code: 'config_invalid', message: `Configuration is invalid (${res.errors.length} error(s)); the active configuration was kept`, details: { errors: res.errors, warnings: res.warnings } },
      });
    }
    return {
      ok: true,
      version: res.config.version,
      hash: res.config.hash,
      changed: res.changed,
      diff: res.diff,
      resetOverrides: res.resetOverrides,
      warnings: res.warnings,
    };
  });

  // --- Notifications --------------------------------------------------------
  app.get('/api/v1/notifications', async (req) => {
    const q = parse(
      z
        .object({
          state: z.enum(['pending', 'delivered', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .strict(),
      req.query,
      'query',
    );
    return {
      notifications: deps.notifications.list({ ...(q.state ? { state: q.state } : {}), limit: q.limit ?? 100, offset: q.offset ?? 0 }),
      counts: repos.notifications.countByState(),
    };
  });
  app.post('/api/v1/notifications/:id/retry', async (req, reply) => {
    const { id } = parse(numericIdParam, req.params, 'path');
    parse(emptyBody, req.body, 'body');
    const res = deps.notifications.retry(id);
    if (!res) throw new ApiError(404, 'not_found', `Notification ${id} not found`);
    return accepted(reply, res);
  });

  // --- SSE --------------------------------------------------------------------
  app.get('/api/v1/events', async (req, reply) => {
    const q = parse(sseQuery, req.query, 'query');
    const header = req.headers['last-event-id'];
    const fromHeader = typeof header === 'string' && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
    const lastEventId = fromHeader ?? q.lastEventId ?? null;
    if (q.run) requireRun(q.run);
    reply.hijack();
    deps.events.handle(req.raw, reply.raw, { runId: q.run ?? null, lastEventId });
  });

  // --- Static web UI (WI-11) --------------------------------------------------
  if (deps.uiDir && existsSync(deps.uiDir)) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: path.resolve(deps.uiDir), prefix: '/', index: ['index.html'] });
  }

  return app;
}

/** YAML files of the config dir (read-only display); literal secrets known to the redactor are masked. */
async function readConfigFiles(configDir: string, redact: Redactor): Promise<Array<{ file: string; content: string | null; error?: string }>> {
  const { readdir } = await import('node:fs/promises');
  const files: string[] = [];
  for (const top of ['config.yaml', 'sources.yaml', 'identities.yaml']) if (existsSync(path.join(configDir, top))) files.push(top);
  for (const sub of ['workflows', 'views']) {
    try {
      const names = (await readdir(path.join(configDir, sub))).filter((n) => /\.ya?ml$/.test(n)).sort();
      for (const n of names) files.push(`${sub}/${n}`);
    } catch {
      // directory missing
    }
  }
  return Promise.all(
    files.map(async (file) => {
      try {
        const st = await stat(path.join(configDir, file));
        if (st.size > 1024 * 1024) return { file, content: null, error: 'file too large' };
        return { file, content: redact(await readFile(path.join(configDir, file), 'utf8')) };
      } catch (err) {
        return { file, content: null, error: errorMessage(err) };
      }
    }),
  );
}
