/**
 * Configuration / System (Spec §16, §19): YAML read-only, validation, manual
 * reload, runtime overrides note, notification delivery failures.
 */
import { ApiError, api, qs } from '../api.js';
import { h, replaceChildren, rerender } from '../dom.js';
import { createRefresher } from '../../shared/throttle.js';
import { buildHash } from '../../shared/route.js';
import { stateTone } from '../../shared/format.js';
import type { Page, PageContext } from '../page.js';
import type { ConfigIssue, Notification, Status } from '../types.js';
import { act, badge, button, confirmDialog, errorBox, jsonBlock, kv, loading, section, table, text, time, toast } from '../ui.js';

function issuesList(issues: ConfigIssue[]): HTMLElement {
  return h(
    'ul',
    { class: 'issues' },
    issues.map((i) =>
      h('li', null, badge(i.severity, i.severity === 'error' ? 'error' : 'warn'), ' ', h('code', null, `${i.file}${i.line ? `:${i.line}` : ''}${i.path ? ` ${i.path}` : ''}`), ' ', i.message),
    ),
  );
}

export const configPage = (ctx: PageContext): Page => {
  ctx.setTitle('Configuration');
  const tab = ctx.route.query.tab === 'notifications' ? 'notifications' : 'config';
  const tabs = h(
    'nav',
    { class: 'tabs' },
    h('a', { href: buildHash(['config']), class: tab === 'config' ? 'active' : null }, 'Configuration'),
    h('a', { href: buildHash(['config'], { tab: 'notifications' }), class: tab === 'notifications' ? 'active' : null }, 'Notifications'),
  );
  const body = h('div', null, loading());
  const el = h('div', { class: 'page' }, h('h1', null, 'Configuration / System'), tabs, body);

  // ------------------------------------------------------------ config tab
  const result = h('div');
  const validateBtn: HTMLButtonElement = button('Validate', () => {
    void (async () => {
      const res = await act(validateBtn, () => api.post<{ ok: boolean; errors: ConfigIssue[]; warnings: ConfigIssue[]; hash?: string }>('/api/v1/config/validate'));
      if (!res) return;
      replaceChildren(
        result,
        h(
          'div',
          { class: `alert ${res.ok ? 'alert-ok' : 'alert-error'}` },
          res.ok ? `Configuration on disk is valid${res.hash ? ` (hash ${res.hash.slice(0, 12)})` : ''}. Nothing was activated.` : `Configuration on disk is invalid (${res.errors.length} error(s)).`,
          res.errors.length ? issuesList(res.errors) : null,
          res.warnings.length ? issuesList(res.warnings) : null,
        ),
      );
    })();
  }, { requires: 'viewer' });
  const reloadBtn: HTMLButtonElement = button(
    'Reload',
    () => {
      void (async () => {
        const r = await confirmDialog({
          title: 'Reload configuration?',
          message: h(
            'div',
            null,
            h('p', null, 'All YAML files are read and validated. Only if everything is valid, the new configuration is activated atomically; otherwise the active configuration is kept.'),
            h('p', null, 'Runtime overrides of affected settings are reset to the YAML values. Running runs keep their configuration snapshot.'),
          ),
          confirmLabel: 'Reload',
        });
        if (!r.ok) return;
        reloadBtn.disabled = true;
        try {
          const res = await api.post<{ version: number; hash: string; changed: boolean; diff: unknown; resetOverrides: unknown; warnings: ConfigIssue[] }>('/api/v1/config/reload');
          toast(res.changed ? `Configuration v${res.version} activated` : 'Configuration unchanged', 'ok');
          replaceChildren(
            result,
            h(
              'div',
              { class: 'alert alert-ok' },
              res.changed ? `Reloaded: version ${res.version}, hash ${res.hash.slice(0, 12)}.` : 'No changes.',
              res.warnings.length ? issuesList(res.warnings) : null,
              h('details', null, h('summary', null, 'Diff / reset overrides'), jsonBlock({ diff: res.diff, resetOverrides: res.resetOverrides })),
            ),
          );
          void loadConfig();
        } catch (err) {
          const issues = err instanceof ApiError ? ((err.details as { errors?: ConfigIssue[] } | null)?.errors ?? []) : [];
          replaceChildren(
            result,
            h('div', { class: 'alert alert-error' }, err instanceof ApiError && err.code === 'config_invalid' ? 'Reload rejected – the active configuration was kept.' : errorBox(err), issues.length ? issuesList(issues) : null),
          );
        } finally {
          reloadBtn.disabled = false;
        }
      })();
    },
    { kind: 'primary', requires: 'operator' },
  );
  const systemBox = h('div');
  const filesBox = h('div', null, loading());

  const loadConfig = async (): Promise<void> => {
    try {
      const [status, files, cfg] = await Promise.all([
        api.get<Status>('/api/v1/status'),
        api.get<{ files: Array<{ file: string; content: string | null; error?: string }> }>('/api/v1/config/files'),
        api.get<{ overrides: { global: Record<string, unknown>; workflows: Record<string, Record<string, unknown>> } }>('/api/v1/config'),
      ]);
      const overrideCount = Object.keys(cfg.overrides.global ?? {}).length + Object.values(cfg.overrides.workflows ?? {}).reduce((n, o) => n + Object.keys(o ?? {}).length, 0);
      rerender(
        systemBox,
        h(
          'div',
          { class: 'grid' },
          section(
            'Active configuration',
            kv([
              ['Directory', h('code', null, status.config.configDir)],
              ['Version', String(status.config.version)],
              ['Hash', h('code', null, status.config.hash)],
              ['Loaded', time(status.config.loadedAt)],
              ['Runtime overrides', overrideCount > 0 ? h('span', null, badge(String(overrideCount), 'info'), ' active – not persistent, lost on restart, reset by reload') : 'none'],
            ]),
            h('div', { class: 'actions' }, validateBtn, reloadBtn),
            result,
            overrideCount > 0 ? h('details', null, h('summary', null, 'Overrides'), jsonBlock(cfg.overrides)) : null,
          ),
          section(
            'System',
            kv([
              ['Version', status.version],
              ['Started', time(status.startedAt)],
              ['Bind', h('span', null, `${status.server.host}:${status.server.port ?? '?'} `, status.server.loopback ? badge('loopback', 'ok') : badge('not loopback – protect with proxy/VPN', 'warn'))],
              ['Readiness', h('span', null, Object.entries(status.readiness.checks).map(([k, v]) => badge(k, (k === 'shuttingDown' ? !v : v) ? 'ok' : 'warn')))],
              ['SSE clients', String(status.sse.clients)],
              ['Notifications', Object.entries(status.counts.notifications).map(([k, v]) => `${k} ${v}`).join(', ') || '—'],
              ['Retention', status.retention ? h('span', null, 'last run ', time(status.retention.lastRunAt), ` · deleted ${JSON.stringify(status.retention.deletedRuns)} · errors ${status.retention.errors}`) : text(null)],
            ]),
          ),
        ),
      );
      rerender(
        filesBox,
        h('h2', null, 'YAML files (read-only, secrets redacted)'),
        files.files.length === 0 ? h('p', { class: 'empty' }, 'No files.') : null,
        files.files.map((f) =>
          h(
            'details',
            { class: 'file' },
            h('summary', null, h('code', null, f.file), f.error ? badge('unavailable', 'warn', f.error) : null),
            f.content !== null ? h('pre', { class: 'yaml' }, f.content) : h('p', { class: 'error-text' }, f.error ?? 'not available'),
          ),
        ),
      );
    } catch (err) {
      replaceChildren(systemBox, errorBox(err));
    }
  };

  // ----------------------------------------------------- notifications tab
  let notifState = ctx.route.query.state === 'all' ? '' : 'failed';
  const loadNotifications = async (): Promise<void> => {
    try {
      const res = await api.get<{ notifications: Notification[]; counts: Record<string, number> }>(`/api/v1/notifications${qs({ state: notifState, limit: 200 })}`);
      const stateSel = h(
        'select',
        { class: 'input', 'aria-label': 'Delivery state', on: { change: () => { notifState = stateSel.value; void loadNotifications(); } } },
        h('option', { value: 'failed', selected: notifState === 'failed' }, `Failed deliveries (${res.counts.failed ?? 0})`),
        h('option', { value: '', selected: notifState === '' }, 'All'),
      ) as HTMLSelectElement;
      rerender(
        body,
        section(
          'Orchestrator notifications',
          h('p', { class: 'hint' }, 'Central notifications (retry block created, lifecycle action failed, recovery failed) and their delivery attempts per channel.'),
          h('div', { class: 'filters' }, stateSel),
          table(
            ['#', 'Event', 'Created', 'State', 'Deliveries', ''],
            res.notifications.map((n) => {
              const retry: HTMLButtonElement | null =
                n.deliveryState === 'failed'
                  ? button('Retry', () => void act(retry, () => api.post(`/api/v1/notifications/${n.id}/retry`), 'Delivery re-queued').then(() => loadNotifications()), { kind: 'primary', requires: 'operator' })
                  : null;
              return [
                String(n.id),
                h('span', null, h('code', null, n.eventType), h('details', null, h('summary', null, 'payload'), jsonBlock(n.payload, 20_000))),
                time(n.createdAt),
                badge(n.deliveryState, stateTone(n.deliveryState)),
                n.deliveries.length
                  ? h(
                      'ul',
                      { class: 'plain' },
                      n.deliveries.map((d) =>
                        h(
                          'li',
                          null,
                          h('code', null, d.channelId),
                          ' ',
                          badge(d.state, stateTone(d.state)),
                          ` ${d.attempts} attempt(s)`,
                          d.lastStatus !== null ? ` · HTTP ${d.lastStatus}` : '',
                          d.lastError ? h('div', { class: 'error-text' }, d.lastError) : null,
                          d.nextAttemptAt ? h('div', { class: 'muted' }, 'next attempt ', time(d.nextAttemptAt)) : null,
                        ),
                      ),
                    )
                  : text(n.lastError ?? 'no channels'),
                retry,
              ];
            }),
            { empty: notifState === 'failed' ? 'No failed deliveries.' : 'No notifications.' },
          ),
        ),
      );
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };

  const load = tab === 'config' ? loadConfig : loadNotifications;
  if (tab === 'config') replaceChildren(body, systemBox, h('section', { class: 'card' }, filesBox));
  const refresher = createRefresher(load, 2000);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (msg.type === 'config.reloaded' || (tab === 'notifications' && msg.type === 'notification')) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
