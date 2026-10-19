/**
 * Collecting and formatting configuration issues.
 */
import type { ConfigIssue, ConfigIssueSeverity } from './model.js';

/** Path segments inside a YAML document. */
export type IssuePath = readonly (string | number)[];

/** Issue before line resolution. */
export interface PendingIssue {
  severity: ConfigIssueSeverity;
  file: string;
  path: IssuePath;
  message: string;
  line?: number;
  /**
   * Hops through named filters (WI-15), appended to the formatted path:
   * `filter.all[0] (use "x" → filters/x.yaml: filter.all[1].field)`.
   */
  via?: string;
}

/** Mutable collector used during one load. */
export class IssueCollector {
  readonly items: PendingIssue[] = [];

  error(file: string, path: IssuePath, message: string, line?: number): void {
    this.items.push({ severity: 'error', file, path, message, ...(line !== undefined ? { line } : {}) });
  }

  warning(file: string, path: IssuePath, message: string, line?: number): void {
    this.items.push({ severity: 'warning', file, path, message, ...(line !== undefined ? { line } : {}) });
  }

  /** Add an issue as is (e.g. with {@link PendingIssue.via}). */
  add(issue: PendingIssue): void {
    this.items.push(issue);
  }

  get hasErrors(): boolean {
    return this.items.some((i) => i.severity === 'error');
  }
}

/** Format path segments as `a.b[1].c`. */
export function formatIssuePath(path: IssuePath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/** Human-readable single line: `workflows/coder.yaml:12: execute.timeout: message`. */
export function formatConfigIssue(issue: ConfigIssue): string {
  const location = issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
  const prefix = issue.severity === 'warning' ? 'warning: ' : '';
  return issue.path ? `${location}: ${prefix}${issue.path}: ${issue.message}` : `${location}: ${prefix}${issue.message}`;
}

/** Stable ordering: by file, then line, then path. */
export function sortIssues(issues: ConfigIssue[]): ConfigIssue[] {
  return [...issues].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
      a.path.localeCompare(b.path),
  );
}
