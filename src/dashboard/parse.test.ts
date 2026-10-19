import { describe, expect, it } from 'vitest';
import { infoValueStatus, MAX_INFO_TEXT_LENGTH, parseInfoOutput } from './parse.js';

const none = { warnAbove: null, criticalAbove: null, warnBelow: null, criticalBelow: null };

describe('parseInfoOutput (WI-24)', () => {
  it('text: first non-empty line, trimmed and shortened', () => {
    expect(parseInfoOutput('text', '\n\n  main is green  \nsecond')).toEqual({ ok: true, value: 'main is green' });
    const long = parseInfoOutput('text', 'x'.repeat(500));
    expect(long.ok && typeof long.value === 'string' && long.value.length).toBe(MAX_INFO_TEXT_LENGTH);
    expect(parseInfoOutput('text', '  \n\t\n')).toMatchObject({ ok: false, error: expect.stringContaining('no output') });
  });

  it('number: dot as decimal separator, optional configured unit', () => {
    expect(parseInfoOutput('number', '42\n')).toEqual({ ok: true, value: 42 });
    expect(parseInfoOutput('number', '-1.5')).toEqual({ ok: true, value: -1.5 });
    expect(parseInfoOutput('number', '.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseInfoOutput('number', '12.5 GB', 'GB')).toEqual({ ok: true, value: 12.5 });
    expect(parseInfoOutput('number', '12.5GB', 'GB')).toEqual({ ok: true, value: 12.5 });
    for (const bad of ['1,5', '12 MB', 'abc', '1e3', 'Infinity', '0x10', '']) {
      expect(parseInfoOutput('number', bad, 'GB').ok, bad).toBe(false);
    }
    expect(parseInfoOutput('number', '1,5')).toMatchObject({ ok: false, error: expect.stringContaining('unparsable output "1,5"') });
  });

  it('percent: 0–100, optionally with %', () => {
    expect(parseInfoOutput('percent', '87%')).toEqual({ ok: true, value: 87 });
    expect(parseInfoOutput('percent', '0')).toEqual({ ok: true, value: 0 });
    expect(parseInfoOutput('percent', '100 %')).toEqual({ ok: true, value: 100 });
    expect(parseInfoOutput('percent', '101')).toMatchObject({ ok: false, error: 'percent value 101 is outside 0–100' });
    expect(parseInfoOutput('percent', '-3%').ok).toBe(false);
    expect(parseInfoOutput('percent', 'full').ok).toBe(false);
  });
});

describe('infoValueStatus (WI-24)', () => {
  it('applies above/below thresholds, critical first, inclusive', () => {
    const above = { ...none, warnAbove: 80, criticalAbove: 95 };
    expect(infoValueStatus(79.9, above)).toBe('ok');
    expect(infoValueStatus(80, above)).toBe('warn');
    expect(infoValueStatus(95, above)).toBe('critical');
    const below = { ...none, warnBelow: 20, criticalBelow: 5 };
    expect(infoValueStatus(21, below)).toBe('ok');
    expect(infoValueStatus(20, below)).toBe('warn');
    expect(infoValueStatus(5, below)).toBe('critical');
    expect(infoValueStatus(50, none)).toBe('ok');
    expect(infoValueStatus('text', above)).toBe('ok');
  });
});
