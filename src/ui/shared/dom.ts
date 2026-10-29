/**
 * Minimal, XSS-safe element builder (Spec §20.5). Works against a structural
 * `DocLike` so it runs in the browser (`document`) and in unit tests (fake
 * document) alike.
 *
 * Rules:
 * - String/number children always become text nodes (`createTextNode`), never HTML.
 * - Attribute values are set via `setAttribute` only; event-handler attributes
 *   (`on*`), `style`, `srcdoc` and friends are rejected.
 * - URL attributes (`href`, `src`, `action`, …) accept only absolute
 *   `http(s)` URLs or internal hash routes (`#/…`); anything else is dropped.
 * - Event listeners are attached with `addEventListener` via the `on` option.
 */
import { isAppHref } from './base-path.js';
import { isInternalHref, safeHttpUrl } from './format.js';

/** Event listener (`any`: structural compatibility with the overloaded DOM signatures). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Listener = (ev: any) => void;

/** Node as seen by the builder. */
export interface NodeLike {
  readonly nodeType?: number;
}

/** Element as seen by the builder. */
export interface ElementLike extends NodeLike {
  setAttribute(name: string, value: string): void;
  appendChild(child: NodeLike): unknown;
  addEventListener(type: string, listener: Listener): void;
}

/** Document as seen by the builder. */
export interface DocLike<E extends ElementLike = ElementLike, T extends NodeLike = NodeLike> {
  createElement(tagName: string): E;
  createTextNode(data: string): T;
}

/** Child of {@link HFn}: nodes, text, or nothing; arrays are flattened. */
export type Child = NodeLike | string | number | null | undefined | false | readonly Child[];

/** Attribute value: `true` = present without value, `false`/`null`/`undefined` = omitted. */
export type AttrValue = string | number | boolean | null | undefined;

/** Options of {@link HFn}. */
export interface HOptions {
  [attr: string]: AttrValue | Record<string, Listener> | undefined;
  /** Event listeners, e.g. `{ click: () => … }`. */
  on?: Record<string, Listener>;
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'cite', 'data', 'background', 'ping']);
const FORBIDDEN_ATTRS = new Set(['style', 'srcdoc', 'srcset', 'is']);
const ATTR_NAME = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;
/** Tags the builder refuses to create (script execution / embedding). */
const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'meta', 'link', 'style']);

/**
 * Decide whether an attribute may be set and with which value.
 * Returns `null` if the attribute must be dropped.
 */
export function sanitizeAttribute(name: string, value: string): string | null {
  const n = name.toLowerCase();
  if (!ATTR_NAME.test(n) || n.startsWith('on') || FORBIDDEN_ATTRS.has(n)) return null;
  if (URL_ATTRS.has(n)) {
    if (isInternalHref(value)) return value;
    if (n === 'href' && isAppHref(value)) return value;
    return safeHttpUrl(value);
  }
  return value;
}

/** Element builder function. */
export type HFn<E extends ElementLike> = (tag: string, opts?: HOptions | null, ...children: Child[]) => E;

/** Create an element builder for `doc`. */
export function createH<E extends ElementLike, T extends NodeLike>(doc: DocLike<E, T>): HFn<E> {
  const append = (parent: E, child: Child): void => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      for (const c of child as readonly Child[]) append(parent, c);
      return;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(doc.createTextNode(String(child)));
      return;
    }
    parent.appendChild(child as NodeLike);
  };
  return (tag, opts, ...children) => {
    const t = tag.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(t) || FORBIDDEN_TAGS.has(t)) throw new Error(`h(): tag <${tag}> is not allowed`);
    const el = doc.createElement(t);
    if (opts) {
      for (const [name, raw] of Object.entries(opts)) {
        if (name === 'on') continue;
        if (raw === null || raw === undefined || raw === false) continue;
        if (typeof raw === 'object' || typeof raw === 'function') continue;
        const value = raw === true ? '' : String(raw);
        const safe = sanitizeAttribute(name === 'className' ? 'class' : name, value);
        if (safe !== null) el.setAttribute(name === 'className' ? 'class' : name.toLowerCase(), safe);
      }
      if (opts.on) for (const [type, listener] of Object.entries(opts.on)) el.addEventListener(type, listener);
    }
    for (const c of children) append(el, c);
    return el;
  };
}

/** SVG namespace. */
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Document that can create namespaced (SVG) elements. */
export interface SvgDocLike<E extends ElementLike = ElementLike, T extends NodeLike = NodeLike> {
  createElementNS(namespace: string, qualifiedName: string): E;
  createTextNode(data: string): T;
}

/** SVG elements the chart builder may create (no `a`, `use`, `image`, `foreignObject`, `script`, animation). */
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'line', 'polyline', 'polygon', 'circle', 'text', 'tspan', 'title', 'desc']);
/** SVG attribute names are case-sensitive (`viewBox`). */
const SVG_ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Decide whether an SVG attribute may be set: event handlers, `style` and all
 * URL-bearing attributes (`href`, `xlink:href`, …) are dropped, as are values
 * referencing URLs; everything else is plain geometry, classes or ARIA.
 */
export function sanitizeSvgAttribute(name: string, value: string): string | null {
  const n = name.toLowerCase();
  if (!SVG_ATTR_NAME.test(name) || n.startsWith('on') || FORBIDDEN_ATTRS.has(n) || URL_ATTRS.has(n) || n === 'href') return null;
  if (/url\s*\(|javascript:/i.test(value)) return null;
  return value;
}

/**
 * Element builder for inline SVG charts (WI-23), same rules as
 * {@link createH}: strings become text nodes, attributes only via `setAttribute`.
 */
export function createSvg<E extends ElementLike, T extends NodeLike>(doc: SvgDocLike<E, T>): HFn<E> {
  const append = (parent: E, child: Child): void => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      for (const c of child as readonly Child[]) append(parent, c);
      return;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(doc.createTextNode(String(child)));
      return;
    }
    parent.appendChild(child as NodeLike);
  };
  return (tag, opts, ...children) => {
    const t = tag.toLowerCase();
    if (!SVG_TAGS.has(t)) throw new Error(`svg(): tag <${tag}> is not allowed`);
    const el = doc.createElementNS(SVG_NS, t);
    if (opts) {
      for (const [name, raw] of Object.entries(opts)) {
        if (name === 'on') continue;
        if (raw === null || raw === undefined || raw === false) continue;
        if (typeof raw === 'object' || typeof raw === 'function') continue;
        const safe = sanitizeSvgAttribute(name, raw === true ? '' : String(raw));
        if (safe !== null) el.setAttribute(name, safe);
      }
      if (opts.on) for (const [type, listener] of Object.entries(opts.on)) el.addEventListener(type, listener);
    }
    for (const c of children) append(el, c);
    return el;
  };
}
