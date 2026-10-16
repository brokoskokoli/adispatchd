/**
 * Cron slot computation on top of croner (Spec §5.5, §7, §24.7). Pure
 * functions; the DST semantics are pinned by tests and documented in
 * `docs/cron-semantics.md`.
 */
import { Cron } from 'croner';

/** A parsed cron schedule (paused croner instance – it never fires on its own). */
export interface CronSchedule {
  readonly expression: string;
  readonly timezone: string;
  /** First slot strictly after `after`, or `null` if the expression never fires again. */
  next(after: Date): Date | null;
}

/**
 * Parse a cron expression for a time zone (croner syntax, 5 or 6 fields).
 * @throws Error for invalid expressions/time zones (config validation rejects them earlier).
 */
export function parseCron(expression: string, timezone: string): CronSchedule {
  const job = new Cron(expression, { paused: true, timezone });
  return {
    expression,
    timezone,
    next(after: Date): Date | null {
      // croner works with second precision: a reference inside a second is
      // treated as that second, so `next` is strictly after `after`.
      const next = job.nextRun(after);
      return next && next.getTime() > after.getTime() ? next : null;
    },
  };
}

/** The next `count` slots strictly after `after`. */
export function nextSlots(schedule: CronSchedule, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = schedule.next(cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Result of {@link dueSlots}. */
export interface DueSlots {
  /** The most recent due slots (ascending), at most `keep`. */
  slots: Date[];
  /** Total number of due slots found (≥ `slots.length`). */
  total: number;
  /** True if scanning stopped at `maxScan` before reaching `now` (older slots were not counted). */
  scanLimited: boolean;
}

/**
 * All slots in `(after, now]`, keeping only the most recent `keep` of them.
 * Scanning is bounded by `maxScan`; if hit, scanning restarts closer to
 * `now` so that the most recent slots are still found.
 */
export function dueSlots(schedule: CronSchedule, after: Date, now: Date, options: { keep: number; maxScan: number }): DueSlots {
  const keep = Math.max(1, options.keep);
  let slots: Date[] = [];
  let total = 0;
  let scanned = 0;
  let cursor = after;
  let scanLimited = false;
  for (;;) {
    const next = schedule.next(cursor);
    if (!next || next.getTime() > now.getTime()) break;
    slots.push(next);
    if (slots.length > keep) slots = slots.slice(-keep);
    total++;
    cursor = next;
    if (++scanned >= options.maxScan) {
      // Too many slots (e.g. a per-second schedule after a long downtime):
      // jump to a window right before `now` and only collect the latest ones.
      scanLimited = true;
      const windowStart = new Date(now.getTime() - estimateWindowMs(schedule, now, keep));
      if (windowStart.getTime() <= cursor.getTime()) continue;
      cursor = windowStart;
      slots = [];
      scanned = 0;
    }
  }
  return { slots, total: Math.max(total, slots.length), scanLimited };
}

/** Rough time span that contains about `keep` slots before `now` (doubling search, bounded). */
function estimateWindowMs(schedule: CronSchedule, now: Date, keep: number): number {
  let span = 60_000;
  for (let i = 0; i < 40; i++) {
    const found = nextSlots(schedule, new Date(now.getTime() - span), keep + 1).filter((d) => d.getTime() <= now.getTime());
    if (found.length >= keep) return span;
    span *= 2;
  }
  return span;
}
