/**
 * WI-16: `source.update` with project fields through the lifecycle engine –
 * journal details, identity selection, retries.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessToken, CredentialProvider, SourceItem } from '../core/index.js';
import { BASE_FILES } from '../config/testing/fixtures.js';
import { eventSummary } from '../ui/shared/format.js';
import type { FakeProject } from '../sources/github/testing/index.js';
import { ISSUE, ITEM_KEY, REPO, createEnv, drive, loadSnapshot, type LifecycleTestEnv } from './testing/helpers.js';

const PROJECT_FIELDS = { Status: 'single_select', Notes: 'text' } as const;

/** The run's item as handed in by the caller (no extra read before the hook). */
const ITEM: SourceItem = { sourceId: 'repo_a', itemId: String(ISSUE), key: ITEM_KEY, url: '', type: 'issue', fields: {} };

function sourcesYaml(projectIdentity?: string): string {
  return [
    'sources:',
    '  repo_a:',
    '    type: github',
    '    owner: example',
    '    repository: a',
    '    identity: maintainer',
    '    project:',
    '      number: 3',
    ...(projectIdentity ? [`      identity: ${projectIdentity}`] : []),
    '      fields: { Status: single_select, Notes: text }',
    '',
  ].join('\n');
}

const IDENTITIES = `${BASE_FILES['identities.yaml']}  board:\n    type: github_token\n    token_env: TEST_BOARD_TOKEN\n`;

const WORKFLOW = `id: wf
name: Coder WF
identity: coder
trigger: { type: source, source: repo_a }
execute: { type: shell, command: /bin/true }
on_success:
  - type: source.update
    labels: { add: [ready-for-review], remove: [coding] }
    project: { Status: Review, Notes: null }
`;

/** Records the identity of every token request and hands out `tok-<identity>`. */
function perIdentityCredentials(): CredentialProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getToken: (identity): Promise<AccessToken> => {
      calls.push(identity);
      return Promise.resolve({ token: `tok-${identity}`, expiresAt: new Date('2999-01-01T00:00:00Z') });
    },
  };
}

function setup(projectIdentity?: string): { env: LifecycleTestEnv; project: FakeProject } {
  const env = createEnv({
    project: { number: 3, fields: PROJECT_FIELDS, ...(projectIdentity ? { identity: projectIdentity, writeIdentity: projectIdentity } : {}) },
    credentials: perIdentityCredentials(),
  });
  const project = env.github.createProject('example', {
    number: 3,
    fields: [
      { name: 'Status', dataType: 'SINGLE_SELECT', options: ['In Progress', 'Review'] },
      { name: 'Notes', dataType: 'TEXT' },
    ],
  });
  return { env, project };
}

describe('lifecycle: source.update with project fields', () => {
  let env: LifecycleTestEnv | undefined;
  afterEach(() => env?.cleanup());

  it('journals the changed project fields and writes with the action identity', async () => {
    const s = setup();
    env = s.env;
    s.env.github.addProjectItem(s.project, REPO, ISSUE, { Status: 'In Progress', Notes: 'wip' });
    const snapshot = await loadSnapshot(WORKFLOW, 'wf', { 'sources.yaml': sourcesYaml() });
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot, { item: ITEM }), env.clock);

    expect(result.status).toBe('succeeded');
    expect(s.env.github.projectValues(s.project, REPO, ISSUE)).toMatchObject({ Status: 'Review', Notes: null });
    const event = env.p.events
      .listForRun(run.id)
      .find((e) => e.type === 'lifecycle.action' && e.payload.status === 'succeeded' && e.payload.type === 'source.update');
    expect(event?.payload.details).toEqual({
      changed: true,
      applied: { labelsAdded: ['ready-for-review'], labelsRemoved: ['coding'], projectFields: { Status: 'Review', Notes: null } },
    });
    expect(result.actions[0]?.config).toMatchObject({ project: { Status: 'Review', Notes: null } });
    // Workflow identity `coder` for labels and project fields.
    const graphql = s.env.github.requests.filter((r) => r.graphql);
    expect(graphql.length).toBeGreaterThan(0);
    expect(graphql.every((r) => r.token === 'tok-coder')).toBe(true);
  });

  it('an explicit project.identity writes the project fields', async () => {
    const s = setup('board');
    env = s.env;
    s.env.github.addProjectItem(s.project, REPO, ISSUE, { Status: 'In Progress' });
    const snapshot = await loadSnapshot(WORKFLOW, 'wf', { 'sources.yaml': sourcesYaml('board'), 'identities.yaml': IDENTITIES });
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    await drive(env.engine().runHook(run, 'on_success', snapshot, { item: ITEM }), env.clock);
    const requests = s.env.github.requests;
    expect(requests.filter((r) => r.graphql).every((r) => r.token === 'tok-board')).toBe(true);
    expect(requests.filter((r) => r.method !== 'GET' && !r.graphql).every((r) => r.token === 'tok-coder')).toBe(true);
    expect(s.env.github.projectValues(s.project, REPO, ISSUE)).toMatchObject({ Status: 'Review' });
  });

  it('a rate limit is retried by the action retry; a second run of the hook changes nothing', async () => {
    const s = setup();
    env = s.env;
    s.env.github.addProjectItem(s.project, REPO, ISSUE, { Status: 'In Progress' });
    const snapshot = await loadSnapshot(WORKFLOW, 'wf', { 'sources.yaml': sourcesYaml() });
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    s.env.github.failNext({ method: 'POST', path: '/graphql' }, { status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'rate limit' }] }, headers: { 'retry-after': '2' } });
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot, { item: ITEM }), env.clock);
    expect(result.status).toBe('succeeded');
    expect(result.actions[0]?.attempts).toBe(2);
    expect(s.env.github.projectMutations().map((m) => m.name)).toEqual(['updateProjectV2ItemFieldValue']);

    // Repeating the update (as a retry or recovery would) does not mutate again.
    await env.adapter.applyUpdate(ITEM, { project: { Status: 'Review', Notes: null } }, 'coder');
    expect(s.env.github.projectMutations()).toHaveLength(1);
  });

  it('an unknown option fails the action without retries and notifies', async () => {
    const s = setup();
    env = s.env;
    s.env.github.addProjectItem(s.project, REPO, ISSUE);
    const snapshot = await loadSnapshot(WORKFLOW.replace('Status: Review', 'Status: Blocked'), 'wf', { 'sources.yaml': sourcesYaml() });
    const run = env.finalizeSuccess(env.reserve(snapshot).id);
    const result = await drive(env.engine().runHook(run, 'on_success', snapshot, { item: ITEM }), env.clock);
    expect(result.status).toBe('failed');
    expect(result.actions[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(result.actions[0]?.lastError).toMatchObject({ retryable: false, kind: 'invalid' });
    expect(String((result.actions[0]?.lastError as { message?: unknown }).message)).toContain('option "Blocked" not found (available: "In Progress", "Review")');
    expect(env.notifications.map((n) => n.type)).toEqual(['lifecycle_action_failed']);
    // Labels were applied before the project part failed – and the journal says so (attempt, action, event).
    expect(s.env.github.labels(REPO, ISSUE)).toContain('ready-for-review');
    const applied = { labelsAdded: ['ready-for-review'], labelsRemoved: ['coding'] };
    expect(result.actions[0]?.lastError).toMatchObject({ details: { applied } });
    const attempts = env.p.actions.listAttempts(result.actions[0]?.id as number);
    expect(attempts[0]?.error).toMatchObject({ details: { applied } });
    const event = env.p.events.listForRun(run.id).find((e) => e.type === 'lifecycle.action' && e.payload.status === 'failed');
    expect(event?.payload.error).toMatchObject({ details: { applied } });
    expect(eventSummary({ type: event?.type ?? '', payload: event?.payload })).toBe('on_success on_success.0 failed (+ready-for-review, -coding)');
  });
});
