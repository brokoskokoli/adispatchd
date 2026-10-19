import { describe, expect, it } from 'vitest';
import { displayText, sanitizeDisplayText, shortenText } from './display-text.js';

const redact = (s: string): string => s.replaceAll('SECRET-TOKEN-123', '[REDACTED]');

describe('display text (WI-24)', () => {
  it('removes ANSI escapes, control and bidi characters', () => {
    expect(sanitizeDisplayText('\u001b[31mred\u001b[0m text')).toBe('red text');
    expect(sanitizeDisplayText('\u001b]0;title\u0007after')).toBe('after');
    expect(sanitizeDisplayText('a\u0000b\u0007c\u007fd\u009be')).toBe('abcde');
    expect(sanitizeDisplayText('tab\there\r')).toBe('tab here');
    expect(sanitizeDisplayText('admin\u202e\u2066txt.exe\u2069\u200f')).toBe('admintxt.exe');
  });

  it('redacts before shortening: a secret at the cut position never leaks partially', () => {
    const line = `${'x'.repeat(190)}SECRET-TOKEN-123`;
    expect(shortenText(line, 200)).toContain('SECRET-'); // what naive cut-then-redact would expose
    const shown = displayText(line, 200, redact);
    expect(shown).not.toContain('SECRET');
    expect(shown.length).toBeLessThanOrEqual(200);
    // A secret split by an escape sequence is still found.
    expect(displayText('SECRET-\u001b[1mTOKEN-123', 50, redact)).toBe('[REDACTED]');
  });
});
