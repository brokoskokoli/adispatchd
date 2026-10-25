/**
 * Page contract of the SPA: every route renders into its own element and may
 * react to live messages and resyncs (after an SSE reconnect).
 */
import type { LiveMessage } from '../shared/sse.js';
import type { Route } from '../shared/route.js';

/** Services available to pages. */
export interface PageContext {
  route: Route;
  /** Navigate to a hash route. */
  navigate(hash: string): void;
  /** Reload navigation counters (blocks, failed actions, views). */
  refreshNav(): void;
  /** Set the document title suffix. */
  setTitle(title: string): void;
}

/** A mounted page. */
export interface Page {
  el: HTMLElement;
  /** Live message from `/api/v1/events`. */
  onLive?(msg: LiveMessage): void;
  /** Called after an SSE reconnect/reset: reload state via REST. */
  onResync?(): void;
  /**
   * The hash changed: return true if the page applied the new route itself
   * (e.g. only the selected dashboard tabs changed, WI-32) instead of being
   * rebuilt.
   */
  onRouteChange?(route: Route): boolean;
  /** Cleanup (timers, refreshers). */
  dispose?(): void;
}

/** Page factory. */
export type PageFactory = (ctx: PageContext) => Page;

/** True for live messages that change run/system state (used for coalesced refreshes). */
export function isStateChange(msg: LiveMessage): boolean {
  // `dashboard.info` (WI-24) and `system.metrics` (WI-23) are handled by their dashboard sections (no page reload).
  return (
    msg.type !== 'run.output' &&
    msg.type !== 'stream.open' &&
    msg.type !== 'retention.finished' &&
    msg.type !== 'dashboard.info' &&
    msg.type !== 'system.metrics'
  );
}

/** Run ID a live message refers to, if any. */
export function messageRunId(msg: LiveMessage): string | null {
  const p = msg.payload;
  return typeof p.runId === 'string' ? p.runId : null;
}
