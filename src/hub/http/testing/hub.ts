/** A hub HTTP server with fake workspaces for UI tests (excluded from the build with the other `testing/` directories). */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noopLogger } from '../../../core/index.js';
import { NO_AUTH_CONFIG, type AuthConfig } from '../../../config/index.js';
import { createHubHttp as create, type HubHttp } from '../server.js';
import { FakeHubSource, FakeInstance } from './fakes.js';

export interface TestHub {
  base: string;
  source: FakeHubSource;
  instances: FakeInstance[];
  http: HubHttp;
  close(): Promise<void>;
}

/** Start a hub server (no login unless `auth`) with two fake workspaces `a` and `b`. */
export async function createHubHttp(options: { uiDir: string | null; auth?: AuthConfig }): Promise<TestHub> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-hubui-'));
  const instances = [new FakeInstance('a', 'a'.repeat(43)), new FakeInstance('b', 'b'.repeat(43))];
  await Promise.all(instances.map((i) => i.listen()));
  const source = new FakeHubSource(instances);
  const http = await create({
    config: { configDir: '/cfg', maxConcurrent: 4, server: { host: '127.0.0.1', port: 0, allowedHosts: [] }, auth: options.auth ?? NO_AUTH_CONFIG, workspaces: [] },
    hub: source,
    dataDir: dir,
    version: 'test',
    logger: noopLogger,
    port: 0,
    uiDir: options.uiDir,
    monitoring: false,
  });
  const { url } = await http.listen();
  return {
    base: url,
    source,
    instances,
    http,
    async close() {
      await http.close();
      await Promise.all(instances.map((i) => i.close()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
