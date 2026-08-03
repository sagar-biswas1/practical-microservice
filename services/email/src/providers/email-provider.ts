import { AppError, ErrorCode } from "../errors/app-error.js";
import type { Result } from "../utils/result.js";

/**
 * A message as the provider needs to see it.
 *
 * Deliberately not the Prisma row. The provider layer is the one part of this
 * service that talks to a third party, and coupling it to the database schema
 * would mean a column rename could break an integration. This type is the
 * contract; `email.dispatcher.ts` maps a row onto it.
 */
export interface OutboundEmail {
  /**
   * The outbox row id. Doubles as the provider-side idempotency key, which is
   * what makes a retry after an ambiguous timeout safe: if the first attempt
   * actually reached the provider, the second is de-duplicated there instead
   * of producing a second delivery.
   */
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  bodyType: "TEXT" | "HTML";
}

export interface ProviderSendResult {
  /** Provider that accepted the message, recorded on the row. */
  provider: string;
  /** The provider's own id for the message — the receipt for support tickets. */
  providerMessageId: string;
}

/**
 * A failed send, carrying the one thing the dispatcher needs to decide what to
 * do next.
 *
 * `retryable` is the important field. "The provider is down" and "this address
 * does not exist" are both failures, but retrying the first is correct and
 * retrying the second burns the whole backoff schedule to arrive at the same
 * rejection five times. Only the provider adapter can tell them apart, so the
 * judgement is made there and travels with the error.
 */
export class ProviderSendError extends AppError {
  readonly retryable: boolean;
  /** HTTP status from the provider, when the failure got that far. */
  readonly providerStatus?: number;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      providerStatus?: number;
      cause?: unknown;
    },
  ) {
    super(
      message,
      options.retryable ? 503 : 422,
      options.retryable ? ErrorCode.SERVICE_UNAVAILABLE : ErrorCode.UNPROCESSABLE_ENTITY,
      { cause: options.cause },
    );
    this.retryable = options.retryable;
    if (options.providerStatus !== undefined) this.providerStatus = options.providerStatus;
  }
}

/**
 * The seam. Swapping mail vendors means writing one more implementation of
 * this interface and adding it to the factory in `providers/index.ts` — no
 * change to the service, the dispatcher, the routes or the schema.
 *
 * Implementations must not throw. Like everything else here they return
 * `[error, data]`, and a provider that fails is an ordinary, expected outcome
 * rather than an exception: the outbox exists precisely because sends fail.
 */
export interface EmailProvider {
  /** Stable identifier recorded on each row this provider handled. */
  readonly name: string;

  send(message: OutboundEmail): Promise<Result<ProviderSendResult, ProviderSendError>>;
}

/**
 * Maps an HTTP status onto "worth trying again".
 *
 * Shared by every HTTP-based provider so they classify consistently.
 *   - 408/429 and 5xx: the request never got a verdict, or the provider asked
 *     us to come back later.
 *   - Any other 4xx: the provider understood the request and refused it.
 *     A malformed address or an unverified sender domain will be refused
 *     identically on every retry, so the row goes straight to DEAD and an
 *     operator sees it in the dead-letter listing.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
