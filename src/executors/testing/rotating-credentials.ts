/**
 * Test helper (excluded from the build): a credential provider issuing a new,
 * unique token on every call with a fixed lifetime measured by a clock, so
 * that token-file renewal can be tested with a fake clock (WI-18).
 */
import { SourceError, type AccessToken, type Clock, type CredentialProvider, type IdentityRef, type TokenRequestOptions } from '../../core/index.js';

/** Recorded `getToken` call. */
export interface RotatingCall {
  identity: IdentityRef;
  minValidityMs: number | undefined;
}

/** See module docs. */
export class RotatingCredentials implements CredentialProvider {
  readonly calls: RotatingCall[] = [];
  /** Every token handed out, in order. */
  readonly issued: AccessToken[] = [];
  /** Number of upcoming calls that fail with a transient error. */
  failNext = 0;
  /** Identities that never expire (like `github_token`). */
  readonly nonExpiring = new Set<IdentityRef>();
  private counter = 0;

  constructor(
    private readonly clock: Clock,
    private readonly lifetimeMs = 60 * 60_000,
    private readonly prefix = 'tok',
  ) {}

  getToken(identity: IdentityRef, options: TokenRequestOptions = {}): Promise<AccessToken> {
    this.calls.push({ identity, minValidityMs: options.minValidityMs });
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new SourceError('transient', `token exchange for ${identity} failed (HTTP 502)`, { retryable: true }));
    }
    this.counter++;
    const token: AccessToken = {
      token: `${this.prefix}_${identity}_${String(this.counter).padStart(4, '0')}_secretvalue`,
      expiresAt: this.nonExpiring.has(identity)
        ? new Date('9999-12-31T23:59:59Z')
        : new Date(this.clock.now().getTime() + this.lifetimeMs),
    };
    this.issued.push(token);
    return Promise.resolve(token);
  }

  /** The token issued last. */
  get last(): AccessToken | undefined {
    return this.issued.at(-1);
  }
}
