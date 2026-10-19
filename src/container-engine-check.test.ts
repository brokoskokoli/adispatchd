/** Engine binary check at startup and when a reload adds a container workflow (WI-19 review). */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppEnv, type AppEnv } from './api/testing/helpers.js';
import { ContainerEngineClient } from './executors/index.js';

describe('container engine check', () => {
  let env: AppEnv;
  beforeAll(async () => {
    env = await startAppEnv({
      app: { controller: { containers: new ContainerEngineClient({ binaries: { docker: '/nonexistent/docker', podman: '/nonexistent/podman' } }) } },
    });
  });
  afterAll(async () => env.cleanup());

  const warnings = () => env.logger.records.filter((r) => r.msg === 'container engine not available: container runs will end with start_error');

  it('warns when a reload adds a container workflow whose engine is missing (once per engine)', async () => {
    expect(warnings()).toEqual([]);
    writeFileSync(
      path.join(env.configDir, 'workflows', 'boxed.yaml'),
      'id: boxed\ntrigger: { type: manual }\nexecute:\n  type: container\n  engine: podman\n  image: busybox\n',
    );
    expect((await env.app.reloadConfig()).ok).toBe(true);
    for (let i = 0; i < 100 && warnings().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(warnings().map((r) => r.fields.engine)).toEqual(['podman']);
    expect((await env.app.reloadConfig()).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(warnings()).toHaveLength(1);
  });
});
