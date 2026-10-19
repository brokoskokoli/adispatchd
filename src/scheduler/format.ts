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
  return `${what} ${c.command}: ${value}${c.error ? ` – ${c.error}` : ''}`;
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
  if (c.filter) lines.push('     filter:', ...traceLines(c.filter, '       '));
  if (c.shellFilter) lines.push(`     ${checkLine(c.shellFilter)}`);
  for (const ic of c.itemConditions) lines.push(`     ${checkLine(ic)}`);
  return lines;
}

/** Render a dry-run result as plain text. */
export function formatDryRun(r: DryRunResult): string {
  const t = r.trigger;
  const trigger = t.type === 'source' ? `source ${t.source}` : t.type === 'schedule' ? `schedule '${t.cron}' (${t.timezone})` : 'manual';
  const lines = [
    `Dry-run of workflow '${r.workflowId}' (${r.name}) at ${r.generatedAt}`,
    `  trigger: ${trigger}`,
    `  enabled: ${r.enabled ? 'yes' : 'no'}, workflow priority: ${r.workflowPriority}`,
    `  capacity: workflow ${r.capacity.workflow.active}/${r.capacity.workflow.max} active, global ${r.capacity.global.active}/${r.capacity.global.max} active`,
  ];
  if (r.gate) lines.push(`  automatic starts: ${r.gate.canStartAutomatically ? 'possible' : `not possible (${r.gate.reason ?? 'unknown'})`}`);
  for (const c of r.conditions) lines.push(`  ${checkLine(c)}`);
  // `hooks` is missing in results of older instances (before 0.3.0).
  if (r.hooks) {
    lines.push(`  on_result: ${r.hooks.onResult.length > 0 ? r.hooks.onResult.join(', ') : '(none)'}`);
    lines.push(`  technical outcomes: ${Object.entries(r.hooks.technical).map(([status, hook]) => `${status} → ${hook}`).join(', ')}`);
  }
  if (r.source) {
    // `filter` is missing in results of older instances (before 0.2.0).
    if (r.source.filter !== undefined) lines.push(`  filter: ${r.source.filter ? JSON.stringify(r.source.filter) : '(none)'}`);
    lines.push(`  source ${r.source.sourceId}: ${r.source.polled} item(s) polled${r.source.pushdown ? `, pushdown ${JSON.stringify(r.source.pushdown)}` : ''}`);
    if (r.source.error) lines.push(`  SOURCE ERROR: ${r.source.error}`);
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
