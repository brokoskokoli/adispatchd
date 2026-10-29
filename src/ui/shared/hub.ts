/**
 * Overview of the hub (WI-36), DOM-free so it is unit-testable: defensive
 * parsing of the hub API payloads, the model that live events update, which
 * actions a workspace offers in which state, and the texts of the confirmation
 * dialogs. Nothing from the payloads is ever interpreted as HTML.
 */
import type { Tone } from './format.js';
import { roleAllows, type Role } from './auth.js';

export type WorkspaceState = 'starting' | 'running' | 'backoff' | 'stopped' | 'failed';
export type WorkspaceTransition = 'draining' | 'stopping' | 'restarting';
export type WorkspaceAction = 'start' | 'stop' | 'restart' | 'drain';
export type HubWideAction = 'pause' | 'resume' | 'drain-all' | 'stop-all';

const STATES: readonly string[] = ['starting', 'running', 'backoff', 'stopped', 'failed'];
const TRANSITIONS: readonly string[] = ['draining', 'stopping', 'restarting'];

/** What the overview shows about a running workspace instance. */
export interface HubActivity {
  version: string;
  activeRuns: number;
  supervisedRuns: number;
  recoveryPending: number;
  activeBlocks: number;
  failedActions: number;
  failedNotifications: number;
  scheduler: { state: string; paused: boolean; draining: boolean };
  ownLimit: number;
}

/** One workspace (`GET /api/v1/hub/workspaces`). */
export interface HubWorkspace {
  id: string;
  enabled: boolean;
  state: WorkspaceState;
  transition: WorkspaceTransition | null;
  startedAt: string | null;
  restarts: number;
  crashes: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  nextRestartAt: string | null;
  message: string | null;
  slots: number;
  connected: boolean;
  activity: HubActivity | null;
}

export interface HubResources {
  at: string;
  cpu: { percent: number; cores: number; load: [number, number, number] };
  memory: { usedBytes: number; totalBytes: number };
  disks: Array<{ path: string; freeBytes: number; totalBytes: number }>;
}

/** `GET /api/v1/hub/status`. */
export interface HubStatus {
  version: string;
  startedAt: string;
  state: 'running' | 'paused' | 'stopping';
  paused: boolean;
  slots: { max: number; active: number; byWorkspace: Record<string, number> };
  resources: HubResources | null;
}

/** Everything the page shows. */
export interface HubModel {
  status: HubStatus | null;
  workspaces: HubWorkspace[];
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const nonNeg = (v: unknown): number => Math.max(0, num(v));

export function parseActivity(v: unknown): HubActivity | null {
  const o = obj(v);
  if (!o) return null;
  const s = obj(o.scheduler) ?? {};
  return {
    version: str(o.version, 40) ?? '',
    activeRuns: nonNeg(o.activeRuns),
    supervisedRuns: nonNeg(o.supervisedRuns),
    recoveryPending: nonNeg(o.recoveryPending),
    activeBlocks: nonNeg(o.activeBlocks),
    failedActions: nonNeg(o.failedActions),
    failedNotifications: nonNeg(o.failedNotifications),
    scheduler: { state: str(s.state, 20) ?? 'unknown', paused: s.paused === true, draining: s.draining === true },
    ownLimit: nonNeg(o.ownLimit),
  };
}

export function parseWorkspace(v: unknown): HubWorkspace | null {
  const o = obj(v);
  if (!o) return null;
  const id = str(o.id, 40);
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const state = typeof o.state === 'string' && STATES.includes(o.state) ? (o.state as WorkspaceState) : null;
  if (!state) return null;
  const exit = obj(o.lastExit);
  return {
    id,
    enabled: o.enabled !== false,
    state,
    transition: typeof o.transition === 'string' && TRANSITIONS.includes(o.transition) ? (o.transition as WorkspaceTransition) : null,
    startedAt: str(o.startedAt, 40),
    restarts: nonNeg(o.restarts),
    crashes: nonNeg(o.crashes),
    lastExit: exit ? { code: typeof exit.code === 'number' ? exit.code : null, signal: str(exit.signal, 20), at: str(exit.at, 40) ?? '' } : null,
    nextRestartAt: str(o.nextRestartAt, 40),
    message: str(o.message, 1000),
    slots: nonNeg(o.slots),
    connected: o.connected === true,
    activity: parseActivity(o.activity),
  };
}

export function parseWorkspaces(v: unknown): HubWorkspace[] {
  const list = obj(v)?.workspaces;
  return Array.isArray(list) ? list.map(parseWorkspace).filter((w): w is HubWorkspace => w !== null) : [];
}

export function parseResources(v: unknown): HubResources | null {
  const o = obj(v);
  const cpu = obj(o?.cpu);
  const mem = obj(o?.memory);
  if (!o || !cpu || !mem) return null;
  const load = Array.isArray(cpu.load) ? cpu.load.map((x) => num(x)) : [];
  return {
    at: str(o.at, 40) ?? '',
    cpu: { percent: Math.min(100, nonNeg(cpu.percent)), cores: Math.max(1, nonNeg(cpu.cores)), load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] },
    memory: { usedBytes: nonNeg(mem.usedBytes), totalBytes: nonNeg(mem.totalBytes) },
    disks: (Array.isArray(o.disks) ? o.disks : [])
      .map(obj)
      .filter((d): d is Record<string, unknown> => d !== null)
      .map((d) => ({ path: str(d.path, 300) ?? '', freeBytes: nonNeg(d.freeBytes), totalBytes: nonNeg(d.totalBytes) })),
  };
}

export function parseStatus(v: unknown): HubStatus | null {
  const o = obj(v);
  const slots = obj(o?.slots);
  if (!o || !slots) return null;
  const by = obj(slots.byWorkspace) ?? {};
  return {
    version: str(o.version, 40) ?? '',
    startedAt: str(o.startedAt, 40) ?? '',
    state: o.state === 'paused' || o.state === 'stopping' ? o.state : 'running',
    paused: o.paused === true,
    slots: {
      max: Math.max(1, nonNeg(slots.max)),
      active: nonNeg(slots.active),
      byWorkspace: Object.fromEntries(Object.entries(by).map(([k, n]) => [k, nonNeg(n)])),
    },
    resources: parseResources(o.resources),
  };
}

/** `hub.snapshot` / REST load → model. */
export function parseModel(statusBody: unknown, workspacesBody: unknown): HubModel {
  return { status: parseStatus(statusBody), workspaces: parseWorkspaces(workspacesBody) };
}

/**
 * Apply one live message (`hub.snapshot`, `hub.status`, `hub.workspace`,
 * `hub.resources`). Returns the (possibly new) model and what changed so the
 * page re-renders only that part.
 */
export type HubChange = { kind: 'all' } | { kind: 'status' } | { kind: 'resources' } | { kind: 'workspace'; id: string } | { kind: 'none' };

export function applyLive(model: HubModel, type: string, payload: Record<string, unknown>): { model: HubModel; change: HubChange } {
  switch (type) {
    case 'hub.snapshot':
      return { model: parseModel(payload.status, { workspaces: payload.workspaces }), change: { kind: 'all' } };
    case 'hub.status': {
      const status = parseStatus({ ...payload, resources: model.status?.resources ?? null });
      return status ? { model: { ...model, status }, change: { kind: 'status' } } : { model, change: { kind: 'none' } };
    }
    case 'hub.resources': {
      if (!model.status) return { model, change: { kind: 'none' } };
      return { model: { ...model, status: { ...model.status, resources: parseResources(payload) } }, change: { kind: 'resources' } };
    }
    case 'hub.workspace': {
      const w = parseWorkspace(payload);
      if (!w) return { model, change: { kind: 'none' } };
      const known = model.workspaces.some((x) => x.id === w.id);
      const workspaces = known ? model.workspaces.map((x) => (x.id === w.id ? w : x)) : [...model.workspaces, w];
      return { model: { ...model, workspaces }, change: { kind: 'workspace', id: w.id } };
    }
    default:
      return { model, change: { kind: 'none' } };
  }
}

/** Badge of the state; a requested transition is shown instead of the state. */
export function stateBadge(w: Pick<HubWorkspace, 'state' | 'transition' | 'enabled'>): { label: string; tone: Tone } {
  if (w.transition === 'draining') return { label: 'draining', tone: 'warn' };
  if (w.transition === 'stopping') return { label: 'stopping', tone: 'warn' };
  if (w.transition === 'restarting') return { label: 'restarting', tone: 'warn' };
  switch (w.state) {
    case 'running':
      return { label: 'running', tone: 'ok' };
    case 'starting':
      return { label: 'starting', tone: 'info' };
    case 'backoff':
      return { label: 'restarting after crash', tone: 'warn' };
    case 'failed':
      return { label: 'failed', tone: 'error' };
    case 'stopped':
      return { label: w.enabled ? 'stopped' : 'disabled', tone: 'muted' };
  }
}

/** One button of a workspace tile. */
export interface ActionSpec {
  action: WorkspaceAction;
  label: string;
  enabled: boolean;
  /** Needs a confirmation (it ends or interrupts work). */
  confirm: boolean;
  /** Why it is disabled. */
  reason?: string;
}

/** Actions of a workspace in its current state (`stop` is also valid while it waits for a restart). */
export function workspaceActions(w: Pick<HubWorkspace, 'state' | 'transition'>): ActionSpec[] {
  const busy = w.transition !== null;
  const hasProcess = w.state === 'starting' || w.state === 'running';
  const why = (ok: boolean, reason: string): { enabled: boolean; reason?: string } => (ok ? { enabled: true } : { enabled: false, reason });
  return [
    { action: 'start', label: 'Start', confirm: false, ...why(!hasProcess && !busy, hasProcess || busy ? 'Already running' : '') },
    { action: 'drain', label: 'Drain', confirm: true, ...why(hasProcess && !busy, busy ? `Already ${w.transition}` : 'Not running') },
    { action: 'restart', label: 'Restart', confirm: true, ...why(hasProcess && !busy, busy ? `Already ${w.transition}` : 'Not running') },
    { action: 'stop', label: 'Stop', confirm: true, ...why((hasProcess || w.state === 'backoff') && w.transition !== 'stopping', w.transition === 'stopping' ? 'Already stopping' : 'Not running') },
  ];
}

/** Texts of the confirmation dialog of a workspace action. */
export function workspaceConfirm(action: WorkspaceAction, id: string): { title: string; message: string; confirmLabel: string; danger: boolean } {
  switch (action) {
    case 'drain':
      return { title: `Drain ${id}?`, message: `No new runs start in "${id}"; running runs finish normally, then the workspace stops and stays stopped.`, confirmLabel: 'Drain', danger: false };
    case 'restart':
      return {
        title: `Restart ${id}?`,
        message: `"${id}" is drained (running runs get the drain timeout, then they are cancelled) and started again.`,
        confirmLabel: 'Restart',
        danger: true,
      };
    case 'stop':
      return { title: `Stop ${id}?`, message: `All runs of "${id}" are cancelled and the workspace stops. It stays stopped until you start it.`, confirmLabel: 'Stop', danger: true };
    case 'start':
      return { title: `Start ${id}?`, message: '', confirmLabel: 'Start', danger: false };
  }
}

/** Texts of the confirmation dialogs of the hub-wide actions. */
export function hubConfirm(action: HubWideAction): { title: string; message: string; confirmLabel: string; danger: boolean } | null {
  switch (action) {
    case 'pause':
      return { title: 'Pause the hub?', message: 'No workspace starts new automatic runs until you resume. Running runs and manual starts are not affected.', confirmLabel: 'Pause', danger: false };
    case 'drain-all':
      return {
        title: 'Drain all workspaces?',
        message: 'No new runs start anywhere; running runs finish normally, then every workspace stops and stays stopped.',
        confirmLabel: 'Drain all',
        danger: false,
      };
    case 'stop-all':
      return { title: 'Stop all workspaces?', message: 'All running runs in every workspace are cancelled and the workspaces stop. They stay stopped until you start them.', confirmLabel: 'Stop all', danger: true };
    case 'resume':
      return null;
  }
}

/** The hub-wide buttons the role may use (empty for viewers: they are not shown at all). */
export function visibleHubActions(role: Role | null, paused: boolean): HubWideAction[] {
  if (!roleAllows(role, 'operator')) return [];
  return [paused ? 'resume' : 'pause', 'drain-all', 'stop-all'];
}

/** Whether control buttons are shown at all. */
export function mayControl(role: Role | null): boolean {
  return roleAllows(role, 'operator');
}

/** Short explanation under a tile (what needs attention), or `null`. */
export function workspaceNote(w: HubWorkspace): string | null {
  if (w.message) return w.message;
  if (w.state === 'running' && !w.connected && w.transition === null) return 'No slot connection to the hub yet: automatic runs do not start.';
  if (w.state === 'stopped' && w.lastExit && w.lastExit.code !== 0 && w.lastExit.code !== null) return `Last exit code ${w.lastExit.code}.`;
  return null;
}

/** `2/5`. */
export const slotsText = (active: number, max: number): string => `${active}/${max}`;

/** Fullest disk of the resources (highest used fraction), or `null`. */
export function fullestDisk(r: HubResources): { path: string; fraction: number; freeBytes: number; totalBytes: number } | null {
  let best: { path: string; fraction: number; freeBytes: number; totalBytes: number } | null = null;
  for (const d of r.disks) {
    if (d.totalBytes <= 0) continue;
    const fraction = Math.min(1, Math.max(0, 1 - d.freeBytes / d.totalBytes));
    if (!best || fraction > best.fraction) best = { ...d, fraction };
  }
  return best;
}

/** One audit entry (`GET /api/v1/hub/audit`). */
export interface HubAuditRow {
  id: number;
  at: string;
  actor: string | null;
  role: string | null;
  via: string;
  action: string;
  workspace: string | null;
  result: 'ok' | 'failed';
  error: string | null;
}

export function parseAudit(v: unknown): HubAuditRow[] {
  const list = obj(v)?.entries;
  if (!Array.isArray(list)) return [];
  return list
    .map(obj)
    .filter((e): e is Record<string, unknown> => e !== null)
    .map((e) => ({
      id: num(e.id),
      at: str(e.at, 40) ?? '',
      actor: str(e.actor, 320),
      role: str(e.role, 20),
      via: str(e.via, 30) ?? '',
      action: str(e.action, 40) ?? '',
      workspace: str(e.workspace, 40),
      result: e.result === 'failed' ? ('failed' as const) : ('ok' as const),
      error: str(e.error, 100),
    }));
}
