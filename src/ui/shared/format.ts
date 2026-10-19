/**
 * Pure formatting helpers of the web UI (no DOM). Compiled for the browser
 * (tsconfig.ui.json) and unit-tested under Node.
 */

/** Visual tone of a badge / message. */
export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted';

/** Duration as `850 ms`, `12s`, `3m 05s`, `2h 04m`, `3d 02h`; `—` for null/invalid. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${String(h % 24).padStart(2, '0')}h`;
}

/** Byte size as `0 B`, `512 B`, `1.5 KiB`, `3.2 MiB`, `1.1 GiB`; `—` for null. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * ISO timestamp as `YYYY-MM-DD HH:MM:SS` in local time (or UTC with
 * `utc: true`); `—` for null, the input itself if unparseable.
 */
export function formatDateTime(iso: string | null | undefined, opts: { utc?: boolean } = {}): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const [y, mo, da, h, mi, s] = opts.utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  return `${y}-${pad(mo)}-${pad(da)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

/** Relative time (`just now`, `5s ago`, `3m ago`, `in 2h`, …) of `iso` against `nowMs`. */
export function formatRelative(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = nowMs - t;
  const abs = Math.abs(diff);
  if (abs < 2000) return 'just now';
  const s = Math.round(abs / 1000);
  const text = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/**
 * Only absolute `http:`/`https:` URLs are allowed as external link targets
 * (Spec §20.5). Returns the normalized URL or `null`.
 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  // Reject control characters and whitespace that browsers would strip before parsing the scheme.
  if (/[\u0000- \u007f]/.test(value)) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

/** Internal link target: a hash route like `#/runs/<id>`. */
export function isInternalHref(value: string): boolean {
  return /^#\/[^\s]*$/.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Shorten `s` to `max` characters with an ellipsis. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Pretty JSON for display, cut after `maxChars` (with a marker). */
export function prettyJson(value: unknown, maxChars = 200_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length > maxChars) return `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters not shown)`;
  return text;
}

/** Minimal run shape needed to describe its outcome. */
export interface RunOutcomeLike {
  status: string;
  outcome: 'active' | 'success' | 'failure' | 'technical_error' | 'cancelled' | string;
  finalStatus?: string | null;
  lifecycleStatus?: string | null;
  lifecycleFailed?: boolean;
}

/** Badge description. */
export interface BadgeInfo {
  label: string;
  tone: Tone;
  /** Tooltip / longer explanation. */
  title: string;
}

/**
 * Unambiguous outcome badges of a run (Spec §21): business `failure` (result
 * file) vs. technical error (`crashed`, `start_error`, `timed_out`) vs.
 * `cancelled`; "lifecycle failed" is a separate badge.
 */
export function runBadges(run: RunOutcomeLike): BadgeInfo[] {
  const badges: BadgeInfo[] = [];
  switch (run.outcome) {
    case 'active':
      badges.push(
        run.status === 'recovery_pending'
          ? { label: 'recovery pending', tone: 'warn', title: 'Recovery could not decide whether the process is gone; operator action required' }
          : { label: run.status, tone: 'info', title: `Active run (technical state ${run.status})` },
      );
      break;
    case 'success':
      badges.push({ label: 'success', tone: 'ok', title: 'Completed; worker reported success' });
      break;
    case 'failure':
      badges.push({
        label: 'failure (business)',
        tone: 'warn',
        title: 'Business result "failure": the worker finished in a controlled way and reported that the task cannot be solved (does not count as technical failure)',
      });
      break;
    case 'technical_error': {
      const st = run.finalStatus ?? run.status;
      badges.push({ label: `technical error: ${st}`, tone: 'error', title: `Technical error (${st}); counts towards retry blocks` });
      break;
    }
    case 'cancelled':
      badges.push({ label: 'cancelled', tone: 'muted', title: 'Cancelled (does not count as technical failure)' });
      break;
    default:
      badges.push({ label: String(run.outcome), tone: 'muted', title: '' });
  }
  if (run.lifecycleFailed || run.lifecycleStatus === 'failed') {
    badges.push({ label: 'lifecycle failed', tone: 'error', title: 'A lifecycle action failed; see Failed Actions' });
  } else if (run.lifecycleStatus === 'running' && run.outcome !== 'active') {
    badges.push({ label: 'lifecycle running', tone: 'info', title: 'Lifecycle hook chain is running' });
  }
  return badges;
}

/** Display value of a check / filter trace value (dry-run never claims `pass` for unevaluated checks). */
export function checkValueLabel(value: unknown): { label: string; tone: Tone } {
  if (value === true || value === 'pass') return { label: 'pass', tone: 'ok' };
  if (value === false || value === 'fail') return { label: 'fail', tone: 'error' };
  if (value === 'not_evaluated') return { label: 'unknown / not evaluated', tone: 'muted' };
  if (value === 'unknown') return { label: 'unknown', tone: 'warn' };
  return { label: String(value), tone: 'muted' };
}

/** Tone of a planning / dry-run decision. */
export function decisionTone(decision: string): Tone {
  if (decision === 'started' || decision === 'would_start') return 'ok';
  if (decision === 'pending_checks') return 'info';
  if (decision.endsWith('unknown') || decision === 'start_failed' || decision === 'blocked') return 'warn';
  return 'muted';
}

/** Tone of an action / lifecycle / notification state. */
export function stateTone(state: string | null | undefined): Tone {
  switch (state) {
    case 'succeeded':
    case 'delivered':
    case 'ok':
      return 'ok';
    case 'failed':
      return 'error';
    case 'running':
    case 'pending':
      return 'info';
    default:
      return 'muted';
  }
}

/** Minimal run event shape. */
export interface RunEventLike {
  type: string;
  payload: Record<string, unknown> | null | undefined;
}

/** One-line summary of a run event (all parts are plain text, rendered via textContent). */
export function eventSummary(e: RunEventLike): string {
  const p = e.payload ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  if (e.type === 'run.status') {
    const from = str(p.from);
    const to = str(p.to) ?? '?';
    return `${from ? `${from} ` : ''}→ ${to}${str(p.target) ? ` (target ${str(p.target)})` : ''}`;
  }
  if (e.type === 'progress' && typeof p.value === 'number') {
    return `${p.value}%${str(p.message) ? ` ${str(p.message)}` : ''}`;
  }
  if (e.type === 'lifecycle.action' || e.type === 'lifecycle.chain') {
    const err = str(p.error);
    const applied = e.type === 'lifecycle.action' ? appliedSummary(p.details) : '';
    return (
      [str(p.hook), str(p.name) ?? str(p.type), str(p.status)].filter(Boolean).join(' ') +
      (applied ? ` (${applied})` : '') +
      (err ? `: ${err}` : '')
    );
  }
  const message = str(p.message) ?? str(p.reason) ?? str(p.error);
  if (message !== null) return message;
  const keys = Object.keys(p).filter((k) => k !== 'type');
  return keys.length === 0 ? '' : truncate(JSON.stringify(p), 200);
}

/**
 * What a `source.update` changed (`details.applied` of a `lifecycle.action`
 * event): `+label`, `-label`, `added to project`, `Field=value` / `Field cleared`.
 */
export function appliedSummary(details: unknown): string {
  const applied = details && typeof details === 'object' ? (details as { applied?: unknown }).applied : undefined;
  if (!applied || typeof applied !== 'object') return '';
  const a = applied as Record<string, unknown>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const parts = [...strings(a.labelsAdded).map((l) => `+${l}`), ...strings(a.labelsRemoved).map((l) => `-${l}`)];
  if (a.projectItemAdded === true) parts.push('added to project');
  if (a.projectFields && typeof a.projectFields === 'object') {
    for (const [name, value] of Object.entries(a.projectFields as Record<string, unknown>)) {
      parts.push(value === null ? `${name} cleared` : `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
  return truncate(parts.join(', '), 200);
}
