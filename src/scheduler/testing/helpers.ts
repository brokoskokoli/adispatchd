/**
 * Test helpers for scheduler tests (excluded from the build): builds on the
 * run-controller test environment (temp SQLite, Fake-GitHub, real shell
 * scripts) and adds a real ConfigManager, a FakeClock for polling/cron and
 * a Scheduler.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FakeClock, isTerminalStatus, type SourceAdapter, type TechnicalStatus } from '../../core/index.js';
import { ConfigManager } from '../../config/index.js';
import type { RunRecord } from '../../persistence/index.js';
import { createFakeGitHubSource } from '../../sources/github/testing/index.js';
import { createRunsEnv, defaultConfigYaml, waitForRun, type ControllerHarness, type RunsTestEnv } from '../../runs/testing/helpers.js';
import { Scheduler, type SchedulerOptions } from '../scheduler.js';

export { ISSUE, ITEM_KEY, REPO } from '../../runs/testing/helpers.js';

/** Scheduler test environment. */
export interface SchedulerEnv {
  env: RunsTestEnv;
  clock: FakeClock;
  /** Adapter for `repo_b` (example/b). */
  adapterB: SourceAdapter;
  /** Write `workflows/<id>.yaml`. */
  workflow(id: string, yaml: string): void;
  /** Overwrite `config.yaml` with the test defaults plus `extra` lines. */
  configYaml(extra?: { maxConcurrent?: number; pollingInterval?: string }): void;
  /** Script that blocks until `release()` was called. */
  blockingScript(name?: string): string;
  release(): void;
  /** Build ConfigManager + recovered controller + scheduler (not started). */
  build(options?: Partial<SchedulerOptions> & { recover?: boolean }): Promise<Built>;
  /** Release blocking scripts and wait until no run is active. */
  teardown(): Promise<void>;
}

/** Built components. */
export interface Built {
  config: ConfigManager;
  h: ControllerHarness;
  scheduler: Scheduler;
}

/** Workflow YAML for a source workflow on `repo_a` with label hooks. */
export function sourceWorkflow(id: string, command: string, extra = ''): string {
  return `
id: ${id}
name: Coder ${id}
trigger: { type: source, source: repo_a }
identity: coder
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
on_cancel:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_crash:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
${extra}`;
}

/** Workflow YAML for a schedule workflow. */
export function scheduleWorkflow(id: string, command: string, cron: string, extra = ''): string {
  return `
id: ${id}
name: Nightly ${id}
trigger: { type: schedule, cron: '${cron}', timezone: UTC }
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
${extra}`;
}

export function createSchedulerEnv(options: { start?: string } = {}): SchedulerEnv {
  const env = createRunsEnv();
  const clock = new FakeClock(options.start ?? '2026-01-01T00:00:00.000Z');
  const adapterB = createFakeGitHubSource(env.github, { sourceId: 'repo_b', owner: 'example', repository: 'b', identity: 'maintainer' });
  const releaseFile = path.join(env.marks, 'release');
  const built: Built[] = [];
  return {
    env,
    clock,
    adapterB,
    workflow(id, yaml) {
      writeFileSync(path.join(env.configDir, 'workflows', `${id}.yaml`), yaml);
    },
    configYaml(extra = {}) {
      let yaml = defaultConfigYaml(env.workspaces);
      if (extra.maxConcurrent !== undefined) yaml = yaml.replace('max_concurrent: 4', `max_concurrent: ${extra.maxConcurrent}`);
      if (extra.pollingInterval !== undefined) yaml = yaml.replace('scheduler:\n', `scheduler:\n  polling_interval: ${extra.pollingInterval}\n`);
      writeFileSync(path.join(env.configDir, 'config.yaml'), yaml);
    },
    blockingScript(name = 'block.sh') {
      return env.script(name, `while [ ! -f "${releaseFile}" ]; do sleep 0.05; done`);
    },
    release() {
      if (!existsSync(releaseFile)) writeFileSync(releaseFile, '');
    },
    async build(opts = {}) {
      const config = await ConfigManager.create({ configDir: env.configDir, dataDir: env.dataDir });
      const h = env.harness();
      if (opts.recover !== false) await h.controller.recover();
      const sources = (id: string): SourceAdapter | undefined => (id === 'repo_a' ? env.adapter : id === 'repo_b' ? adapterB : undefined);
      const scheduler = new Scheduler({
        config,
        repositories: env.p,
        controller: h.controller,
        sources,
        clock: clock,
        timers: clock,
        ...opts,
      });
      const b = { config, h, scheduler };
      built.push(b);
      return b;
    },
    async teardown() {
      this.release();
      for (const b of built) await b.scheduler.stop();
      for (const b of built) {
        const pending = b.h.controller.activeRunIds().map((id) => waitForRun(b.h, env.p, id, (r) => isTerminalStatus(r.status)));
        await Promise.all(pending);
      }
      env.cleanup();
    },
  };
}

/** Wait for a run to reach `status`. */
export function waitStatus(b: Built, env: RunsTestEnv, runId: string, status: TechnicalStatus): Promise<RunRecord> {
  return waitForRun(b.h, env.p, runId, (r) => r.status === status);
}
