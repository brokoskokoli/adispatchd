/**
 * `GET /api/v1/runs/:id` result file (WI-19 review M1): container runs read
 * `runs/<id>/out/result.json`; a symlinked result file is refused (never shown).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeEngine, type FakeEngine } from '../executors/testing/fake-engine.js';
import { startAppEnv, type AppEnv } from './testing/helpers.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

describe.runIf(supported)('run detail result file', () => {
  let env: AppEnv;
  let engine: FakeEngine;

  beforeAll(async () => {
    engine = await createFakeEngine();
    env = await startAppEnv({ app: { controller: { containers: engine.client() } } }, (e) => {
      const worker = e.script('boxed.sh', `printf '{"schema_version":1,"result":"success","message":"from the box"}' > "$ADISPATCH_RESULT_FILE"`);
      writeFileSync(
        path.join(e.configDir, 'workflows', 'boxed.yaml'),
        `id: boxed\ntrigger: { type: manual }\nexecute:\n  type: container\n  image: localhost/worker:current\n  command: ['${worker}']\n  cancel_grace: 1s\n`,
      );
      writeFileSync(path.join(e.root, 'host-secret.json'), '{"schema_version":1,"result":"failure","message":"HOST CONTENT"}');
      const linker = e.script('linker.sh', `ln -s "${path.join(e.root, 'host-secret.json')}" "$ADISPATCH_RESULT_FILE"`);
      writeFileSync(
        path.join(e.configDir, 'workflows', 'linker.yaml'),
        `id: linker\ntrigger: { type: manual }\nexecute:\n  type: shell\n  command: ${linker}\n  cancel_grace: 300ms\n`,
      );
    });
  });
  afterAll(async () => {
    await env.cleanup();
    await engine.cleanup();
  });

  it('shows the result file of a container run', async () => {
    const res = await env.request('POST', '/api/v1/workflows/boxed/start', {});
    expect(res.status).toBe(202);
    const run = await env.waitTerminal(res.json.run.id);
    expect(run.status).toBe('completed');
    const detail = await env.request('GET', `/api/v1/runs/${run.id}`);
    expect(detail.json.resultFile).toMatchObject({ result: 'success', message: 'from the box' });
    expect(detail.json.resultFileError).toBeNull();
  });

  it('refuses a symlinked result file', async () => {
    const res = await env.request('POST', '/api/v1/workflows/linker/start', {});
    const run = await env.waitTerminal(res.json.run.id);
    expect(run.status).toBe('crashed');
    const detail = await env.request('GET', `/api/v1/runs/${run.id}`);
    expect(detail.json.resultFile).toBeNull();
    expect(detail.json.resultFileError).toContain('symbolic link');
    expect(JSON.stringify(detail.json)).not.toContain('HOST CONTENT');
  });
});
