/**
 * Embedded external tool (WI-25, `ui.external_links` with `embed: true`):
 * header with "Open in new tab" and the tool in a sandboxed iframe. The
 * browser talks to the tool directly (no proxy). Whether the tool loaded
 * cannot be detected reliably for cross-origin frames, so the link and a
 * short explanation of typical causes always stay visible.
 */
import { h, replaceChildren } from '../dom.js';
import { embedFrame, urlOrigin, type ExternalLink } from '../../shared/external-links.js';
import { safeHttpUrl } from '../../shared/format.js';
import type { Page, PageContext } from '../page.js';
import { button, loading } from '../ui.js';
import { externalLinks, frameAllowedByDocument } from '../external-links.js';

export const toolPage = (ctx: PageContext, id: string): Page => {
  ctx.setTitle(id);
  const el = h('div', { class: 'page tool-page' }, loading());
  let disposed = false;
  const render = (links: ExternalLink[]): void => {
    if (disposed) return;
    const link = links.find((l) => l.id === id && l.embed);
    if (!link) {
      replaceChildren(
        el,
        h('h1', null, 'Tool not found'),
        h('p', null, 'No enabled embedded tool with this ID is configured (ui.external_links). ', h('a', { href: '#/' }, 'Go to the dashboard')),
      );
      return;
    }
    ctx.setTitle(link.label);
    const frame = embedFrame(document, link);
    const origin = urlOrigin(link.url) ?? link.url;
    replaceChildren(
      el,
      h(
        'div',
        { class: 'tool-head' },
        h('h1', null, link.label),
        h('a', { class: 'btn', href: link.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in new tab ↗'),
      ),
      frameAllowedByDocument(link)
        ? null
        : h(
            'div',
            { class: 'alert alert-warn', role: 'status' },
            'This tool was configured after this page was loaded; the browser only allows embedding it after a reload. ',
            button('Reload page', () => location.reload()),
          ),
      h(
        'p',
        { class: 'hint tool-hint' },
        'Nothing shown? The tool may not be running, may not be reachable from this browser at ',
        h('code', null, origin),
        ', may reject the request (e.g. host check, missing login or token) or may forbid being embedded (X-Frame-Options / CSP frame-ancestors). Use "Open in new tab" in that case.',
      ),
      frame ?? h('p', { class: 'error-text' }, 'Invalid tool URL.'),
    );
  };
  void externalLinks().then(render);
  return {
    el,
    onLive: (msg) => {
      // A reload may remove/change the tool; re-render only if its entry changed (keeps the iframe state otherwise).
      if (msg.type !== 'config.reloaded') return;
      const frame = el.querySelector('iframe');
      const before = frame ? `${frame.getAttribute('src') ?? ''}\n${frame.getAttribute('title') ?? ''}` : null;
      void externalLinks().then((links) => {
        const link = links.find((l) => l.id === id && l.embed);
        const src = link ? safeHttpUrl(link.url) : null;
        if (!link || `${src ?? ''}\n${link.label}` !== before) render(links);
      });
    },
    dispose: () => {
      disposed = true;
    },
  };
};
