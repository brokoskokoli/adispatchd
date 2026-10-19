import { describe, expect, it } from 'vitest';
import { checkCountsText, checkCountsTone, checkTitle, conditionStatusInfo, formatInfoValue, infoStatusLabel, infoStatusTone } from './checks.js';

describe('condition display (WI-24)', () => {
  it('maps statuses to colors: green ok, red not now, yellow check error, grey not evaluated / never', () => {
    expect(conditionStatusInfo('ok')).toEqual({ label: 'ok', tone: 'ok' });
    expect(conditionStatusInfo('not_now')).toEqual({ label: 'not now', tone: 'error' });
    expect(conditionStatusInfo('error')).toEqual({ label: 'check error', tone: 'warn' });
    expect(conditionStatusInfo('skipped')).toEqual({ label: 'not evaluated', tone: 'muted' });
    expect(conditionStatusInfo(null)).toEqual({ label: 'never checked', tone: 'muted' });
  });

  it('shows the name instead of the command when configured', () => {
    expect(checkTitle({ name: 'Credits available', command: '/x/check.sh' })).toBe('Credits available');
    expect(checkTitle({ name: null, command: '/x/check.sh' })).toBe('/x/check.sh');
    expect(checkTitle({ command: '/x/check.sh' })).toBe('/x/check.sh');
  });

  it('summarizes item checks', () => {
    expect(checkCountsText({ items: 3, ok: 1, notNow: 1, error: 1, notEvaluated: 0 })).toBe('3 item(s): 1 ok · 1 not now · 1 error');
    expect(checkCountsText({ items: 0, ok: 0, notNow: 0, error: 0 })).toBe('no items checked');
    expect(checkCountsTone({ items: 2, ok: 2, notNow: 0, error: 0 })).toBe('ok');
    expect(checkCountsTone({ items: 2, ok: 1, notNow: 0, error: 1 })).toBe('warn');
    expect(checkCountsTone({ items: 2, ok: 1, notNow: 1, error: 1 })).toBe('error');
    expect(checkCountsTone({ items: 0, ok: 0, notNow: 0, error: 0 })).toBe('muted');
  });
});

describe('info tile display (WI-24)', () => {
  it('formats values with unit', () => {
    expect(formatInfoValue(87, '%')).toBe('87%');
    expect(formatInfoValue(12.3456, 'GB')).toBe('12.35 GB');
    expect(formatInfoValue(3, null)).toBe('3');
    expect(formatInfoValue('main is green', null)).toBe('main is green');
    expect(formatInfoValue(null, 'GB')).toBe('—');
  });

  it('colors by status', () => {
    expect(infoStatusTone('ok')).toBe('ok');
    expect(infoStatusTone('warn')).toBe('warn');
    expect(infoStatusTone('critical')).toBe('error');
    expect(infoStatusTone('error')).toBe('error');
    expect(infoStatusTone('pending')).toBe('muted');
    expect(infoStatusLabel('error', true)).toBe('error (stale value)');
    expect(infoStatusLabel('critical')).toBe('critical');
  });
});
