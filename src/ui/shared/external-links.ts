/**
 * External tools in the toolbar (WI-25), DOM-free so it is unit-testable:
 * parsing the untrusted `externalLinks` of `GET /api/v1/config`, the nav
 * entries (link in a new tab vs. internal page with an iframe) and the
 * iframe itself with a fixed sandbox. Labels and URLs always end up as text
 * or as attribute values set via `setAttribute` (never HTML).
 */
import type { DocLike, ElementLike, HFn } from './dom.js';
import { safeHttpUrl } from './format.js';
import { buildHash } from './route.js';

/** Active external link as delivered by the API. */
export interface ExternalLink {
  id: string;
  label: string;
  url: string;
  embed: boolean;
}

/** Sandbox of the embedded tool page (Spec §16, WI-25). */
export const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';

/** Route segment of embedded tools: `#/tools/<id>`. */
export const TOOLS_ROUTE = 'tools';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validate the API payload defensively; drops malformed entries (non-http(s) URLs, bad IDs, duplicates). */
export function parseExternalLinks(value: unknown): ExternalLink[] {
  if (!Array.isArray(value)) return [];
  const out: ExternalLink[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !ID.test(r.id) || seen.has(r.id)) continue;
    if (typeof r.label !== 'string' || r.label.trim() === '') continue;
    const url = safeHttpUrl(r.url);
    if (!url) continue;
    seen.add(r.id);
    out.push({ id: r.id, label: r.label.slice(0, 40), url, embed: r.embed === true });
  }
  return out;
}

/** Internal route of an embedded tool. */
export function toolHash(id: string): string {
  return buildHash([TOOLS_ROUTE, id]);
}

/** `data-nav` key of an embedded tool (matches `markActiveNav`: first two route segments). */
export function toolNavKey(id: string): string {
  return `${TOOLS_ROUTE}/${id}`;
}

/**
 * Toolbar entry: `embed` → internal page `#/tools/<id>`; otherwise a link
 * opening the tool in a new tab (`noopener noreferrer`) with an "external" icon.
 */
export function externalNavItem<E extends ElementLike>(h: HFn<E>, link: ExternalLink): E {
  if (link.embed) {
    return h('li', { class: 'ext-link' }, h('a', { href: toolHash(link.id), 'data-nav': toolNavKey(link.id) }, link.label));
  }
  return h(
    'li',
    { class: 'ext-link' },
    h(
      'a',
      { href: link.url, target: '_blank', rel: 'noopener noreferrer', title: 'Opens in a new tab' },
      link.label,
      h('span', { class: 'ext-icon', 'aria-hidden': 'true' }, '↗'),
      h('span', { class: 'sr-only' }, ' (opens in a new tab)'),
    ),
  );
}

/**
 * The iframe of an embedded tool. `h()` refuses `<iframe>` on purpose; this is
 * the only place that creates one, with fixed sandbox/referrer attributes and
 * an http(s)-only `src` (`null` for anything else).
 */
export function embedFrame<E extends ElementLike>(doc: DocLike<E>, link: ExternalLink): E | null {
  const src = safeHttpUrl(link.url);
  if (!src) return null;
  const frame = doc.createElement('iframe');
  frame.setAttribute('class', 'tool-frame');
  frame.setAttribute('sandbox', EMBED_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', link.label);
  frame.setAttribute('src', src);
  return frame;
}

/** Origin of an http(s) URL (`null` if invalid). */
export function urlOrigin(url: string): string | null {
  const safe = safeHttpUrl(url);
  return safe ? new URL(safe).origin : null;
}
