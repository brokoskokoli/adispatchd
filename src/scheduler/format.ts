/**
 * Human-readable rendering of a {@link DryRunResult} (CLI `workflow dry-run`).
 */
import type { FilterTrace } from '../filters/index.js';
import type { CandidateDiagnosis, CheckDiagnosis, DryRunResult } from './types.js';

function traceLines(trace: FilterTrace, indent: string): string[] {
  const value = String(trace.value);
  switch (trace.kind) {
    case 'all':
    case 'any':
      return [`${indent}${trace.kind}: ${value}`, ...trace.children.flatMap((c) => traceLines(c, `${indent}  `))];
    case 'not':
      return [`${indent}not: ${value}`, ...traceLines(trace.child, `${indent}  `)];
    case 'predicate': {
      const actual = 'actual' in trace && trace.actual !== undefined ? ` (actual ${JSON.stringify(trace.actual)})` : '';
      const why = trace.reason ? ` – ${trace.reason}` : '';
      return [`${indent}${trace.field} ${trace.operator} ${JSON.stringify(trace.expected)}: ${value}${actual}${why}`];
    }
    case 'invalid':
      return [`${indent}invalid rule: ${value} – ${trace.reason}`];
  }
}

function checkLine(c: CheckDiagnosis): string {
  const what = c.kind === 'shell_filter' ? 'shell filter' : `${c.kind.replace('_', ' ')} ${c.index}`;
  const value = c.value === 'not_evaluated' ? 'unknown / not evaluated' : String(c.value);
  const label = c.name !== undefined ? `"${c.name}" (${c.command})` : c.command;
  return `${what} ${label}: ${value}${c.error ? ` – ${c.error}` : ''}`;
}

function candidateLines(c: CandidateDiagnosis, n: number): string[] {
  const title = c.title ? ` "${c.title}"` : '';
  const lines = [
    `${String(n).padStart(3)}. ${c.itemKey}${title}`,
    `     priority ${c.workflowPriority}/${c.itemPriority}${c.matchedPriorityRule !== null ? ` (rule ${c.matchedPriorityRule})` : ''}  →  ${c.decision}${c.reason ? `: ${c.reason}` : ''}`,
    `     ${c.url}`,
  ];
  const project = Object.entries(c.projectFields ?? {});
  if (project.length > 0) {
    lines.push(
      '     project fields:',
      ...project.map(([name, r]) => `       ${name}: ${r.known ? JSON.stringify(r.value) : `unknown – ${r.reason}`}`),
    );
  }
  const linked = Object.entries(c.linkedFields ?? {});
  if (linked.length > 0) {
    lines.push(
      '     linked fields:',
      ...linked.map(([name, r]) => `       ${name}: ${r.known ? JSON.stringify(r.value) : `unknown – ${r.reason}`}`),
    );
  }
  if (c.filter) lines.push('     filter:', ...traceLines(c.filter, '       '));
  if (c.shellFilter) lines.push(`     ${checkLine(c.shellFilter)}`);
  for (const ic of c.itemConditions) lines.push(`     ${checkLine(ic)}`);
  return lines;
}

/** Quote a command-line word for display (POSIX shell style) when it contains special characters. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_/.,:=@%+<>{}-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Render a dry-run result as plain text. */
export function formatDryRun(r: DryRunResult): string {
  const t = r.trigger;
  const trigger =
    t.type === 'source'
      ? t.sources !== undefined
        ? `sources ${t.sources.join(', ')}`
        : `source ${t.source}`
      : t.type === 'schedule'
        ? `schedule '${t.cron}' (${t.timezone})`
        : 'manual';
  const lines = [
    `Dry-run of workflow '${r.workflowId}' (${r.name}) at ${r.generatedAt}`,
    `  trigger: ${trigger}`,
    `  enabled: ${r.enabled ? 'yes' : 'no'}, workflow priority: ${r.workflowPriority}`,
    `  capacity: workflow ${r.capacity.workflow.active}/${r.capacity.workflow.max} active, global ${r.capacity.global.active}/${r.capacity.global.max} active`,
  ];
  if (r.capacity.perSource) {
    const per = Object.entries(r.capacity.perSource.active).map(([id, n]) => `${id} ${n}/${r.capacity.perSource?.max ?? 0}`);
    lines.push(`  capacity per source: ${per.join(', ')}`);
  }
  if (r.gate) lines.push(`  automatic starts: ${r.gate.canStartAutomatically ? 'possible' : `not possible (${r.gate.reason ?? 'unknown'})`}`);
  for (const c of r.conditions) lines.push(`  ${checkLine(c)}`);
  // `hooks` is missing in results of older instances (before 0.3.0).
  if (r.hooks) {
    lines.push(`  on_result: ${r.hooks.onResult.length > 0 ? r.hooks.onResult.join(', ') : '(none)'}`);
    lines.push(`  technical outcomes: ${Object.entries(r.hooks.technical).map(([status, hook]) => `${status} → ${hook}`).join(', ')}`);
  }
  // Container workflows (WI-19): the engine call; secrets by name only.
  if (r.container) lines.push(`  container (${r.container.engine}, image ${r.container.image}): ${[r.container.command, ...r.container.args].map(shellQuote).join(' ')}`);
  // `secrets` is missing in results of older instances (before 0.3.0); values are never part of a dry-run.
  for (const x of r.secrets ?? []) {
    lines.push(`  secret ${x.where}: ${x.name} ← identity ${x.identity}, delivery ${x.delivery} (${x.variable})`);
  }
  if (r.source) {
    // `filter` is missing in results of older instances (before 0.2.0).
    if (r.source.filter !== undefined) lines.push(`  filter: ${r.source.filter ? JSON.stringify(r.source.filter) : '(none)'}`);
    // `sources` is missing in results of older instances (before 0.3.0).
    const perSource = r.source.sources ?? [
      { sourceId: r.source.sourceId, polled: r.source.polled, pushdown: r.source.pushdown, error: r.source.error, status: r.source.error ? 'source_error' : 'ok' },
    ];
    for (const s of perSource) {
      lines.push(`  source ${s.sourceId}: ${s.polled} item(s) polled${s.pushdown ? `, pushdown ${JSON.stringify(s.pushdown)}` : ''}`);
      if (s.error) lines.push(`  SOURCE ERROR: ${s.error}`);
    }
    lines.push('', `Candidates (${r.summary.candidates}): ${r.summary.wouldStart} would start, ${r.summary.pendingChecks} pending checks, ${r.summary.notStartable} not startable`);
    r.candidates.forEach((c, i) => lines.push(...candidateLines(c, i + 1)));
  }
  if (r.cron) {
    lines.push(`  next slots: ${r.cron.nextSlots.join(', ') || '(none)'}`);
    lines.push(`  next slot: ${r.cron.nextSlotForecast}${r.cron.forecastReason ? ` – ${r.cron.forecastReason}` : ''}`);
    if (r.cron.recentFirings.length > 0) {
      lines.push('  recent slots:');
      for (const f of r.cron.recentFirings) {
        lines.push(`    ${f.scheduledFor}  ${f.decision}${f.runId ? ` (${f.runId})` : ''}${f.reason ? ` – ${f.reason}` : ''}`);
      }
    }
  }
  if (r.notes.length > 0) lines.push('', 'Notes:', ...r.notes.map((n) => `  - ${n}`));
  return `${lines.join('\n')}\n`;
}
