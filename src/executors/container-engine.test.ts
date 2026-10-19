/**
 * ContainerEngineClient against the fake engine (WI-19): ps by instance
 * label, stop/rm incl. "no such container", unreachable engine, engine env.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTAINER_RESERVED_ENV_NAMES, containerName } from '../core/index.js';
import { ContainerEngineClient, ContainerEngineError } from './container-engine.js';
import { MINIMAL_ENV_KEYS } from './env.js';
import { createFakeEngine, type FakeEngine } from './testing/fake-engine.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

let engine: FakeEngine;

beforeEach(async () => {
  engine = await createFakeEngine();
});

afterEach(async () => {
  await engine.cleanup();
});

describe('ContainerEngineClient', () => {
  it('passes only minimal and engine variables to the engine process', () => {
    const client = new ContainerEngineClient({
      baseEnv: { PATH: '/bin', HOME: '/home/svc', DOCKER_HOST: 'unix:///run/docker.sock', XDG_RUNTIME_DIR: '/run/user/1', GH_PRIVATE_KEY: 'pem', SECRET: 'x' },
    });
    expect(client.env({ API_TOKEN: 't' })).toEqual({
      PATH: '/bin',
      HOME: '/home/svc',
      DOCKER_HOST: 'unix:///run/docker.sock',
      XDG_RUNTIME_DIR: '/run/user/1',
      API_TOKEN: 't',
    });
    expect(client.binary('podman')).toBe('podman');
  });

  it('reserves every minimal worker variable for the engine process', () => {
    for (const key of MINIMAL_ENV_KEYS) expect(CONTAINER_RESERVED_ENV_NAMES).toContain(key);
  });

  it.runIf(supported)('lists containers of one instance, stops and removes them', async () => {
    const client = engine.client();
    await engine.orphan(containerName('run-a'), ['adispatch.instance=aaaa', 'adispatch.run=run-a']);
    await engine.orphan(containerName('run-b'), ['adispatch.instance=bbbb', 'adispatch.run=run-b']);
    expect(await client.list('docker', 'aaaa')).toEqual([containerName('run-a')]);
    expect(await client.stop('docker', containerName('run-a'), 1000)).toBe('stopped');
    await client.remove('docker', containerName('run-a'));
    expect(await engine.containers()).toEqual([containerName('run-b')]);
    expect(await client.stop('docker', containerName('run-a'), 0)).toBe('not_found');
    await expect(client.remove('docker', containerName('run-a'))).resolves.toBeUndefined();
    const ps = (await engine.calls()).find((c) => c.argv[0] === 'ps');
    expect(ps?.argv).toEqual(['ps', '-a', '--filter', 'label=adispatch.instance=aaaa', '--format', '{{.Names}}']);
  });

  it.runIf(supported)('reports an unreachable or missing engine', async () => {
    const client = engine.client();
    expect(await client.check('docker')).toEqual({ ok: true, version: 'Fake engine version 1.0' });
    await engine.fail('all');
    await expect(client.list('docker', 'aaaa')).rejects.toBeInstanceOf(ContainerEngineError);
    await expect(client.stop('docker', 'x', 0)).rejects.toThrow(/stop x failed/);
    const missing = new ContainerEngineClient({ binaries: { docker: path.join(engine.binDir, 'nope') } });
    const check = await missing.check('docker');
    expect(check.ok).toBe(false);
    await expect(missing.list('docker', 'aaaa')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
