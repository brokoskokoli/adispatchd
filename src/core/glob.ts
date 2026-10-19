/**
 * Small glob dialect for `execute.keep` (WI-22): patterns are relative,
 * `/`-separated paths whose segments may contain `*` (any characters except
 * `/`), `?` (one character except `/`) or consist of `**` (zero or more
 * directories). Everything else is literal. Wildcards also match names that
 * start with a dot.
 */

/** One parsed segment of a {@link KeepPattern}. */
export type GlobSegment = { kind: 'literal'; value: string } | { kind: 'wildcard'; regex: RegExp; source: string } | { kind: 'globstar' };

/** A validated, parsed keep pattern. */
export interface KeepPattern {
  /** The pattern as configured (normalised: leading `./` removed). */
  pattern: string;
  segments: readonly GlobSegment[];
}

/**
 * Why `pattern` is not a valid keep pattern, or `null` if it is valid:
 * non-empty, relative (no leading `/`, `\` or drive letter), no `..`
 * segment, no empty segment, no backslash, no NUL, not only `**`.
 */
export function keepPatternError(pattern: string): string | null {
  if (pattern.trim() === '') return 'Pattern must not be empty';
  if (pattern.includes('\0')) return 'Pattern must not contain a NUL byte';
  if (pattern.includes('\\')) return 'Pattern must not contain "\\" (use "/" as separator)';
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) return 'Pattern must be relative to the workspace (no absolute path)';
  const segments = stripDotSlash(pattern).split('/');
  if (segments.some((s) => s === '..')) return 'Pattern must not contain ".." (only files inside the workspace can be kept)';
  if (segments.some((s) => s === '' || s === '.')) return 'Pattern must not contain empty or "." segments (e.g. "a//b" or a trailing "/"; use "dir/**" for a directory)';
  if (segments[segments.length - 1] === '**') return 'Pattern must not end with "**" (use "dir/**/*" or "**/*.log")';
  return null;
}

/**
 * Parse a keep pattern.
 * @throws Error with the message of {@link keepPatternError}
 */
export function parseKeepPattern(pattern: string): KeepPattern {
  const error = keepPatternError(pattern);
  if (error) throw new Error(`Invalid keep pattern "${pattern}": ${error}`);
  const normalised = stripDotSlash(pattern);
  const segments = normalised.split('/').map((s): GlobSegment => {
    if (s === '**') return { kind: 'globstar' };
    if (!/[*?]/.test(s)) return { kind: 'literal', value: s };
    return { kind: 'wildcard', regex: segmentRegex(s), source: s };
  });
  // Collapse consecutive `**` (equivalent, avoids redundant walking).
  const collapsed = segments.filter((s, i) => !(s.kind === 'globstar' && segments[i - 1]?.kind === 'globstar'));
  return { pattern: normalised, segments: collapsed };
}

/** True if `name` (one path segment) matches the segment. */
export function matchGlobSegment(segment: GlobSegment, name: string): boolean {
  switch (segment.kind) {
    case 'literal':
      return segment.value === name;
    case 'wildcard':
      return segment.regex.test(name);
    case 'globstar':
      return true;
  }
}

/** True if the relative `/`-separated path matches the pattern (pure; used for tests and listings). */
export function matchKeepPattern(pattern: KeepPattern, relPath: string): boolean {
  const parts = relPath.split('/');
  const segs = pattern.segments;
  const memo = new Map<string, boolean>();
  const go = (si: number, pi: number): boolean => {
    const key = `${si}:${pi}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (si === segs.length) result = pi === parts.length;
    else {
      const seg = segs[si] as GlobSegment;
      if (seg.kind === 'globstar') result = go(si + 1, pi) || (pi < parts.length - 1 && go(si, pi + 1));
      else result = pi < parts.length && matchGlobSegment(seg, parts[pi] as string) && go(si + 1, pi + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function stripDotSlash(pattern: string): string {
  let p = pattern;
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

function segmentRegex(segment: string): RegExp {
  let src = '';
  for (const ch of segment) {
    if (ch === '*') src += '[^/]*';
    else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'su');
}
