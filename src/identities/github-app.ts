/**
 * GitHub App credential provider (Spec §5.3): signs an app JWT and exchanges
 * it for a short-lived installation token, cached until shortly before expiry.
 * Concurrent requests for the same identity share one exchange.
 *
 * Private keys and tokens are never logged or put into error messages; they
 * are registered with an optional {@link SecretRedactor} so that downstream
 * logs redact them as well (Spec §20.4).
 */
import type { KeyObject } from 'node:crypto';
import {
  SourceError,
  noopLogger,
  type AccessToken,
  type Clock,
  type CredentialProvider,
  type FetchLike,
  type IdentityRef,
  type Logger,
  type SecretRedactor,
  type Timers,
} from '../core/index.js';
import { GitHubHttpClient } from '../sources/index.js';
import { createAppJwt, normalizePrivateKeyPem, parsePrivateKey } from './jwt.js';

/** Identity entry of type `github_app` (normalised, camelCase). */
export interface GitHubAppIdentityConfig {
  appId: string | number;
  installationId: string | number;
  /** Name of the environment variable holding the PEM private key. */
  privateKeyEnv: string;
}

/** Dependencies of {@link GitHubAppCredentialProvider}. */
export interface GitHubAppCredentialProviderDeps {
  clock: Clock;
  fetch?: FetchLike;
  timers?: Timers;
  logger?: Logger;
  /** Environment to read private keys from. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Registry that receives private keys and issued tokens for redaction. */
  redactor?: SecretRedactor;
  /** API base URL (default `https://api.github.com`). */
  apiBaseUrl?: string;
  /** Pre-built HTTP client (overrides fetch/timers/apiBaseUrl). */
  http?: GitHubHttpClient;
  /** Refresh a cached token this long before it expires. Default 5 min. */
  refreshMarginMs?: number;
}

interface InstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

/** {@link CredentialProvider} for identities of type `github_app`. */
export class GitHubAppCredentialProvider implements CredentialProvider {
  private readonly identities: ReadonlyMap<string, GitHubAppIdentityConfig>;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly redactor: SecretRedactor | undefined;
  private readonly http: GitHubHttpClient;
  private readonly refreshMarginMs: number;
  private readonly keys = new Map<string, KeyObject>();
  private readonly cache = new Map<string, AccessToken>();
  private readonly inflight = new Map<string, Promise<AccessToken>>();
  /** Bumped on invalidate so that an in-flight exchange started earlier does not repopulate the cache. */
  private readonly generation = new Map<string, number>();
  /** Issued tokens still registered with the redactor (removed once expired). */
  private issued: AccessToken[] = [];

  constructor(identities: Readonly<Record<string, GitHubAppIdentityConfig>>, deps: GitHubAppCredentialProviderDeps) {
    this.identities = new Map(Object.entries(identities));
    this.clock = deps.clock;
    this.logger = (deps.logger ?? noopLogger).child({ component: 'identities' });
    this.env = deps.env ?? process.env;
    this.redactor = deps.redactor;
    this.refreshMarginMs = deps.refreshMarginMs ?? 5 * 60_000;
    this.http =
      deps.http ??
      new GitHubHttpClient({
        clock: deps.clock,
        logger: this.logger,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.timers ? { timers: deps.timers } : {}),
        ...(deps.apiBaseUrl ? { baseUrl: deps.apiBaseUrl } : {}),
      });
  }

  /** IDs of the configured identities. */
  identityIds(): string[] {
    return [...this.identities.keys()];
  }

  async getToken(identity: IdentityRef, options: { signal?: AbortSignal } = {}): Promise<AccessToken> {
    const cached = this.cache.get(identity);
    if (cached && cached.expiresAt.getTime() - this.refreshMarginMs > this.clock.now().getTime()) return cached;
    const pending = this.inflight.get(identity);
    if (pending) return pending;
    const generation = this.generation.get(identity) ?? 0;
    const promise = this.exchange(identity, options.signal)
      .then((token) => {
        if ((this.generation.get(identity) ?? 0) === generation) {
          this.cache.set(identity, token);
        }
        return token;
      })
      .finally(() => {
        if (this.inflight.get(identity) === promise) this.inflight.delete(identity);
      });
    this.inflight.set(identity, promise);
    return promise;
  }

  invalidate(identity: IdentityRef): void {
    this.cache.delete(identity);
    this.inflight.delete(identity);
    this.generation.set(identity, (this.generation.get(identity) ?? 0) + 1);
  }

  private privateKey(identity: string, config: GitHubAppIdentityConfig): KeyObject {
    const cached = this.keys.get(identity);
    if (cached) return cached;
    const raw = this.env[config.privateKeyEnv];
    if (!raw || raw.trim() === '') {
      throw new SourceError(
        'auth',
        `Private key for identity "${identity}" missing: environment variable ${config.privateKeyEnv} is not set`,
        { retryable: false },
      );
    }
    // Register every form the key may show up in (raw env value, `\n`-escaped and normalised PEM).
    const normalized = normalizePrivateKeyPem(raw);
    for (const form of [raw, raw.trim(), normalized, normalized.trim()]) this.redactor?.add(form);
    const key = parsePrivateKey(raw, `identity "${identity}"`);
    this.keys.set(identity, key);
    return key;
  }

  private async exchange(identity: string, signal: AbortSignal | undefined): Promise<AccessToken> {
    const config = this.identities.get(identity);
    if (!config) throw new SourceError('auth', `Unknown identity "${identity}"`, { retryable: false });
    const jwt = createAppJwt(config.appId, this.privateKey(identity, config), this.clock.now());
    this.redactor?.add(jwt);
    let data: InstallationTokenResponse;
    try {
      const res = await this.http.request<InstallationTokenResponse>(
        'POST',
        `/app/installations/${encodeURIComponent(String(config.installationId))}/access_tokens`,
        // Token creation has no side effects worth reconciling: safe to retry.
        { token: jwt, idempotent: true, ...(signal ? { signal } : {}) },
      );
      data = res.data ?? {};
    } catch (err) {
      if (err instanceof SourceError) {
        // Client errors (bad JWT, unknown installation, revoked app) are auth failures;
        // transient/rate-limit errors keep their kind so callers can retry.
        if (err.kind === 'transient' || err.kind === 'rate_limited') throw err;
        throw new SourceError('auth', `Could not obtain installation token for identity "${identity}": ${err.message}`, {
          retryable: false,
          ...(err.status !== undefined ? { status: err.status } : {}),
        });
      }
      throw err;
    } finally {
      this.redactor?.remove(jwt);
    }
    if (typeof data.token !== 'string' || typeof data.expires_at !== 'string' || Number.isNaN(Date.parse(data.expires_at))) {
      throw new SourceError('auth', `Invalid installation token response for identity "${identity}"`, { retryable: false });
    }
    const token: AccessToken = { token: data.token, expiresAt: new Date(data.expires_at) };
    this.trackForRedaction(token);
    this.logger.info('Obtained GitHub installation token', { identity, expiresAt: token.expiresAt.toISOString() });
    return token;
  }

  /** Register a new token for redaction and forget tokens that have expired (bounded registry). */
  private trackForRedaction(token: AccessToken): void {
    if (!this.redactor) return;
    const now = this.clock.now().getTime();
    this.issued = this.issued.filter((t) => {
      if (t.expiresAt.getTime() > now) return true;
      this.redactor?.remove(t.token);
      return false;
    });
    this.redactor.add(token.token);
    this.issued.push(token);
  }
}
