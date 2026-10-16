/**
 * Control commands against a running instance over HTTP (Spec §14, §19):
 * `status`, `pause`, `resume`, `drain`, `cancel-all`, `config reload`.
 *
 * Exit codes: 0 = ok, 1 = API error (e.g. reload rejected), 2 = usage error,
 * 3 = instance not reachable, 4 = `--wait` timed out.
 */
import { errorMessage, parseDuration, type FetchLike } from '../core/index.js';
import { formatConfigIssue, type ConfigIssue } from '../config/index.js';
import { ApiClient, ApiResponseError, ApiUnreachableError, EXIT_UNREACHABLE, resolveBaseUrl } from './http-client.js';
import type { CliIo, ControlCliOptions, ShutdownCliOptions } from './program.js';

/** Exit code when `--wait` timed out. */
export const EXIT_WAIT_TIMEOUT = 4;

/** Injectable dependencies (tests). */
export interface ControlDeps {
  fetch?: FetchLike;
  /** Poll interval for `--wait` (default 500 ms). */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Io = Pick<CliIo, 'stdout' | 'stderr'>;

async function client(opts: ControlCliOptions, io: Io, deps: ControlDeps): Promise<ApiClient | number> {
  try {
    const { url, note } = await resolveBaseUrl(opts);
    if (note) io.stderr(`note: ${note}\n`);
    return new ApiClient(url, deps.fetch ? { fetch: deps.fetch } : {});
  } catch (err) {
    io.stderr(`${errorMessage(err)}\n`);
    return 2;
  }
}

function reportError(name: string, err: unknown, io: Io): number {
  if (err instanceof ApiUnreachableError) {
    io.stderr(`${name}: ${err.message}\n`);
    return EXIT_UNREACHABLE;
  }
  if (err instanceof ApiResponseError) {
    io.stderr(`${name}: ${err.message} (HTTP ${err.status}, ${err.code})\n`);
    return 1;
  }
  io.stderr(`${name}: ${errorMessage(err)}\n`);
  return 1;
}

/** Text summary of `GET /api/v1/status`. */
export function formatStatus(s: any): string {
  const lines: string[] = [];
  const sched = s?.scheduler ?? {};
  const usage = s?.usage ?? {};
  const limits = s?.limits ?? {};
  lines.push(`agent-orchestrator ${s?.version ?? '?'} – started ${s?.startedAt ?? '?'}`);
  lines.push(`ready:      ${s?.readiness?.ready ? 'yes' : 'no'}`);
  lines.push(`scheduler:  ${sched.state ?? '?'}${sched.pollingIntervalMs ? ` (polling every ${Math.round(sched.pollingIntervalMs / 1000)}s)` : ''}`);
  lines.push(
    `runs:       ${usage.activeRuns ?? 0} active / limit ${limits.maxConcurrent ?? '?'}` +
      (limits.override !== null && limits.override !== undefined ? ` (override, configured ${limits.configuredMaxConcurrent})` : '') +
      (usage.recoveryPending ? `, ${usage.recoveryPending} recovery pending` : ''),
  );
  const byWf = Object.entries((usage.byWorkflow ?? {}) as Record<string, { active: number; max: number }>).filter(([, v]) => v.active > 0);
  for (const [id, v] of byWf) lines.push(`  ${id}: ${v.active}/${v.max}`);
  const counts = s?.counts ?? {};
  const n = counts.notifications ?? {};
  lines.push(
    `blocks:     ${counts.activeBlocks ?? 0} active · failed actions: ${counts.failedActions ?? 0} · notifications failed: ${n.failed ?? 0}, pending: ${n.pending ?? 0}`,
  );
  if (s?.config) lines.push(`config:     version ${s.config.version}, hash ${String(s.config.hash ?? '').slice(0, 12)}, ${s.config.configDir}`);
  if (s?.server) lines.push(`server:     ${s.server.host}:${s.server.port}${s.server.loopback ? '' : ' (NOT loopback – must be behind an authenticating proxy)'}`);
  return `${lines.join('\n')}\n`;
}

/** `status`. */
export function createStatusHandler(io: Io, deps: ControlDeps = {}) {
  return async (opts: ControlCliOptions): Promise<number> => {
    const api = await client(opts, io, deps);
    if (typeof api === 'number') return api;
    try {
      const { body } = await api.get('/api/v1/status');
      io.stdout(opts.json ? `${JSON.stringify(body, null, 2)}\n` : formatStatus(body));
      return 0;
    } catch (err) {
      return reportError('status', err, io);
    }
  };
}

/** `pause` / `resume`. */
export function createSchedulerHandler(action: 'pause' | 'resume', io: Io, deps: ControlDeps = {}) {
  return async (opts: ControlCliOptions): Promise<number> => {
    const api = await client(opts, io, deps);
    if (typeof api === 'number') return api;
    try {
      const { body } = await api.post(`/api/v1/scheduler/${action}`);
      io.stdout(
        opts.json
          ? `${JSON.stringify(body, null, 2)}\n`
          : `${action === 'pause' ? 'automatic starts paused' : 'automatic starts resumed'} (scheduler: ${body?.scheduler?.state ?? '?'})\n`,
      );
      return 0;
    } catch (err) {
      return reportError(action, err, io);
    }
  };
}

/** Wait until `/health` is no longer reachable. */
async function waitForStop(api: ApiClient, opts: ShutdownCliOptions, io: Io, deps: ControlDeps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let deadline = Number.POSITIVE_INFINITY;
  if (opts.timeout) {
    try {
      deadline = now() + parseDuration(opts.timeout);
    } catch (err) {
      io.stderr(`invalid --timeout: ${errorMessage(err)}\n`);
      return 2;
    }
  }
  io.stdout('waiting for the instance to stop...\n');
  while (await api.reachable()) {
    if (now() >= deadline) {
      io.stderr(`instance still running after ${opts.timeout} (runs are still active; it keeps stopping in the background)\n`);
      return EXIT_WAIT_TIMEOUT;
    }
    await sleep(deps.pollIntervalMs ?? 500);
  }
  io.stdout('instance stopped\n');
  return 0;
}

/** `drain` / `cancel-all`. */
export function createShutdownHandler(mode: 'drain' | 'cancel-all', io: Io, deps: ControlDeps = {}) {
  return async (opts: ShutdownCliOptions): Promise<number> => {
    if (opts.timeout && !opts.wait) {
      io.stderr('--timeout requires --wait\n');
      return 2;
    }
    const api = await client(opts, io, deps);
    if (typeof api === 'number') return api;
    try {
      const { body } = await api.post(`/api/v1/shutdown/${mode}`, mode === 'cancel-all' && opts.reason ? { reason: opts.reason } : undefined);
      if (opts.json) io.stdout(`${JSON.stringify(body, null, 2)}\n`);
      else {
        const active: string[] = Array.isArray(body?.activeRuns) ? body.activeRuns : [];
        io.stdout(
          mode === 'drain'
            ? `drain started: no new runs; waiting for ${active.length} active run(s), then the instance stops\n`
            : `cancel-all started: cancelling ${active.length} active run(s) (on_cancel runs), then the instance stops\n`,
        );
        for (const id of active) io.stdout(`  ${id}\n`);
      }
    } catch (err) {
      return reportError(mode, err, io);
    }
    return opts.wait ? waitForStop(api, opts, io, deps) : 0;
  };
}

function issueList(issues: ConfigIssue[] | undefined): string {
  return (issues ?? []).map((i) => `  ${formatConfigIssue(i)}\n`).join('');
}

/** `config reload`. */
export function createConfigReloadHandler(io: Io, deps: ControlDeps = {}) {
  return async (opts: ControlCliOptions): Promise<number> => {
    const api = await client(opts, io, deps);
    if (typeof api === 'number') return api;
    try {
      const { body } = await api.post('/api/v1/config/reload');
      if (opts.json) {
        io.stdout(`${JSON.stringify(body, null, 2)}\n`);
        return 0;
      }
      if (Array.isArray(body?.warnings) && body.warnings.length > 0) {
        io.stderr(`${body.warnings.length} warning(s):\n${issueList(body.warnings)}`);
      }
      io.stdout(
        body?.changed
          ? `configuration reloaded: version ${body.version}, hash ${String(body.hash).slice(0, 12)}` +
              (Array.isArray(body.resetOverrides) && body.resetOverrides.length > 0 ? `, overrides reset: ${body.resetOverrides.join(', ')}` : '') +
              '\n'
          : `configuration unchanged (version ${body?.version}, hash ${String(body?.hash ?? '').slice(0, 12)})\n`,
      );
      return 0;
    } catch (err) {
      if (err instanceof ApiResponseError && err.code === 'config_invalid') {
        const details = (err.details ?? {}) as { errors?: ConfigIssue[] };
        if (opts.json) io.stdout(`${JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }, null, 2)}\n`);
        io.stderr(`config reload rejected – the active configuration was kept:\n${issueList(details.errors)}`);
        return 1;
      }
      return reportError('config reload', err, io);
    }
  };
}
