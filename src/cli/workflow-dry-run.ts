/**
 * `workflow dry-run <id>` (Spec §19). Never reserves, never starts workers,
 * never runs lifecycle actions or shell filters/conditions.
 *
 * - **Running instance (default):** `POST /api/v1/workflows/<id>/dry-run`
 *   against `--url` or the URL from `config.yaml` (includes the live gate:
 *   pause/drain/readiness).
 * - **Local fallback** (no instance reachable and `--config-dir` given, or
 *   `--local`): loads the configuration, queries the source with the
 *   configured GitHub App identity and reads locks/blocks/active runs
 *   read-only from the data directory's database (if present). An explicit
 *   `--url` never falls back.
 *
 * Exit codes: 0 = dry-run done, 1 = invalid configuration / unknown workflow
 * / source error / API error, 2 = usage error, 3 = `--url` not reachable.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPaths, errorMessage, systemClock, type Clock, type FetchLike } from '../core/index.js';
import { ConfigLoadError, ConfigManager, formatConfigIssue } from '../config/index.js';
import { MIGRATIONS, createRepositories, schemaVersion } from '../persistence/index.js';
import { dryRunWorkflow, emptyState, formatDryRun, repositoryState, type DryRunResult, type SchedulingState } from '../scheduler/index.js';
import { SourceRegistry } from '../app.js';
import { ApiClient, ApiResponseError, ApiUnreachableError, EXIT_UNREACHABLE, resolveBaseUrl } from './http-client.js';
import type { CliIo, DryRunCliOptions } from './program.js';

/** Injectable dependencies (tests: Fake-GitHub `fetch`, key env). */
export interface WorkflowDryRunDeps {
  /** HTTP client for GitHub (local variant). */
  fetch?: FetchLike;
  /** HTTP client for the orchestrator API (default global `fetch`). */
  apiFetch?: FetchLike;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
}

/** Read-only scheduling state from `<dataDir>/orchestrator.sqlite`, if usable. */
function openState(dataDir: string | undefined, notes: string[]): { state: SchedulingState; close: () => void } {
  const none = { state: emptyState(), close: () => undefined };
  if (!dataDir) {
    notes.push('no --data-dir given: active runs, locks, blocks and cron history are not considered');
    return none;
  }
  const file = dataPaths(path.resolve(dataDir)).database;
  if (!existsSync(file)) {
    notes.push(`no database at ${file}: active runs, locks, blocks and cron history are not considered`);
    return none;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const expected = Math.max(...MIGRATIONS.map((m) => m.version));
    const actual = schemaVersion(db);
    if (actual !== expected) {
      notes.push(`database schema version ${actual} differs from ${expected}: database not used`);
      db.close();
      return none;
    }
    const repos = createRepositories(db);
    const opened = db;
    return { state: repositoryState(repos), close: () => opened.close() };
  } catch (err) {
    db?.close();
    notes.push(`database ${file} not readable (${errorMessage(err)}): active runs, locks and blocks are not considered`);
    return none;
  }
}

/** Create the `workflow dry-run` handler. */
export function createWorkflowDryRunHandler(io: Pick<CliIo, 'stdout' | 'stderr'>, deps: WorkflowDryRunDeps = {}) {
  return async (workflowId: string, opts: DryRunCliOptions): Promise<number> => {
    const fallbackNotes: string[] = [];
    if (!opts.local) {
      const remote = await dryRunRemote(workflowId, opts, io, deps);
      if (remote.done) return remote.code;
      if (!opts.configDir) {
        io.stderr(`workflow dry-run: no running instance at ${remote.url} and no --config-dir for a local dry-run\n`);
        return 2;
      }
      fallbackNotes.push(`no running instance at ${remote.url}: evaluated locally (pause/drain/readiness of an instance not considered)`);
    }
    if (!opts.configDir) {
      io.stderr('workflow dry-run: --config-dir is required for a local dry-run\n');
      return 2;
    }
    const clock = deps.clock ?? systemClock;
    const configDir = path.resolve(opts.configDir);
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    let config: ConfigManager;
    try {
      config = await ConfigManager.create({ configDir, dataDir, clock });
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        io.stderr(`Configuration in ${configDir} is invalid:\n${err.errors.map((i) => `  ${formatConfigIssue(i)}\n`).join('')}`);
        return 1;
      }
      throw err;
    }
    if (!config.getWorkflow(workflowId)) {
      io.stderr(`workflow dry-run: unknown workflow '${workflowId}'\n`);
      return 1;
    }
    const notes: string[] = [...fallbackNotes];
    const { state, close } = openState(opts.dataDir, notes);
    try {
      const sources = new SourceRegistry(config.current, {
        clock,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      });
      const result = await dryRunWorkflow({ config, sources: (id) => sources.get(id), state, clock, notes }, workflowId);
      io.stdout(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatDryRun(result));
      return result.source?.error ? 1 : 0;
    } finally {
      close();
    }
  };
}

/** Try the running instance; `done: false` = not reachable (fall back to local). */
async function dryRunRemote(
  workflowId: string,
  opts: DryRunCliOptions,
  io: Pick<CliIo, 'stdout' | 'stderr'>,
  deps: WorkflowDryRunDeps,
): Promise<{ done: true; code: number } | { done: false; url: string }> {
  let url: string;
  try {
    url = (await resolveBaseUrl(opts)).url;
  } catch (err) {
    io.stderr(`workflow dry-run: ${errorMessage(err)}\n`);
    return { done: true, code: 2 };
  }
  const api = new ApiClient(url, deps.apiFetch ? { fetch: deps.apiFetch } : {});
  try {
    const { body } = await api.post<DryRunResult>(`/api/v1/workflows/${encodeURIComponent(workflowId)}/dry-run`);
    io.stdout(opts.json ? `${JSON.stringify(body, null, 2)}\n` : formatDryRun(body));
    return { done: true, code: body.source?.error ? 1 : 0 };
  } catch (err) {
    if (err instanceof ApiUnreachableError) {
      if (opts.url) {
        io.stderr(`workflow dry-run: ${err.message}\n`);
        return { done: true, code: EXIT_UNREACHABLE };
      }
      return { done: false, url };
    }
    if (err instanceof ApiResponseError && err.code === 'config_unknown_workflow') {
      io.stderr(`workflow dry-run: unknown workflow '${workflowId}' (instance at ${url})\n`);
      return { done: true, code: 1 };
    }
    io.stderr(`workflow dry-run: ${errorMessage(err)}${err instanceof ApiResponseError ? ` (HTTP ${err.status}, ${err.code})` : ''}\n`);
    return { done: true, code: 1 };
  }
}
