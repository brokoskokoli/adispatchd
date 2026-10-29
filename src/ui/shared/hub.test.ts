import { describe, expect, it } from 'vitest';
import {
  applyLive,
  fullestDisk,
  hubConfirm,
  mayControl,
  parseAudit,
  parseModel,
  parseResources,
  parseStatus,
  parseWorkspace,
  parseWorkspaces,
  slotsText,
  stateBadge,
  visibleHubActions,
  workspaceActions,
  workspaceConfirm,
  workspaceNote,
  type HubWorkspace,
} from './hub.js';

const ws = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'coder',
  enabled: true,
  state: 'running',
  transition: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  restarts: 1,
  crashes: 2,
  lastExit: null,
  nextRestartAt: null,
  message: null,
  slots: 2,
  connected: true,
  activity: { version: '0.9.1', activeRuns: 2, supervisedRuns: 2, recoveryPending: 0, activeBlocks: 1, failedActions: 3, failedNotifications: 0, scheduler: { state: 'running', paused: false, draining: false }, ownLimit: 4 },
  ...extra,
});
const status = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 'x',
  startedAt: 'T',
  state: 'running',
  paused: false,
  slots: { max: 5, active: 2, byWorkspace: { coder: 2 } },
  resources: null,
  ...extra,
});

describe('parsing', () => {
  it('parses a workspace defensively', () => {
    const w = parseWorkspace(ws())!;
    expect(w).toMatchObject({ id: 'coder', state: 'running', slots: 2, connected: true, activity: { activeRuns: 2, activeBlocks: 1, failedActions: 3, scheduler: { state: 'running' } } });
    expect(parseWorkspace(ws({ activity: null }))!.activity).toBeNull();
    expect(parseWorkspace(ws({ state: 'weird' }))).toBeNull();
    expect(parseWorkspace(ws({ id: '<script>' }))).toBeNull();
    expect(parseWorkspace(ws({ id: 'Up' }))).toBeNull();
    expect(parseWorkspace('x')).toBeNull();
    expect(parseWorkspace(ws({ transition: 'draining' }))!.transition).toBe('draining');
    expect(parseWorkspace(ws({ transition: 'bogus' }))!.transition).toBeNull();
    expect(parseWorkspace(ws({ slots: -4, restarts: 'x' }))).toMatchObject({ slots: 0, restarts: 0 });
    expect(parseWorkspace(ws({ message: 'm'.repeat(5000) }))!.message).toHaveLength(1000);
  });

  it('parses lists, status and resources; garbage becomes empty or null', () => {
    expect(parseWorkspaces({ workspaces: [ws(), ws({ id: 'docs' }), { id: 1 }, null] }).map((w) => w.id)).toEqual(['coder', 'docs']);
    expect(parseWorkspaces(null)).toEqual([]);
    expect(parseStatus(status())).toMatchObject({ state: 'running', slots: { max: 5, active: 2, byWorkspace: { coder: 2 } } });
    expect(parseStatus(status({ slots: { max: 0, active: 1, byWorkspace: { a: -1 } } }))!.slots).toEqual({ max: 1, active: 1, byWorkspace: { a: 0 } });
    expect(parseStatus({})).toBeNull();
    const r = parseResources({ at: 'T', cpu: { percent: 140, cores: 0, load: [1, 2] }, memory: { usedBytes: 5, totalBytes: 10 }, disks: [{ path: '/x', freeBytes: 1, totalBytes: 4 }, 3] });
    expect(r).toMatchObject({ cpu: { percent: 100, cores: 1, load: [1, 2, 0] }, memory: { usedBytes: 5, totalBytes: 10 }, disks: [{ path: '/x', freeBytes: 1, totalBytes: 4 }] });
    expect(parseResources(null)).toBeNull();
    expect(parseModel(status(), { workspaces: [ws()] }).workspaces).toHaveLength(1);
  });

  it('parses audit rows', () => {
    const rows = parseAudit({ entries: [{ id: 3, at: 'T', actor: 'alice', role: 'admin', via: 'password', action: 'hub.pause', workspace: null, result: 'ok', error: null }, { id: 2, action: 'x', result: 'failed', error: 'invalid_state' }, 7] });
    expect(rows.map((r) => [r.id, r.actor, r.result, r.error])).toEqual([
      [3, 'alice', 'ok', null],
      [2, null, 'failed', 'invalid_state'],
    ]);
    expect(parseAudit(null)).toEqual([]);
  });
});

describe('live updates', () => {
  const base = parseModel(status(), { workspaces: [ws(), ws({ id: 'docs', slots: 0 })] });

  it('replaces everything on a snapshot', () => {
    const r = applyLive({ status: null, workspaces: [] }, 'hub.snapshot', { status: status(), workspaces: [ws()] });
    expect(r.change).toEqual({ kind: 'all' });
    expect(r.model.workspaces).toHaveLength(1);
    expect(r.model.status?.slots.max).toBe(5);
  });

  it('updates one workspace, appends an unknown one and ignores garbage', () => {
    const changed = applyLive(base, 'hub.workspace', ws({ id: 'docs', state: 'backoff', message: 'crashed' }));
    expect(changed.change).toEqual({ kind: 'workspace', id: 'docs' });
    expect(changed.model.workspaces.map((w) => [w.id, w.state])).toEqual([
      ['coder', 'running'],
      ['docs', 'backoff'],
    ]);
    expect(base.workspaces[1]!.state).toBe('running'); // input untouched
    expect(applyLive(base, 'hub.workspace', ws({ id: 'new' })).model.workspaces.map((w) => w.id)).toEqual(['coder', 'docs', 'new']);
    expect(applyLive(base, 'hub.workspace', { id: 3 }).change).toEqual({ kind: 'none' });
    expect(applyLive(base, 'run.event', {}).change).toEqual({ kind: 'none' });
  });

  it('keeps the resources when the status changes, and the status when resources change', () => {
    const withRes = applyLive(base, 'hub.resources', { at: 'T', cpu: { percent: 10, cores: 2, load: [0, 0, 0] }, memory: { usedBytes: 1, totalBytes: 2 }, disks: [] });
    expect(withRes.change).toEqual({ kind: 'resources' });
    expect(withRes.model.status?.resources?.cpu.percent).toBe(10);
    const paused = applyLive(withRes.model, 'hub.status', status({ state: 'paused', paused: true, workspaces: { total: 2 } }));
    expect(paused.change).toEqual({ kind: 'status' });
    expect(paused.model.status).toMatchObject({ paused: true, state: 'paused', resources: { cpu: { percent: 10 } } });
    expect(applyLive({ status: null, workspaces: [] }, 'hub.resources', {}).change).toEqual({ kind: 'none' });
  });
});

describe('presentation rules', () => {
  const w = (state: string, transition: string | null = null, enabled = true): HubWorkspace => parseWorkspace(ws({ state, transition, enabled }))!;

  it('badges: a requested transition wins over the state', () => {
    expect(stateBadge(w('running'))).toEqual({ label: 'running', tone: 'ok' });
    expect(stateBadge(w('running', 'draining'))).toEqual({ label: 'draining', tone: 'warn' });
    expect(stateBadge(w('running', 'stopping'))).toEqual({ label: 'stopping', tone: 'warn' });
    expect(stateBadge(w('starting', 'restarting'))).toEqual({ label: 'restarting', tone: 'warn' });
    expect(stateBadge(w('backoff')).tone).toBe('warn');
    expect(stateBadge(w('failed')).tone).toBe('error');
    expect(stateBadge(w('stopped'))).toEqual({ label: 'stopped', tone: 'muted' });
    expect(stateBadge(w('stopped', null, false)).label).toBe('disabled');
  });

  it('offers the actions that make sense in a state', () => {
    const enabled = (state: string, transition: string | null = null): string[] => workspaceActions(w(state, transition)).filter((a) => a.enabled).map((a) => a.action);
    expect(enabled('running')).toEqual(['drain', 'restart', 'stop']);
    expect(enabled('starting')).toEqual(['drain', 'restart', 'stop']);
    expect(enabled('stopped')).toEqual(['start']);
    expect(enabled('failed')).toEqual(['start']);
    expect(enabled('backoff')).toEqual(['start', 'stop']); // starting now skips the wait; stopping cancels the restart
    expect(enabled('running', 'draining')).toEqual(['stop']);
    expect(enabled('running', 'stopping')).toEqual([]);
    expect(enabled('running', 'restarting')).toEqual(['stop']);
    const disabled = workspaceActions(w('running', 'stopping')).find((a) => a.action === 'drain')!;
    expect(disabled.reason).toBe('Already stopping');
    expect(workspaceActions(w('running')).filter((a) => a.confirm).map((a) => a.action)).toEqual(['drain', 'restart', 'stop']);
  });

  it('shows control buttons only to operators and admins', () => {
    expect(mayControl('viewer')).toBe(false);
    expect(mayControl(null)).toBe(false);
    expect(mayControl('operator')).toBe(true);
    expect(mayControl('admin')).toBe(true);
    expect(visibleHubActions('viewer', false)).toEqual([]);
    expect(visibleHubActions(null, false)).toEqual([]);
    expect(visibleHubActions('operator', false)).toEqual(['pause', 'drain-all', 'stop-all']);
    expect(visibleHubActions('admin', true)).toEqual(['resume', 'drain-all', 'stop-all']);
  });

  it('has a confirmation text for every destructive action and none for resume/start', () => {
    for (const a of ['drain-all', 'stop-all', 'pause'] as const) {
      const c = hubConfirm(a)!;
      expect(c.title).toBeTruthy();
      expect(c.message.length).toBeGreaterThan(20);
    }
    expect(hubConfirm('stop-all')!.danger).toBe(true);
    expect(hubConfirm('resume')).toBeNull();
    expect(workspaceConfirm('stop', 'coder')).toMatchObject({ danger: true, confirmLabel: 'Stop' });
    expect(workspaceConfirm('drain', 'coder').message).toContain('"coder"');
  });

  it('notes what needs attention', () => {
    expect(workspaceNote(parseWorkspace(ws({ message: 'configuration error' }))!)).toBe('configuration error');
    expect(workspaceNote(parseWorkspace(ws({ connected: false }))!)).toContain('No slot connection');
    expect(workspaceNote(parseWorkspace(ws({ connected: false, transition: 'draining' }))!)).toBeNull();
    expect(workspaceNote(parseWorkspace(ws({ state: 'stopped', lastExit: { code: 1, signal: null, at: 'T' } }))!)).toBe('Last exit code 1.');
    expect(workspaceNote(parseWorkspace(ws())!)).toBeNull();
  });

  it('formats slots and finds the fullest disk', () => {
    expect(slotsText(2, 5)).toBe('2/5');
    expect(fullestDisk({ at: 'T', cpu: { percent: 0, cores: 1, load: [0, 0, 0] }, memory: { usedBytes: 0, totalBytes: 0 }, disks: [{ path: '/a', freeBytes: 50, totalBytes: 100 }, { path: '/b', freeBytes: 10, totalBytes: 100 }, { path: '/c', freeBytes: 0, totalBytes: 0 }] })).toMatchObject({ path: '/b', fraction: 0.9 });
    expect(fullestDisk({ at: 'T', cpu: { percent: 0, cores: 1, load: [0, 0, 0] }, memory: { usedBytes: 0, totalBytes: 0 }, disks: [] })).toBeNull();
  });
});
