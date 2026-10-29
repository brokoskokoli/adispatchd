/**
 * HTTP client for `/api/v1` (docs/api.md). Mutating requests always carry
 * the CSRF header `X-Adispatch-Request: 1` and a JSON body. A 401 (session
 * expired, WI-26) is announced with the window event `adispatch:unauthorized`.
 */
import { appPath } from '../shared/base-path.js';
import { UNAUTHORIZED_EVENT } from './auth.js';

/** Error returned by the API (`{error:{code,message,details}}`) or the network. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating) {
    headers['x-adispatch-request'] = '1';
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(appPath(path), {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(mutating ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', `Network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (res.status === 401 && !path.startsWith('/api/v1/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    const e = (json as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      typeof e?.code === 'string' ? e.code : `http_${res.status}`,
      typeof e?.message === 'string' ? e.message : `HTTP ${res.status}`,
      e?.details ?? null,
    );
  }
  return json as T;
}

/** Query string from an object (empty values omitted). */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
};

/** Encode one path segment. */
export const seg = (s: string | number): string => encodeURIComponent(String(s));
