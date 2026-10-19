/**
 * External tools (WI-25): the links from `GET /api/v1/config`, loaded at
 * start and after `config.reloaded` (logic in shared/external-links.ts).
 */
import { api } from './api.js';
import { createExternalLinkStore, type ExternalLink } from '../shared/external-links.js';

const store = createExternalLinkStore(() => api.get<{ externalLinks?: unknown }>('/api/v1/config'));

/** Fetch the links (again). Errors yield an empty list (the toolbar then simply shows none). */
export const reloadExternalLinks = (): Promise<ExternalLink[]> => store.reload();

/** Current links (loads them on first use). */
export const externalLinks = (): Promise<ExternalLink[]> => store.links();

/** False if the tool was configured after this page was loaded (its CSP still blocks the frame). */
export const frameAllowedByDocument = (link: ExternalLink): boolean => store.frameAllowedByDocument(link);
