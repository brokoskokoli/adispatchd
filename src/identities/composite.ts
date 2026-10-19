/**
 * Routes credential requests to one provider per identity (WI-14), so that
 * identities of different kinds (`github_app`, `github_token`) can be mixed.
 */
import {
  SourceError,
  type AccessToken,
  type CredentialProvider,
  type IdentityDescription,
  type IdentityRef,
  type TokenRequestOptions,
} from '../core/index.js';

/** {@link CredentialProvider} delegating by identity ID. */
export class CompositeCredentialProvider implements CredentialProvider {
  private readonly routes: ReadonlyMap<IdentityRef, CredentialProvider>;

  /** `routes`: identity ID → provider responsible for it. */
  constructor(routes: Readonly<Record<IdentityRef, CredentialProvider>>) {
    this.routes = new Map(Object.entries(routes));
  }

  getToken(identity: IdentityRef, options?: TokenRequestOptions): Promise<AccessToken> {
    const provider = this.routes.get(identity);
    if (!provider) return Promise.reject(new SourceError('auth', `Unknown identity "${identity}"`, { retryable: false }));
    return provider.getToken(identity, options);
  }

  invalidate(identity: IdentityRef): void {
    this.routes.get(identity)?.invalidate?.(identity);
  }

  describe(identity: IdentityRef): IdentityDescription | undefined {
    return this.routes.get(identity)?.describe?.(identity);
  }
}
