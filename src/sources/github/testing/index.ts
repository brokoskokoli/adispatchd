/**
 * Test helpers for the GitHub source (excluded from the build). Import from
 * tests only: `import { FakeGitHub } from '../sources/github/testing/index.js'`.
 */
import { FakeClock, noopLogger, type Clock, type CredentialProvider, type Logger, type Timers } from '../../../core/index.js';
import { GitHubSourceAdapter, type GitHubSourceConfig } from '../adapter.js';
import { FakeGitHub, staticCredentials } from './fake-github.js';

export * from './fake-github.js';

/** Options of {@link createFakeGitHubSource}. */
export interface FakeGitHubSourceOptions extends Partial<GitHubSourceConfig> {
  sourceId?: string;
  credentials?: CredentialProvider;
  clock?: Clock;
  /** Timers for HTTP retry delays; default: a fresh {@link FakeClock} (delays never elapse unless advanced). */
  timers?: Timers;
  logger?: Logger;
  /** HTTP retries for idempotent calls; default 0 so injected faults surface immediately. */
  maxRetries?: number;
}

/**
 * Build a {@link GitHubSourceAdapter} wired to `github.fetch`. Defaults:
 * source `project_a` → `example/project-a`, identity `maintainer`,
 * {@link staticCredentials} (works when no app is registered on the fake).
 */
export function createFakeGitHubSource(github: FakeGitHub, options: FakeGitHubSourceOptions = {}): GitHubSourceAdapter {
  const clock = options.clock ?? new FakeClock();
  return new GitHubSourceAdapter(
    options.sourceId ?? 'project_a',
    {
      owner: options.owner ?? 'example',
      repository: options.repository ?? 'project-a',
      identity: options.identity ?? 'maintainer',
      apiBaseUrl: options.apiBaseUrl ?? github.baseUrl,
      webBaseUrl: options.webBaseUrl ?? github.webBaseUrl,
    },
    {
      credentials: options.credentials ?? staticCredentials(),
      logger: options.logger ?? noopLogger,
      clock,
      fetch: github.fetch,
    },
    {
      timers: options.timers ?? (clock instanceof FakeClock ? clock : new FakeClock()),
      httpOptions: { maxRetries: options.maxRetries ?? 0 },
    },
  );
}
