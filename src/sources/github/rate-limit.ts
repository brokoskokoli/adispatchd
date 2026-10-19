/**
 * Rate-limit pause for GraphQL reads that must never stall the planning step
 * (WI-14, reused by WI-21): after a `rate_limited` error the reader answers
 * "unknown" without calling GitHub until the limit resets.
 */
import { SourceError, type Clock, type Logger } from '../../core/index.js';

/** Longest retry wait of a fail-closed GraphQL read (a longer rate-limit wait gives up immediately). */
export const GRAPHQL_MAX_RETRY_WAIT_MS = 5_000;
/** Rate-limit pause when GitHub gives no reset time. */
export const GRAPHQL_RATE_LIMIT_FALLBACK_MS = 60_000;

/** Remembers "rate limited until" for one reader. */
export class GraphQLRateLimitPause {
  /** No GraphQL calls before this time (epoch ms). */
  private until = 0;

  constructor(
    private readonly deps: { clock: Clock; logger: Logger },
    /** Log message when a pause starts. */
    private readonly message: string,
    /** Log context of the reader (e.g. `{ project: 'owner/3' }`). */
    private readonly context: Record<string, unknown> = {},
  ) {}

  /** Reason while a pause is in effect, otherwise `undefined`. */
  reason(): string | undefined {
    if (this.deps.clock.now().getTime() >= this.until) return undefined;
    return `GitHub GraphQL rate limit until ${new Date(this.until).toISOString()}`;
  }

  /** Start a pause after a rate-limit error (reset time from the error, fallback {@link GRAPHQL_RATE_LIMIT_FALLBACK_MS}). */
  note(err: unknown): void {
    if (!(err instanceof SourceError) || err.kind !== 'rate_limited') return;
    const wait = err.retryAfterMs ?? GRAPHQL_RATE_LIMIT_FALLBACK_MS;
    this.until = this.deps.clock.now().getTime() + Math.max(wait, 1_000);
    this.deps.logger.warn(this.message, { ...this.context, until: new Date(this.until).toISOString() });
  }
}
