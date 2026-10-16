import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeClock, MemoryLogger, SecretRedactor, SourceError, errorMessage } from '../core/index.js';
import { GitHubHttpClient } from '../sources/index.js';
import { FakeGitHub, verifyAppJwt, type FakeAppCredentials } from '../sources/github/testing/index.js';
import { GitHubAppCredentialProvider, createAppJwt, normalizePrivateKeyPem, parsePrivateKey } from './index.js';

let pem: string;
let publicPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createAppJwt', () => {
  it('produces an RS256 JWT verifiable with the public key, iat -60s, exp <= 10 min', () => {
    const now = new Date('2026-10-16T12:00:00.500Z');
    const jwt = createAppJwt(12345, parsePrivateKey(pem, 'test'), now);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = decode(p);
    const nowS = Math.floor(now.getTime() / 1000);
    expect(payload.iss).toBe('12345');
    expect(payload.iat).toBe(nowS - 60);
    expect(payload.exp as number).toBeGreaterThan(nowS);
    expect((payload.exp as number) - nowS).toBeLessThanOrEqual(600);
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(publicPem), Buffer.from(s, 'base64url'))).toBe(true);
    expect(verifyAppJwt(jwt, { appId: '12345', publicKey: createPublicKey(publicPem) }, now)).toBe(true);
    // A tampered payload fails verification.
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, iss: '999' })).toString('base64url')}.${s}`;
    expect(verifyAppJwt(forged, { appId: '999', publicKey: createPublicKey(publicPem) }, now)).toBe(false);
  });

  it('accepts PEM keys with literal \\n escapes, quotes and CRLF', () => {
    const escaped = `"${pem.trim().replace(/\n/g, '\\n')}"`;
    expect(normalizePrivateKeyPem(escaped)).toBe(`${pem.trim()}\n`);
    expect(() => parsePrivateKey(escaped, 'x')).not.toThrow();
    expect(() => parsePrivateKey(pem.replace(/\n/g, '\r\n'), 'x')).not.toThrow();
  });

  it('rejects invalid keys without echoing key material', () => {
    const secretish = '-----BEGIN PRIVATE KEY-----\nTOP-SECRET-MATERIAL\n-----END PRIVATE KEY-----';
    let error: unknown;
    try {
      parsePrivateKey(secretish, 'identity "coder"');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe('auth');
    expect(errorMessage(error)).not.toContain('TOP-SECRET');
    expect(JSON.stringify(error)).not.toContain('TOP-SECRET');
  });
});

describe('GitHubAppCredentialProvider', () => {
  let clock: FakeClock;
  let github: FakeGitHub;
  let app: FakeAppCredentials;

  function provider(extra: Partial<ConstructorParameters<typeof GitHubAppCredentialProvider>[1]> = {}): GitHubAppCredentialProvider {
    return new GitHubAppCredentialProvider(
      { coder: { appId: app.appId, installationId: app.installationId, privateKeyEnv: 'GITHUB_CODER_PRIVATE_KEY' } },
      {
        clock,
        timers: clock,
        fetch: github.fetch,
        env: { GITHUB_CODER_PRIVATE_KEY: app.privateKeyPem.replace(/\n/g, '\\n') },
        ...extra,
      },
    );
  }

  beforeAll(() => {
    clock = new FakeClock('2026-10-16T12:00:00Z');
    github = new FakeGitHub({ clock });
    app = github.createApp({ login: 'coder-bot[bot]' });
  });

  it('exchanges a verified JWT for an installation token with pinned headers', async () => {
    const p = provider();
    const before = github.requests.length;
    const token = await p.getToken('coder');
    expect(token.token).toMatch(/^ghs_fake/);
    expect(token.expiresAt.getTime()).toBe(clock.nowMs() + 60 * 60_000);
    const req = github.requests[before];
    expect(req).toMatchObject({ method: 'POST', path: `/app/installations/${app.installationId}/access_tokens`, status: 201 });
    expect(req?.apiVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('caches the token until shortly before expiry, then refreshes (FakeClock)', async () => {
    const localClock = new FakeClock('2026-10-16T12:00:00Z');
    const gh = new FakeGitHub({ clock: localClock });
    const a = gh.createApp();
    const p = new GitHubAppCredentialProvider(
      { coder: { appId: a.appId, installationId: a.installationId, privateKeyEnv: 'KEY' } },
      { clock: localClock, timers: localClock, fetch: gh.fetch, env: { KEY: a.privateKeyPem } },
    );
    const t1 = await p.getToken('coder');
    localClock.advance(50 * 60_000); // 10 min left > 5 min margin
    const t2 = await p.getToken('coder');
    expect(t2.token).toBe(t1.token);
    expect(gh.tokenRequestCount()).toBe(1);
    localClock.advance(6 * 60_000); // 4 min left < margin
    const t3 = await p.getToken('coder');
    expect(t3.token).not.toBe(t1.token);
    expect(gh.tokenRequestCount()).toBe(2);
    localClock.advance(2 * 60 * 60_000); // fully expired
    const t4 = await p.getToken('coder');
    expect(t4.token).not.toBe(t3.token);
    expect(gh.tokenRequestCount()).toBe(3);
  });

  it('deduplicates concurrent requests and refetches after invalidate', async () => {
    const localClock = new FakeClock('2026-10-16T12:00:00Z');
    const gh = new FakeGitHub({ clock: localClock });
    const a = gh.createApp();
    const p = new GitHubAppCredentialProvider(
      { coder: { appId: a.appId, installationId: a.installationId, privateKeyEnv: 'KEY' } },
      { clock: localClock, fetch: gh.fetch, env: { KEY: a.privateKeyPem } },
    );
    const tokens = await Promise.all([p.getToken('coder'), p.getToken('coder'), p.getToken('coder')]);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(1);
    expect(gh.tokenRequestCount()).toBe(1);
    p.invalidate('coder');
    const fresh = await p.getToken('coder');
    expect(fresh.token).not.toBe(tokens[0]?.token);
    expect(gh.tokenRequestCount()).toBe(2);
  });

  it('does not let one caller\'s abort fail the shared exchange; describes identities', async () => {
    const localClock = new FakeClock('2026-10-16T12:00:00Z');
    const gh = new FakeGitHub({ clock: localClock });
    const a = gh.createApp();
    const p = new GitHubAppCredentialProvider(
      { coder: { appId: a.appId, installationId: a.installationId, privateKeyEnv: 'KEY' } },
      { clock: localClock, fetch: gh.fetch, env: { KEY: a.privateKeyPem } },
    );
    const controller = new AbortController();
    const first = p.getToken('coder', { signal: controller.signal });
    const second = p.getToken('coder');
    controller.abort(new Error('caller gone'));
    await expect(first).rejects.toThrow('caller gone');
    await expect(second).resolves.toMatchObject({ token: expect.stringMatching(/^ghs_fake/) });
    expect(gh.tokenRequestCount()).toBe(1);
    expect(p.describe('coder')).toEqual({ appId: a.appId });
    expect(p.describe('nobody')).toBeUndefined();
  });

  it('fails with kind auth for unknown identity, missing env and rejected JWT', async () => {
    const p = provider();
    await expect(p.getToken('nobody')).rejects.toMatchObject({ kind: 'auth' });
    await expect(provider({ env: {} }).getToken('coder')).rejects.toMatchObject({ kind: 'auth' });

    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const wrongKey = provider({ env: { GITHUB_CODER_PRIVATE_KEY: other } });
    const err = await wrongKey.getToken('coder').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ kind: 'auth', status: 401, retryable: false });
  });

  it('keeps transient failures retryable', async () => {
    github.failNext({ path: /access_tokens$/ }, { status: 503 });
    const p = provider({ http: new GitHubHttpClient({ clock, fetch: github.fetch, maxRetries: 0 }) });
    const err = await p.getToken('coder').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'transient', retryable: true });
    // Next call succeeds.
    await expect(p.getToken('coder')).resolves.toMatchObject({ token: expect.stringMatching(/^ghs_fake/) });
  });

  it('never leaks keys or tokens into logs or error messages', async () => {
    const redactor = new SecretRedactor();
    const logger = new MemoryLogger(redactor.asRedactor);
    const p = provider({ redactor, logger });
    const token = await p.getToken('coder');

    // Anything that later mentions the token or key gets redacted.
    logger.error(`request failed with token ${token.token}`, { header: `Bearer ${token.token}`, key: app.privateKeyPem });
    const escapedKey = app.privateKeyPem.replace(/\n/g, '\\n');
    logger.warn(`env dump ${escapedKey}`);
    const dump = JSON.stringify(logger.records);
    expect(dump).not.toContain(token.token);
    expect(dump).not.toContain('PRIVATE KEY-----\\nMII');
    expect(dump).not.toMatch(/MII[A-Za-z0-9+/]{20}/);

    // Failure paths: error messages contain neither JWT nor key.
    github.failNext({ path: /access_tokens$/ }, { status: 401, body: { message: 'Bad credentials' } });
    p.invalidate('coder');
    const err = await p.getToken('coder').catch((e: unknown) => e);
    const text = `${errorMessage(err)} ${JSON.stringify(err)} ${String((err as Error).stack)}`;
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(token.token);
  });
});
