/**
 * The web UI never assumes it lives at the root of its host (WI-37): the same
 * files are served by an instance at `/` and by a hub at `/w/<id>/` (possibly
 * behind a reverse proxy with a path prefix). All requests therefore use URLs
 * relative to the page (`./api/v1/…`), which the browser resolves against the
 * address of the page itself. The page must be served with a trailing slash
 * (the hub redirects `/w/<id>` to `/w/<id>/`).
 */

/** `/api/v1/x` → `./api/v1/x`; anything else is returned unchanged. */
export function appPath(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? `.${path}` : path;
}

/**
 * Link targets the safe element builder accepts besides hash routes and
 * absolute http(s) URLs: `./api/v1/…` (downloads of the same instance) and
 * the hub links `./`, `./w/<id>/`, `../../` (overview from a workspace page).
 */
export function isAppHref(value: string): boolean {
  if (/[\u0000-\u001f\u007f\s\\]/.test(value) || value.length > 2048) return false;
  if (/^\.\/api\/v1\/[A-Za-z0-9._~%/!'()*-]+$/.test(value)) return !value.split('/').slice(1).some((s) => s === '.' || s === '..' || /^%2e/i.test(s));
  return value === './' || value === '../../' || /^\.\/w\/[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?\/$/.test(value);
}

/**
 * Link from a workspace page back to the hub overview, or `null` if the page is
 * not served by a hub. `pathname` is the page's path (`…/w/<id>/` with an
 * optional `index.html`), `workspaceId` the ID the instance reports in
 * `status.hub.workspace`; both must agree.
 */
export function hubOverviewHref(pathname: string, workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null;
  const m = /\/w\/([a-z0-9][a-z0-9-]*)\/(?:index\.html)?$/.exec(pathname);
  return m && m[1] === workspaceId ? '../../' : null;
}
