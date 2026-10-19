/**
 * External tools (WI-25): loads the active links from `GET /api/v1/config`
 * (at start and after `config.reloaded`) and remembers which embed origins
 * existed when this document was loaded – the CSP `frame-src` of the page is
 * fixed at that moment, a tool added later needs a browser reload.
 */
import { api } from './api.js';
import { parseExternalLinks, urlOrigin, type ExternalLink } from '../shared/external-links.js';

let current: Promise<ExternalLink[]> | null = null;
let documentFrameOrigins: Set<string> | null = null;

/** Fetch the links (again). Errors yield an empty list (the toolbar then simply shows none). */
export function reloadExternalLinks(): Promise<ExternalLink[]> {
  current = api
    .get<{ externalLinks?: unknown }>('/api/v1/config')
    .then((res) => parseExternalLinks(res.externalLinks))
    .catch(() => [] as ExternalLink[]);
  void current.then((links) => {
    documentFrameOrigins ??= new Set(links.filter((l) => l.embed).map((l) => urlOrigin(l.url)).filter((o): o is string => o !== null));
  });
  return current;
}

/** Current links (loads them on first use). */
export function externalLinks(): Promise<ExternalLink[]> {
  return current ?? reloadExternalLinks();
}

/**
 * False if the tool's origin was not embeddable when this page was loaded
 * (configured afterwards → the document's CSP still blocks it).
 */
export function frameAllowedByDocument(link: ExternalLink): boolean {
  const origin = urlOrigin(link.url);
  return documentFrameOrigins === null || (origin !== null && documentFrameOrigins.has(origin));
}
