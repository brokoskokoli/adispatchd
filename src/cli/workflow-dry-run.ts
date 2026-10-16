/**
 * `workflow dry-run <id>` (Spec §19), local variant: loads the configuration,
 * queries the source with the configured GitHub App identity and reads
 * locks/blocks/active runs read-only from the data directory's database (if
 * present). Never reserves, never starts workers, never runs lifecycle
 * actions or shell filters/conditions. Works without a running instance
 * (WI-12 adds the HTTP variant against a running instance).
 *
 * Exit codes: 0 = dry-run done, 1 = invalid configuration / unknown workflow
 * / source error, 2 = usage error.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SecretRedactor,
  dataPaths,
  errorMessage,
  noopLogger,
  systemClock,
  type Clock,
  type FetchLike,
  type SourceAdapter,
} from '../core/index.js';
import { ConfigLoadError, ConfigManager, formatConfigIssue, type LoadedConfig } from '../config/index.js';
import { GitHubAppCredentialProvider } from '../identities/index.js';
import { MIGRATIONS, createRepositories, schemaVersion } from '../persistence/index.js';
import { dryRunWorkflow, emptyState, formatDryRun, repositoryState, type SchedulingState } from '../scheduler/index.js';
import { createGitHubSourceFactory } from '../sources/index.js';
import type { CliIo, DryRunCliOptions } from './program.js';

/** Injectable dependencies (tests: Fake-GitHub `fetch`, key env). */
export interface WorkflowDryRunDeps {
  fetch?: FetchLike;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
}

/** Source adapters for all configured sources (V1: GitHub). */
function buildSources(config: LoadedConfig, deps: WorkflowDryRunDeps, clock: Clock): Map<string, SourceAdapter> {
  const redactor = new SecretRedactor();
  const identities = Object.fromEntries(
    Object.values(config.identities).map((i) => [i.id, { appId: i.appId, installationId: i.installationId, privateKeyEnv: i.privateKeyEnv }]),
  );
  const credentials = new GitHubAppCredentialProvider(identities, {
    clock,
    redactor,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  });
  const factory = createGitHubSourceFactory();
  const adapters = new Map<string, SourceAdapter>();
  for (const source of Object.values(config.sources)) {
    adapters.set(
      source.id,
      factory.create(
        source.id,
        { owner: source.owner, repository: source.repository, identity: source.identity },
        { credentials, logger: noopLogger, clock, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
      ),
    );
  }
  return adapters;
}

/** Read-only scheduling state from `<dataDir>/orchestrator.sqlite`, if usable. */
function openState(dataDir: string | undefined, notes: string[]): { state: SchedulingState; close: () => void } {
  const none = { state: emptyState(), close: () => undefined };
  if (!dataDir) {
    notes.push('no --data-dir given: active runs, locks, blocks and cron history are not considered');
    return none;
  }
  const file = dataPaths(path.resolve(dataDir)).database;
  if (!existsSync(file)) {
    notes.push(`no database at ${file}: active runs, locks, blocks and cron history are not considered`);
    return none;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const expected = Math.max(...MIGRATIONS.map((m) => m.version));
    const actual = schemaVersion(db);
    if (actual !== expected) {
      notes.push(`database schema version ${actual} differs from ${expected}: database not used`);
      db.close();
      return none;
    }
    const repos = createRepositories(db);
    const opened = db;
    return { state: repositoryState(repos), close: () => opened.close() };
  } catch (err) {
    db?.close();
    notes.push(`database ${file} not readable (${errorMessage(err)}): active runs, locks and blocks are not considered`);
    return none;
  }
}

/** Create the `workflow dry-run` handler. */
export function createWorkflowDryRunHandler(io: Pick<CliIo, 'stdout' | 'stderr'>, deps: WorkflowDryRunDeps = {}) {
  return async (workflowId: string, opts: DryRunCliOptions): Promise<number> => {
    if (!opts.configDir) {
      io.stderr('workflow dry-run: --config-dir is required\n');
      return 2;
    }
    const clock = deps.clock ?? systemClock;
    const configDir = path.resolve(opts.configDir);
    const dataDir = path.resolve(opts.dataDir ?? 'data');
    let config: ConfigManager;
    try {
      config = await ConfigManager.create({ configDir, dataDir, clock });
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        io.stderr(`Configuration in ${configDir} is invalid:\n${err.errors.map((i) => `  ${formatConfigIssue(i)}\n`).join('')}`);
        return 1;
      }
      throw err;
    }
    if (!config.getWorkflow(workflowId)) {
      io.stderr(`workflow dry-run: unknown workflow '${workflowId}'\n`);
      return 1;
    }
    const notes: string[] = [];
    const { state, close } = openState(opts.dataDir, notes);
    try {
      const sources = buildSources(config.current, deps, clock);
      const result = await dryRunWorkflow({ config, sources: (id) => sources.get(id), state, clock, notes }, workflowId);
      io.stdout(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatDryRun(result));
      return result.source?.error ? 1 : 0;
    } finally {
      close();
    }
  };
}
