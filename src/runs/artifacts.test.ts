/** Controller behaviour around artifact inputs (WI-35, review m2). */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactError, type ArtifactService } from '../artifacts/index.js';
import type { ArtifactRecord } from '../core/index.js';
import { ArtifactSourceAdapter } from '../sources/index.js';
import { createRunsEnv, type RunsTestEnv } from './testing/helpers.js';

const ID = 'art-20261029T100000000Z-aaaaaaaa';
const record: ArtifactRecord = {
  id: ID, name: 'Report', type: 'report', kind: 'file', fileName: 'r.txt', size: 1, fileCount: 1, workflowId: 'make',
  runId: 'run-x', ordinal: 0, parentId: null, consumedBy: [], attemptedBy: [], createdAt: '2026-10-29T10:00:00.000Z',
};

describe('artifact input staging failures', () => {
  let env: RunsTestEnv;
  beforeEach(() => {
    env = createRunsEnv();
    writeFileSync(path.join(env.configDir, 'sources.yaml'), 'sources:\n  artifacts: { type: artifacts }\n  repo_a: { type: github, owner: example, repository: a, identity: maintainer }\n');
    env.addSource('artifacts', new ArtifactSourceAdapter('artifacts', { list: () => [record], get: (id) => (id === ID ? record : null) }));
  });
  afterEach(() => env.cleanup());

  async function runWith(error: Error) {
    const script = env.script('ok.sh', 'exit 0');
    const yaml = `id: wf\ntrigger: { type: source, source: artifacts }\nexecute:\n  type: shell\n  command: ${script}\nretry: { max_technical_failures: 3 }\n`;
    const snapshot = await env.snapshot(yaml);
    const stub = { stageInput: async () => { throw error; } } as unknown as ArtifactService;
    const h = env.harness({ artifacts: stub });
    await h.controller.recover();
    const run = env.reserve(snapshot, { sourceId: 'artifacts', sourceItemKey: `artifacts:${ID}`, sourceUrl: `#/artifacts/${ID}` });
    return h.controller.startRun(run.id).done;
  }

  it('a vanished artifact cancels the run (not a technical failure, no retry-block count)', async () => {
    const final = await runWith(new ArtifactError('artifact_not_found', 'gone'));
    expect(final).toMatchObject({ status: 'cancelled', finalReason: 'artifact no longer available' });
    expect(env.p.blocks.counter('wf', `artifacts:${ID}`).consecutive).toBe(0);
  });

  it('other staging errors stay technical (start_error, counted)', async () => {
    const final = await runWith(new Error('disk full'));
    expect(final.status).toBe('start_error');
    expect(final.finalReason).toMatch(/artifact input could not be staged: disk full/);
    expect(env.p.blocks.counter('wf', `artifacts:${ID}`).consecutive).toBe(1);
  });
});
