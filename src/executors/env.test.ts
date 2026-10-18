import { describe, expect, it } from 'vitest';
import type { WorkerContext } from '../core/index.js';
import { buildMinimalEnv, buildOrchEnv, buildWorkerEnv, FALLBACK_PATH } from './env.js';

const context: WorkerContext = {
  schema_version: 1,
  run: { id: 'run-1', trigger: 'source', started_at: '2026-10-16T19:00:00Z' },
  workflow: { id: 'wf' },
  source: { id: 'project_a', type: 'github', item_id: '123', item_key: 'project_a:123', url: 'https://x/123', attributes: {} },
  parameters: {},
  workspace: { path: '/ws' },
};

describe('worker env', () => {
  it('picks only the minimal variables from the controller env', () => {
    const env = buildMinimalEnv({ PATH: '/bin', HOME: '/h', SECRET_X: 'nope', NODE_OPTIONS: '--x', USER: 'u' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', USER: 'u' });
  });

  it('falls back to a default PATH', () => {
    expect(buildMinimalEnv({}).PATH).toBe(FALLBACK_PATH);
  });

  it('sets ADISPATCH_* incl. source variables only for source-bound runs', () => {
    const orch = buildOrchEnv({ runId: 'run-1', context, workflowId: 'wf', contextFile: '/c', resultFile: '/r', workspace: '/ws' });
    expect(orch).toEqual({
      ADISPATCH_RUN_ID: 'run-1',
      ADISPATCH_WORKFLOW_ID: 'wf',
      ADISPATCH_CONTEXT_FILE: '/c',
      ADISPATCH_RESULT_FILE: '/r',
      ADISPATCH_WORKSPACE: '/ws',
      ADISPATCH_SOURCE_TYPE: 'github',
      ADISPATCH_SOURCE_ID: 'project_a',
      ADISPATCH_SOURCE_ITEM_ID: '123',
      ADISPATCH_SOURCE_URL: 'https://x/123',
    });
    const { source: _s, ...noSource } = context;
    const orch2 = buildOrchEnv({ runId: 'run-1', context: noSource, workflowId: 'wf', contextFile: '/c', resultFile: '/r', workspace: '/ws' });
    expect(Object.keys(orch2).some((k) => k.startsWith('ADISPATCH_SOURCE'))).toBe(false);
  });

  it('accepts custom (shell action) contexts without a cast', () => {
    const actionContext = { run: { id: 'run-1' }, result: { status: 'completed', message: 'ok' }, source: context.source };
    const orch = buildOrchEnv({ runId: 'run-1', context: actionContext, workflowId: 'wf', contextFile: '/c', resultFile: '/r', workspace: '/ws' });
    expect(orch.ADISPATCH_SOURCE_ITEM_ID).toBe('123');
    const bad = buildOrchEnv({ runId: 'run-1', context: { source: { id: 1 } }, workflowId: 'wf', contextFile: '/c', resultFile: '/r', workspace: '/ws' });
    expect(bad.ADISPATCH_SOURCE_ID).toBeUndefined();
  });

  it('applies precedence minimal < env < secrets < ADISPATCH_*', () => {
    const env = buildWorkerEnv({
      base: { PATH: '/bin', HOME: '/h' },
      env: { HOME: '/declared', A: 'env', ADISPATCH_RUN_ID: 'evil' },
      secrets: { A: 'secret', GH_TOKEN: 't' },
      orch: { ADISPATCH_RUN_ID: 'run-1' },
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/declared', A: 'secret', GH_TOKEN: 't', ADISPATCH_RUN_ID: 'run-1' });
  });
});
