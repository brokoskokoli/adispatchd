/**
 * Hash routing (`#/runs/<id>?tab=logs`): no server-side fallback route is
 * needed, the static server only serves `/index.html`.
 */

/** Parsed route. */
export interface Route {
  /** Decoded path segments, e.g. `['runs', 'run-1']`; `[]` = dashboard. */
  segments: string[];
  query: Record<string, string>;
}

/** Parse `location.hash`. Invalid percent-encoding yields the raw segment. */
export function parseHash(hash: string): Route {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h.startsWith('/')) h = h.slice(1);
  const q = h.indexOf('?');
  const pathPart = q >= 0 ? h.slice(0, q) : h;
  const queryPart = q >= 0 ? h.slice(q + 1) : '';
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const segments = pathPart.split('/').filter((s) => s.length > 0).map(decode);
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  return { segments, query };
}

/** Build a hash (`#/a/b?x=1`); empty/undefined query values are omitted. */
export function buildHash(segments: readonly string[], query: Record<string, string | number | boolean | null | undefined> = {}): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return `#/${path}${qs ? `?${qs}` : ''}`;
}
