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

  it('sets ORCH_* incl. source variables only for source-bound runs', () => {
    const orch = buildOrchEnv({ context, workflowId: 'wf', contextFile: '/c', resultFile: '/r', workspace: '/ws' });
    expect(orch).toEqual({
      ORCH_RUN_ID: 'run-1',
      ORCH_WORKFLOW_ID: 'wf',
      ORCH_CONTEXT_FILE: '/c',
      ORCH_RESULT_FILE: '/r',
      ORCH_WORKSPACE: '/ws',
      ORCH_SOURCE_TYPE: 'github',
      ORCH_SOURCE_ID: 'project_a',
      ORCH_SOURCE_ITEM_ID: '123',
      ORCH_SOURCE_URL: 'https://x/123',
    });
    const { source: _s, ...noSource } = context;
    const orch2 = buildOrchEnv({ context: noSource, workflowId: 'wf', contextFile: '/c', resultFile: '/r', workspace: '/ws' });
    expect(Object.keys(orch2).some((k) => k.startsWith('ORCH_SOURCE'))).toBe(false);
  });

  it('applies precedence minimal < env < secrets < ORCH_*', () => {
    const env = buildWorkerEnv({
      base: { PATH: '/bin', HOME: '/h' },
      env: { HOME: '/declared', A: 'env', ORCH_RUN_ID: 'evil' },
      secrets: { A: 'secret', GH_TOKEN: 't' },
      orch: { ORCH_RUN_ID: 'run-1' },
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/declared', A: 'secret', GH_TOKEN: 't', ORCH_RUN_ID: 'run-1' });
  });
});
