/**
 * Artifact routes (WI-35): list, detail with file tree, file and `.zip`
 * download, start of a workflow on an artifact, delete. Roles: see roles.ts.
 *
 * Downloads follow the kept files of runs (WI-22): safe path resolution in
 * the artifact service, always `Content-Disposition: attachment`, a sandbox
 * CSP and a content type by extension (anything a browser could execute is
 * served as `application/octet-stream`).
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ARTIFACT_SOURCE_TYPE, artifactRoute, errorMessage, noopLogger, type ArtifactRecord, type Logger, type Redactor } from '../core/index.js';
import { triggerSourceIds, type ConfigManager } from '../config/index.js';
import { artifactPathSegments, type ArtifactService } from '../artifacts/index.js';
import type { Repositories } from '../persistence/index.js';
import type { Scheduler } from '../scheduler/index.js';
import { ApiError } from './errors.js';
import { attachmentDisposition, keptContentType } from './kept.js';
import { toRunSummary } from './serialize.js';

/** Max. artifacts per page. */
const MAX_PAGE = 200;

/** Everything the artifact routes need. */
export interface ArtifactRouteDeps {
  config: ConfigManager;
  repositories: Repositories;
  scheduler: Scheduler;
  artifacts: ArtifactService | undefined;
  redact: Redactor;
  logger?: Logger;
  /** Audit (WI-26): record the user on the run's events. */
  auditRun: (req: FastifyRequest, runId: string, action: string, extra?: Record<string, unknown>) => void;
}

/** Artifact in lists and details. */
export interface ArtifactView {
  id: string;
  name: string;
  type: string;
  kind: ArtifactRecord['kind'];
  fileName: string;
  size: number;
  fileCount: number;
  workflow: string;
  runId: string;
  parent: string | null;
  consumedBy: string[];
  attemptedBy: string[];
  createdAt: string;
  /** UI route. */
  url: string;
}

/** The API shape of an artifact. */
export function toArtifactView(a: ArtifactRecord): ArtifactView {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    kind: a.kind,
    fileName: a.fileName,
    size: a.size,
    fileCount: a.fileCount,
    workflow: a.workflowId,
    runId: a.runId,
    parent: a.parentId,
    consumedBy: [...a.consumedBy],
    attemptedBy: [...a.attemptedBy],
    createdAt: a.createdAt,
    url: artifactRoute(a.id),
  };
}

const idParam = z.object({ id: z.string().min(1).max(200) });
const listQuery = z
  .object({
    type: z.string().min(1).max(200).optional(),
    workflow: z.string().min(1).max(200).optional(),
    kind: z.enum(['file', 'folder']).optional(),
    run: z.string().min(1).max(200).optional(),
    parent: z.string().min(1).max(200).optional(),
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
const startBody = z.object({ workflow: z.string().min(1).max(200), parameters: z.record(z.string(), z.unknown()).optional() }).strict();

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(400, 'invalid_request', `Invalid ${what}`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/** Register `/api/v1/artifacts…`. */
export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDeps): void {
  const logger = (deps.logger ?? noopLogger).child({ component: 'artifacts-api' });
  const repos = deps.repositories;

  const service = (): ArtifactService => {
    if (!deps.artifacts) throw new ApiError(503, 'not_ready', 'Artifacts are not available');
    return deps.artifacts;
  };
  const require = (id: string): ArtifactRecord => service().require(id);

  /** ID of the (single) configured artifacts source, if any. */
  const artifactSourceId = (): string | null =>
    Object.values(deps.config.current.sources).find((s) => s.type === ARTIFACT_SOURCE_TYPE)?.id ?? null;

  /** Workflows that can process an artifact (trigger: the artifacts source). */
  const startable = (): Array<{ id: string; name: string | null; enabled: boolean }> => {
    const sourceId = artifactSourceId();
    if (sourceId === null) return [];
    return deps.config
      .listWorkflows()
      .filter((wf) => wf.config.trigger.type === 'source' && triggerSourceIds(wf.config.trigger).includes(sourceId))
      .map((wf) => ({ id: wf.config.id, name: wf.config.name ?? null, enabled: wf.enabled }));
  };

  app.get('/api/v1/artifacts', async (req) => {
    const q = parse(listQuery, req.query, 'query');
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const page = service().query({
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.workflow !== undefined ? { workflowId: q.workflow } : {}),
      ...(q.kind !== undefined ? { kind: q.kind } : {}),
      ...(q.run !== undefined ? { runId: q.run } : {}),
      ...(q.parent !== undefined ? { parentId: q.parent } : {}),
      ...(q.q !== undefined ? { q: q.q } : {}),
      limit,
      offset,
    });
    return {
      artifacts: page.artifacts.map(toArtifactView),
      total: page.total,
      limit,
      offset,
      facets: repos.artifacts.facets(),
      sourceId: artifactSourceId(),
    };
  });

  app.get('/api/v1/artifacts/:id', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const record = require(id);
    const files = await service().listFiles(record);
    const sourceId = artifactSourceId();
    const producer = repos.runs.get(record.runId);
    const parent = record.parentId ? service().get(record.parentId) : null;
    const runs = sourceId ? repos.runs.list({ sourceItemKey: `${sourceId}:${record.id}`, limit: 50 }).runs : [];
    return {
      artifact: toArtifactView(record),
      files: files.files,
      filesTruncated: files.truncated,
      producer: { runId: record.runId, workflow: record.workflowId, run: producer ? toRunSummary(producer) : null },
      parent: record.parentId ? { id: record.parentId, exists: parent !== null, name: parent?.name ?? null } : null,
      children: repos.artifacts.children(record.id).map(toArtifactView),
      /** Runs that processed (or are processing) the artifact as their item, newest first. */
      runs: runs.map(toRunSummary),
      /** Workflows that can be started on this artifact. */
      workflows: startable(),
      itemKey: sourceId ? `${sourceId}:${record.id}` : null,
      sourceId,
    };
  });

  const sendFile = async (reply: FastifyReply, file: { handle: import('node:fs/promises').FileHandle; size: number; name: string }): Promise<unknown> => {
    void reply
      .header('content-type', keptContentType(file.name))
      .header('content-disposition', attachmentDisposition(file.name))
      .header('content-length', String(file.size))
      .header('content-security-policy', "default-src 'none'; sandbox");
    if (file.size === 0) {
      await file.handle.close();
      return reply.send('');
    }
    // Exactly the size seen at open time; the stream closes the handle.
    return reply.send(createReadStream('', { fd: file.handle, start: 0, end: file.size - 1 }));
  };

  app.get('/api/v1/artifacts/:id/files/*', async (req, reply) => {
    const params = req.params as { id?: unknown; '*'?: unknown };
    const { id } = parse(idParam, { id: params.id }, 'path');
    const record = require(id);
    const segments = artifactPathSegments(typeof params['*'] === 'string' ? params['*'] : '');
    return sendFile(reply, await service().openFile(record, segments));
  });

  app.get('/api/v1/artifacts/:id/download', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const record = require(id);
    if (record.kind === 'file') return sendFile(reply, await service().openFile(record, [record.fileName]));
    const zip = await service().openZip(record);
    void reply
      .header('content-type', 'application/zip')
      .header('content-disposition', attachmentDisposition(zip.fileName))
      .header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(Readable.from(zip.stream));
  });

  app.post('/api/v1/artifacts/:id/start', async (req, reply) => {
    const { id } = parse(idParam, req.params, 'path');
    const body = parse(startBody, req.body, 'body');
    const record = require(id);
    const wf = deps.config.getWorkflow(body.workflow);
    if (!wf) throw new ApiError(404, 'config_unknown_workflow', `Unknown workflow "${body.workflow}"`);
    const sourceId = artifactSourceId();
    if (wf.config.trigger.type !== 'source' || sourceId === null || !triggerSourceIds(wf.config.trigger).includes(sourceId)) {
      throw new ApiError(400, 'workflow_not_applicable', `Workflow "${body.workflow}" is not triggered by the artifacts source and cannot process an artifact`);
    }
    const result = await deps.scheduler.startManual(body.workflow, {
      itemRef: `${sourceId}:${record.id}`,
      ...(body.parameters !== undefined ? { parameters: body.parameters } : {}),
    });
    result.done.catch((err: unknown) => logger.warn('manual run supervision failed', { runId: result.run.id, error: errorMessage(err) }));
    deps.auditRun(req, result.run.id, 'start', { artifact: record.id });
    return reply.status(202).send({ run: toRunSummary(repos.runs.get(result.run.id) ?? result.run) });
  });

  app.delete('/api/v1/artifacts/:id', async (req) => {
    const { id } = parse(idParam, req.params, 'path');
    const record = await service().delete(id);
    const actor = req.principal && req.principal.via !== 'anonymous' ? req.principal.name : null;
    logger.info('artifact deleted', { artifact: record.id, workflow: record.workflowId, run: record.runId, ...(actor ? { actor } : {}) });
    return { deleted: true, artifact: toArtifactView(record) };
  });
}
