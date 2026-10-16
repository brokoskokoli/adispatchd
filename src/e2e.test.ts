/**
 * End-to-end: complete app with configuration files, Fake-GitHub (GitHub App
 * auth), a real shell worker and real HTTP + SSE. The scheduler picks up a
 * `ready-for-coding` issue; the SSE stream delivers run events and live log
 * output; after a disconnect, reconnecting with `Last-Event-ID` replays the
 * missed persisted events without gaps or duplicates.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_A, connectSse, startAppEnv, type AppEnv, type SseMessage } from './api/testing/helpers.js';

let env: AppEnv;
let gate: string;

beforeAll(async () => {
  env = await startAppEnv({}, (e) => {
    gate = path.join(e.marks, 'gate');
    const worker = e.script(
      'coder.sh',
      [
        'echo "starting work on $ORCH_SOURCE_ITEM_ID"',
        `echo '@@ORCH_EVENT {"type":"status","message":"phase 1"}'`,
        `while [ ! -f "${gate}" ]; do sleep 0.05; done`,
        `echo '@@ORCH_EVENT {"type":"status","message":"phase 2"}'`,
        `printf '{"schema_version":1,"result":"success","message":"PR opened"}' > "$ORCH_RESULT_FILE"`,
      ].join('\n'),
    );
    writeFileSync(
      path.join(e.configDir, 'workflows', 'coder.yaml'),
      [
        'id: coder',
        'name: Coder',
        'trigger: { type: source, source: repo_a }',
        'identity: coder',
        'filter: { all: [ { field: labels, operator: contains, value: ready-for-coding } ] }',
        'execute:',
        '  type: shell',
        `  command: ${worker}`,
        'on_start:',
        '  - type: source.update',
        '    labels: { add: [coding], remove: [ready-for-coding] }',
        'on_success:',
        '  - type: source.update',
        '    labels: { add: [ready-for-review], remove: [coding] }',
        '  - type: source.comment',
        "    message: 'Done: {result.message}'",
        '',
      ].join('\n'),
    );
  });
});

afterAll(async () => {
  if (!existsSync(gate)) writeFileSync(gate, '');
  await env.cleanup();
});

const statusTo = (m: SseMessage): string | null =>
  m.event === 'run.event' && m.data.payload.type === 'run.status' ? String(m.data.payload.payload.to) : null;

describe('end-to-end', () => {
  it('scheduler run with SSE live events and Last-Event-ID reconnect', async () => {
    const base = env.app.url!;
    const sse = await connectSse(`${base}/api/v1/events`);
    const open = await sse.waitFor((m) => m.event === 'stream.open');
    expect(open.id).not.toBeNull();

    env.github.createIssue(REPO_A, { number: 42, title: 'Implement feature', labels: ['ready-for-coding'] });
    // Trigger a planning step (resume plans immediately).
    const resume = await fetch(`${base}/api/v1/scheduler/resume`, { method: 'POST', headers: { 'x-orchestrator-request': '1' } });
    expect(resume.status).toBe(200);

    const running = await sse.waitFor((m) => statusTo(m) === 'running');
    const runId = running.data.payload.runId as string;
    await sse.waitFor((m) => m.event === 'run.output' && String(m.data.payload.data).includes('starting work on 42'));
    await sse.waitFor((m) => m.event === 'run.event' && m.data.payload.type === 'status' && m.data.payload.payload.message === 'phase 1');
    expect(env.github.labels(REPO_A, 42)).toContain('coding');

    // Persisted events carry strictly increasing ids.
    const ids = sse.messages.filter((m) => m.event === 'run.event').map((m) => Number(m.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const lastSeen = ids.at(-1)!;
    sse.close();
    await sse.closed;

    // While disconnected: the worker finishes, hooks run.
    writeFileSync(gate, '');
    const done = await env.waitTerminal(runId);
    expect(done).toMatchObject({ status: 'completed', businessResult: 'success', lifecycleStatus: 'succeeded' });
    expect(env.github.labels(REPO_A, 42)).toEqual(expect.arrayContaining(['ready-for-review']));
    expect(env.github.comments(REPO_A, 42).some((c) => c.body.includes('Done: PR opened'))).toBe(true);

    // Reconnect with Last-Event-ID: missed events are replayed from SQLite.
    const again = await connectSse(`${base}/api/v1/events`, { 'last-event-id': String(lastSeen) });
    await again.waitFor((m) => statusTo(m) === 'completed');
    const replayed = again.messages.filter((m) => m.event === 'run.event');
    const replayedIds = replayed.map((m) => Number(m.id));
    expect(replayedIds[0]).toBe(lastSeen + 1);
    expect(new Set(replayedIds).size).toBe(replayedIds.length);
    const expected = env.app.persistence.events.listSince(lastSeen).map((e) => e.id);
    expect(replayedIds.slice(0, expected.length)).toEqual(expected);
    expect(replayed.map(statusTo).filter(Boolean)).toEqual(['finalizing', 'completed']);
    expect(replayed.some((m) => m.data.payload.type === 'status' && m.data.payload.payload.message === 'phase 2')).toBe(true);
    // Heartbeats keep the connection alive (comment lines are ignored by clients).
    again.close();

    // Run-scoped stream with query-parameter resume.
    const scoped = await connectSse(`${base}/api/v1/events?run=${runId}&lastEventId=0`);
    await scoped.waitFor((m) => statusTo(m) === 'completed');
    expect(scoped.messages.filter((m) => m.event === 'run.event').every((m) => m.data.payload.runId === runId)).toBe(true);
    scoped.close();

    // The run detail reflects everything for the UI.
    const detail = await (await fetch(`${base}/api/v1/runs/${runId}`)).json();
    expect(detail).toMatchObject({ workflowName: 'Coder', identity: 'coder', triggerType: 'source', resultMessage: 'PR opened', outcome: 'success' });
  });
});
