/**
 * Repository locations of `git_files` sources (WI-40): kinds of `repository`
 * values, the display location (`{source.repository}`), the default web URL
 * and the item folder.
 */
import path from 'node:path';

/** Kind of a `repository` value. */
export type RepositoryKind = 'url' | 'scp' | 'path';

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)/;

/** Kind of a repository value: URL (`https://…`, `ssh://…`, `file://…`), scp-like (`git@host:o/r.git`) or local path. */
export function repositoryKind(value: string): RepositoryKind {
  if (URL_SCHEME.test(value)) return 'url';
  if (SCP_LIKE.test(value)) return 'scp';
  return 'path';
}

/** Problem with a `repository` value (credentials in the URL, unsupported scheme), or `undefined`. */
export function repositoryProblem(value: string): string | undefined {
  if (value.startsWith('-')) return 'must not start with "-"';
  if (/[\s\u0000-\u001f]/.test(value)) return 'must not contain whitespace or control characters';
  if (repositoryKind(value) !== 'url') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a valid URL';
  }
  if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) return `uses the unsupported scheme "${url.protocol.replace(/:$/, '')}" (allowed: https, http, ssh, git, file)`;
  if (url.password !== '' || ((url.protocol === 'https:' || url.protocol === 'http:') && url.username !== '')) {
    return 'must not contain credentials; set "identity" instead (the token is passed to git through a credential helper)';
  }
  return undefined;
}

/** Resolve a local path against the config dir; URLs and scp-like values stay as written. */
export function resolveRepository(value: string, configDir: string): string {
  return repositoryKind(value) === 'path' ? path.resolve(configDir, value) : value;
}

/** `owner/name` of a GitHub repository URL (https, ssh or scp-like), else `null`. */
export function githubRepository(value: string): { owner: string; name: string } | null {
  const m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value) ??
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value);
  return m ? { owner: m[1] as string, name: m[2] as string } : null;
}

/** Display location (`{source.repository}`): `owner/name` on GitHub, else the value without credentials. */
export function repositoryLocation(value: string): string {
  const gh = githubRepository(value);
  if (gh) return `${gh.owner}/${gh.name}`;
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** Default web URL template: GitHub `blob` view for github.com repositories, else `null`. */
export function defaultWebUrl(value: string): string | null {
  const gh = githubRepository(value);
  return gh ? `https://github.com/${gh.owner}/${gh.name}/blob/{ref}/{path}` : null;
}

/** Normalise the item folder (`./issues/` → `issues`, `.` → `''`); `undefined` if it is unsafe. */
export function normalizeItemFolder(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.includes('\\') || trimmed.startsWith('/') || /[\u0000-\u001f]/.test(trimmed)) return undefined;
  const parts = trimmed.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || p === '.git')) return undefined;
  return parts.join('/');
}

/** Problem with a branch name (subset of `git check-ref-format`), or `undefined`. */
export function branchProblem(value: string): string | undefined {
  if (
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.lock') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    /[\s~^:?*[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    return 'is not a valid git branch name';
  }
  return undefined;
}
