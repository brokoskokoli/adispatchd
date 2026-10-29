/** Artifacts (WI-35): list with filters, detail with file tree, download, delete and "start workflow". */
import { api, qs, seg } from '../api.js';
import { h, replaceChildren } from '../dom.js';
import { buildHash } from '../../shared/route.js';
import { createRefresher } from '../../shared/throttle.js';
import { formatBytes } from '../../shared/format.js';
import { artifactDownloadHref, artifactFileHref, artifactHref, buildFileTree, parseStartParameters, type FileTreeNode } from '../../shared/artifacts.js';
import type { Page, PageContext } from '../page.js';
import type { Artifact, ArtifactDetail, RunSummary } from '../types.js';
import { act, badge, button, confirmDialog, errorBox, kv, loading, routeLink, runLink, runOutcomeBadges, section, table, text, time, toast } from '../ui.js';

const PAGE_SIZE = 50;

const isArtifactMessage = (type: string): boolean => type === 'artifact.created' || type === 'artifact.deleted';

/** Link to an artifact page. */
export const artifactLink = (a: Pick<Artifact, 'id' | 'name'>): HTMLElement => h('a', { href: artifactHref(a.id) }, a.name);

/** Download link of a whole artifact (`.zip` for folders). */
const downloadLink = (a: Artifact): HTMLElement => h('a', { href: artifactDownloadHref(a.id), download: '' }, a.kind === 'folder' ? '.zip' : 'Download');

const kindBadge = (a: Artifact): HTMLElement => badge(a.kind, a.kind === 'folder' ? 'info' : 'muted');

export const artifactsPage = (ctx: PageContext): Page => {
  ctx.setTitle('Artifacts');
  const q = ctx.route.query;
  const type = q.type ?? '';
  const workflow = q.workflow ?? '';
  const kind = q.kind === 'file' || q.kind === 'folder' ? q.kind : '';
  const search = q.q ?? '';
  const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);
  const go = (patch: Record<string, string | number>): void => ctx.navigate(buildHash(['artifacts'], { type, workflow, kind, q: search, offset: 0, ...patch }));

  const typeSelect = h('select', { class: 'input', 'aria-label': 'Type', on: { change: () => go({ type: typeSelect.value }) } }, h('option', { value: '' }, 'All types')) as HTMLSelectElement;
  const wfSelect = h('select', { class: 'input', 'aria-label': 'Workflow', on: { change: () => go({ workflow: wfSelect.value }) } }, h('option', { value: '' }, 'All producing workflows')) as HTMLSelectElement;
  const kindSelect = h(
    'select',
    { class: 'input', 'aria-label': 'Kind', on: { change: () => go({ kind: kindSelect.value }) } },
    [['', 'Files and folders'], ['file', 'Files'], ['folder', 'Folders']].map(([v, l]) => h('option', { value: v!, selected: v === kind }, l!)),
  ) as HTMLSelectElement;
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search name or ID',
    value: search,
    'aria-label': 'Search',
    on: { keydown: (ev: KeyboardEvent) => ev.key === 'Enter' && go({ q: searchInput.value.trim() }) },
  }) as HTMLInputElement;
  const body = h('div', null, loading());
  const el = h('div', { class: 'page' }, h('h1', null, 'Artifacts'), h('p', { class: 'hint' }, 'Files and folders that workflows produce (execute.artifacts). Other workflows can process them as items of the source of type "artifacts".'), h('div', { class: 'filters' }, typeSelect, wfSelect, kindSelect, searchInput), body);

  const load = async (): Promise<void> => {
    try {
      const res = await api.get<{ artifacts: Artifact[]; total: number; limit: number; offset: number; facets: { types: string[]; workflows: string[] } }>(
        `/api/v1/artifacts${qs({ type, workflow, kind, q: search, limit: PAGE_SIZE, offset })}`,
      );
      const fill = (select: HTMLSelectElement, values: string[], current: string): void => {
        const all = current && !values.includes(current) ? [...values, current] : values;
        select.replaceChildren(select.firstElementChild as Node, ...all.map((v) => h('option', { value: v, selected: v === current }, v)));
      };
      fill(typeSelect, res.facets.types, type);
      fill(wfSelect, res.facets.workflows, workflow);
      const rows = res.artifacts.map((a) => [
        artifactLink(a),
        a.type,
        kindBadge(a),
        formatBytes(a.size),
        String(a.fileCount),
        h('code', null, a.workflow),
        runLink(a.runId),
        a.consumedBy.length ? h('span', null, a.consumedBy.map((w) => badge(w, 'ok'))) : text(null),
        time(a.createdAt),
        downloadLink(a),
      ]);
      const from = res.total === 0 ? 0 : res.offset + 1;
      const to = res.offset + res.artifacts.length;
      const pager = h(
        'div',
        { class: 'pager' },
        h('span', null, `${from}–${to} of ${res.total}`),
        offset > 0 ? h('a', { href: buildHash(['artifacts'], { type, workflow, kind, q: search, offset: Math.max(0, offset - PAGE_SIZE) }) }, '← Newer') : null,
        to < res.total ? h('a', { href: buildHash(['artifacts'], { type, workflow, kind, q: search, offset: offset + PAGE_SIZE }) }, 'Older →') : null,
      );
      replaceChildren(body, table(['Name', 'Type', 'Kind', 'Size', 'Files', 'Workflow', 'Run', 'Processed by', 'Created', ''], rows, { empty: 'No artifacts match.' }), pager);
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 1500);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (isArtifactMessage(msg.type) || (msg.type === 'run.event' && msg.payload.type === 'run.status')) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};

/** Nested list of the files of a folder (or the single file) with a download link per file. */
function fileTree(id: string, nodes: FileTreeNode[]): HTMLElement {
  return h(
    'ul',
    { class: 'file-tree' },
    nodes.map((n) =>
      n.size === null
        ? h('li', null, h('details', { open: '' }, h('summary', null, h('code', null, `${n.name}/`)), fileTree(id, n.children)))
        : h('li', null, h('a', { href: artifactFileHref(id, n.path), download: '' }, h('code', null, n.name)), ' ', h('small', { class: 'muted' }, formatBytes(n.size))),
    ),
  );
}

export const artifactPage = (ctx: PageContext, id: string): Page => {
  ctx.setTitle(`Artifact ${id}`);
  const body = h('div', null, loading());
  const el = h('div', { class: 'page' }, h('p', { class: 'crumbs' }, routeLink(['artifacts'], '← Artifacts')), body);

  const render = (d: ArtifactDetail): void => {
    const a = d.artifact;
    ctx.setTitle(a.name);
    const del: HTMLButtonElement = button(
      'Delete',
      () => {
        void (async () => {
          const ok = await confirmDialog({
            title: 'Delete artifact',
            message: h('p', null, `Delete "${a.name}" with its ${a.fileCount} file(s)? This cannot be undone. Runs that processed it keep their history.`),
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok.ok) return;
          const done = await act(del, () => api.del(`/api/v1/artifacts/${seg(a.id)}`), 'Artifact deleted');
          if (done !== undefined) ctx.navigate('#/artifacts');
        })();
      },
      { kind: 'danger', requires: 'admin' },
    );
    const wfSelect = h(
      'select',
      { class: 'input', 'aria-label': 'Workflow to start' },
      d.workflows.map((w) => h('option', { value: w.id }, `${w.name ?? w.id}${w.enabled ? '' : ' (disabled)'}`)),
    ) as HTMLSelectElement;
    const params = h('textarea', { class: 'input', rows: 2, placeholder: '{"parameter": "value"}  (optional)', 'aria-label': 'Parameters as JSON' }) as HTMLTextAreaElement;
    const startErrors = h('div');
    const start: HTMLButtonElement = button(
      'Start workflow…',
      () => {
        const parsed = parseStartParameters(params.value);
        if (!parsed.ok) {
          replaceChildren(startErrors, h('div', { class: 'alert alert-error' }, parsed.error));
          return;
        }
        startErrors.replaceChildren();
        void (async () => {
          start.disabled = true;
          try {
            const r = await api.post<{ run: RunSummary }>(`/api/v1/artifacts/${seg(a.id)}/start`, {
              workflow: wfSelect.value,
              ...(parsed.value ? { parameters: parsed.value } : {}),
            });
            toast(`Run ${r.run.id} started`, 'ok');
            ctx.navigate(buildHash(['runs', r.run.id], { tab: 'logs' }));
          } catch (err) {
            replaceChildren(startErrors, errorBox(err));
          } finally {
            start.disabled = false;
          }
        })();
      },
      { kind: 'primary', requires: 'operator' },
    );
    const tree = buildFileTree(d.files);
    replaceChildren(
      body,
      h('header', { class: 'page-head' }, h('h1', null, a.name), h('span', null, kindBadge(a), ' ', badge(a.type, 'info'))),
      h(
        'div',
        { class: 'grid' },
        section(
          'Artifact',
          kv([
            ['ID', h('code', null, a.id)],
            ['Kind', a.kind],
            ['Size', `${formatBytes(a.size)} in ${a.fileCount} file(s)`],
            ['Created', time(a.createdAt)],
            ['Produced by', h('span', null, h('code', null, a.workflow), ' in run ', runLink(a.runId), d.producer.run ? [' ', runOutcomeBadges(d.producer.run)] : h('small', { class: 'muted' }, ' (run deleted)'))],
            [
              'Parent',
              d.parent ? (d.parent.exists ? h('a', { href: artifactHref(d.parent.id) }, d.parent.name ?? d.parent.id) : h('span', null, h('code', null, d.parent.id), h('small', { class: 'muted' }, ' (deleted)'))) : text(null),
            ],
            ['Processed by', a.consumedBy.length ? h('span', null, a.consumedBy.map((w) => badge(w, 'ok'))) : text('not yet')],
          ]),
        ),
        section(
          'Download & actions',
          h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: artifactDownloadHref(a.id), download: '' }, a.kind === 'folder' ? 'Download .zip' : 'Download'), del),
          d.workflows.length
            ? h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, 'Process with workflow'), wfSelect), h('label', { class: 'field' }, h('span', null, 'Parameters'), params), startErrors, h('div', { class: 'actions' }, start))
            : h('p', { class: 'muted' }, d.sourceId ? 'No workflow uses the artifacts source as its trigger.' : 'No source of type "artifacts" is configured, so artifacts cannot be processed by workflows.'),
        ),
        h(
          'section',
          { class: 'card span-all' },
          h('h2', null, a.kind === 'folder' ? 'Files' : 'File'),
          tree.length ? fileTree(a.id, tree) : h('p', { class: 'muted' }, 'No files.'),
          d.filesTruncated ? h('p', { class: 'hint' }, 'The list is truncated; download the .zip for the rest if it fits.') : null,
          h('p', { class: 'hint' }, 'Known secrets were redacted while the files were collected (best effort, like logs).'),
        ),
        d.children.length
          ? section('Derived artifacts', table(['Name', 'Type', 'Size', 'Created'], d.children.map((c) => [artifactLink(c), c.type, formatBytes(c.size), time(c.createdAt)])))
          : null,
        section(
          'Runs that used it as input',
          table(
            ['Run', 'Workflow', 'Outcome', 'Started'],
            d.runs.map((r) => [runLink(r.id), r.workflowId, runOutcomeBadges(r), time(r.startedAt ?? r.createdAt)]),
            { empty: 'No run has processed this artifact yet.' },
          ),
          d.itemKey ? h('p', { class: 'hint' }, 'Item history: ', h('a', { href: `#/items/${seg(d.sourceId ?? '')}/${seg(a.id)}` }, 'open')) : null,
        ),
      ),
    );
  };

  const load = async (): Promise<void> => {
    try {
      render(await api.get<ArtifactDetail>(`/api/v1/artifacts/${seg(id)}`));
    } catch (err) {
      replaceChildren(body, errorBox(err));
    }
  };
  const refresher = createRefresher(load, 1500);
  void load();
  return {
    el,
    onLive: (msg) => {
      if (isArtifactMessage(msg.type) || (msg.type === 'run.event' && msg.payload.type === 'run.status')) refresher.trigger();
    },
    onResync: () => void refresher.now(),
    dispose: () => refresher.dispose(),
  };
};
