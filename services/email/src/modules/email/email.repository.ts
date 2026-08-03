import type { EmailMessage } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { attempt, fail, ok, type Result } from "../../utils/result.js";
import { isAppError } from "../../errors/app-error.js";
import {
  CLAIMABLE_STATUSES,
  EMAIL_BODY_TYPES,
  EMAIL_STATUSES,
  type EmailBodyTypeValue,
  type EmailStatusValue,
} from "./email.schema.js";

export type { EmailMessage };

/**
 * Compile-time guard against the hand-written tuples in `email.schema.ts`
 * drifting from the Prisma enums. If someone adds a status to the schema and
 * forgets the tuple (or the reverse), `true` stops being assignable to `never`
 * and the build fails here rather than at runtime in the dispatcher.
 */
type AssertSameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _statusesMatch: AssertSameUnion<EmailStatusValue, EmailMessage["status"]> = true;
const _bodyTypesMatch: AssertSameUnion<EmailBodyTypeValue, EmailMessage["bodyType"]> = true;
void _statusesMatch;
void _bodyTypesMatch;

/** The row as written on enqueue; everything else is defaulted by the store. */
export interface NewEmailRecord {
  recipient: string;
  subject: string;
  body: string;
  bodyType: EmailBodyTypeValue;
  source: string;
  maxAttempts: number;
}

/** The caller-supplied de-duplication token and the digest of its payload. */
export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
}

export interface EnqueueOutcome {
  message: EmailMessage;
  /** True when an existing key was found and no new row was written. */
  replayed: boolean;
  /**
   * The fingerprint stored against the key — the one from the *original*
   * request on a replay. `null` when the caller supplied no key. The service
   * compares it with the current request to catch key reuse.
   */
  storedFingerprint: string | null;
}

export interface ClaimOptions {
  limit: number;
  /** Identifies this dispatcher instance; how it fetches back its own claims. */
  workerId: string;
  /** A SENDING row locked longer than this is treated as orphaned. */
  claimTimeoutMs: number;
  now?: Date;
}

export interface ListEmailsFilter {
  page: number;
  limit: number;
  status?: EmailStatusValue;
  source?: string;
  recipient?: string;
}

export interface EmailPage {
  items: EmailMessage[];
  total: number;
}

export type StatusCounts = Record<EmailStatusValue, number>;

/**
 * Persistence boundary for the outbox.
 *
 * Every method is error-first, and — as in the user service — a lookup that
 * finds nothing returns `[null, null]` rather than an error. Absence is an
 * ordinary answer; `[error, null]` means the store failed to answer at all.
 *
 * Note what is *not* here: nothing in this interface sends an email. The
 * repository's entire responsibility is to make state transitions durable, and
 * keeping the network call out of it is what lets the enqueue path be a single
 * committed transaction.
 */
export interface EmailRepository {
  /**
   * Writes the message and its idempotency key atomically, or returns the
   * message an earlier request with the same key already produced.
   */
  enqueue(
    input: NewEmailRecord,
    idempotency: IdempotencyRecord | null,
  ): Promise<Result<EnqueueOutcome>>;

  findById(id: string): Promise<Result<EmailMessage | null>>;
  list(filter: ListEmailsFilter): Promise<Result<EmailPage>>;
  countByStatus(): Promise<Result<StatusCounts>>;

  /** Atomically takes ownership of up to `limit` due rows. */
  claimDue(options: ClaimOptions): Promise<Result<EmailMessage[]>>;

  markSent(
    id: string,
    result: { provider: string; providerMessageId: string; now?: Date },
  ): Promise<Result<EmailMessage>>;

  /** Records a failure that will be retried once `nextAttemptAt` passes. */
  markForRetry(
    id: string,
    failure: { error: string; nextAttemptAt: Date },
  ): Promise<Result<EmailMessage>>;

  /** Moves a row to the dead-letter state. Nothing claims it again. */
  markDead(id: string, failure: { error: string }): Promise<Result<EmailMessage>>;

  /** Operator-driven revival of a FAILED or DEAD row. */
  requeue(id: string, options?: { resetAttempts?: boolean; now?: Date }): Promise<Result<EmailMessage>>;

  /** Deletes delivered rows older than the cutoff. Returns how many went. */
  purgeSentBefore(cutoff: Date): Promise<Result<number>>;
}

export class PrismaEmailRepository implements EmailRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The atomic write at the heart of the outbox pattern.
   *
   * The message row and its idempotency key are committed together, so there
   * is no window in which one exists without the other. Crucially there is no
   * network call inside the transaction: a slow provider must never be able to
   * hold a database connection open, because that is how a single upstream
   * outage turns into pool exhaustion and takes the whole service down.
   */
  async enqueue(
    input: NewEmailRecord,
    idempotency: IdempotencyRecord | null,
  ): Promise<Result<EnqueueOutcome>> {
    const [error, outcome] = await attempt(() => this.insert(input, idempotency));
    if (!error) return ok(outcome);

    // Two requests carrying the same key raced: both saw no existing key, both
    // inserted, and the loser tripped the primary key. Its whole transaction
    // rolled back — message included — so re-reading the winner's row is both
    // safe and exactly what the caller asked for.
    if (idempotency && isAppError(error) && error.statusCode === 409) {
      const [replayError, replay] = await this.findByIdempotencyKey(idempotency.key);
      if (replayError) return fail(replayError);
      if (replay) return ok({ ...replay, replayed: true });
    }

    return fail(error);
  }

  private async insert(
    input: NewEmailRecord,
    idempotency: IdempotencyRecord | null,
  ): Promise<EnqueueOutcome> {
    return this.prisma.$transaction(async (tx) => {
      if (idempotency) {
        const existing = await tx.idempotencyKey.findUnique({
          where: { key: idempotency.key },
          include: { emailMessage: true },
        });

        if (existing) {
          return {
            message: existing.emailMessage,
            replayed: true,
            storedFingerprint: existing.requestFingerprint,
          };
        }
      }

      const message = await tx.emailMessage.create({ data: input });

      if (idempotency) {
        await tx.idempotencyKey.create({
          data: {
            key: idempotency.key,
            requestFingerprint: idempotency.fingerprint,
            emailMessageId: message.id,
          },
        });
      }

      return {
        message,
        replayed: false,
        storedFingerprint: idempotency?.fingerprint ?? null,
      };
    });
  }

  private async findByIdempotencyKey(
    key: string,
  ): Promise<Result<{ message: EmailMessage; storedFingerprint: string } | null>> {
    return attempt(async () => {
      const record = await this.prisma.idempotencyKey.findUnique({
        where: { key },
        include: { emailMessage: true },
      });

      return record
        ? { message: record.emailMessage, storedFingerprint: record.requestFingerprint }
        : null;
    });
  }

  findById(id: string): Promise<Result<EmailMessage | null>> {
    return attempt(() => this.prisma.emailMessage.findUnique({ where: { id } }));
  }

  list({ page, limit, status, source, recipient }: ListEmailsFilter): Promise<Result<EmailPage>> {
    const where = {
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(recipient ? { recipient } : {}),
    };

    return attempt(async () => {
      // One round trip, one snapshot: counting and paging in separate queries
      // can disagree with each other while rows are being inserted.
      const [total, items] = await this.prisma.$transaction([
        this.prisma.emailMessage.count({ where }),
        this.prisma.emailMessage.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      return { items, total };
    });
  }

  countByStatus(): Promise<Result<StatusCounts>> {
    return attempt(async () => {
      const rows = await this.prisma.emailMessage.groupBy({
        by: ["status"],
        _count: { _all: true },
      });

      // Seeded with every status so a quiet queue reports `0`, not a missing
      // key — a dashboard should not have to distinguish those.
      const counts = Object.fromEntries(
        EMAIL_STATUSES.map((status) => [status, 0]),
      ) as StatusCounts;

      for (const row of rows) counts[row.status] = row._count._all;
      return counts;
    });
  }

  /**
   * Claims due rows for this worker.
   *
   * Done as select-then-guarded-update rather than `SELECT … FOR UPDATE SKIP
   * LOCKED`, because the guard makes it safe without raw SQL: two workers can
   * happily select the same candidates, but the `UPDATE` carries the original
   * predicate, so the loser blocks on the row lock, re-evaluates once the
   * winner commits, finds the row is now SENDING and updates nothing. Each
   * worker then reads back only the rows stamped with its own id.
   *
   * (`SKIP LOCKED` avoids that momentary block and is the better choice at
   * high throughput; it needs `$queryRaw`, which would put the claim logic out
   * of reach of the in-memory repository the tests run against.)
   *
   * `attempts` is incremented here, at claim time, not on completion. A worker
   * that dies mid-send has still spent an attempt, which is what stops a
   * message that reliably crashes its handler from being retried for ever.
   */
  claimDue({ limit, workerId, claimTimeoutMs, now = new Date() }: ClaimOptions): Promise<
    Result<EmailMessage[]>
  > {
    const staleBefore = new Date(now.getTime() - claimTimeoutMs);

    const due = {
      OR: [
        { status: { in: [...CLAIMABLE_STATUSES] }, nextAttemptAt: { lte: now } },
        // Orphan recovery: a SENDING row whose holder never came back.
        { status: "SENDING" as const, lockedAt: { lt: staleBefore } },
      ],
    };

    return attempt(async () => {
      const candidates = await this.prisma.emailMessage.findMany({
        where: due,
        // Oldest due first, so a burst cannot starve messages already waiting.
        orderBy: { nextAttemptAt: "asc" },
        take: limit,
        select: { id: true },
      });

      if (candidates.length === 0) return [];

      await this.prisma.emailMessage.updateMany({
        where: { id: { in: candidates.map((row) => row.id) }, ...due },
        data: {
          status: "SENDING",
          lockedAt: now,
          lockedBy: workerId,
          attempts: { increment: 1 },
        },
      });

      // `lockedAt` is matched exactly: it pins the read to this cycle's claims
      // and cannot pick up a row this worker locked in an earlier one.
      return this.prisma.emailMessage.findMany({
        where: { status: "SENDING", lockedBy: workerId, lockedAt: now },
        orderBy: { nextAttemptAt: "asc" },
      });
    });
  }

  markSent(
    id: string,
    { provider, providerMessageId, now = new Date() }: {
      provider: string;
      providerMessageId: string;
      now?: Date;
    },
  ): Promise<Result<EmailMessage>> {
    return attempt(() =>
      this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: "SENT",
          provider,
          providerMessageId,
          sentAt: now,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
        },
      }),
    );
  }

  markForRetry(
    id: string,
    { error, nextAttemptAt }: { error: string; nextAttemptAt: Date },
  ): Promise<Result<EmailMessage>> {
    return attempt(() =>
      this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: "FAILED",
          lastError: truncateError(error),
          nextAttemptAt,
          lockedAt: null,
          lockedBy: null,
        },
      }),
    );
  }

  markDead(id: string, { error }: { error: string }): Promise<Result<EmailMessage>> {
    return attempt(() =>
      this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: "DEAD",
          lastError: truncateError(error),
          lockedAt: null,
          lockedBy: null,
        },
      }),
    );
  }

  requeue(
    id: string,
    { resetAttempts = true, now = new Date() }: { resetAttempts?: boolean; now?: Date } = {},
  ): Promise<Result<EmailMessage>> {
    return attempt(() =>
      this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: "PENDING",
          nextAttemptAt: now,
          lockedAt: null,
          lockedBy: null,
          ...(resetAttempts ? { attempts: 0 } : {}),
        },
      }),
    );
  }

  /**
   * Only SENT rows are purged. DEAD ones are the record of what never got
   * delivered, which is the last thing you want a cleanup job to erase.
   * Idempotency keys go with their message via `onDelete: Cascade`.
   */
  purgeSentBefore(cutoff: Date): Promise<Result<number>> {
    return attempt(async () => {
      const { count } = await this.prisma.emailMessage.deleteMany({
        where: { status: "SENT", createdAt: { lt: cutoff } },
      });
      return count;
    });
  }
}

/** Keeps a provider's essay of an error message inside the column width. */
export function truncateError(message: string, max = 1000): string {
  return message.length <= max ? message : `${message.slice(0, max - 1)}…`;
}
