/**
 * Content-Security-Policy of the web UI (WI-11, WI-25). Sent as an HTTP
 * header (a `<meta>` policy cannot be extended per configuration):
 * everything `'self'` only, frames only for the origins of the enabled
 * `ui.external_links` entries with `embed: true`.
 */

/** Directives without `frame-src` (unchanged from the former `<meta>` policy of WI-11). */
export const UI_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
] as const;

/**
 * CSP header value for UI responses. `frameOrigins` must be normalized
 * origins (`scheme://host[:port]`, see `externalLinkFrameOrigins`); without
 * any, no `frame-src` is added (falls back to `default-src 'none'`).
 */
export function uiContentSecurityPolicy(frameOrigins: readonly string[]): string {
  const directives: string[] = [...UI_CSP_DIRECTIVES];
  if (frameOrigins.length > 0) directives.push(`frame-src ${frameOrigins.join(' ')}`);
  return directives.join('; ');
}
