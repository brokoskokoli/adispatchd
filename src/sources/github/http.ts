/**
 * Minimal GitHub REST client on top of an injectable `fetch` (no Octokit).
 *
 * - Pins the REST API version ({@link GITHUB_API_VERSION}) and the
 *   `application/vnd.github+json` media type.
 * - Maps HTTP failures to {@link SourceError} kinds (auth, forbidden,
 *   not_found, rate_limited, transient, invalid). Messages never contain the
 *   token or request headers (Spec §20.4).
 * - Retries idempotent requests on transient errors and rate limits using the
 *   injected {@link Timers}; mutating requests are never retried blindly and are
 *   flagged `outcomeUnknown` when the request may have taken effect.
 * - Follows `Link: <…>; rel="next"` pagination, but only within the API origin
 *   so the token is never sent to a foreign host.
 * - Runs read-only GraphQL queries ({@link GitHubHttpClient.graphql}) with the
 *   same retry/rate-limit handling; GraphQL reports some rate limits as HTTP
 *   200 with `errors[].type == "RATE_LIMITED"`, which is mapped to `rate_limited`.
 */
import {
  SourceError,
  noopLogger,
  sleep,
  systemTimers,
  type Clock,
  type FetchLike,
  type Logger,
  type Timers,
} from '../../core/index.js';

/** Pinned GitHub REST API version (sent as `X-GitHub-Api-Version`). */
export const GITHUB_API_VERSION = '2026-03-10';

/** Default REST API base URL. */
export const GITHUB_API_BASE_URL = 'https://api.github.com';

/** Media type requested from the API. */
export const GITHUB_ACCEPT = 'application/vnd.github+json';

/** HTTP methods used by the orchestrator. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Options of {@link GitHubHttpClient}. */
export interface GitHubHttpClientOptions {
  /** HTTP implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
  clock: Clock;
  /** Timers used for retry delays (inject a `FakeClock` in tests). */
  timers?: Timers;
  logger?: Logger;
  /** API base URL, default {@link GITHUB_API_BASE_URL} (GHES: `https://host/api/v3`). */
  baseUrl?: string;
  /** Retries for idempotent requests (transient errors / rate limits). Default 2. */
  maxRetries?: number;
  /** Longest wait the client sleeps for a rate limit before giving up and throwing. Default 60 s. */
  maxRetryWaitMs?: number;
  /** Base delay for transient retries (exponential). Default 1 s. */
  retryBaseDelayMs?: number;
  /** Per-request timeout. Default 30 s. `0` disables it. */
  requestTimeoutMs?: number;
  /** Max pages followed by {@link GitHubHttpClient.paginate}. Default 50. */
  maxPages?: number;
  userAgent?: string;
}

/** Per-request options. */
export interface GitHubRequestOptions {
  /** Bearer token (installation token or app JWT). Never logged. */
  token?: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. */
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Whether the request may be repeated safely. Default: true for GET,
   * false otherwise. Rate-limit responses are retried regardless because
   * the request was rejected before taking effect.
   */
  idempotent?: boolean;
  /**
   * Never repeat this request automatically, not even after a rate-limit
   * response (WI-27: comments written in the web UI are sent exactly once).
   */
  noRetry?: boolean;
  /**
   * Inspect a successful (2xx) parsed body inside the retry loop: a returned
   * error is thrown as if the request had failed (e.g. GraphQL rate limits
   * reported with HTTP 200), so retries and rate-limit waits apply.
   */
  checkBody?: (data: unknown, headers: Headers) => SourceError | undefined;
  /**
   * Longest retry wait for THIS request (overrides the client's
   * `maxRetryWaitMs`); a longer wait throws immediately. Used e.g. by
   * project reads so a rate limit never stalls the planning step.
   */
  maxRetryWaitMs?: number;
}

/** One entry of a GraphQL `errors` array (only the fields the orchestrator uses). */
export interface GraphQLErrorJson {
  type?: string;
  message?: string;
  path?: ReadonlyArray<string | number>;
}

/** GraphQL response envelope. `data` may be partial when `errors` is present. */
export interface GraphQLResponse<T> {
  data: T | null;
  errors: GraphQLErrorJson[];
}

/**
 * GraphQL endpoint for a REST base URL: `https://api.github.com` →
 * `https://api.github.com/graphql`; GitHub Enterprise Server
 * `https://host/api/v3` → `https://host/api/graphql`.
 */
export function graphqlUrlFor(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/api\/v3$/.test(base) ? `${base.slice(0, -'/v3'.length)}/graphql` : `${base}/graphql`;
}

/** Successful response. */
export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** Default per-page size used for list endpoints. */
export const DEFAULT_PER_PAGE = 100;

/** GitHub REST client. One instance can be shared by adapters and credential providers. */
export class GitHubHttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxPages: number;
  private readonly userAgent: string;
  private readonly origin: string;

  constructor(options: GitHubHttpClientOptions) {
    this.baseUrl = (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, '');
    this.origin = new URL(this.baseUrl).origin;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock;
    this.timers = options.timers ?? systemTimers;
    this.logger = options.logger ?? noopLogger;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 60_000;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxPages = options.maxPages ?? 50;
    this.userAgent = options.userAgent ?? 'adispatchd';
  }

  /** Perform one request (with retries for idempotent calls) and parse the JSON body. */
  async request<T = unknown>(method: HttpMethod, path: string, options: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = this.buildUrl(path, options.query);
    return this.requestUrl<T>(method, url, options);
  }

  /**
   * Run a read-only GraphQL query (`POST {graphql endpoint}` with
   * `{ query, variables }`). Treated as idempotent: retried on transient
   * errors and rate limits. Never interpolate user data into `query`; pass it
   * as `variables`. Returns `data` (possibly partial) plus `errors`; throws
   * `rate_limited` for GraphQL `RATE_LIMITED` errors and `invalid` when the
   * body is not a GraphQL response.
   */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown>,
    options: Pick<GitHubRequestOptions, 'token' | 'signal' | 'maxRetryWaitMs'> = {},
  ): Promise<GraphQLResponse<T>> {
    const url = new URL(graphqlUrlFor(this.baseUrl));
    const label = `POST ${describePath(url)}`;
    const res = await this.requestUrl<{ data?: unknown; errors?: unknown }>('POST', url, {
      ...options,
      body: { query, variables },
      idempotent: true,
      checkBody: (data, headers) => {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          return new SourceError('invalid', `${label} returned no GraphQL response`, { retryable: false });
        }
        const errors = graphqlErrors((data as { errors?: unknown }).errors);
        if (errors.some((e) => e.type === 'RATE_LIMITED')) {
          return new SourceError('rate_limited', `${label} failed: GraphQL rate limit exceeded`, {
            retryAfterMs: this.retryAfter(headers) ?? 60_000,
            details: { path: describePath(url) },
          });
        }
        return undefined;
      },
    });
    const body = res.data;
    return {
      data: (body.data ?? null) as T | null,
      errors: graphqlErrors(body.errors),
    };
  }

  /**
   * GET all pages of a list endpoint by following `Link: rel="next"`.
   * `per_page` defaults to {@link DEFAULT_PER_PAGE}.
   */
  async paginate<T = unknown>(path: string, options: Omit<GitHubRequestOptions, 'body' | 'idempotent'> = {}): Promise<T[]> {
    const items: T[] = [];
    let url: URL | null = this.buildUrl(path, { per_page: DEFAULT_PER_PAGE, ...options.query });
    let pages = 0;
    while (url) {
      if (pages >= this.maxPages) {
        throw new SourceError('invalid', `Pagination limit of ${this.maxPages} pages exceeded for GET ${describePath(url)}`, {
          retryable: false,
        });
      }
      const res: GitHubResponse<T[]> = await this.requestUrl<T[]>('GET', url, options);
      pages += 1;
      if (!Array.isArray(res.data)) {
        throw new SourceError('invalid', `Expected a JSON array from GET ${describePath(url)}`, { status: res.status });
      }
      items.push(...res.data);
      url = this.nextPageUrl(res.headers.get('link'));
    }
    return items;
  }

  private buildUrl(path: string, query?: GitHubRequestOptions['query']): URL {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private nextPageUrl(link: string | null): URL | null {
    const next = parseLinkHeader(link).next;
    if (!next) return null;
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      return null;
    }
    if (url.origin !== this.origin) {
      // Never forward the token to another host.
      this.logger.warn('Ignoring pagination link to foreign origin', { origin: url.origin });
      return null;
    }
    return url;
  }

  private async requestUrl<T>(method: HttpMethod, url: URL, options: GitHubRequestOptions): Promise<GitHubResponse<T>> {
    const idempotent = options.idempotent ?? method === 'GET';
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, url, options, idempotent);
      } catch (err) {
        if (!(err instanceof SourceError) || options.signal?.aborted) throw err;
        const retryAllowed = err.kind === 'rate_limited' || (idempotent && err.kind === 'transient');
        if (!retryAllowed || options.noRetry === true || attempt >= this.maxRetries) throw err;
        const delay =
          err.kind === 'rate_limited'
            ? (err.retryAfterMs ?? this.retryBaseDelayMs)
            : (err.retryAfterMs ?? this.retryBaseDelayMs * 2 ** attempt);
        if (delay > (options.maxRetryWaitMs ?? this.maxRetryWaitMs)) throw err;
        this.logger.warn('GitHub request failed, retrying', {
          method,
          path: describePath(url),
          kind: err.kind,
          status: err.status,
          attempt: attempt + 1,
          delayMs: delay,
        });
        await sleep(this.timers, delay, options.signal);
      }
    }
  }

  private async once<T>(method: HttpMethod, url: URL, options: GitHubRequestOptions, idempotent: boolean): Promise<GitHubResponse<T>> {
    const headers: Record<string, string> = {
      Accept: GITHUB_ACCEPT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': this.userAgent,
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    if (this.requestTimeoutMs > 0) signals.push(AbortSignal.timeout(this.requestTimeoutMs));
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    const label = `${method} ${describePath(url)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) });
    } catch (err) {
      if (options.signal?.aborted) throw options.signal.reason ?? err;
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // Never include the raw error: some fetch implementations echo request details.
      throw new SourceError('transient', `${label} failed: ${timedOut ? 'request timed out' : 'network error'}`, {
        outcomeUnknown: !idempotent,
        details: { method, path: describePath(url) },
      });
    }

    const text = await safeText(res);
    if (res.ok) {
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          // For a mutating request the change may have been applied although the body is unusable.
          throw idempotent
            ? new SourceError('invalid', `${label} returned invalid JSON`, { status: res.status, retryable: false })
            : new SourceError('transient', `${label} returned invalid JSON; outcome unknown`, {
                status: res.status,
                outcomeUnknown: true,
              });
        }
      }
      const bodyError = options.checkBody?.(data, res.headers);
      if (bodyError) throw bodyError;
      return { status: res.status, data: data as T, headers: res.headers };
    }
    throw this.toError(res, text, label, idempotent);
  }

  private toError(res: Response, text: string, label: string, idempotent: boolean): SourceError {
    const status = res.status;
    const apiMessage = extractMessage(text);
    const message = `${label} failed with HTTP ${status}${apiMessage ? `: ${apiMessage}` : ''}`;
    const details = { status, path: label.slice(label.indexOf(' ') + 1) };
    const retryAfterMs = this.retryAfter(res.headers);
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (res.headers.get('x-ratelimit-remaining') === '0' ||
          res.headers.has('retry-after') ||
          /rate limit/i.test(apiMessage ?? '')));
    if (rateLimited) {
      return new SourceError('rate_limited', message, {
        status,
        details,
        retryAfterMs: retryAfterMs ?? 60_000,
      });
    }
    if (status === 401) return new SourceError('auth', message, { status, details });
    if (status === 403) return new SourceError('forbidden', message, { status, details });
    if (status === 404 || status === 410) return new SourceError('not_found', message, { status, details });
    if (status >= 500) {
      return new SourceError('transient', message, {
        status,
        details,
        outcomeUnknown: !idempotent,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    return new SourceError('invalid', message, { status, details });
  }

  /** Wait time from `Retry-After` (seconds) or `X-RateLimit-Reset` (epoch seconds). */
  private retryAfter(headers: Headers): number | undefined {
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    }
    const reset = headers.get('x-ratelimit-reset');
    if (reset !== null && headers.get('x-ratelimit-remaining') === '0') {
      const resetMs = Number(reset) * 1000;
      if (Number.isFinite(resetMs)) return Math.max(0, resetMs - this.clock.now().getTime()) + 1_000;
    }
    return undefined;
  }
}

/** Parse an RFC 8288 `Link` header into `{ rel: url }`. */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const match = /<([^>]*)>\s*;(.*)/.exec(part.trim());
    if (!match) continue;
    const [, url, params] = match;
    const rel = /rel="?([^";]+)"?/.exec(params ?? '');
    if (url !== undefined && rel?.[1]) {
      for (const name of rel[1].trim().split(/\s+/)) out[name] = url;
    }
  }
  return out;
}

/** Path (without query string) for messages; query strings could contain user data only, but stay short. */
function describePath(url: URL): string {
  return url.pathname;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function extractMessage(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === 'string') return truncate(parsed.message, 200);
  } catch {
    // non-JSON error body: do not echo arbitrary content
  }
  return undefined;
}

/** Normalise a GraphQL `errors` value; messages are truncated (they may echo query details). */
function graphqlErrors(value: unknown): GraphQLErrorJson[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
    .map((e) => ({
      ...(typeof e.type === 'string' ? { type: e.type } : {}),
      ...(typeof e.message === 'string' ? { message: truncate(e.message, 200) } : {}),
      ...(Array.isArray(e.path) ? { path: e.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number') } : {}),
    }));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
