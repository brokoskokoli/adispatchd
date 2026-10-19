import { describe, expect, it } from 'vitest';
import { MAX_RESULT_FILE_BYTES, parseWorkerResult } from './worker-protocol.js';

describe('parseWorkerResult', () => {
  it('accepts the spec example (§9.2)', () => {
    const parsed = parseWorkerResult(
      JSON.stringify({
        schema_version: 1,
        result: 'failure',
        message: 'OAuth-Anbieter nicht spezifiziert',
        details: { missing_information: ['OAuth provider', 'Scopes'] },
        artifacts: [{ type: 'url', name: 'Draft PR', url: 'https://github.com/example/project-a/pull/142' }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.result).toBe('failure');
  });

  it.each([
    ['not json', '{'],
    ['wrong version', JSON.stringify({ schema_version: 2, result: 'success' })],
    ['missing result', JSON.stringify({ schema_version: 1 })],
    ['invalid result', JSON.stringify({ schema_version: 1, result: 'maybe' })],
    ['array', '[]'],
  ])('rejects %s', (_name, content) => {
    expect(parseWorkerResult(content).ok).toBe(false);
  });

  it('accepts a named outcome in config-ID format (WI-17)', () => {
    const parsed = parseWorkerResult(JSON.stringify({ schema_version: 1, result: 'failure', outcome: 'needs_maintainer' }));
    expect(parsed).toEqual({ ok: true, result: { schema_version: 1, result: 'failure', outcome: 'needs_maintainer' }, warnings: [] });
  });

  it.each([
    ['spaces', 'needs maintainer'],
    ['a number', 42],
    ['null', null],
    ['too long', 'x'.repeat(65)],
  ])('ignores an outcome with %s and warns, the rest is evaluated', (_name, outcome) => {
    const parsed = parseWorkerResult(JSON.stringify({ schema_version: 1, result: 'success', message: 'ok', outcome }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result).toEqual({ schema_version: 1, result: 'success', message: 'ok' });
    expect(parsed.warnings).toEqual([expect.stringMatching(/^outcome ignored: expected an ID/)]);
  });

  it('describes an ignored outcome with a bounded preview only', () => {
    const preview = (outcome: unknown): string => {
      const parsed = parseWorkerResult(JSON.stringify({ schema_version: 1, result: 'success', outcome }));
      return parsed.ok ? (parsed.warnings[0] ?? '') : '';
    };
    expect(preview('x'.repeat(500_000))).toMatch(new RegExp(`got "${'x'.repeat(80)}"…$`));
    expect(preview('bad id')).toMatch(/got "bad id"$/);
    expect(preview(Array.from({ length: 1000 }, () => 'y'.repeat(100)))).toMatch(/got an array \(1000 entries\)$/);
    expect(preview({ nested: 'z'.repeat(10_000) })).toMatch(/got an object$/);
    expect(preview(42)).toMatch(/got 42$/);
    expect(preview('x'.repeat(500_000)).length).toBeLessThan(250);
  });

  it('rejects oversized files', () => {
    const big = JSON.stringify({ schema_version: 1, result: 'success', message: 'x'.repeat(MAX_RESULT_FILE_BYTES) });
    const parsed = parseWorkerResult(big);
    expect(parsed.ok).toBe(false);
  });
});
