/**
 * Test helpers for lifecycle tests (excluded from the build).
 */
import { FakeClock, type Notifier, type NotificationEventType, type SourceAdapter } from '../../core/index.js';
import { BASE_FILES, createTempConfigDir } from '../../config/testing/fixtures.js';
import { formatConfigIssue, loadConfig, snapshotWorkflow, type WorkflowSnapshot } from '../../config/index.js';
import { openTestPersistence } from '../../persistence/testing/helpers.js';
import type { Persistence, RunRecord } from '../../persistence/index.js';
import { FakeGitHub, createFakeGitHubSource, staticCredentials } from '../../sources/github/testing/index.js';
import { LifecycleEngine, type LifecycleEngineOptions } from '../engine.js';

export const REPO = 'example/a';
export const ISSUE = 7;
export const ITEM_KEY = `repo_a:${ISSUE}`;
export const ITEM_URL = `https://github.com/${REPO}/issues/${ISSUE}`;

/** Load a workflow YAML (id `wf`, source `repo_a` unless the YAML says otherwise) and snapshot it. */
export async function loadSnapshot(workflowYaml: string, workflowId = 'wf'): Promise<WorkflowSnapshot> {
  const cfg = await createTempConfigDir({ ...BASE_FILES, [`workflows/${workflowId}.yaml`]: workflowYaml });
  try {
    const loaded = await loadConfig(cfg.dir, { dataDir: cfg.dataDir });
    if (!loaded.ok) throw new Error(`invalid test config:\n${loaded.errors.map(formatConfigIssue).join('\n')}`);
    return snapshotWorkflow(loaded.config, workflowId);
  } finally {
    await cfg.cleanup();
  }
}

/** Recorded notification. */
export interface RecordedNotification {
  type: NotificationEventType;
  payload: Record<string, unknown>;
}

/** Test environment: DB, fake GitHub, adapter, engine factory. */
export interface LifecycleTestEnv {
  p: Persistence;
  clock: FakeClock;
  dataDir: string;
  github: FakeGitHub;
  adapter: SourceAdapter;
  credentials: ReturnType<typeof staticCredentials>;
  notifications: RecordedNotification[];
  notifier: Notifier;
  /** Engine over the shared DB (a second call simulates a restarted controller). */
  engine(overrides?: Partial<LifecycleEngineOptions>): LifecycleEngine;
  /** Reserve a source run for issue #7 with `snapshot`. */
  reserve(snapshot: WorkflowSnapshot): RunRecord;
  /** Move a reserved run to `finalizing` with a successful result. */
  finalizeSuccess(runId: string, message?: string): RunRecord;
  cleanup(): void;
}

export function createEnv(): LifecycleTestEnv {
  const { p, clock, dir, cleanup } = openTestPersistence();
  const github = new FakeGitHub({ clock });
  github.createIssue(REPO, { number: ISSUE, title: 'Implement OAuth', labels: ['coding', 'manual-label'] });
  const credentials = staticCredentials();
  const adapter = createFakeGitHubSource(github, {
    sourceId: 'repo_a',
    owner: 'example',
    repository: 'a',
    identity: 'maintainer',
    credentials,
    clock,
  });
  const notifications: RecordedNotification[] = [];
  const notifier: Notifier = { notify: (type, payload) => notifications.push({ type, payload }) };
  return {
    p,
    clock,
    dataDir: dir,
    github,
    adapter,
    credentials,
    notifications,
    notifier,
    engine: (overrides = {}) =>
      new LifecycleEngine({
        repositories: p,
        sources: (id) => (id === 'repo_a' ? adapter : undefined),
        dataDir: dir,
        clock,
        timers: clock,
        notifier,
        ...overrides,
      }),
    reserve: (snapshot) =>
      p.runs.reserve({
        workflowId: snapshot.workflow.id,
        triggerType: 'source',
        sourceId: 'repo_a',
        sourceItemKey: ITEM_KEY,
        sourceUrl: ITEM_URL,
        configSnapshot: snapshot,
      }),
    finalizeSuccess: (runId, message = 'All done') => {
      p.runs.transition(runId, 'starting');
      p.runs.transition(runId, 'running', { update: { pid: 4242 } });
      p.runs.beginFinalization(
        runId,
        { status: 'completed', businessResult: 'success', reason: 'exit code 0' },
        { update: { result: { schema_version: 1, result: 'success', message } } },
      );
      return p.runs.require(runId);
    },
    cleanup,
  };
}

/**
 * Await `promise` while advancing the fake clock whenever timers are pending
 * (retry delays elapse without real waiting).
 */
export async function drive<T>(promise: Promise<T>, clock: FakeClock, stepMs = 1_000): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + 15_000; // real-time safety net (shell actions run real processes)
  while (!settled && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled && clock.pendingTimers() > 0) await clock.advanceAsync(stepMs);
  }
  return promise;
}

/** Comments on the test issue that carry an orchestrator marker. */
export function markedComments(github: FakeGitHub): string[] {
  return github
    .comments(REPO, ISSUE)
    .map((c) => c.body)
    .filter((b) => b.includes('<!-- adispatchd:'));
}
