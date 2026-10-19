import { describe, expect, it } from 'vitest';
import { keepPatternError, matchKeepPattern, parseKeepPattern } from './glob.js';

const m = (pattern: string, rel: string): boolean => matchKeepPattern(parseKeepPattern(pattern), rel);

describe('keep patterns', () => {
  it('accepts relative patterns and strips a leading ./', () => {
    for (const p of ['a.txt', '.agent/transcript.jsonl', '.agent/gate/*.log', '**/*.log', 'a/**/b/?.txt', './x/y']) {
      expect(keepPatternError(p)).toBeNull();
    }
    expect(parseKeepPattern('./x/y').pattern).toBe('x/y');
  });

  it('rejects empty, absolute, traversing and malformed patterns', () => {
    expect(keepPatternError('')).toMatch(/empty/);
    expect(keepPatternError('  ')).toMatch(/empty/);
    expect(keepPatternError('/etc/passwd')).toMatch(/relative/);
    expect(keepPatternError('C:/x')).toMatch(/relative/);
    expect(keepPatternError('../x')).toMatch(/\.\./);
    expect(keepPatternError('a/../../x')).toMatch(/\.\./);
    expect(keepPatternError('a\\b')).toMatch(/\\/);
    expect(keepPatternError('a//b')).toMatch(/empty/);
    expect(keepPatternError('a/')).toMatch(/empty/);
    expect(keepPatternError('a/./b')).toMatch(/empty/);
    expect(keepPatternError('a/**')).toMatch(/end with/);
    expect(keepPatternError('a\0b')).toMatch(/NUL/);
    expect(() => parseKeepPattern('../x')).toThrow(/Invalid keep pattern/);
  });

  it('matches *, ? and ** like a shell glob (wildcards include dot files)', () => {
    expect(m('*.log', 'a.log')).toBe(true);
    expect(m('*.log', '.hidden.log')).toBe(true);
    expect(m('*.log', 'd/a.log')).toBe(false);
    expect(m('?.txt', 'a.txt')).toBe(true);
    expect(m('?.txt', 'ab.txt')).toBe(false);
    expect(m('**/*.log', 'a.log')).toBe(true);
    expect(m('**/*.log', 'x/y/z/a.log')).toBe(true);
    expect(m('a/**/b.txt', 'a/b.txt')).toBe(true);
    expect(m('a/**/b.txt', 'a/x/y/b.txt')).toBe(true);
    expect(m('a/**/b.txt', 'c/a/b.txt')).toBe(false);
    expect(m('a/**/**/b.txt', 'a/b.txt')).toBe(true);
    // Regex metacharacters are literal.
    expect(m('a+(b).[c]', 'a+(b).[c]')).toBe(true);
    expect(m('a.c', 'abc')).toBe(false);
  });
});
