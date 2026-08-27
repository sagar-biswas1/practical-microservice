import { ProviderSendError } from "../../src/providers/email-provider.js";
import type {
  EmailProvider,
  OutboundEmail,
  ProviderSendResult,
} from "../../src/providers/email-provider.js";
import { fail, ok, type Result } from "../../src/utils/result.js";

/**
 * One scripted outcome: deliver it, return this failure, or throw this error
 * (which a well-behaved provider never does — that path exists to prove the
 * dispatcher survives one that misbehaves).
 */
export type StubOutcome = "ok" | ProviderSendError | Error;

/**
 * Scriptable `EmailProvider`.
 *
 * Outcomes are queued, so a test can say "fail twice, then succeed" and assert
 * on the retry path without touching the network or the clock.
 */
export class StubEmailProvider implements EmailProvider {
  readonly name = "stub";
  readonly sent: OutboundEmail[] = [];

  private readonly queue: StubOutcome[] = [];
  private fallback: StubOutcome = "ok";
  private counter = 0;

  /** Injectable delay, so concurrency behaviour can be observed. */
  constructor(private readonly onSend?: (message: OutboundEmail) => Promise<void>) {}

  /** Queues outcomes for the next N sends, in order. */
  script(...outcomes: StubOutcome[]): this {
    this.queue.push(...outcomes);
    return this;
  }

  /** Outcome for every send not covered by the script. */
  always(outcome: StubOutcome): this {
    this.fallback = outcome;
    return this;
  }

  static retryable(message = "provider unavailable"): ProviderSendError {
    return new ProviderSendError(message, { retryable: true, providerStatus: 503 });
  }

  static permanent(message = "invalid recipient"): ProviderSendError {
    return new ProviderSendError(message, { retryable: false, providerStatus: 422 });
  }

  async send(message: OutboundEmail): Promise<Result<ProviderSendResult, ProviderSendError>> {
    this.sent.push(message);
    await this.onSend?.(message);

    const outcome = this.queue.shift() ?? this.fallback;

    if (outcome instanceof ProviderSendError) return fail(outcome);
    if (outcome instanceof Error) throw outcome;

    this.counter += 1;
    return ok({ provider: this.name, providerMessageId: `stub-${this.counter}` });
  }
}
