/**
 * Browser binding of the safe element builder (see shared/dom.ts). All
 * rendering goes through `h()`; untrusted strings therefore always end up in
 * text nodes. `innerHTML` is never used in the UI.
 */
import { createH, createSvg, type Child } from '../shared/dom.js';

export type { Child } from '../shared/dom.js';

/** Element builder bound to `document`. */
export const h = createH<HTMLElement, Text>(document);

/** SVG element builder bound to `document` (charts, WI-23). */
export const svg = createSvg<SVGElement, Text>(document);

/** Remove all children of `el` and append `children`. */
export function replaceChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  const tmp = h('div', null, ...children);
  while (tmp.firstChild) el.appendChild(tmp.firstChild);
}

/**
 * Like {@link replaceChildren}, but keeps the open state of `<details>`
 * elements (matched by position) across live re-renders.
 */
export function rerender(el: Element, ...children: Child[]): void {
  const open = [...el.querySelectorAll('details')].map((d) => d.open);
  replaceChildren(el, ...children);
  el.querySelectorAll('details').forEach((d, i) => {
    if (open[i]) d.open = true;
  });
}

/** Typed `querySelector` that throws if missing. */
export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`element ${selector} not found`);
  return el as HTMLElement;
}
