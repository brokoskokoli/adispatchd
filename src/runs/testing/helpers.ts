/**
 * Test helpers for run-controller tests (excluded from the build): real
 * SQLite in a temp dir, Fake-GitHub, real shell scripts, real config loader.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemClock, type Notifier, type NotificationEventType, type SourceAdapter, type TechnicalStatus } from '../../core/index.js';
import { BASE_FILES } from '../../config/testing/fixtures.js';
import { formatConfigIssue, loadConfig, snapshotWorkflow, type WorkflowSnapshot } from '../../config/index.js';
import { LifecycleEngine } from '../../lifecycle/index.js';
import { openPersistence, type Persistence, type ReserveRunInput, type RunRecord } from '../../persistence/index.js';
import { FakeGitHub, createFakeGitHubSource } from '../../sources/github/testing/index.js';
import { RunController, type RunControllerOptions } from '../controller.js';
import { PersistedEventPublisher, RunEventBus, type BusEvent } from '../event-bus.js';

export const REPO = 'example/a';
export const ISSUE = 7;
export const ITEM_KEY = `repo_a:${ISSUE}`;
export const ITEM_URL = `https://github.com/${REPO}/issues/${ISSUE}`;

/** Recorded notification. */
export interface RecordedNotification {
  type: NotificationEventType;
  payload: Record<string, unknown>;
}

/** Controller plus its bus/publisher/lifecycle and a log of all bus events. */
export interface ControllerHarness {
  controller: RunController;
  bus: RunEventBus;
  lifecycle: LifecycleEngine;
  events: BusEvent[];
}

export interface RunsTestEnv {
  root: string;
  dataDir: string;
  configDir: string;
  workspaces: string;
  /** Directory for marker files written by test scripts. */
  marks: string;
  p: Persistence;
  github: FakeGitHub;
  adapter: SourceAdapter;
  notifications: RecordedNotification[];
  notifier: Notifier;
  /** Make another source adapter known to controllers/lifecycle created afterwards (multi-source tests, WI-20). */
  addSource(id: string, adapter: SourceAdapter): void;
  /** Write an executable shell script and return its absolute path. */
  script(name: string, body: string): string;
  /** Write `workflows/<id>.yaml` (+ optional config.yaml) and return the workflow snapshot. */
  snapshot(workflowYaml: string, options?: { id?: string; configYaml?: string }): Promise<WorkflowSnapshot>;
  /** Fresh controller over the shared DB (a second call simulates a restarted controller). */
  harness(overrides?: Partial<RunControllerOptions>): ControllerHarness;
  /** Reserve a source run for issue #7. */
  reserve(snapshot: WorkflowSnapshot, extra?: Partial<ReserveRunInput>): RunRecord;
  cleanup(): void;
}

/** Default `config.yaml` of the tests: workspaces below the temp root, fast action retries. */
export function defaultConfigYaml(workspaces: string): string {
  return [
    'scheduler:',
    '  max_concurrent: 4',
    'workspace:',
    `  base_dir: ${workspaces}`,
    '  cleanup: on_success',
    'lifecycle:',
    '  action_retry:',
    '    max_attempts: 1',
    '    delay: 10ms',
    '',
  ].join('\n');
}

export function createRunsEnv(): RunsTestEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orch-runs-'));
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  const workspaces = path.join(root, 'workspaces');
  const marks = path.join(root, 'marks');
  const scripts = path.join(root, 'scripts');
  for (const d of [dataDir, configDir, workspaces, marks, scripts, path.join(configDir, 'workflows')]) mkdirSync(d, { recursive: true });
  for (const [rel, content] of Object.entries(BASE_FILES)) writeFileSync(path.join(configDir, rel), content);
  writeFileSync(path.join(configDir, 'config.yaml'), defaultConfigYaml(workspaces));

  const p = openPersistence(dataDir, { clock: systemClock });
  const github = new FakeGitHub({ clock: systemClock });
  github.createIssue(REPO, { number: ISSUE, title: 'Implement OAuth', labels: ['ready-for-coding', 'manual-label'] });
  const adapter = createFakeGitHubSource(github, {
    sourceId: 'repo_a',
    owner: 'example',
    repository: 'a',
    identity: 'maintainer',
    clock: systemClock,
  });
  const notifications: RecordedNotification[] = [];
  const notifier: Notifier = { notify: (type, payload) => notifications.push({ type, payload }) };
  const controllers: RunController[] = [];
  const extraSources = new Map<string, SourceAdapter>();

  return {
    root,
    dataDir,
    configDir,
    workspaces,
    marks,
    p,
    github,
    adapter,
    notifications,
    notifier,
    addSource(id, source) {
      extraSources.set(id, source);
    },
    script(name, body) {
      const file = path.join(scripts, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    },
    async snapshot(workflowYaml, options = {}) {
      const id = options.id ?? 'wf';
      if (options.configYaml !== undefined) writeFileSync(path.join(configDir, 'config.yaml'), options.configYaml);
      writeFileSync(path.join(configDir, 'workflows', `${id}.yaml`), workflowYaml);
      const loaded = await loadConfig(configDir, { dataDir });
      if (!loaded.ok) throw new Error(`invalid test config:\n${loaded.errors.map(formatConfigIssue).join('\n')}`);
      return snapshotWorkflow(loaded.config, id);
    },
    harness(overrides = {}) {
      const bus = new RunEventBus();
      const publisher = new PersistedEventPublisher(p, bus);
      const events: BusEvent[] = [];
      bus.subscribe((e) => events.push(e));
      const sources = (id: string): SourceAdapter | undefined => (id === 'repo_a' ? adapter : extraSources.get(id));
      const lifecycle = new LifecycleEngine({
        repositories: p,
        sources,
        dataDir,
        notifier,
        onActionChange: publisher.actionListener(),
        shellCancelGraceMs: 200,
      });
      const controller = new RunController({
        repositories: p,
        lifecycle,
        sources,
        dataDir,
        publisher,
        notifier,
        recoveryGraceMs: 300,
        recoveryKillConfirmMs: 2_000,
        ...overrides,
      });
      controllers.push(controller);
      return { controller, bus, lifecycle, events };
    },
    reserve(snapshot, extra = {}) {
      return p.runs.reserve({
        workflowId: snapshot.workflow.id,
        triggerType: 'source',
        sourceId: 'repo_a',
        sourceItemKey: ITEM_KEY,
        sourceUrl: ITEM_URL,
        configSnapshot: snapshot,
        ...extra,
      });
    },
    cleanup() {
      try {
        p.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Resolve once `predicate(run)` holds, re-checking on every bus event of the
 * run (no fixed sleeps). Rejects after a generous real-time safety net.
 */
export function waitForRun(
  h: ControllerHarness,
  p: Persistence,
  runId: string,
  predicate: (run: RunRecord) => boolean,
  timeoutMs = 15_000,
): Promise<RunRecord> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const run = p.runs.get(runId);
      if (run && predicate(run)) {
        cleanup();
        resolve(run);
        return true;
      }
      return false;
    };
    const unsubscribe = h.bus.subscribe((e) => {
      if (e.type === 'run.event' && e.event.runId === runId) check();
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for run ${runId} (status ${p.runs.get(runId)?.status})`));
    }, timeoutMs);
    const cleanup = (): void => {
      unsubscribe();
      clearTimeout(timer);
    };
    check();
  });
}

/** Wait for a status. */
export function waitForStatus(h: ControllerHarness, p: Persistence, runId: string, status: TechnicalStatus): Promise<RunRecord> {
  return waitForRun(h, p, runId, (r) => r.status === status);
}

/** Status transitions of a run as published on the bus (`from→to`). */
export function statusTrail(events: readonly BusEvent[], runId: string): string[] {
  return events
    .filter((e): e is Extract<BusEvent, { type: 'run.event' }> => e.type === 'run.event' && e.event.runId === runId && e.event.type === 'run.status')
    .map((e) => String(e.event.payload.to));
}

/** Standard workflow YAML with label hooks. */
export function workflowYaml(command: string, extra = ''): string {
  return `
id: wf
name: Coder
trigger: { type: source, source: repo_a }
execute:
  type: shell
  command: ${command}
  cancel_grace: 300ms
retry: { max_technical_failures: 3 }
on_start:
  - type: source.update
    labels: { add: [coding], remove: [ready-for-coding] }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
on_failure:
  - type: source.update
    labels: { add: [needs-maintainer], remove: [coding] }
  - type: source.comment
    message: 'Needs maintainer: {result.message}'
on_crash:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_start_error:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_cancel:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
on_timeout:
  - type: source.update
    labels: { add: [ready-for-coding], remove: [coding] }
${extra}`;
}
