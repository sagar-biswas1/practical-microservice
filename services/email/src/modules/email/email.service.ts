import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import { fingerprint } from "../../utils/fingerprint.js";
import { fail, ok, type Result } from "../../utils/result.js";
import type {
  EmailMessage,
  EmailRepository,
  StatusCounts,
} from "./email.repository.js";
import type { ListEmailsQuery, SendEmailInput } from "./email.schema.js";

export interface EnqueueResult {
  message: EmailMessage;
  /**
   * True when an identical request had already been accepted under the same
   * idempotency key. The controller uses it to answer `200` instead of `202`,
   * so a caller can tell "I created this" from "this already existed" without
   * the outcome differing in any way that matters.
   */
  replayed: boolean;
}

export interface EmailListResult {
  items: EmailMessage[];
  total: number;
  page: number;
  limit: number;
}

export interface EmailServiceOptions {
  /** Attempt ceiling stamped onto each new row. */
  maxAttempts: number;
}

/** Statuses an operator may revive. */
const RETRYABLE_STATUSES = new Set<EmailMessage["status"]>(["FAILED", "DEAD"]);

/**
 * Business rules for the outbox. Free of Express and Prisma types, and — as
 * everywhere else in this service — nothing in here throws.
 *
 * The single most important thing this class does *not* do is send email.
 * Accepting a request and delivering it are separate concerns with separate
 * failure modes, and keeping them apart is what lets the accept path be a
 * plain database write that either commits or does not. Delivery is
 * `EmailDispatcher`'s problem.
 */
export class EmailService {
  constructor(
    private readonly repository: EmailRepository,
    private readonly options: EmailServiceOptions,
  ) {}

  /**
   * Accepts a message into the outbox.
   *
   * With an `Idempotency-Key`, a caller that times out and retries gets the
   * original message back rather than a second email. The key is written in
   * the same transaction as the message, so the pair cannot come apart.
   *
   * Reusing one key for a *different* payload is rejected rather than quietly
   * replayed: that combination is always a bug on the caller's side, and
   * returning the first message would hide it while silently dropping the
   * second email.
   */
  async enqueue(
    input: SendEmailInput,
    idempotencyKey?: string,
  ): Promise<Result<EnqueueResult>> {
    const digest = fingerprint({ ...input });

    const [error, outcome] = await this.repository.enqueue(
      {
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        bodyType: input.bodyType,
        source: input.source,
        maxAttempts: this.options.maxAttempts,
      },
      idempotencyKey ? { key: idempotencyKey, fingerprint: digest } : null,
    );
    if (error) return fail(error);

    if (outcome.replayed && outcome.storedFingerprint !== digest) {
      return fail(
        new ConflictError(
          `Idempotency-Key '${idempotencyKey}' was already used for a different message`,
        ),
      );
    }

    return ok({ message: outcome.message, replayed: outcome.replayed });
  }

  async getById(id: string): Promise<Result<EmailMessage>> {
    const [error, message] = await this.repository.findById(id);
    if (error) return fail(error);
    if (!message) return fail(new NotFoundError(`Email '${id}' was not found`));
    return ok(message);
  }

  async list(query: ListEmailsQuery): Promise<Result<EmailListResult>> {
    const [error, page] = await this.repository.list(query);
    if (error) return fail(error);

    return ok({ ...page, page: query.page, limit: query.limit });
  }

  /** Outbox depth by status — the number an operator actually watches. */
  stats(): Promise<Result<StatusCounts>> {
    return this.repository.countByStatus();
  }

  /**
   * Returns a message to the queue after an operator has fixed whatever caused
   * it to fail — a corrected sender domain, a restored API key.
   *
   * Only FAILED and DEAD rows qualify. Reviving a SENT one would send a second
   * copy of an email the recipient already has, and PENDING or SENDING rows
   * are already in the dispatcher's hands; clearing their lock would hand the
   * same message to a second worker while the first is mid-send.
   */
  async retry(id: string): Promise<Result<EmailMessage>> {
    const [lookupError, message] = await this.getById(id);
    if (lookupError) return fail(lookupError);

    if (!RETRYABLE_STATUSES.has(message.status)) {
      return fail(
        new ConflictError(
          `Email '${id}' is ${message.status}; only FAILED or DEAD messages can be retried`,
        ),
      );
    }

    return this.repository.requeue(id, { resetAttempts: true });
  }
}
