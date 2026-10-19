import { describe, expect, it } from 'vitest';
import { FakeClock, SourceError, type FetchLike } from '../../core/index.js';
import { GITHUB_ACCEPT, GITHUB_API_VERSION, GitHubHttpClient, parseLinkHeader } from './http.js';
import { FakeGitHub } from './testing/index.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler): FetchLike & { calls: Array<{ url: URL; init: RequestInit }> } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Wait until the client has scheduled its retry delay on the fake timers. */
async function waitForTimer(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 100 && clock.pendingTimers() === 0; i++) await new Promise((r) => setImmediate(r));
  expect(clock.pendingTimers()).toBe(1);
}

describe('GitHubHttpClient', () => {
  it('sends pinned API version, accept header and bearer token', async () => {
    const fetch = stubFetch(() => jsonRes(200, { ok: true }));
    const client = new GitHubHttpClient({ clock: new FakeClock(), fetch });
    const res = await client.request('GET', '/repos/o/r', { token: 'tok-123', query: { a: 1, b: undefined } });
    expect(res.data).toEqual({ ok: true });
    const headers = new Headers(fetch.calls[0]?.init.headers);
    expect(headers.get('x-github-api-version')).toBe(GITHUB_API_VERSION);
    expect(headers.get('accept')).toBe(GITHUB_ACCEPT);
    expect(headers.get('authorization')).toBe('Bearer tok-123');
    expect(fetch.calls[0]?.url.toString()).toBe('https://api.github.com/repos/o/r?a=1');
  });

  it('follows Link rel="next" pagination', async () => {
    const clock = new FakeClock();
    const github = new FakeGitHub({ clock });
    for (let i = 0; i < 250; i++) github.createIssue('o/r');
    const client = new GitHubHttpClient({ clock, fetch: github.fetch });
    const all = await client.paginate<{ number: number }>('/repos/o/r/issues', { query: { direction: 'asc' } });
    expect(all).toHaveLength(250);
    expect(all.map((i) => i.number)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    expect(github.requests.map((r) => r.query.page ?? '1')).toEqual(['1', '2', '3']);
  });

  it('does not follow pagination links to a foreign origin', async () => {
    const fetch = stubFetch(() => jsonRes(200, [1], { link: '<https://evil.example/steal?page=2>; rel="next"' }));
    const client = new GitHubHttpClient({ clock: new FakeClock(), fetch });
    expect(await client.paginate('/x', { token: 't' })).toEqual([1]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('enforces a page limit', async () => {
    const fetch = stubFetch((url) => jsonRes(200, [1], { link: `<${url.origin}${url.pathname}?page=${Number(url.searchParams.get('page') ?? 1) + 1}>; rel="next"` }));
    const client = new GitHubHttpClient({ clock: new FakeClock(), fetch, maxPages: 3 });
    await expect(client.paginate('/x')).rejects.toMatchObject({ kind: 'invalid' });
    expect(fetch.calls).toHaveLength(3);
  });

  it('retries 429 after Retry-After using the injected timers', async () => {
    const clock = new FakeClock();
    let n = 0;
    const fetch = stubFetch(() => (++n === 1 ? jsonRes(429, { message: 'slow down' }, { 'retry-after': '7' }) : jsonRes(200, { ok: 1 })));
    const client = new GitHubHttpClient({ clock, timers: clock, fetch });
    const pending = client.request('GET', '/x');
    await waitForTimer(clock);
    await clock.advanceAsync(6_999);
    expect(fetch.calls).toHaveLength(1);
    await clock.advanceAsync(1);
    await expect(pending).resolves.toMatchObject({ data: { ok: 1 } });
    expect(fetch.calls).toHaveLength(2);
  });

  it('treats 403 with x-ratelimit-remaining=0 as rate limit and waits until reset', async () => {
    const clock = new FakeClock('2026-10-16T12:00:00Z');
    const reset = Math.floor(clock.nowMs() / 1000) + 30;
    let n = 0;
    const fetch = stubFetch(() =>
      ++n === 1
        ? jsonRes(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
        : jsonRes(200, []),
    );
    const client = new GitHubHttpClient({ clock, timers: clock, fetch });
    const pending = client.request('POST', '/mutating', { body: { a: 1 } }); // rate limits are retried even for POST
    await waitForTimer(clock);
    await clock.advanceAsync(31_000);
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it('gives up with rate_limited when the wait exceeds maxRetryWaitMs', async () => {
    const clock = new FakeClock();
    const fetch = stubFetch(() => jsonRes(429, { message: 'secondary rate limit' }, { 'retry-after': '3600' }));
    const client = new GitHubHttpClient({ clock, timers: clock, fetch });
    const err = await client.request('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 3_600_000, status: 429 });
    expect(fetch.calls).toHaveLength(1);
  });

  it('retries transient errors for GET with backoff, but never blindly for POST', async () => {
    const clock = new FakeClock();
    const fetch = stubFetch(() => jsonRes(502, { message: 'bad gateway' }));
    const client = new GitHubHttpClient({ clock, timers: clock, fetch, maxRetries: 2 });
    const pending = client.request('GET', '/x').catch((e: unknown) => e);
    await waitForTimer(clock);
    await clock.advanceAsync(1_000);
    await waitForTimer(clock);
    await clock.advanceAsync(2_000);
    const err = await pending;
    expect(err).toMatchObject({ kind: 'transient', outcomeUnknown: false });
    expect(fetch.calls).toHaveLength(3);

    const post = await client.request('POST', '/comments', { body: { body: 'x' } }).catch((e: unknown) => e);
    expect(post).toMatchObject({ kind: 'transient', outcomeUnknown: true, retryable: true });
    expect(fetch.calls).toHaveLength(4);
  });

  it('flags network errors of mutating requests as outcomeUnknown', async () => {
    const fetch = stubFetch(() => {
      throw new TypeError('fetch failed: connect ECONNRESET Authorization: Bearer leaked-token');
    });
    const client = new GitHubHttpClient({ clock: new FakeClock(), fetch, maxRetries: 0 });
    const err = (await client.request('POST', '/x', { token: 'leaked-token', body: {} }).catch((e: unknown) => e)) as SourceError;
    expect(err).toMatchObject({ kind: 'transient', outcomeUnknown: true });
    expect(err.message).not.toContain('leaked-token');
    expect(JSON.stringify(err)).not.toContain('leaked-token');
    expect(err.cause).toBeUndefined();
  });

  it('flags unusable 2xx bodies of mutating requests as outcomeUnknown', async () => {
    const fetch = stubFetch(() => new Response('not json', { status: 201 }));
    const client = new GitHubHttpClient({ clock: new FakeClock(), fetch, maxRetries: 0 });
    await expect(client.request('POST', '/x', { body: {} })).rejects.toMatchObject({ kind: 'transient', outcomeUnknown: true });
    await expect(client.request('GET', '/x')).rejects.toMatchObject({ kind: 'invalid', outcomeUnknown: false });
  });

  it('maps status codes to error kinds without echoing tokens', async () => {
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [410, 'not_found'],
      [422, 'invalid'],
      [500, 'transient'],
    ];
    for (const [status, kind] of cases) {
      const fetch = stubFetch(() => jsonRes(status, { message: `msg ${status}` }));
      const client = new GitHubHttpClient({ clock: new FakeClock(), fetch, maxRetries: 0 });
      const err = (await client.request('GET', '/repos/o/r', { token: 'secret-token-value' }).catch((e: unknown) => e)) as SourceError;
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.message).toContain(`HTTP ${status}`);
      expect(`${err.message}${JSON.stringify(err.details)}`).not.toContain('secret-token-value');
    }
  });

  it('posts GraphQL queries with variables to the GraphQL endpoint (github.com and GHES)', async () => {
    const fetch = stubFetch(() => jsonRes(200, { data: { viewer: { login: 'x' } } }));
    const client = new GitHubHttpClient({ clock: new FakeClock(), fetch });
    const res = await client.graphql('query($a: String!) { viewer { login } }', { a: 'v' }, { token: 'tok' });
    expect(res).toEqual({ data: { viewer: { login: 'x' } }, errors: [] });
    const call = fetch.calls[0];
    expect(call?.url.toString()).toBe('https://api.github.com/graphql');
    expect(call?.init.method).toBe('POST');
    expect(JSON.parse(String(call?.init.body))).toEqual({ query: 'query($a: String!) { viewer { login } }', variables: { a: 'v' } });
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer tok');

    const ghes = new GitHubHttpClient({ clock: new FakeClock(), fetch, baseUrl: 'https://ghe.example.com/api/v3' });
    await ghes.graphql('{ viewer { login } }', {});
    expect(fetch.calls[1]?.url.toString()).toBe('https://ghe.example.com/api/graphql');
  });

  it('returns partial data with errors and treats GraphQL RATE_LIMITED (HTTP 200) as rate limit with retry', async () => {
    const clock = new FakeClock('2026-10-19T12:00:00Z');
    let n = 0;
    const fetch = stubFetch(() =>
      ++n === 1
        ? jsonRes(200, { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { 'retry-after': '3' })
        : jsonRes(200, { data: { a: null }, errors: [{ type: 'NOT_FOUND', path: ['a'], message: 'nope' }] }),
    );
    const client = new GitHubHttpClient({ clock, timers: clock, fetch, maxRetries: 1 });
    const pending = client.graphql('{ a }', {});
    await waitForTimer(clock);
    await clock.advanceAsync(3_000);
    expect(await pending).toEqual({ data: { a: null }, errors: [{ type: 'NOT_FOUND', path: ['a'], message: 'nope' }] });
    expect(fetch.calls).toHaveLength(2);

    const limited = stubFetch(() => jsonRes(200, { errors: [{ type: 'RATE_LIMITED', message: 'x' }] }));
    const noRetry = new GitHubHttpClient({ clock, timers: clock, fetch: limited, maxRetries: 0 });
    await expect(noRetry.graphql('{ a }', {})).rejects.toMatchObject({ kind: 'rate_limited', retryable: true });

    // Transient HTTP errors are retried: the query is read-only (idempotent).
    let m = 0;
    const flaky = stubFetch(() => (++m === 1 ? jsonRes(502, { message: 'bad gateway' }) : jsonRes(200, { data: { ok: true } })));
    const retrying = new GitHubHttpClient({ clock, timers: clock, fetch: flaky, maxRetries: 1, retryBaseDelayMs: 10 });
    const p2 = retrying.graphql('{ ok }', {});
    await waitForTimer(clock);
    await clock.advanceAsync(10);
    expect((await p2).data).toEqual({ ok: true });

    const broken = stubFetch(() => jsonRes(200, [1, 2]));
    await expect(new GitHubHttpClient({ clock, fetch: broken }).graphql('{ a }', {})).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('parses Link headers', () => {
    expect(
      parseLinkHeader('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
    ).toEqual({ next: 'https://api.github.com/x?page=2', last: 'https://api.github.com/x?page=5' });
    expect(parseLinkHeader(null)).toEqual({});
  });
});
