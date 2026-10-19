import { describe, expect, it } from 'vitest';
import { createH, createSvg, sanitizeAttribute, sanitizeSvgAttribute, SVG_NS, type DocLike, type ElementLike, type NodeLike, type SvgDocLike } from './dom.js';
import { eventSummary } from './format.js';

/** Minimal fake DOM that records how nodes were created (no HTML parser exists here at all). */
class FakeText implements NodeLike {
  readonly nodeType = 3;
  constructor(readonly data: string) {}
}
class FakeElement implements ElementLike {
  readonly nodeType = 1;
  attrs: Record<string, string> = {};
  children: Array<FakeElement | FakeText> = [];
  listeners: Record<string, unknown> = {};
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  appendChild(child: NodeLike): unknown {
    this.children.push(child as FakeElement | FakeText);
    return child;
  }
  addEventListener(type: string, listener: unknown): void {
    this.listeners[type] = listener;
  }
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
  }
  /** All element tags in the subtree. */
  tags(): string[] {
    return [this.tag, ...this.children.flatMap((c) => (c instanceof FakeElement ? c.tags() : []))];
  }
}
const created: string[] = [];
const doc: DocLike<FakeElement, FakeText> = {
  createElement: (tag) => {
    created.push(tag);
    return new FakeElement(tag);
  },
  createTextNode: (data) => new FakeText(data),
};
const h = createH(doc);

describe('h() – XSS-safe rendering (Spec §20.5)', () => {
  it('renders an event message with HTML as plain text', () => {
    const payload = { type: 'status', message: '<img src=x onerror=alert(1)>' };
    created.length = 0;
    const cell = h('td', { class: 'event-message' }, eventSummary({ type: 'status', payload }));
    expect(cell.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(cell.children).toHaveLength(1);
    expect(cell.children[0]).toBeInstanceOf(FakeText);
    expect(created).toEqual(['td']); // no <img> element was ever created
    expect(cell.tags()).toEqual(['td']);
  });

  it('renders numbers and nested arrays as text, skips null/false', () => {
    const el = h('p', null, 'a', 1, null, false, undefined, ['<b>', ['c']]);
    expect(el.textContent).toBe('a1<b>c');
    expect(el.tags()).toEqual(['p']);
  });

  it('drops event-handler, style and srcdoc attributes', () => {
    const el = h('div', { onclick: 'alert(1)', onerror: 'x', style: 'background:url(javascript:x)', srcdoc: '<script>', title: '<ok>' });
    expect(el.attrs).toEqual({ title: '<ok>' });
  });

  it('allows only http(s) and internal hash links', () => {
    expect(h('a', { href: 'javascript:alert(1)' }).attrs).toEqual({});
    expect(h('a', { href: ' javascript:alert(1)' }).attrs).toEqual({});
    expect(h('a', { href: 'JAVASCRIPT:alert(1)' }).attrs).toEqual({});
    expect(h('a', { href: 'data:text/html,<script>' }).attrs).toEqual({});
    expect(h('a', { href: 'java\tscript:alert(1)' }).attrs).toEqual({});
    expect(h('a', { href: '//evil.example/x' }).attrs).toEqual({});
    expect(h('a', { href: 'https://github.com/o/r/issues/7' }).attrs).toEqual({ href: 'https://github.com/o/r/issues/7' });
    expect(h('a', { href: '#/runs/run-1' }).attrs).toEqual({ href: '#/runs/run-1' });
    expect(h('img', { src: 'javascript:x' }).attrs).toEqual({});
  });

  it('refuses script-capable tags', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'base', 'style', 'SCRIPT']) expect(() => h(tag)).toThrow(/not allowed/);
    expect(() => h('img onerror=x')).toThrow();
  });

  it('attaches listeners only via the `on` option; boolean attributes', () => {
    const fn = (): void => undefined;
    const el = h('button', { disabled: true, hidden: false, on: { click: fn } });
    expect(el.attrs).toEqual({ disabled: '' });
    expect(el.listeners.click).toBe(fn);
  });
});

describe('sanitizeAttribute', () => {
  it('validates names and URL values', () => {
    expect(sanitizeAttribute('aria-label', 'x')).toBe('x');
    expect(sanitizeAttribute('data-nav', 'runs')).toBe('runs');
    expect(sanitizeAttribute('onClick', 'x')).toBeNull();
    expect(sanitizeAttribute('x y', 'x')).toBeNull();
    expect(sanitizeAttribute('formaction', 'javascript:x')).toBeNull();
    expect(sanitizeAttribute('href', 'http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });
});

describe('createSvg (charts, WI-23)', () => {
  const nsCreated: Array<[string, string]> = [];
  const svgDoc: SvgDocLike<FakeElement, FakeText> = {
    createElementNS: (ns, tag) => {
      nsCreated.push([ns, tag]);
      return new FakeElement(tag);
    },
    createTextNode: (data) => new FakeText(data),
  };
  const s = createSvg(svgDoc);

  it('creates namespaced elements, keeps case-sensitive attributes and renders names as text only', () => {
    const name = '<img src=x onerror=alert(1)>';
    const el = s('svg', { viewBox: '0 0 10 10', class: 'chart', role: 'img' }, s('path', { d: 'M0,0L1,1Z', class: 'area m-wf-1' }, s('title', null, name)));
    expect(nsCreated.every(([ns]) => ns === SVG_NS)).toBe(true);
    expect(el.attrs).toEqual({ viewBox: '0 0 10 10', class: 'chart', role: 'img' });
    expect(el.textContent).toBe(name);
    expect(el.tags()).toEqual(['svg', 'path', 'title']);
  });

  it('drops event handlers, style, href and url() values; refuses unsafe tags', () => {
    const el = s('rect', { onclick: 'x', style: 'fill:red', href: 'http://x', 'xlink:href': '#a', fill: 'url(http://evil/)', width: 5 });
    expect(el.attrs).toEqual({ width: '5' });
    expect(sanitizeSvgAttribute('stroke-width', '2')).toBe('2');
    expect(sanitizeSvgAttribute('fill', 'javascript:x')).toBeNull();
    for (const tag of ['script', 'foreignObject', 'a', 'use', 'image', 'animate']) expect(() => s(tag)).toThrow(/not allowed/);
  });
});
