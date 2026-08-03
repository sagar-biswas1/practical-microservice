import { randomUUID } from "node:crypto";
import { ServiceUnavailableError } from "../../src/errors/app-error.js";
import type {
  ClaimOptions,
  EmailMessage,
  EmailPage,
  EmailRepository,
  EnqueueOutcome,
  IdempotencyRecord,
  ListEmailsFilter,
  NewEmailRecord,
  StatusCounts,
} from "../../src/modules/email/email.repository.js";
import { truncateError } from "../../src/modules/email/email.repository.js";
import { EMAIL_STATUSES } from "../../src/modules/email/email.schema.js";
import { fail, ok, type Result } from "../../src/utils/result.js";

type RepositoryMethod = keyof EmailRepository;

interface StoredKey {
  requestFingerprint: string;
  emailMessageId: string;
}

/**
 * Test double for `EmailRepository`.
 *
 * It reimplements the claim protocol rather than stubbing it, because the
 * protocol is the interesting part: exclusivity between workers, orphan
 * recovery, the attempt increment landing at claim time. Those are properties
 * of the transition rules, not of Postgres, so they can and should be pinned
 * here — a mocked `claimDue` returning a fixed array would prove none of them.
 */
export class InMemoryEmailRepository implements EmailRepository {
  private readonly messages = new Map<string, EmailMessage>();
  private readonly keys = new Map<string, StoredKey>();
  private readonly failing = new Set<RepositoryMethod>();

  constructor(seed: EmailMessage[] = []) {
    for (const message of seed) this.messages.set(message.id, message);
  }

  static buildMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: randomUUID(),
      recipient: `to-${randomUUID()}@example.com`,
      subject: "Test subject",
      body: "Test body",
      bodyType: "TEXT",
      source: "test-suite",
      status: "PENDING",
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      provider: null,
      providerMessageId: null,
      sentAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  /** Makes one method behave as though the database were unreachable. */
  fail(method: RepositoryMethod): void {
    this.failing.add(method);
  }

  private outage<T>(method: RepositoryMethod): Result<T> | null {
    if (!this.failing.has(method)) return null;
    return fail(new ServiceUnavailableError(`${method} is unavailable`));
  }

  private require(id: string): EmailMessage {
    const message = this.messages.get(id);
    if (!message) throw new Error(`No email message ${id} in the test repository`);
    return message;
  }

  async enqueue(
    input: NewEmailRecord,
    idempotency: IdempotencyRecord | null,
  ): Promise<Result<EnqueueOutcome>> {
    const outage = this.outage<EnqueueOutcome>("enqueue");
    if (outage) return outage;

    if (idempotency) {
      const existing = this.keys.get(idempotency.key);
      if (existing) {
        return ok({
          message: this.require(existing.emailMessageId),
          replayed: true,
          storedFingerprint: existing.requestFingerprint,
        });
      }
    }

    const message = InMemoryEmailRepository.buildMessage({
      ...input,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    this.messages.set(message.id, message);

    if (idempotency) {
      this.keys.set(idempotency.key, {
        requestFingerprint: idempotency.fingerprint,
        emailMessageId: message.id,
      });
    }

    return ok({
      message,
      replayed: false,
      storedFingerprint: idempotency?.fingerprint ?? null,
    });
  }

  async findById(id: string): Promise<Result<EmailMessage | null>> {
    const outage = this.outage<EmailMessage | null>("findById");
    if (outage) return outage;

    return ok(this.messages.get(id) ?? null);
  }

  async list({ page, limit, status, source, recipient }: ListEmailsFilter): Promise<
    Result<EmailPage>
  > {
    const outage = this.outage<EmailPage>("list");
    if (outage) return outage;

    const matched = [...this.messages.values()]
      .filter((message) => (status ? message.status === status : true))
      .filter((message) => (source ? message.source === source : true))
      .filter((message) => (recipient ? message.recipient === recipient : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return ok({
      items: matched.slice((page - 1) * limit, page * limit),
      total: matched.length,
    });
  }

  async countByStatus(): Promise<Result<StatusCounts>> {
    const outage = this.outage<StatusCounts>("countByStatus");
    if (outage) return outage;

    const counts = Object.fromEntries(
      EMAIL_STATUSES.map((status) => [status, 0]),
    ) as StatusCounts;

    for (const message of this.messages.values()) counts[message.status] += 1;
    return ok(counts);
  }

  /**
   * Mirrors `PrismaEmailRepository.claimDue`: due rows plus orphaned SENDING
   * ones, oldest first, stamped with the worker id and with `attempts`
   * incremented as part of the claim.
   */
  async claimDue({
    limit,
    workerId,
    claimTimeoutMs,
    now = new Date(),
  }: ClaimOptions): Promise<Result<EmailMessage[]>> {
    const outage = this.outage<EmailMessage[]>("claimDue");
    if (outage) return outage;

    const staleBefore = new Date(now.getTime() - claimTimeoutMs);

    const due = [...this.messages.values()]
      .filter((message) => {
        if (message.status === "PENDING" || message.status === "FAILED") {
          return message.nextAttemptAt.getTime() <= now.getTime();
        }
        if (message.status === "SENDING") {
          return message.lockedAt !== null && message.lockedAt.getTime() < staleBefore.getTime();
        }
        return false;
      })
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);

    const claimed = due.map((message) => {
      const next: EmailMessage = {
        ...message,
        status: "SENDING",
        lockedAt: now,
        lockedBy: workerId,
        attempts: message.attempts + 1,
        updatedAt: now,
      };
      this.messages.set(next.id, next);
      return next;
    });

    return ok(claimed);
  }

  async markSent(
    id: string,
    { provider, providerMessageId, now = new Date() }: {
      provider: string;
      providerMessageId: string;
      now?: Date;
    },
  ): Promise<Result<EmailMessage>> {
    const outage = this.outage<EmailMessage>("markSent");
    if (outage) return outage;

    const next: EmailMessage = {
      ...this.require(id),
      status: "SENT",
      provider,
      providerMessageId,
      sentAt: now,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: now,
    };
    this.messages.set(id, next);
    return ok(next);
  }

  async markForRetry(
    id: string,
    { error, nextAttemptAt }: { error: string; nextAttemptAt: Date },
  ): Promise<Result<EmailMessage>> {
    const outage = this.outage<EmailMessage>("markForRetry");
    if (outage) return outage;

    const next: EmailMessage = {
      ...this.require(id),
      status: "FAILED",
      lastError: truncateError(error),
      nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    };
    this.messages.set(id, next);
    return ok(next);
  }

  async markDead(id: string, { error }: { error: string }): Promise<Result<EmailMessage>> {
    const outage = this.outage<EmailMessage>("markDead");
    if (outage) return outage;

    const next: EmailMessage = {
      ...this.require(id),
      status: "DEAD",
      lastError: truncateError(error),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    };
    this.messages.set(id, next);
    return ok(next);
  }

  async requeue(
    id: string,
    { resetAttempts = true, now = new Date() }: { resetAttempts?: boolean; now?: Date } = {},
  ): Promise<Result<EmailMessage>> {
    const outage = this.outage<EmailMessage>("requeue");
    if (outage) return outage;

    const current = this.require(id);
    const next: EmailMessage = {
      ...current,
      status: "PENDING",
      nextAttemptAt: now,
      lockedAt: null,
      lockedBy: null,
      attempts: resetAttempts ? 0 : current.attempts,
      updatedAt: now,
    };
    this.messages.set(id, next);
    return ok(next);
  }

  async purgeSentBefore(cutoff: Date): Promise<Result<number>> {
    const outage = this.outage<number>("purgeSentBefore");
    if (outage) return outage;

    let deleted = 0;
    for (const [id, message] of this.messages) {
      if (message.status === "SENT" && message.createdAt.getTime() < cutoff.getTime()) {
        this.messages.delete(id);
        for (const [key, stored] of this.keys) {
          if (stored.emailMessageId === id) this.keys.delete(key);
        }
        deleted += 1;
      }
    }
    return ok(deleted);
  }

  // ---- Test-only accessors --------------------------------------------------

  get size(): number {
    return this.messages.size;
  }

  all(): EmailMessage[] {
    return [...this.messages.values()];
  }

  get(id: string): EmailMessage | undefined {
    return this.messages.get(id);
  }
}
