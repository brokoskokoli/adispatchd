/**
 * External tools linked from the web UI toolbar (`ui.external_links`, WI-25):
 * semantic URL checks, the list of active links exposed to the UI and the
 * origins the UI's Content-Security-Policy allows in `frame-src`.
 */
import type { IssueCollector, IssuePath } from './issues.js';
import type { ExternalLinkConfig, GlobalConfig } from './model.js';

/** Link as delivered to the UI (`GET /api/v1/config` → `externalLinks`). */
export interface ExternalLinkInfo {
  id: string;
  label: string;
  url: string;
  embed: boolean;
}

/**
 * Query parameter names that look like an access token. Such a URL is
 * accepted, but the token would be visible in the config API and the UI.
 */
const TOKEN_LIKE_PARAM = /^(t|key|auth|sig|signature|pass|pwd)$|token|secret|passw|api[-_]?key|credential/i;

/** True if `name` looks like a query parameter carrying a secret. */
export function isTokenLikeParam(name: string): boolean {
  return TOKEN_LIKE_PARAM.test(name);
}

/** Validate `ui.external_links` (schema checks already passed). URLs are never echoed. */
export function validateExternalLinks(links: readonly ExternalLinkConfig[], file: string, issues: IssueCollector): void {
  const ids = new Set<string>();
  links.forEach((link, i) => {
    const at: IssuePath = ['ui', 'external_links', i];
    if (ids.has(link.id)) issues.error(file, [...at, 'id'], `Duplicate external link ID "${link.id}"`);
    ids.add(link.id);
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      issues.error(file, [...at, 'url'], 'Must be an absolute http(s) URL');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.error(file, [...at, 'url'], 'Must be an absolute http(s) URL');
      return;
    }
    if (url.username !== '' || url.password !== '') {
      issues.error(file, [...at, 'url'], 'Must not contain credentials ("user:password@"); use an authenticating reverse proxy instead');
      return;
    }
    const tokenParams = [...new Set([...url.searchParams.keys()].filter(isTokenLikeParam))];
    if (tokenParams.length > 0) {
      issues.warning(
        file,
        [...at, 'url'],
        `Query parameter ${tokenParams.map((p) => `"${p}"`).join(', ')} looks like an access token; while the link is enabled, its URL is visible to everyone who can reach the web UI/API (toolbar, GET /api/v1/config) – keep the UI behind authentication`,
      );
    }
    if (link.embed && frameOrigin(url) === null) {
      issues.error(
        file,
        [...at, 'embed'],
        'The host cannot be allowed in the Content-Security-Policy (frame-src): use a plain host name or IPv4 address (letters, digits, ".", "-"), or set embed: false',
      );
    }
  });
}

/** Enabled links in configuration order (what the UI shows). */
export function activeExternalLinks(global: GlobalConfig): ExternalLinkInfo[] {
  return global.ui.externalLinks
    .filter((link) => link.enabled)
    .map((link) => ({ id: link.id, label: link.label, url: link.url, embed: link.embed }));
}

/** Normalized lower-case origin as accepted in a CSP source list (`scheme://host[:port]`). */
const FRAME_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/;

/**
 * Origin of `url` if it can be put into `frame-src` without any risk of CSP
 * injection: http(s) only, host made of `[a-z0-9.-]` (no IPv6 literal, no
 * `_`, `*`, `;`, `,` …), else `null`.
 */
export function frameOrigin(url: URL | string): string | null {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return FRAME_ORIGIN.test(u.origin) ? u.origin : null;
}

/**
 * Origins of the enabled `embed: true` links, deduplicated and safe to put
 * into a CSP source list (see {@link frameOrigin}).
 */
export function externalLinkFrameOrigins(global: GlobalConfig): string[] {
  const origins = new Set<string>();
  for (const link of activeExternalLinks(global)) {
    if (!link.embed) continue;
    // Defense in depth: validation already rejects embed entries without such an origin.
    const origin = frameOrigin(link.url);
    if (origin !== null) origins.add(origin);
  }
  return [...origins];
}
