import { describe, expect, it } from 'vitest';
import {
  checkValueLabel,
  decisionTone,
  eventSummary,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelative,
  isInternalHref,
  prettyJson,
  runBadges,
  safeHttpUrl,
  triggerSummary,
  truncate,
} from './format.js';

describe('triggerSummary', () => {
  it('lists all sources of a multi-source workflow (WI-20)', () => {
    expect(triggerSummary({ type: 'source', source: 'repo_a' })).toBe('source: repo_a');
    expect(triggerSummary({ type: 'source', source: 'repo_a', sources: ['repo_a', 'repo_b'] })).toBe('sources: repo_a, repo_b');
    expect(triggerSummary({ type: 'schedule', cron: '0 3 * * *' })).toBe('schedule: 0 3 * * * (UTC)');
    expect(triggerSummary({ type: 'manual' })).toBe('manual');
  });
});

describe('formatting', () => {
  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(2 * 3600_000 + 4 * 60_000)).toBe('2h 04m');
    expect(formatDuration(3 * 86400_000 + 2 * 3600_000)).toBe('3d 02h');
  });
  it('formatBytes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(3.2 * 1024 * 1024)).toBe('3.2 MiB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MiB');
  });
  it('formatDateTime / formatRelative', () => {
    expect(formatDateTime('2026-10-17T03:04:05.000Z', { utc: true })).toBe('2026-10-17 03:04:05');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('garbage')).toBe('garbage');
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(formatRelative('2026-10-17T12:00:00Z', now)).toBe('just now');
    expect(formatRelative('2026-10-17T11:59:30Z', now)).toBe('30s ago');
    expect(formatRelative('2026-10-17T11:00:00Z', now)).toBe('1h ago');
    expect(formatRelative('2026-10-17T12:05:00Z', now)).toBe('in 5m');
  });
  it('truncate / prettyJson', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson('x'.repeat(50), 10)).toMatch(/more characters not shown/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(prettyJson(cyclic)).toBe('[object Object]');
  });
});

describe('links', () => {
  it('safeHttpUrl allows only absolute http(s) URLs', () => {
    expect(safeHttpUrl('https://github.com/o/r/issues/1')).toBe('https://github.com/o/r/issues/1');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' https://x', 'data:text/html,x', 'vbscript:x', '/relative', '//host/x', 'file:///etc/passwd', 'java\nscript:x', '', null, 5]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
  it('isInternalHref', () => {
    expect(isInternalHref('#/runs/a')).toBe(true);
    expect(isInternalHref('#x')).toBe(false);
    expect(isInternalHref('#/a b')).toBe(false);
  });
});

describe('run outcome badges (Spec §21)', () => {
  const base = { status: 'completed', finalStatus: 'completed', lifecycleStatus: 'succeeded', lifecycleFailed: false };
  it('distinguishes business failure, technical error and cancelled', () => {
    expect(runBadges({ ...base, outcome: 'success' }).map((b) => b.label)).toEqual(['success']);
    const failure = runBadges({ ...base, outcome: 'failure' });
    expect(failure.map((b) => [b.label, b.tone])).toEqual([['failure (business)', 'warn']]);
    const crashed = runBadges({ ...base, status: 'crashed', finalStatus: 'crashed', outcome: 'technical_error' });
    expect(crashed.map((b) => [b.label, b.tone])).toEqual([['technical error: crashed', 'error']]);
    expect(runBadges({ ...base, status: 'timed_out', finalStatus: 'timed_out', outcome: 'technical_error' })[0]!.label).toBe('technical error: timed_out');
    expect(runBadges({ ...base, status: 'cancelled', outcome: 'cancelled' })[0]!.label).toBe('cancelled');
  });
  it('shows lifecycle failed as a separate badge', () => {
    const b = runBadges({ ...base, outcome: 'failure', lifecycleStatus: 'failed', lifecycleFailed: true });
    expect(b.map((x) => x.label)).toEqual(['failure (business)', 'lifecycle failed']);
    expect(runBadges({ ...base, outcome: 'success', lifecycleStatus: 'failed', lifecycleFailed: true }).map((x) => x.label)).toEqual(['success', 'lifecycle failed']);
  });
  it('active runs show their technical state', () => {
    expect(runBadges({ status: 'running', outcome: 'active', lifecycleStatus: null })[0]).toMatchObject({ label: 'running', tone: 'info' });
    // WI-17: the named outcome is an extra badge next to the business result.
    expect(runBadges({ ...base, outcome: 'failure', resultOutcome: 'needs_maintainer', completionHook: 'on_result.needs_maintainer' })).toEqual([
      expect.objectContaining({ label: 'failure (business)' }),
      { label: 'outcome: needs_maintainer', tone: 'info', title: 'Named outcome reported by the worker; completion hook on_result.needs_maintainer' },
    ]);
    expect(runBadges({ status: 'recovery_pending', outcome: 'active' })[0]).toMatchObject({ label: 'recovery pending', tone: 'warn' });
  });
});

describe('dry-run / events', () => {
  it('never shows not_evaluated as pass', () => {
    expect(checkValueLabel('not_evaluated')).toEqual({ label: 'unknown / not evaluated', tone: 'muted' });
    expect(checkValueLabel(true).label).toBe('pass');
    expect(checkValueLabel(false).label).toBe('fail');
    expect(checkValueLabel('unknown').label).toBe('unknown');
    expect(decisionTone('would_start')).toBe('ok');
    expect(decisionTone('filter_unknown')).toBe('warn');
    expect(decisionTone('filtered')).toBe('muted');
  });
  it('summarizes events', () => {
    expect(eventSummary({ type: 'run.status', payload: { from: 'starting', to: 'running' } })).toBe('starting → running');
    expect(eventSummary({ type: 'run.status', payload: { from: null, to: 'reserved' } })).toBe('→ reserved');
    expect(eventSummary({ type: 'progress', payload: { value: 60 } })).toBe('60%');
    expect(eventSummary({ type: 'status', payload: { message: 'Tests laufen' } })).toBe('Tests laufen');
    expect(eventSummary({ type: 'lifecycle.action', payload: { hook: 'on_success', name: 'label', type: 'source.update', status: 'failed', error: 'x' } })).toBe('on_success label failed: x');
    expect(
      eventSummary({
        type: 'lifecycle.action',
        payload: {
          hook: 'on_start',
          name: 'on_start.0',
          status: 'succeeded',
          details: { changed: true, applied: { labelsAdded: ['in-progress'], labelsRemoved: ['ready'], projectItemAdded: true, projectFields: { Status: 'In Progress', Estimate: 3, Notes: null } } },
        },
      }),
    ).toBe('on_start on_start.0 succeeded (+in-progress, -ready, added to project, Status=In Progress, Estimate=3, Notes cleared)');
    expect(eventSummary({ type: 'lifecycle.action', payload: { hook: 'on_start', name: 'x', status: 'succeeded', details: { changed: false } } })).toBe('on_start x succeeded');
    expect(eventSummary({ type: 'custom', payload: {} })).toBe('');
    expect(eventSummary({ type: 'custom', payload: null })).toBe('');
  });
});
