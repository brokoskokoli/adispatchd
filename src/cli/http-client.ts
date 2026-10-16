/**
 * Minimal HTTP client for the CLI control commands (`status`, `pause`,
 * `resume`, `drain`, `cancel-all`, `config reload`, `workflow dry-run`)
 * against a running instance (docs/api.md).
 *
 * - Base URL: `--url`, else `server.host`/`server.port` from `config.yaml` of
 *   `--config-dir`, else `http://127.0.0.1:8787`. Wildcard binds
 *   (`0.0.0.0`, `::`) are reached via loopback so the `Host` header is on the
 *   server's allowlist.
 * - Mutating requests carry the CSRF header `X-Orchestrator-Request: 1` and a
 *   JSON body (never form data); no `Origin` is sent.
 */
import path from 'node:path';
import { errorMessage, type FetchLike } from '../core/index.js';
import { loadConfig } from '../config/index.js';

/** Default base URL (Spec §5.1 defaults). */
export const DEFAULT_API_URL = 'http://127.0.0.1:8787';
/** CSRF header required by the API for mutating requests. */
export const CSRF_HEADER_NAME = 'x-orchestrator-request';

/** Exit code when no instance is reachable. */
export const EXIT_UNREACHABLE = 3;

/** The instance could not be reached (connection refused, DNS, timeout). */
export class ApiUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    cause: unknown,
  ) {
    super(`cannot reach the orchestrator at ${baseUrl} (${errorMessage(cause)}) – is it running? Use --url or --config-dir`);
    this.name = 'ApiUnreachableError';
  }
}

/** An API error response (`{error: {code, message, details}}`). */
export class ApiResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

/** Build a URL for a bind host/port, mapping wildcard binds to loopback. */
export function urlForBind(host: string, port: number): string {
  let h = host.replace(/^\[|\]$/g, '');
  if (h === '0.0.0.0' || h === '') h = '127.0.0.1';
  else if (h === '::' || h === '::0') h = '::1';
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/**
 * Resolve the base URL: explicit `--url` → `config.yaml` of `--config-dir`
 * (host/port are read even if other files are invalid is not guaranteed; on a
 * load error the default is used and a note returned) → default.
 */
export async function resolveBaseUrl(opts: { url?: string; configDir?: string; dataDir?: string }): Promise<{ url: string; note?: string }> {
  if (opts.url) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new Error(`invalid --url "${opts.url}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`invalid --url "${opts.url}" (http/https only)`);
    return { url: opts.url.replace(/\/+$/, '') };
  }
  if (opts.configDir) {
    const configDir = path.resolve(opts.configDir);
    const loaded = await loadConfig(configDir, { dataDir: path.resolve(opts.dataDir ?? 'data') });
    if (loaded.ok) {
      const { host, port } = loaded.config.global.server;
      return { url: urlForBind(host, port) };
    }
    return { url: DEFAULT_API_URL, note: `configuration in ${configDir} is invalid; using ${DEFAULT_API_URL}` };
  }
  return { url: DEFAULT_API_URL };
}

/** JSON response of the API. */
export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

/** Small API client. */
export class ApiClient {
  private readonly fetchFn: FetchLike;

  constructor(
    readonly baseUrl: string,
    options: { fetch?: FetchLike; timeoutMs?: number } = {},
  ) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private readonly timeoutMs: number;

  /** GET a JSON resource; non-2xx → {@link ApiResponseError}. */
  get<T = any>(p: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', p);
  }

  /** POST JSON (CSRF header set); non-2xx → {@link ApiResponseError}. */
  post<T = any>(p: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', p, body);
  }

  /** True if `/health` answers (any HTTP status), false if unreachable. */
  async reachable(): Promise<boolean> {
    try {
      await this.raw('GET', '/health');
      return true;
    } catch (err) {
      if (err instanceof ApiUnreachableError) return false;
      throw err;
    }
  }

  async request<T>(method: string, p: string, body?: unknown): Promise<ApiResponse<T>> {
    const res = await this.raw(method, p, body);
    const text = await res.text();
    let json: any = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiResponseError(res.status, 'invalid_response', `unexpected non-JSON response (HTTP ${res.status}) from ${this.baseUrl}${p}`, null);
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const e = json?.error;
      throw new ApiResponseError(
        res.status,
        typeof e?.code === 'string' ? e.code : `http_${res.status}`,
        typeof e?.message === 'string' ? e.message : `HTTP ${res.status}`,
        e?.details ?? null,
      );
    }
    return { status: res.status, body: json as T };
  }

  private async raw(method: string, p: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating) headers[CSRF_HEADER_NAME] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      return await this.fetchFn(`${this.baseUrl}${p}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      throw new ApiUnreachableError(this.baseUrl, (err as { cause?: unknown }).cause ?? err);
    }
  }
}
