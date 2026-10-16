/**
 * Parsing of user-supplied item references for a GitHub source.
 */

/** Pattern of a valid GitHub item ID (issue/PR number as decimal string). */
export const ITEM_ID_PATTERN = /^[1-9]\d{0,9}$/;

/**
 * Parse `ref` into an item ID (issue/PR number) of the repository
 * `owner/repo`, or `null`. Accepted forms:
 * - `123`, `#123`
 * - `owner/repo#123`
 * - `https://github.com/owner/repo/issues/123` and `/pull/123`
 *   (optional trailing path such as `/files`, query and fragment)
 *
 * Owner and repository are compared case-insensitively (GitHub semantics);
 * references to other repositories yield `null`.
 */
export function parseGitHubItemRef(ref: string, owner: string, repo: string, webBaseUrl = 'https://github.com'): string | null {
  const text = ref.trim();
  const bare = /^#?(\d+)$/.exec(text);
  if (bare) return normalizeNumber(bare[1]);

  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(text);
  if (short) return sameRepo(short[1], short[2], owner, repo) ? normalizeNumber(short[3]) : null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const base = new URL(webBaseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.host.toLowerCase() !== base.host.toLowerCase()) return null;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (!url.pathname.startsWith(`${basePath}/`)) return null;
  const segments = url.pathname.slice(basePath.length + 1).split('/');
  const [o, r, kind, number] = segments;
  if (o === undefined || r === undefined || number === undefined) return null;
  if (kind !== 'issues' && kind !== 'pull' && kind !== 'pulls') return null;
  if (!sameRepo(o, r, owner, repo)) return null;
  if (!/^\d+$/.test(number)) return null;
  return normalizeNumber(number);
}

function sameRepo(o: string | undefined, r: string | undefined, owner: string, repo: string): boolean {
  return o?.toLowerCase() === owner.toLowerCase() && r?.toLowerCase() === repo.toLowerCase();
}

function normalizeNumber(digits: string | undefined): string | null {
  if (digits === undefined) return null;
  const normalized = digits.replace(/^0+/, '');
  return ITEM_ID_PATTERN.test(normalized) ? normalized : null;
}
