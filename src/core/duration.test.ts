import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, parseSize, tryParseDuration } from './duration.js';
import { ValidationError } from './errors.js';

describe('parseDuration', () => {
  it.each([
    ['100ms', 100],
    ['30s', 30_000],
    ['45m', 2_700_000],
    ['6h', 21_600_000],
    ['30d', 2_592_000_000],
    ['1.5h', 5_400_000],
    [' 0s ', 0],
  ])('parses %j', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', '30', 's', '-5s', '1h30m', '5 min', '10x', '0.5ms', 'abc'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(ValidationError);
    expect(tryParseDuration(input)).toBeUndefined();
  });

  it('rejects non-strings', () => {
    expect(() => parseDuration(30 as unknown as string)).toThrow(ValidationError);
  });

  it('formats durations', () => {
    expect(formatDuration(90_000)).toBe('90s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(1_500)).toBe('1500ms');
  });
});

describe('parseSize', () => {
  it.each([
    ['100MB', 100 * 1024 * 1024],
    ['512KB', 512 * 1024],
    ['1GB', 1024 ** 3],
    ['10b', 10],
    ['2MiB', 2 * 1024 * 1024],
    ['1.5 kb', 1536],
  ])('parses %j', (input, bytes) => {
    expect(parseSize(input)).toBe(bytes);
  });

  it.each(['', '100', 'MB', '-1MB', '10TB', '1e3MB'])('rejects %j', (input) => {
    expect(() => parseSize(input)).toThrow(ValidationError);
  });
});
