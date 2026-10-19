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
        `Query parameter ${tokenParams.map((p) => `"${p}"`).join(', ')} looks like an access token; it is visible in the config API and the web UI`,
      );
    }
    if (link.embed && url.hostname.startsWith('[')) {
      issues.warning(file, [...at, 'embed'], 'IPv6 literals cannot be allowed in the Content-Security-Policy (frame-src); use a host name to embed this tool');
    }
  });
}

/** Enabled links in configuration order (what the UI shows). */
export function activeExternalLinks(global: GlobalConfig): ExternalLinkInfo[] {
  return global.ui.externalLinks
    .filter((link) => link.enabled)
    .map((link) => ({ id: link.id, label: link.label, url: link.url, embed: link.embed }));
}

/**
 * Origins of the enabled `embed: true` links, deduplicated and safe to put
 * into a CSP source list (`scheme://host[:port]`; IPv6 literals are skipped,
 * CSP host sources cannot express them).
 */
export function externalLinkFrameOrigins(global: GlobalConfig): string[] {
  const origins = new Set<string>();
  for (const link of activeExternalLinks(global)) {
    if (!link.embed) continue;
    try {
      const url = new URL(link.url);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.startsWith('[')) continue;
      // URL.origin is normalized (lower-case host, default port omitted) and cannot contain ";", "," or spaces.
      if (/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(url.origin)) origins.add(url.origin);
    } catch {
      // invalid URLs never pass validation
    }
  }
  return [...origins];
}
