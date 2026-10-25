/**
 * Shared data of the dashboard widgets (WI-32). Widgets subscribe to feeds;
 * a feed exists while it has subscribers, so widgets in inactive tabs cost
 * nothing. Widgets showing the same data share one request:
 *
 * - `status` and `runs(query)`: reloaded on live state changes (coalesced,
 *   at most one reload per second, as the 0.7.0 dashboard);
 * - `view(id)`: one query per view for all its widgets (union of their
 *   sections, largest limit), polled at the shortest `refresh` of them; no
 *   live reload (views cost source API calls).
 */
import { api, qs, seg } from '../api.js';
import { createRefresher, type Refresher } from '../../shared/throttle.js';
import { coversRequest, mergeViewRequests, pollInterval, type ViewRequest } from '../../shared/dashboard-layout.js';
import type { RunSummary, Status, ViewItems } from '../types.js';

/** Latest state of a feed. */
export type FeedState<T> = { kind: 'loading' } | { kind: 'ok'; data: T } | { kind: 'error'; error: unknown };

export type Listener<T> = (state: FeedState<T>) => void;

/** Runs list as served by `GET /api/v1/runs`. */
export interface RunsPage {
  runs: RunSummary[];
  total: number;
}

/** Query of a runs widget. */
export interface RunsQuery {
  active: boolean;
  limit: number;
  workflows: readonly string[] | null;
}

interface LiveFeed<T> {
  state: FeedState<T>;
  listeners: Set<Listener<T>>;
  refresher: Refresher;
}

interface ViewFeed {
  state: FeedState<ViewItems>;
  /** Request the current data was fetched for. */
  fetched: ViewRequest | null;
  subscribers: Map<Listener<ViewItems>, { request: ViewRequest; refreshMs: number }>;
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number | null;
  /** Request of the load in flight. */
  pending: ViewRequest | null;
  gen: number;
}

export interface DashboardFeeds {
  /** `GET /api/v1/status` (scheduler, capacity, attention, notices). */
  status(listener: Listener<Status>): () => void;
  runs(query: RunsQuery, listener: Listener<RunsPage>): () => void;
  view(viewId: string, request: ViewRequest & { refreshMs: number }, listener: Listener<ViewItems>): () => void;
  /** Reload status and runs now (after a control action). */
  refreshNow(): Promise<void>;
  /** Reload one view, bypassing the server cache (widget "Refresh"). */
  refreshView(viewId: string): Promise<void>;
  /** A live state change: coalesced reload of status and runs. */
  stateChanged(): void;
  /** After an SSE reconnect: reload everything. */
  resync(): void;
  dispose(): void;
}

export function createDashboardFeeds(): DashboardFeeds {
  const live = new Map<string, LiveFeed<unknown>>();
  const views = new Map<string, ViewFeed>();
  let disposed = false;

  const emit = <T>(listeners: Iterable<Listener<T>>, state: FeedState<T>): void => {
    for (const l of [...listeners]) l(state);
  };

  function subscribeLive<T>(key: string, fetch: () => Promise<T>, listener: Listener<T>): () => void {
    let feed = live.get(key) as LiveFeed<T> | undefined;
    if (!feed) {
      const f: LiveFeed<T> = {
        state: { kind: 'loading' },
        listeners: new Set(),
        refresher: createRefresher(async () => {
          try {
            f.state = { kind: 'ok', data: await fetch() };
          } catch (error) {
            f.state = { kind: 'error', error };
          }
          if (!disposed) emit(f.listeners, f.state);
        }, 1000),
      };
      feed = f;
      live.set(key, f as LiveFeed<unknown>);
      void f.refresher.now();
    }
    feed.listeners.add(listener);
    listener(feed.state);
    const own = feed;
    return () => {
      own.listeners.delete(listener);
      if (own.listeners.size === 0) {
        own.refresher.dispose();
        live.delete(key);
      }
    };
  }

  const loadView = (viewId: string, feed: ViewFeed, refresh: boolean): Promise<void> => {
    const request = mergeViewRequests([...feed.subscribers.values()].map((s) => s.request));
    const gen = ++feed.gen;
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', 'true');
    for (const s of request.sections ?? []) params.append('sections', s);
    params.set('limit', String(request.limit));
    feed.pending = request;
    return (async () => {
      try {
        const data = await api.get<ViewItems>(`/api/v1/views/${seg(viewId)}/items?${params.toString()}`);
        if (gen !== feed.gen) return;
        feed.state = { kind: 'ok', data };
        feed.fetched = request;
      } catch (error) {
        if (gen !== feed.gen) return;
        feed.state = { kind: 'error', error };
        feed.fetched = null;
      }
      feed.pending = null;
      if (!disposed && views.get(viewId) === feed) emit(feed.subscribers.keys(), feed.state);
    })();
  };

  /** (Re)start the poll timer at the shortest interval of the subscribers. */
  const schedule = (viewId: string, feed: ViewFeed): void => {
    const interval = pollInterval([...feed.subscribers.values()].map((s) => s.refreshMs));
    if (interval === feed.intervalMs) return;
    if (feed.timer !== null) clearInterval(feed.timer);
    feed.intervalMs = interval;
    feed.timer = interval === null ? null : setInterval(() => void loadView(viewId, feed, false), interval);
  };

  const feeds: DashboardFeeds = {
    status: (listener) => subscribeLive('status', () => api.get<Status>('/api/v1/status'), listener),

    runs: (query, listener) => {
      const params = { active: query.active ? 'true' : 'false', limit: query.limit, workflow: query.workflows?.join(',') ?? null };
      return subscribeLive(`runs:${JSON.stringify(params)}`, () => api.get<RunsPage>(`/api/v1/runs${qs(params)}`), listener);
    },

    view: (viewId, request, listener) => {
      let feed = views.get(viewId);
      if (!feed) {
        feed = { state: { kind: 'loading' }, fetched: null, subscribers: new Map(), timer: null, intervalMs: null, pending: null, gen: 0 };
        views.set(viewId, feed);
      }
      const own = feed;
      own.subscribers.set(listener, { request: { sections: request.sections, limit: request.limit }, refreshMs: request.refreshMs });
      schedule(viewId, own);
      if (own.fetched && own.state.kind === 'ok' && coversRequest(own.fetched, request)) listener(own.state);
      else {
        listener({ kind: 'loading' });
        // One load for all widgets mounted in the same tick (e.g. a tab with two widgets of one view).
        queueMicrotask(() => {
          if (views.get(viewId) !== own || !own.subscribers.has(listener)) return;
          const needed = mergeViewRequests([...own.subscribers.values()].map((s) => s.request));
          if (own.fetched && own.state.kind === 'ok' && coversRequest(own.fetched, needed)) listener(own.state);
          else if (!(own.pending && coversRequest(own.pending, needed))) void loadView(viewId, own, false);
        });
      }
      return () => {
        own.subscribers.delete(listener);
        if (own.subscribers.size === 0) {
          if (own.timer !== null) clearInterval(own.timer);
          own.gen++;
          views.delete(viewId);
        } else schedule(viewId, own);
      };
    },

    refreshNow: async () => {
      await Promise.all([...live.values()].map((f) => f.refresher.now()));
    },

    refreshView: async (viewId) => {
      const feed = views.get(viewId);
      if (feed) await loadView(viewId, feed, true);
    },

    stateChanged: () => {
      for (const f of live.values()) f.refresher.trigger();
    },

    resync: () => {
      for (const f of live.values()) void f.refresher.now();
      for (const [id, f] of views) void loadView(id, f, false);
    },

    dispose: () => {
      disposed = true;
      for (const f of live.values()) f.refresher.dispose();
      live.clear();
      for (const f of views.values()) if (f.timer !== null) clearInterval(f.timer);
      views.clear();
    },
  };
  return feeds;
}
