import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { logger, type Logger } from "../../lib/logger.js";
import { attempt, fail, ok, type Result } from "../../utils/result.js";
import { nextAttemptAt } from "../../utils/backoff.js";
import type { EmailProvider } from "../../providers/email-provider.js";
import type { EmailMessage, EmailRepository } from "./email.repository.js";

export interface DispatcherOptions {
  /** Sender address applied to every outgoing message. */
  from: string;
  batchSize: number;
  /** How many sends may be in flight at once within a batch. */
  concurrency: number;
  pollIntervalMs: number;
  claimTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Days a SENT row is kept before the purge removes it. `0` disables it. */
  retentionDays: number;
  /** Identifies this instance in `lockedBy`. Defaults to host + pid. */
  workerId?: string;
  /** Injectable clock and RNG — the tests need both to be deterministic. */
  now?: () => Date;
  random?: () => number;
  logger?: Logger;
}

export type DeliveryOutcome = "sent" | "retrying" | "dead";

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retrying: number;
  dead: number;
}

/** Purge runs on its own slow cadence, not once per poll. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The relay: claims due rows from the outbox, hands them to the provider, and
 * records what happened.
 *
 * This is the only place in the service that performs the actual send, and it
 * runs entirely outside the request that created the message. That separation
 * is the point of the whole design — the caller's transaction commits against
 * the local database and nothing else, so a provider outage cannot fail a
 * write, hold a connection open, or leave the caller unsure whether their
 * request took effect.
 *
 * Delivery is at-least-once. A worker can be killed between the provider
 * accepting a message and the row being marked SENT, in which case the row is
 * eventually reclaimed and sent again. That window is closed at the provider
 * instead: the row id travels as the provider-side idempotency key, so the
 * duplicate attempt is de-duplicated there rather than landing in an inbox
 * twice.
 */
export class EmailDispatcher {
  private readonly log: Logger;
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly random: () => number;

  private running = false;
  private timer?: NodeJS.Timeout;
  private cycle?: Promise<unknown>;
  private lastPurgeAt = 0;

  constructor(
    private readonly repository: EmailRepository,
    private readonly provider: EmailProvider,
    private readonly options: DispatcherOptions,
  ) {
    this.log = (options.logger ?? logger).child({ component: "email-dispatcher" });
    this.workerId = (options.workerId ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`)
      .slice(0, 100);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  /** The id written to `lockedBy`; surfaced for logs and tests. */
  get id(): string {
    return this.workerId;
  }

  /**
   * Begins polling.
   *
   * Scheduled with a chained `setTimeout` rather than `setInterval`, so a
   * cycle that runs longer than the interval delays the next one instead of
   * overlapping with it. Two overlapping cycles in the same worker would each
   * claim a batch and compete for the same concurrency budget.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info(
      { workerId: this.workerId, provider: this.provider.name, intervalMs: this.options.pollIntervalMs },
      "dispatcher_started",
    );
    this.schedule(0);
  }

  /** Stops polling and waits for the cycle in flight to finish. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.cycle;
    this.log.info({ workerId: this.workerId }, "dispatcher_stopped");
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.tick(), delayMs);
    // Never hold the event loop open on the dispatcher's account.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    this.cycle = (async () => {
      const [error, summary] = await this.runOnce();

      if (error) {
        // A failing cycle must not stop the loop: the usual cause is the
        // database being briefly unreachable, which resolves on its own.
        this.log.error({ err: error, workerId: this.workerId }, "dispatch_cycle_failed");
      } else if (summary.claimed > 0) {
        this.log.info({ ...summary, workerId: this.workerId }, "dispatch_cycle_complete");
      }

      await this.purgeIfDue();
    })();

    await this.cycle;

    if (this.running) this.schedule(this.options.pollIntervalMs);
  }

  /**
   * One claim-send-record cycle. Public so it can be driven by a cron, by a
   * test, or by the admin endpoint when the background loop is disabled.
   */
  async runOnce(): Promise<Result<DispatchSummary>> {
    const [claimError, claimed] = await this.repository.claimDue({
      limit: this.options.batchSize,
      workerId: this.workerId,
      claimTimeoutMs: this.options.claimTimeoutMs,
      now: this.now(),
    });
    if (claimError) return fail(claimError);

    const outcomes = await this.mapWithConcurrency(
      claimed,
      this.options.concurrency,
      (message) => this.deliver(message),
    );

    return ok({
      claimed: claimed.length,
      sent: outcomes.filter((outcome) => outcome === "sent").length,
      retrying: outcomes.filter((outcome) => outcome === "retrying").length,
      dead: outcomes.filter((outcome) => outcome === "dead").length,
    });
  }

  /** Sends one claimed message and records the result. */
  private async deliver(message: EmailMessage): Promise<DeliveryOutcome> {
    // `attempt` guards the provider call: implementations are contracted to
    // return `[error, data]`, but a third-party client buried inside one can
    // still throw, and a single misbehaving adapter must not abort the batch.
    const [crash, sendOutcome] = await attempt(() =>
      this.provider.send({
        id: message.id,
        from: this.options.from,
        to: message.recipient,
        subject: message.subject,
        body: message.body,
        bodyType: message.bodyType,
      }),
    );

    if (crash) {
      // Cause unknown, so assume it is transient — the attempt ceiling stops
      // this from retrying for ever if it is not.
      return this.recordFailure(message, `Provider threw: ${crash.message}`, true);
    }

    const [sendError, result] = sendOutcome;
    if (sendError) return this.recordFailure(message, sendError.message, sendError.retryable);

    const [markError] = await this.repository.markSent(message.id, {
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      now: this.now(),
    });

    if (markError) {
      // The email went out but the row still says SENDING. It will be
      // reclaimed once the lock goes stale and sent again — which is exactly
      // the case the provider-side idempotency key exists to absorb.
      this.log.error(
        { err: markError, emailId: message.id, providerMessageId: result.providerMessageId },
        "email_sent_but_not_recorded",
      );
      return "sent";
    }

    this.log.info(
      {
        emailId: message.id,
        source: message.source,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        attempts: message.attempts,
      },
      "email_sent",
    );
    return "sent";
  }

  /**
   * Decides between another attempt and the dead-letter state.
   *
   * A permanent rejection goes straight to DEAD. Retrying a malformed address
   * or an unverified sender domain just spends the whole backoff schedule
   * arriving at the same refusal, and it delays the moment an operator sees
   * the message sitting in the dead-letter listing.
   */
  private async recordFailure(
    message: EmailMessage,
    reason: string,
    retryable: boolean,
  ): Promise<DeliveryOutcome> {
    // `attempts` was incremented at claim time, so it already counts this one.
    const exhausted = message.attempts >= message.maxAttempts;

    if (!retryable || exhausted) {
      const [error] = await this.repository.markDead(message.id, { error: reason });
      if (error) this.log.error({ err: error, emailId: message.id }, "mark_dead_failed");

      this.log.error(
        {
          emailId: message.id,
          source: message.source,
          recipient: message.recipient,
          attempts: message.attempts,
          maxAttempts: message.maxAttempts,
          reason,
          cause: retryable ? "attempts_exhausted" : "permanent_rejection",
        },
        "email_dead_lettered",
      );
      return "dead";
    }

    const retryAt = nextAttemptAt(message.attempts, {
      baseMs: this.options.backoffBaseMs,
      maxMs: this.options.backoffMaxMs,
      random: this.random,
      now: this.now(),
    });

    const [error] = await this.repository.markForRetry(message.id, {
      error: reason,
      nextAttemptAt: retryAt,
    });
    if (error) this.log.error({ err: error, emailId: message.id }, "mark_retry_failed");

    this.log.warn(
      {
        emailId: message.id,
        attempts: message.attempts,
        maxAttempts: message.maxAttempts,
        nextAttemptAt: retryAt.toISOString(),
        reason,
      },
      "email_send_failed",
    );
    return "retrying";
  }

  /**
   * Deletes delivered rows past their retention window.
   *
   * An outbox is a queue, not an archive. Left alone it accumulates millions
   * of SENT rows, and since almost every row ends up in that one status, the
   * claim index degrades along with it and the poll gets slower every day.
   */
  async purgeExpired(): Promise<Result<number>> {
    if (this.options.retentionDays <= 0) return ok(0);

    const cutoff = new Date(this.now().getTime() - this.options.retentionDays * MS_PER_DAY);
    const [error, deleted] = await this.repository.purgeSentBefore(cutoff);
    if (error) return fail(error);

    if (deleted > 0) {
      this.log.info({ deleted, cutoff: cutoff.toISOString() }, "outbox_purged");
    }
    return ok(deleted);
  }

  private async purgeIfDue(): Promise<void> {
    if (this.options.retentionDays <= 0) return;

    const now = this.now().getTime();
    if (now - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.lastPurgeAt = now;

    const [error] = await this.purgeExpired();
    if (error) this.log.error({ err: error }, "outbox_purge_failed");
  }

  /**
   * Runs `worker` over `items`, at most `limit` at a time.
   *
   * A batch of 25 sends should not become 25 simultaneous connections to the
   * provider — that is how a rate limit gets tripped and a batch that would
   * have succeeded turns into 25 backed-off failures.
   */
  private async mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;

    const run = async (): Promise<void> => {
      while (cursor < items.length) {
        const index = cursor++;
        // Guarded by the loop condition; the check satisfies
        // `noUncheckedIndexedAccess`.
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await worker(item);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => run()),
    );

    return results;
  }
}
