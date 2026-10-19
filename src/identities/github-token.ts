/**
 * Credential provider for identities of type `github_token` (WI-14): a
 * long-lived GitHub token (e.g. a fine-grained personal access token) read
 * from an environment variable. Needed e.g. for user-owned GitHub Projects,
 * which GitHub App installation tokens cannot read.
 *
 * The token is never logged or put into error messages; it is registered
 * with the {@link SecretRedactor} as soon as it is read (at construction), so
 * logs and run output are redacted from the start (Spec §20.4).
 */
import {
  SourceError,
  noopLogger,
  type AccessToken,
  type CredentialProvider,
  type IdentityDescription,
  type IdentityRef,
  type Logger,
  type SecretRedactor,
} from '../core/index.js';

/** Identity entry of type `github_token` (normalised, camelCase). */
export interface GitHubTokenIdentityConfig {
  /** Name of the environment variable holding the token. */
  tokenEnv: string;
}

/** Dependencies of {@link GitHubTokenCredentialProvider}. */
export interface GitHubTokenCredentialProviderDeps {
  /** Environment to read tokens from. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Registry that receives the tokens for redaction. */
  redactor?: SecretRedactor;
  logger?: Logger;
}

/** Tokens do not expire from the orchestrator's point of view (GitHub may still revoke them → 401). */
const FAR_FUTURE = new Date('9999-12-31T23:59:59Z');

/** {@link CredentialProvider} for `github_token` identities. */
export class GitHubTokenCredentialProvider implements CredentialProvider {
  private readonly identities: ReadonlyMap<string, GitHubTokenIdentityConfig>;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly redactor: SecretRedactor | undefined;
  private readonly logger: Logger;
  private readonly tokens = new Map<string, string>();

  constructor(identities: Readonly<Record<string, GitHubTokenIdentityConfig>>, deps: GitHubTokenCredentialProviderDeps = {}) {
    this.identities = new Map(Object.entries(identities));
    this.env = deps.env ?? process.env;
    this.redactor = deps.redactor;
    this.logger = (deps.logger ?? noopLogger).child({ component: 'identities' });
    // Read every token once at start: registers it for redaction and reports a missing variable early.
    for (const [id, config] of this.identities) {
      try {
        this.read(id, config);
      } catch (err) {
        this.logger.error('GitHub token identity not usable', { identity: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  getToken(identity: IdentityRef): Promise<AccessToken> {
    const config = this.identities.get(identity);
    if (!config) return Promise.reject(new SourceError('auth', `Unknown identity "${identity}"`, { retryable: false }));
    try {
      return Promise.resolve({ token: this.tokens.get(identity) ?? this.read(identity, config), expiresAt: FAR_FUTURE });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Forget the cached token: the next call reads the environment variable again (e.g. after a 401). */
  invalidate(identity: IdentityRef): void {
    this.tokens.delete(identity);
  }

  describe(identity: IdentityRef): IdentityDescription | undefined {
    return this.identities.has(identity) ? { kind: 'github_token' } : undefined;
  }

  private read(identity: string, config: GitHubTokenIdentityConfig): string {
    const raw = this.env[config.tokenEnv];
    const token = raw?.trim() ?? '';
    if (token === '') {
      throw new SourceError('auth', `Token for identity "${identity}" missing: environment variable ${config.tokenEnv} is not set or empty`, {
        retryable: false,
      });
    }
    if (raw !== undefined) this.redactor?.add(raw);
    this.redactor?.add(token);
    this.tokens.set(identity, token);
    return token;
  }
}
