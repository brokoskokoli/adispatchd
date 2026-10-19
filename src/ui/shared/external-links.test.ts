import { describe, expect, it } from 'vitest';
import { createH, type DocLike, type ElementLike, type NodeLike } from './dom.js';
import { EMBED_SANDBOX, embedFrame, externalNavItem, parseExternalLinks, toolHash, toolNavKey, urlOrigin, type ExternalLink } from './external-links.js';
import { parseHash } from './route.js';

/** Minimal fake DOM (no HTML parser): text only via createTextNode. */
class FakeText implements NodeLike {
  readonly nodeType = 3;
  constructor(readonly data: string) {}
}
class FakeElement implements ElementLike {
  readonly nodeType = 1;
  attrs: Record<string, string> = {};
  children: Array<FakeElement | FakeText> = [];
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  appendChild(child: NodeLike): unknown {
    this.children.push(child as FakeElement | FakeText);
    return child;
  }
  addEventListener(): void {}
  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join('');
  }
  find(tag: string): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(c.tag === tag ? [c] : []), ...c.find(tag)] : []));
  }
  tags(): string[] {
    return [this.tag, ...this.children.flatMap((c) => (c instanceof FakeElement ? c.tags() : []))];
  }
}
const doc: DocLike<FakeElement, FakeText> = { createElement: (t) => new FakeElement(t), createTextNode: (d) => new FakeText(d) };
const h = createH(doc);

const embedded: ExternalLink = { id: 'claude-inspect', label: 'Claude Inspect', url: 'http://127.0.0.1:47717/', embed: true };
const newTab: ExternalLink = { id: 'grafana', label: 'Grafana', url: 'https://grafana.example.com/d/x?orgId=1', embed: false };

describe('parseExternalLinks (untrusted API data)', () => {
  it('keeps valid entries and normalizes embed to a boolean', () => {
    expect(parseExternalLinks([{ ...embedded }, { ...newTab, embed: 'yes' }])).toEqual([embedded, { ...newTab, embed: false }]);
  });
  it('drops non-http(s) URLs, bad IDs, empty labels, duplicates and non-arrays', () => {
    expect(parseExternalLinks(null)).toEqual([]);
    expect(parseExternalLinks({ id: 'x' })).toEqual([]);
    expect(
      parseExternalLinks([
        { id: 'js', label: 'JS', url: 'javascript:alert(1)', embed: true },
        { id: 'data', label: 'Data', url: 'data:text/html,<script>alert(1)</script>', embed: true },
        { id: 'rel', label: 'Rel', url: '/inspect', embed: false },
        { id: '../x', label: 'Path', url: 'https://a.example.com/', embed: true },
        { id: 'blank', label: '  ', url: 'https://a.example.com/', embed: true },
        { id: 'num', label: 5, url: 'https://a.example.com/', embed: true },
        { ...embedded },
        { ...embedded, label: 'Duplicate' },
        'string',
      ]),
    ).toEqual([embedded]);
  });
});

describe('toolbar entries', () => {
  it('embed: internal route #/tools/<id> with a nav key matching the route', () => {
    const li = externalNavItem(h, embedded);
    const a = li.find('a')[0]!;
    expect(li.attrs.class).toBe('ext-link');
    expect(a.attrs.href).toBe('#/tools/claude-inspect');
    expect(a.attrs.target).toBeUndefined();
    expect(a.attrs['data-nav']).toBe(toolNavKey('claude-inspect'));
    expect(parseHash(toolHash('claude-inspect')).segments.slice(0, 2).join('/')).toBe(toolNavKey('claude-inspect'));
    expect(a.textContent).toBe('Claude Inspect');
  });

  it('embed: false → new tab with noopener noreferrer and an external icon', () => {
    const a = externalNavItem(h, newTab).find('a')[0]!;
    expect(a.attrs).toMatchObject({ href: newTab.url, target: '_blank', rel: 'noopener noreferrer' });
    expect(a.attrs['data-nav']).toBeUndefined();
    expect(a.textContent).toBe('Grafana↗ (opens in a new tab)');
    expect(a.find('span').map((s) => s.attrs.class)).toEqual(['ext-icon', 'sr-only']);
  });

  it('labels are rendered as text only (no HTML)', () => {
    const evil = '<img src=x onerror=alert(1)><b>x</b>';
    for (const link of [{ ...embedded, label: evil }, { ...newTab, label: evil }]) {
      const li = externalNavItem(h, link);
      expect(li.textContent.startsWith(evil)).toBe(true);
      expect(li.tags().filter((t) => !['li', 'a', 'span'].includes(t))).toEqual([]);
    }
    const frame = embedFrame(doc, { ...embedded, label: evil })!;
    expect(frame.attrs.title).toBe(evil); // attribute value via setAttribute, never parsed
    expect(frame.children).toEqual([]);
  });
});

describe('embedFrame', () => {
  it('creates a sandboxed iframe without referrer', () => {
    const frame = embedFrame(doc, embedded)!;
    expect(frame.tag).toBe('iframe');
    expect(frame.attrs).toEqual({
      class: 'tool-frame',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads',
      referrerpolicy: 'no-referrer',
      title: 'Claude Inspect',
      src: 'http://127.0.0.1:47717/',
    });
    expect(EMBED_SANDBOX).not.toMatch(/top-navigation|allow-modals|allow-popups-to-escape/);
  });

  it('refuses non-http(s) URLs', () => {
    expect(embedFrame(doc, { ...embedded, url: 'javascript:alert(1)' })).toBeNull();
    expect(embedFrame(doc, { ...embedded, url: ' https://a.example.com' })).toBeNull();
  });

  it('h() itself still refuses <iframe>', () => {
    expect(() => h('iframe', { src: embedded.url })).toThrow(/not allowed/);
  });
});

describe('urlOrigin', () => {
  it('returns the normalized origin or null', () => {
    expect(urlOrigin('HTTPS://Tools.Example.com:443/a?b')).toBe('https://tools.example.com');
    expect(urlOrigin('http://127.0.0.1:47717/')).toBe('http://127.0.0.1:47717');
    expect(urlOrigin('ftp://x')).toBeNull();
  });
});
