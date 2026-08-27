import { Prisma } from "../../generated/prisma/client.js";
import type {
  AuthUser,
  LoginHistory,
  RefreshToken,
  Verification,
} from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { attempt, ok, type Result } from "../../utils/result.js";
import type {
  LoginHistoryQuery,
  LoginOutcomeValue,
  PendingProfile,
  RevokeReasonValue,
  RoleValue,
  VerificationTypeValue,
} from "./auth.schema.js";

export type { AuthUser, LoginHistory, RefreshToken, Verification };

/**
 * Compile-time guard against the hand-written unions in `auth.schema.ts`
 * drifting from the Prisma enums. If someone adds a member to the schema and
 * forgets the tuple (or the reverse), these stop type-checking.
 */
type AssertSameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _rolesMatch: AssertSameUnion<RoleValue, AuthUser["role"]> = true;
const _verificationTypesMatch: AssertSameUnion<
  VerificationTypeValue,
  Verification["type"]
> = true;
const _outcomesMatch: AssertSameUnion<LoginOutcomeValue, LoginHistory["outcome"]> = true;
const _revokeReasonsMatch: AssertSameUnion<
  RevokeReasonValue,
  NonNullable<RefreshToken["revokedReason"]>
> = true;
void _rolesMatch;
void _verificationTypesMatch;
void _outcomesMatch;
void _revokeReasonsMatch;

// ---- Write shapes -----------------------------------------------------------

export interface NewAuthUserRecord {
  email: string;
  username: string;
  passwordHash: string;
  pendingProfile: PendingProfile;
}

export interface NewVerificationRecord {
  authUserId: string;
  codeHash: string;
  type: VerificationTypeValue;
  expiresAt: Date;
  maxAttempts: number;
  newEmail?: string | null;
}

export interface NewLoginHistoryRecord {
  authUserId: string | null;
  email: string;
  success: boolean;
  outcome: LoginOutcomeValue;
  attempt: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface NewRefreshTokenRecord {
  authUserId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginHistoryPage {
  items: LoginHistory[];
  total: number;
}

/**
 * Persistence boundary for authentication.
 *
 * The service layer depends on this interface, not on Prisma — which is what
 * lets the tests swap in an in-memory implementation and keeps the storage
 * engine replaceable.
 *
 * Every method is error-first. A lookup that finds nothing is `[null, null]`,
 * not an error: absence is an ordinary answer to a query, and only the service
 * knows whether it means "401" or "good, the email is free". A database that
 * refused to answer is `[error, null]` — already normalised to an `AppError` by
 * `attempt`, so callers never handle a raw Prisma type.
 *
 * The multi-row operations are transactions rather than sequences of writes,
 * and each one is a transaction because a half-applied version of it would be
 * a security bug rather than merely untidy. Those cases are called out
 * individually below.
 */
export interface AuthRepository {
  // ---- Auth users ----
  createAuthUserWithVerification(
    user: NewAuthUserRecord,
    verification: Omit<NewVerificationRecord, "authUserId">,
  ): Promise<Result<{ authUser: AuthUser; verification: Verification }>>;
  findAuthUserById(id: string): Promise<Result<AuthUser | null>>;
  findAuthUserByEmail(email: string): Promise<Result<AuthUser | null>>;
  findAuthUserByUsername(username: string): Promise<Result<AuthUser | null>>;

  /** Attaches the profile the user service created, clearing the parked copy. */
  attachProfile(id: string, userId: string): Promise<Result<AuthUser>>;

  // ---- Login accounting ----
  recordLoginAttempt(input: NewLoginHistoryRecord): Promise<Result<LoginHistory>>;
  registerFailedLogin(id: string, lockUntil: Date | null): Promise<Result<AuthUser>>;
  registerSuccessfulLogin(id: string, at: Date): Promise<Result<AuthUser>>;
  listLoginHistory(
    authUserId: string,
    query: LoginHistoryQuery,
  ): Promise<Result<LoginHistoryPage>>;

  // ---- Verification ----
  /** Newest PENDING code of this type, or null. */
  findActiveVerification(
    authUserId: string,
    type: VerificationTypeValue,
  ): Promise<Result<Verification | null>>;
  /** Revokes every PENDING code of a type, then issues a fresh one. */
  replaceVerification(input: NewVerificationRecord): Promise<Result<Verification>>;
  /** Records a wrong guess, burning the code once the ceiling is reached. */
  registerVerificationAttempt(id: string, exhausted: boolean): Promise<Result<Verification>>;
  attachVerificationEmail(id: string, emailMessageId: string): Promise<Result<void>>;
  /** Consumes an EMAIL_VERIFICATION code and marks the account verified. */
  consumeEmailVerification(
    verificationId: string,
    authUserId: string,
    at: Date,
  ): Promise<Result<AuthUser>>;
  /** Consumes a PASSWORD_RESET code, sets the new hash, and cuts all sessions. */
  consumePasswordReset(
    verificationId: string,
    authUserId: string,
    passwordHash: string,
    at: Date,
  ): Promise<Result<AuthUser>>;

  // ---- Sessions ----
  createRefreshToken(input: NewRefreshTokenRecord): Promise<Result<RefreshToken>>;
  findRefreshTokenByHash(tokenHash: string): Promise<Result<RefreshToken | null>>;
  /** Revokes the presented token and issues its successor in one transaction. */
  rotateRefreshToken(
    currentId: string,
    next: NewRefreshTokenRecord,
  ): Promise<Result<RefreshToken>>;
  revokeRefreshToken(id: string, reason: RevokeReasonValue): Promise<Result<void>>;
  /** Kills every token descended from one login — the reuse-detection response. */
  revokeFamily(familyId: string, reason: RevokeReasonValue): Promise<Result<number>>;
  revokeAllForUser(authUserId: string, reason: RevokeReasonValue): Promise<Result<number>>;
  listActiveSessions(authUserId: string, now: Date): Promise<Result<RefreshToken[]>>;

  // ---- Password ----
  updatePassword(
    authUserId: string,
    passwordHash: string,
    at: Date,
  ): Promise<Result<AuthUser>>;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- Auth users -----------------------------------------------------------

  /**
   * Creates the account and its first verification code together.
   *
   * A transaction because an account with no code is an account nobody can
   * ever verify — the user would be told to check their email for something
   * that was never issued, and the only route out would be an operator. The
   * two rows are one fact: "a registration happened".
   *
   * Note what is *not* in here: the call to the email service. A network
   * request inside a transaction holds a database connection open for the
   * duration of someone else's outage. The mail is enqueued after this
   * commits — see `AuthService.register`.
   */
  createAuthUserWithVerification(
    user: NewAuthUserRecord,
    verification: Omit<NewVerificationRecord, "authUserId">,
  ): Promise<Result<{ authUser: AuthUser; verification: Verification }>> {
    return attempt(async () =>
      this.prisma.$transaction(async (tx) => {
        const authUser = await tx.authUser.create({
          data: {
            email: user.email,
            username: user.username,
            passwordHash: user.passwordHash,
            pendingProfile: user.pendingProfile,
          },
        });

        const created = await tx.verification.create({
          data: {
            authUserId: authUser.id,
            codeHash: verification.codeHash,
            type: verification.type,
            expiresAt: verification.expiresAt,
            maxAttempts: verification.maxAttempts,
            newEmail: verification.newEmail ?? null,
          },
        });

        return { authUser, verification: created };
      }),
    );
  }

  findAuthUserById(id: string): Promise<Result<AuthUser | null>> {
    return attempt(() => this.prisma.authUser.findUnique({ where: { id } }));
  }

  findAuthUserByEmail(email: string): Promise<Result<AuthUser | null>> {
    return attempt(() => this.prisma.authUser.findUnique({ where: { email } }));
  }

  findAuthUserByUsername(username: string): Promise<Result<AuthUser | null>> {
    return attempt(() => this.prisma.authUser.findUnique({ where: { username } }));
  }

  /**
   * `pendingProfile` is cleared in the same write that records `userId`.
   *
   * Leaving it behind would keep a copy of the user's name, address and phone
   * in a service that has no business holding them — and would leave two
   * sources of truth for a profile the user can already edit next door.
   */
  attachProfile(id: string, userId: string): Promise<Result<AuthUser>> {
    return attempt(() =>
      this.prisma.authUser.update({
        where: { id },
        // `Prisma.DbNull`, not `null`. In a Json column those are two different
        // values: `DbNull` is SQL NULL — the column holds nothing — while
        // `JsonNull` would store the JSON literal `null`, a present value that
        // happens to be null. Plain `null` is rejected outright rather than
        // letting the ambiguity through, which is why this reads oddly and
        // should stay as it is.
        data: { userId, pendingProfile: Prisma.DbNull },
      }),
    );
  }

  // ---- Login accounting -----------------------------------------------------

  recordLoginAttempt(input: NewLoginHistoryRecord): Promise<Result<LoginHistory>> {
    return attempt(() =>
      this.prisma.loginHistory.create({
        data: {
          authUserId: input.authUserId,
          email: input.email,
          success: input.success,
          outcome: input.outcome,
          attempt: input.attempt,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
      }),
    );
  }

  /**
   * `increment` rather than a read-modify-write.
   *
   * Counting failures in application code — read 4, add 1, write 5 — loses
   * increments under concurrency, which is the exact condition a lockout is
   * meant to detect. An attacker running parallel guesses would keep the
   * counter permanently below the threshold. Postgres does the addition.
   */
  registerFailedLogin(id: string, lockUntil: Date | null): Promise<Result<AuthUser>> {
    return attempt(() =>
      this.prisma.authUser.update({
        where: { id },
        data: {
          failedLoginAttempts: { increment: 1 },
          ...(lockUntil ? { lockedUntil: lockUntil } : {}),
        },
      }),
    );
  }

  registerSuccessfulLogin(id: string, at: Date): Promise<Result<AuthUser>> {
    return attempt(() =>
      this.prisma.authUser.update({
        where: { id },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: at },
      }),
    );
  }

  async listLoginHistory(
    authUserId: string,
    query: LoginHistoryQuery,
  ): Promise<Result<LoginHistoryPage>> {
    const where = {
      authUserId,
      ...(query.success === undefined ? {} : { success: query.success }),
      ...(query.outcome ? { outcome: query.outcome } : {}),
    };

    // One round trip, and — more importantly — one snapshot: a count and a page
    // fetched separately can disagree, reporting 21 results and returning 20.
    const [error, result] = await attempt(() =>
      this.prisma.$transaction([
        this.prisma.loginHistory.count({ where }),
        this.prisma.loginHistory.findMany({
          where,
          orderBy: { loginAt: "desc" },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]),
    );
    if (error) return [error, null];

    const [total, items] = result;
    return ok({ items, total });
  }

  // ---- Verification ---------------------------------------------------------

  findActiveVerification(
    authUserId: string,
    type: VerificationTypeValue,
  ): Promise<Result<Verification | null>> {
    return attempt(() =>
      this.prisma.verification.findFirst({
        where: { authUserId, type, status: "PENDING" },
        orderBy: { issuedAt: "desc" },
      }),
    );
  }

  /**
   * Revokes any outstanding codes of this type before issuing a new one.
   *
   * A transaction because the invariant is "at most one live code per account
   * per type". If the revoke committed and the insert failed, the user would
   * be locked out of a flow they just asked to restart; if the insert
   * committed first and the revoke failed, two codes would be live at once and
   * the attempt ceiling would be worth double.
   */
  replaceVerification(input: NewVerificationRecord): Promise<Result<Verification>> {
    return attempt(async () =>
      this.prisma.$transaction(async (tx) => {
        await tx.verification.updateMany({
          where: { authUserId: input.authUserId, type: input.type, status: "PENDING" },
          data: { status: "REVOKED" },
        });

        return tx.verification.create({
          data: {
            authUserId: input.authUserId,
            codeHash: input.codeHash,
            type: input.type,
            expiresAt: input.expiresAt,
            maxAttempts: input.maxAttempts,
            newEmail: input.newEmail ?? null,
          },
        });
      }),
    );
  }

  registerVerificationAttempt(id: string, exhausted: boolean): Promise<Result<Verification>> {
    return attempt(() =>
      this.prisma.verification.update({
        where: { id },
        // Incremented by the database for the same reason as the login
        // counter: parallel guesses must not be able to lose a count.
        data: {
          attempts: { increment: 1 },
          ...(exhausted ? { status: "EXPIRED" as const } : {}),
        },
      }),
    );
  }

  async attachVerificationEmail(id: string, emailMessageId: string): Promise<Result<void>> {
    const [error] = await attempt(() =>
      this.prisma.verification.update({ where: { id }, data: { emailMessageId } }),
    );
    return error ? [error, null] : [null, undefined];
  }

  /**
   * Marks the code used and the account verified.
   *
   * A transaction because these are two halves of one decision. Consuming the
   * code without verifying the account strands the user — the code is spent
   * and the account still unverified. Verifying without consuming leaves a
   * live code that could be replayed.
   *
   * `status: "PENDING"` in the where-clause is what makes this safe under
   * concurrency: two simultaneous submissions of the same correct code both
   * pass the checks in the service layer, but only one matches here. The other
   * updates zero rows, Prisma raises P2025, and `attempt` turns it into a 404
   * rather than letting a code be consumed twice.
   */
  consumeEmailVerification(
    verificationId: string,
    authUserId: string,
    at: Date,
  ): Promise<Result<AuthUser>> {
    return attempt(async () =>
      this.prisma.$transaction(async (tx) => {
        await tx.verification.update({
          where: { id: verificationId, status: "PENDING" },
          data: { status: "VERIFIED", verifiedAt: at },
        });

        return tx.authUser.update({
          where: { id: authUserId },
          data: { verified: true, verifiedAt: at },
        });
      }),
    );
  }

  /**
   * Consumes a reset code, installs the new password, and revokes every
   * session in one transaction.
   *
   * The revocation is the point. Someone resetting a password is very often
   * doing it *because* the account is compromised, and a new password that
   * leaves the attacker's existing session alive accomplishes nothing. If the
   * password write committed but the revocation did not, the user would be
   * told they were safe while they were not — so the two must not be
   * separable.
   */
  consumePasswordReset(
    verificationId: string,
    authUserId: string,
    passwordHash: string,
    at: Date,
  ): Promise<Result<AuthUser>> {
    return attempt(async () =>
      this.prisma.$transaction(async (tx) => {
        await tx.verification.update({
          where: { id: verificationId, status: "PENDING" },
          data: { status: "VERIFIED", verifiedAt: at },
        });

        await tx.refreshToken.updateMany({
          where: { authUserId, revokedAt: null },
          data: { revokedAt: at, revokedReason: "PASSWORD_CHANGED" },
        });

        return tx.authUser.update({
          where: { id: authUserId },
          data: {
            passwordHash,
            passwordChangedAt: at,
            // A reset proves control of the mailbox just as registration does,
            // so an account that had never confirmed is confirmed by this too.
            verified: true,
            verifiedAt: at,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        });
      }),
    );
  }

  // ---- Sessions -------------------------------------------------------------

  createRefreshToken(input: NewRefreshTokenRecord): Promise<Result<RefreshToken>> {
    return attempt(() =>
      this.prisma.refreshToken.create({
        data: {
          authUserId: input.authUserId,
          tokenHash: input.tokenHash,
          familyId: input.familyId,
          expiresAt: input.expiresAt,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
      }),
    );
  }

  findRefreshTokenByHash(tokenHash: string): Promise<Result<RefreshToken | null>> {
    return attempt(() => this.prisma.refreshToken.findUnique({ where: { tokenHash } }));
  }

  /**
   * Exchanges a live token for its successor.
   *
   * A transaction, and the `revokedAt: null` guard is the load-bearing part.
   * Two concurrent refreshes with the same token both find it live in the
   * service layer; here only the first matches the where-clause. The second
   * updates nothing, P2025 aborts the transaction, and no second token is
   * minted — which is what keeps "a used token was presented again" a reliable
   * signal of theft rather than a routine race between browser tabs.
   */
  rotateRefreshToken(
    currentId: string,
    next: NewRefreshTokenRecord,
  ): Promise<Result<RefreshToken>> {
    return attempt(async () =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.refreshToken.create({
          data: {
            authUserId: next.authUserId,
            tokenHash: next.tokenHash,
            familyId: next.familyId,
            expiresAt: next.expiresAt,
            ip: next.ip ?? null,
            userAgent: next.userAgent ?? null,
          },
        });

        await tx.refreshToken.update({
          where: { id: currentId, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revokedReason: "ROTATED",
            replacedById: created.id,
          },
        });

        return created;
      }),
    );
  }

  async revokeRefreshToken(id: string, reason: RevokeReasonValue): Promise<Result<void>> {
    // `updateMany` with a `revokedAt: null` guard, not `update`: revoking an
    // already-revoked token is a no-op, not a 404. A client retrying a logout
    // that timed out should get the same answer as the first attempt.
    const [error] = await attempt(() =>
      this.prisma.refreshToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
    return error ? [error, null] : [null, undefined];
  }

  async revokeFamily(familyId: string, reason: RevokeReasonValue): Promise<Result<number>> {
    const [error, result] = await attempt(() =>
      this.prisma.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
    return error ? [error, null] : ok(result.count);
  }

  async revokeAllForUser(
    authUserId: string,
    reason: RevokeReasonValue,
  ): Promise<Result<number>> {
    const [error, result] = await attempt(() =>
      this.prisma.refreshToken.updateMany({
        where: { authUserId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
    return error ? [error, null] : ok(result.count);
  }

  listActiveSessions(authUserId: string, now: Date): Promise<Result<RefreshToken[]>> {
    return attempt(() =>
      this.prisma.refreshToken.findMany({
        where: { authUserId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  // ---- Password -------------------------------------------------------------

  /**
   * Changes the password of a logged-in user and cuts every session, for the
   * same reason `consumePasswordReset` does — including the one making the
   * request. The caller is handed a fresh pair immediately afterwards, so in
   * practice only the *other* devices notice.
   */
  updatePassword(
    authUserId: string,
    passwordHash: string,
    at: Date,
  ): Promise<Result<AuthUser>> {
    return attempt(async () =>
      this.prisma.$transaction(async (tx) => {
        await tx.refreshToken.updateMany({
          where: { authUserId, revokedAt: null },
          data: { revokedAt: at, revokedReason: "PASSWORD_CHANGED" },
        });

        return tx.authUser.update({
          where: { id: authUserId },
          data: { passwordHash, passwordChangedAt: at },
        });
      }),
    );
  }
}
