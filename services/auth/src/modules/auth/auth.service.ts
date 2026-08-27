import { randomUUID } from "node:crypto";

import type { EmailClient } from "../../clients/email.client.js";
import type { UserClient } from "../../clients/user.client.js";
import {
  ConflictError,
  ForbiddenError,
  TooManyRequestsError,
  UnauthorizedError,
  type AppError,
} from "../../errors/app-error.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { createRefreshToken, hashRefreshToken, signAccessToken } from "../../lib/tokens.js";
import { generateCode, hashCode } from "../../utils/codes.js";
import { safeEqual } from "../../utils/hash.js";
import { fail, ok, type Result } from "../../utils/result.js";
import type {
  AuthRepository,
  AuthUser,
  LoginHistoryPage,
  RefreshToken,
} from "./auth.repository.js";
import {
  profileSchema,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type LoginHistoryQuery,
  type LoginInput,
  type LoginOutcomeValue,
  type PendingProfile,
  type RegisterInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from "./auth.schema.js";
import {
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from "./auth.templates.js";

// ---- Public shapes ----------------------------------------------------------

/**
 * The account as it is allowed to leave this service.
 *
 * A hand-written projection, never the Prisma row. Returning the entity
 * directly would put `passwordHash` on the wire the first time someone added a
 * field and forgot to think about it — and a leak like that is silent, because
 * nothing about the response looks wrong. Building the safe shape explicitly
 * means the dangerous fields have to be *typed out* to escape.
 */
export interface PublicAuthUser {
  id: string;
  email: string;
  username: string;
  role: string;
  status: string;
  verified: boolean;
  /** The user service's profile id, or null if it has not been created yet. */
  userId: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface AuthenticatedResult {
  user: PublicAuthUser;
  tokens: AuthTokens;
}

export interface RegistrationResult {
  user: PublicAuthUser;
  /**
   * False when the account was created but the code could not be handed to the
   * email service. Reported rather than hidden: the client needs to know to
   * offer "resend", and a silent success here means a user waiting forever for
   * mail that was never enqueued.
   */
  emailQueued: boolean;
}

export interface VerificationResult extends AuthenticatedResult {
  /** False when the profile hand-off to the user service has not happened yet. */
  profileCreated: boolean;
}

export interface SessionView {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  /** True for the session whose refresh token made this request. */
  current: boolean;
}

/** What the HTTP layer knows about the caller, for audit rows and sessions. */
export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}

export interface AuthServiceOptions {
  verificationTtlMinutes: number;
  verificationMaxAttempts: number;
  resendCooldownSeconds: number;
  maxFailedLoginAttempts: number;
  lockDurationMinutes: number;
}

const MINUTE_MS = 60_000;

export function toPublicAuthUser(user: AuthUser): PublicAuthUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    status: user.status,
    verified: user.verified,
    userId: user.userId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * Reads back a parked profile.
 *
 * `pendingProfile` is a Json column, so what comes out of the database is
 * `unknown` as far as this service is concerned — the column could hold
 * anything a previous version of the code wrote. Re-validating on read means a
 * malformed value degrades into "no profile to hand off", which a retry can
 * fix, rather than a 500 in the middle of a verification.
 */
function readPendingProfile(value: unknown): PendingProfile | null {
  const parsed = profileSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Authentication rules. Deliberately free of Express and Prisma types so it can
 * be unit-tested directly and driven from a CLI or a queue consumer.
 *
 * Nothing in here throws. Each method returns `[error, data]`, and each call it
 * makes is unpacked the same way, so a failure is either handled or explicitly
 * forwarded — there is no third option where it goes unnoticed.
 *
 * Two rules shape almost every method below:
 *
 * 1. **Never confirm whether an address has an account.** Login, resend and
 *    forgot-password all answer identically whether or not the account exists.
 *    An endpoint that distinguishes them is a free membership oracle: point it
 *    at a leaked address list and it sorts your users out of it.
 *
 * 2. **Network calls happen after the transaction, never inside it.** The
 *    database can guarantee atomicity for its own writes and nothing about an
 *    HTTP call to another service, so the two are never mixed into one unit of
 *    work. Where that leaves a gap — an account verified but its profile not
 *    yet created — the gap is closed by retrying later, not by pretending a
 *    distributed transaction exists.
 */
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly emailClient: EmailClient,
    private readonly userClient: UserClient,
    private readonly options: AuthServiceOptions,
  ) {}

  // ---- Registration ---------------------------------------------------------

  /**
   * Creates an unverified account and mails it a code.
   *
   * A duplicate email is answered with a 409, which does confirm that the
   * address is registered — a deliberate exception to the no-enumeration rule
   * above. The alternative (accepting every registration and mailing "someone
   * tried to register your address") is what a service holding sensitive
   * membership data should do, but it makes the sign-up form unusable for
   * everyone else: a user who simply forgot they had an account is told to go
   * check their email and never finds out why nothing works. The oracle is
   * also weak here, because sign-up is the one endpoint where rate limiting is
   * uncontroversial and a slow argon2 hash is already on the path.
   */
  async register(input: RegisterInput, meta: RequestMeta = {}): Promise<Result<RegistrationResult>> {
    const [emailLookupError, byEmail] = await this.repository.findAuthUserByEmail(input.email);
    if (emailLookupError) return fail(emailLookupError);
    if (byEmail) {
      return fail(new ConflictError(`An account with email '${input.email}' already exists`));
    }

    const [usernameLookupError, byUsername] = await this.repository.findAuthUserByUsername(
      input.username,
    );
    if (usernameLookupError) return fail(usernameLookupError);
    if (byUsername) {
      return fail(new ConflictError(`The username '${input.username}' is taken`));
    }

    const [hashError, passwordHash] = await hashPassword(input.password);
    if (hashError) return fail(hashError);

    const code = generateCode();
    const now = new Date();

    // Account and code commit together; either both exist or neither does.
    // Both uniqueness checks above are advisory — two concurrent registrations
    // can pass them — and the unique indexes are what actually settle it.
    // Prisma's P2002 normalises to the same 409, so the loser of the race gets
    // the same answer either way.
    const [createError, created] = await this.repository.createAuthUserWithVerification(
      {
        email: input.email,
        username: input.username,
        passwordHash,
        pendingProfile: input.profile,
      },
      {
        codeHash: hashCode(code),
        type: "EMAIL_VERIFICATION",
        expiresAt: new Date(now.getTime() + this.options.verificationTtlMinutes * MINUTE_MS),
        maxAttempts: this.options.verificationMaxAttempts,
      },
    );
    if (createError) return fail(createError);

    // Outside the transaction, and non-fatal. The account is already committed;
    // a mail service outage must not undo a registration the user completed,
    // and "resend" is the documented way out.
    const emailQueued = await this.dispatchCode(
      created.verification.id,
      verificationEmail(input.email, code),
      `verify:${created.verification.id}`,
      meta,
    );

    return ok({ user: toPublicAuthUser(created.authUser), emailQueued });
  }

  /**
   * Issues a fresh code, subject to a cooldown.
   *
   * Always reports success, whatever actually happened — unknown address,
   * already-verified account, cooldown still running. This endpoint takes an
   * email address and nothing else, so any variation in its answer is a
   * membership oracle that needs no credentials at all to query.
   *
   * The cooldown is enforced even so, silently: it is what stops the endpoint
   * from being used to mail an arbitrary address as fast as HTTP allows.
   */
  async resendVerification(email: string, meta: RequestMeta = {}): Promise<Result<void>> {
    const [lookupError, authUser] = await this.repository.findAuthUserByEmail(email);
    if (lookupError) return fail(lookupError);

    if (!authUser || authUser.verified || authUser.status !== "ACTIVE") {
      return ok(undefined);
    }

    const [activeError, active] = await this.repository.findActiveVerification(
      authUser.id,
      "EMAIL_VERIFICATION",
    );
    if (activeError) return fail(activeError);

    if (active && this.withinCooldown(active.issuedAt)) return ok(undefined);

    const [issueError] = await this.issueCode(authUser, "EMAIL_VERIFICATION", meta);
    if (issueError) return fail(issueError);

    return ok(undefined);
  }

  /**
   * Consumes an email-verification code, then logs the account in.
   *
   * The order matters and is not negotiable: the code is consumed and the
   * account marked verified in one committed transaction *before* anything is
   * asked of the user service. If the profile hand-off then fails, the account
   * is still verified and the user is still logged in — they simply have no
   * profile yet, which the next login will fix. The reverse order would risk
   * creating a profile for an account that never became verified.
   */
  async verifyEmail(
    input: VerifyEmailInput,
    meta: RequestMeta = {},
  ): Promise<Result<VerificationResult>> {
    const [lookupError, authUser] = await this.repository.findAuthUserByEmail(input.email);
    if (lookupError) return fail(lookupError);

    // Same error for a wrong address and a wrong code. Splitting them would
    // turn this into an oracle that needs only an email address to query.
    if (!authUser) return fail(this.invalidCodeError());
    if (authUser.status !== "ACTIVE") return fail(this.invalidCodeError());
    if (authUser.verified) {
      return fail(new ConflictError("This account has already been verified"));
    }

    const [checkError, verification] = await this.consumeCode(
      authUser.id,
      "EMAIL_VERIFICATION",
      input.code,
    );
    if (checkError) return fail(checkError);

    const now = new Date();
    const [consumeError, verified] = await this.repository.consumeEmailVerification(
      verification.id,
      authUser.id,
      now,
    );
    if (consumeError) return fail(consumeError);

    const handoff = await this.ensureProfile(verified, meta);

    const [sessionError, session] = await this.startSession(handoff.authUser, meta, now);
    if (sessionError) return fail(sessionError);

    // Verification signs the user in, so it belongs in the audit trail like any
    // other sign-in. Without this row the account's first session would appear
    // in `GET /auth/sessions` with nothing in its history to account for it —
    // and "I don't recognise this device" is exactly the question that log
    // exists to answer.
    const [recordError] = await this.recordAttempt(authUser.id, authUser.email, "SUCCESS", 1, meta);
    if (recordError) return fail(recordError);

    return ok({ ...session, profileCreated: handoff.authUser.userId !== null });
  }

  // ---- Login ----------------------------------------------------------------

  /**
   * Exchanges credentials for a token pair.
   *
   * Every failure below is recorded in `login_history` with its real cause and
   * reported to the client as one of two messages. The audit trail needs to
   * distinguish "no such account" from "wrong password"; the response must
   * not.
   */
  async login(input: LoginInput, meta: RequestMeta = {}): Promise<Result<AuthenticatedResult>> {
    const [lookupError, authUser] = await this.repository.findAuthUserByEmail(input.email);
    if (lookupError) return fail(lookupError);

    if (!authUser) {
      // Hash the submitted password anyway before answering.
      //
      // Returning early here would make a login for an unknown address
      // measurably faster than one for a known address — argon2 is deliberately
      // slow, and its absence is trivially visible in the response time. That
      // timing difference is a membership oracle just as usable as a different
      // error message, and it survives every other precaution taken above.
      await hashPassword(input.password);
      const [recordError] = await this.recordAttempt(null, input.email, "UNKNOWN_EMAIL", 1, meta);
      if (recordError) return fail(recordError);
      return fail(this.invalidCredentialsError());
    }

    const [verifyError, matches] = await verifyPassword(authUser.passwordHash, input.password);
    if (verifyError) return fail(verifyError);

    if (!matches) {
      const attemptNumber = authUser.failedLoginAttempts + 1;
      const shouldLock = attemptNumber >= this.options.maxFailedLoginAttempts;
      const lockUntil = shouldLock
        ? new Date(Date.now() + this.options.lockDurationMinutes * MINUTE_MS)
        : null;

      const [lockError] = await this.repository.registerFailedLogin(authUser.id, lockUntil);
      if (lockError) return fail(lockError);

      const [recordError] = await this.recordAttempt(
        authUser.id,
        input.email,
        "INVALID_CREDENTIALS",
        attemptNumber,
        meta,
      );
      if (recordError) return fail(recordError);

      return fail(this.invalidCredentialsError());
    }

    // Everything below this line is reached only by someone who proved they
    // know the password, so a specific message reveals nothing they could not
    // already establish — and a vague one would leave a legitimate user with
    // no idea what to do next.

    if (authUser.lockedUntil && authUser.lockedUntil > new Date()) {
      const [recordError] = await this.recordAttempt(
        authUser.id,
        input.email,
        "ACCOUNT_LOCKED",
        authUser.failedLoginAttempts,
        meta,
      );
      if (recordError) return fail(recordError);

      return fail(
        new TooManyRequestsError(
          "Too many failed attempts. Try again after " +
            `${this.options.lockDurationMinutes} minutes, or reset your password.`,
        ),
      );
    }

    if (authUser.status !== "ACTIVE") {
      const [recordError] = await this.recordAttempt(
        authUser.id,
        input.email,
        "ACCOUNT_INACTIVE",
        authUser.failedLoginAttempts,
        meta,
      );
      if (recordError) return fail(recordError);

      return fail(new ForbiddenError("This account is not active. Contact support."));
    }

    if (!authUser.verified) {
      const [recordError] = await this.recordAttempt(
        authUser.id,
        input.email,
        "NOT_VERIFIED",
        authUser.failedLoginAttempts,
        meta,
      );
      if (recordError) return fail(recordError);

      return fail(
        new ForbiddenError("Verify your email address before signing in. Request a new code."),
      );
    }

    const now = new Date();
    const [resetError, refreshed] = await this.repository.registerSuccessfulLogin(
      authUser.id,
      now,
    );
    if (resetError) return fail(resetError);

    const [recordError] = await this.recordAttempt(authUser.id, input.email, "SUCCESS", 1, meta);
    if (recordError) return fail(recordError);

    // Retry point for a hand-off that failed at verification time. Best-effort:
    // the user service being down must not stop someone logging in.
    const handoff = await this.ensureProfile(refreshed, meta);

    return this.startSession(handoff.authUser, meta, now);
  }

  /**
   * Exchanges a refresh token for a new pair, invalidating the old one.
   *
   * Rotation means the presented token dies the moment its successor is
   * issued. So a token that is *already* revoked and is presented again means
   * two copies existed — the legitimate client's and someone else's. There is
   * no way to tell which one just called, so the response is to revoke the
   * entire family and force everybody to log in again. Losing a session is a
   * cheap price for cutting off a stolen one.
   */
  async refresh(token: string, meta: RequestMeta = {}): Promise<Result<AuthTokens>> {
    const [lookupError, stored] = await this.repository.findRefreshTokenByHash(
      hashRefreshToken(token),
    );
    if (lookupError) return fail(lookupError);
    if (!stored) return fail(this.invalidSessionError());

    if (stored.revokedAt) {
      // Reuse detected. Revoke the whole family, including the successor the
      // legitimate client is currently holding.
      const [revokeError] = await this.repository.revokeFamily(stored.familyId, "REUSE_DETECTED");
      if (revokeError) return fail(revokeError);

      return fail(
        new UnauthorizedError(
          "This session was ended for security reasons. Please sign in again.",
        ),
      );
    }

    if (stored.expiresAt <= new Date()) return fail(this.invalidSessionError());

    const [userError, authUser] = await this.repository.findAuthUserById(stored.authUserId);
    if (userError) return fail(userError);
    if (!authUser) return fail(this.invalidSessionError());

    // Re-checked on every refresh, not just at login. Otherwise a suspended
    // account keeps renewing itself for the full life of its refresh token —
    // up to a month — and "suspend this user" would not actually do anything.
    if (authUser.status !== "ACTIVE" || !authUser.verified) {
      const [revokeError] = await this.repository.revokeAllForUser(authUser.id, "LOGOUT_ALL");
      if (revokeError) return fail(revokeError);
      return fail(new ForbiddenError("This account is not active. Contact support."));
    }

    const next = createRefreshToken();
    const [rotateError] = await this.repository.rotateRefreshToken(stored.id, {
      authUserId: authUser.id,
      tokenHash: next.tokenHash,
      // The successor inherits the family, which is what makes the chain — and
      // therefore reuse — detectable across an unlimited number of rotations.
      familyId: stored.familyId,
      expiresAt: next.expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    if (rotateError) return fail(rotateError);

    const [accessError, access] = await signAccessToken({
      sub: authUser.id,
      email: authUser.email,
      username: authUser.username,
      role: authUser.role,
      sid: stored.familyId,
    });
    if (accessError) return fail(accessError);

    return ok({
      accessToken: access.token,
      refreshToken: next.token,
      tokenType: "Bearer",
      expiresIn: access.expiresIn,
    });
  }

  /**
   * Ends one session.
   *
   * An unknown or already-revoked token is a success, not a 404. Logout is
   * idempotent by nature — the caller's goal is "this token must not work",
   * and it already does not. Answering 404 would also let an unauthenticated
   * caller probe which token values exist.
   */
  async logout(token: string): Promise<Result<void>> {
    const [lookupError, stored] = await this.repository.findRefreshTokenByHash(
      hashRefreshToken(token),
    );
    if (lookupError) return fail(lookupError);
    if (!stored) return ok(undefined);

    return this.repository.revokeRefreshToken(stored.id, "LOGOUT");
  }

  /** Ends every session for the account — the "sign out everywhere" button. */
  async logoutAll(authUserId: string): Promise<Result<{ revoked: number }>> {
    const [error, revoked] = await this.repository.revokeAllForUser(authUserId, "LOGOUT_ALL");
    if (error) return fail(error);
    return ok({ revoked });
  }

  // ---- Passwords ------------------------------------------------------------

  /**
   * Starts a password reset.
   *
   * Reports success unconditionally — see `resendVerification`. This endpoint
   * is the most attractive enumeration target in the service precisely because
   * it needs no credentials, and "no account with that email" would answer the
   * attacker's question for them.
   */
  async forgotPassword(
    input: ForgotPasswordInput,
    meta: RequestMeta = {},
  ): Promise<Result<void>> {
    const [lookupError, authUser] = await this.repository.findAuthUserByEmail(input.email);
    if (lookupError) return fail(lookupError);

    if (!authUser || authUser.status !== "ACTIVE") return ok(undefined);

    const [activeError, active] = await this.repository.findActiveVerification(
      authUser.id,
      "PASSWORD_RESET",
    );
    if (activeError) return fail(activeError);
    if (active && this.withinCooldown(active.issuedAt)) return ok(undefined);

    const [issueError] = await this.issueCode(authUser, "PASSWORD_RESET", meta);
    if (issueError) return fail(issueError);

    return ok(undefined);
  }

  /**
   * Completes a reset: consumes the code, installs the new password, and cuts
   * every existing session in one transaction.
   *
   * The session revocation is not a courtesy. A reset is very often being done
   * *because* the account is compromised, and a new password that leaves the
   * attacker's session alive changes nothing at all.
   */
  async resetPassword(input: ResetPasswordInput, meta: RequestMeta = {}): Promise<Result<void>> {
    const [lookupError, authUser] = await this.repository.findAuthUserByEmail(input.email);
    if (lookupError) return fail(lookupError);
    if (!authUser || authUser.status !== "ACTIVE") return fail(this.invalidCodeError());

    const [checkError, verification] = await this.consumeCode(
      authUser.id,
      "PASSWORD_RESET",
      input.code,
    );
    if (checkError) return fail(checkError);

    const [hashError, passwordHash] = await hashPassword(input.password);
    if (hashError) return fail(hashError);

    const [consumeError] = await this.repository.consumePasswordReset(
      verification.id,
      authUser.id,
      passwordHash,
      new Date(),
    );
    if (consumeError) return fail(consumeError);

    // After the commit, and non-fatal: the password has already changed, and
    // failing the request now would tell the user it had not.
    await this.emailClient.enqueue(passwordChangedEmail(authUser.email), {
      requestId: meta.requestId,
    });

    return ok(undefined);
  }

  /**
   * Changes the password of a signed-in user.
   *
   * The current password is required even though the caller already holds a
   * valid access token. A token can be stolen; re-proving knowledge of the
   * password is what stops a stolen one from being upgraded into permanent
   * control of the account.
   *
   * Every session is revoked, then a fresh pair is issued to the caller — so
   * the device making the change stays signed in and every other one does not.
   */
  async changePassword(
    authUserId: string,
    input: ChangePasswordInput,
    meta: RequestMeta = {},
  ): Promise<Result<AuthTokens>> {
    const [lookupError, authUser] = await this.repository.findAuthUserById(authUserId);
    if (lookupError) return fail(lookupError);
    if (!authUser) return fail(new UnauthorizedError("Authentication required"));

    const [verifyError, matches] = await verifyPassword(
      authUser.passwordHash,
      input.currentPassword,
    );
    if (verifyError) return fail(verifyError);
    if (!matches) return fail(new UnauthorizedError("Current password is incorrect"));

    const [hashError, passwordHash] = await hashPassword(input.password);
    if (hashError) return fail(hashError);

    const now = new Date();
    const [updateError, updated] = await this.repository.updatePassword(
      authUser.id,
      passwordHash,
      now,
    );
    if (updateError) return fail(updateError);

    await this.emailClient.enqueue(passwordChangedEmail(authUser.email), {
      requestId: meta.requestId,
    });

    const [sessionError, session] = await this.startSession(updated, meta, now);
    if (sessionError) return fail(sessionError);

    return ok(session.tokens);
  }

  // ---- Reads ----------------------------------------------------------------

  async getById(authUserId: string): Promise<Result<PublicAuthUser>> {
    const [error, authUser] = await this.repository.findAuthUserById(authUserId);
    if (error) return fail(error);
    // A valid token for a deleted account: 401, not 404. The credential is the
    // thing that is no longer good, and there is no resource to be missing.
    if (!authUser) return fail(new UnauthorizedError("Authentication required"));
    return ok(toPublicAuthUser(authUser));
  }

  async listSessions(
    authUserId: string,
    currentSessionId?: string,
  ): Promise<Result<SessionView[]>> {
    const [error, sessions] = await this.repository.listActiveSessions(authUserId, new Date());
    if (error) return fail(error);

    return ok(
      sessions.map((session: RefreshToken) => ({
        id: session.id,
        ip: session.ip,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        current: currentSessionId !== undefined && session.familyId === currentSessionId,
      })),
    );
  }

  listLoginHistory(
    authUserId: string,
    query: LoginHistoryQuery,
  ): Promise<Result<LoginHistoryPage>> {
    return this.repository.listLoginHistory(authUserId, query);
  }

  // ---- Internals ------------------------------------------------------------

  /**
   * Validates a submitted code against the account's live one.
   *
   * A wrong code costs an attempt. Once the ceiling is reached the code is
   * burned, so guessing a six-digit number requires a fresh email round-trip
   * every few tries — which is what makes six digits enough.
   *
   * Every failure returns the same error. "Expired", "already used", "wrong"
   * and "you have no code" are four different facts about an account, and each
   * one narrows an attacker's search.
   */
  private async consumeCode(
    authUserId: string,
    type: "EMAIL_VERIFICATION" | "PASSWORD_RESET",
    code: string,
  ): Promise<Result<{ id: string }>> {
    const [lookupError, verification] = await this.repository.findActiveVerification(
      authUserId,
      type,
    );
    if (lookupError) return fail(lookupError);
    if (!verification) return fail(this.invalidCodeError());

    if (verification.expiresAt <= new Date()) return fail(this.invalidCodeError());
    if (verification.attempts >= verification.maxAttempts) return fail(this.invalidCodeError());

    // Constant-time, even though both sides are hashes of a six-digit number
    // and the timing leak is theoretical. The habit is what matters: the day
    // this compares something with real entropy, it will already be correct.
    if (!safeEqual(verification.codeHash, hashCode(code))) {
      const exhausted = verification.attempts + 1 >= verification.maxAttempts;
      const [attemptError] = await this.repository.registerVerificationAttempt(
        verification.id,
        exhausted,
      );
      if (attemptError) return fail(attemptError);
      return fail(this.invalidCodeError());
    }

    return ok({ id: verification.id });
  }

  /** Issues a code of a given type and mails it. */
  private async issueCode(
    authUser: AuthUser,
    type: "EMAIL_VERIFICATION" | "PASSWORD_RESET",
    meta: RequestMeta,
  ): Promise<Result<void>> {
    const code = generateCode();

    const [createError, verification] = await this.repository.replaceVerification({
      authUserId: authUser.id,
      codeHash: hashCode(code),
      type,
      expiresAt: new Date(Date.now() + this.options.verificationTtlMinutes * MINUTE_MS),
      maxAttempts: this.options.verificationMaxAttempts,
    });
    if (createError) return fail(createError);

    const message =
      type === "EMAIL_VERIFICATION"
        ? verificationEmail(authUser.email, code)
        : passwordResetEmail(authUser.email, code);

    await this.dispatchCode(verification.id, message, `${type}:${verification.id}`, meta);

    return ok(undefined);
  }

  /**
   * Hands a code to the email service and records the resulting message id.
   *
   * Never fails the caller. The verification row is already committed, so the
   * only thing a failure changes is that the user needs to ask for a resend —
   * and the null `emailMessageId` left behind is exactly the row an operator
   * should be looking for.
   *
   * The idempotency key is the verification id, so a retry after a timeout
   * returns the message the first attempt created instead of mailing the code
   * twice.
   */
  private async dispatchCode(
    verificationId: string,
    message: Parameters<EmailClient["enqueue"]>[0],
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<boolean> {
    const [error, enqueued] = await this.emailClient.enqueue(message, {
      requestId: meta.requestId,
      idempotencyKey,
    });
    if (error || !enqueued) return false;

    await this.repository.attachVerificationEmail(verificationId, enqueued.id);
    return true;
  }

  /**
   * Creates the user-service profile if it does not exist yet.
   *
   * Best-effort by design, and the reason `AuthUser.userId` is nullable. The
   * account is already verified and committed at this point; the user service
   * being unreachable is not a reason to fail a login, so the gap is left open
   * and closed on the next attempt. Every caller of this is a natural retry
   * point.
   *
   * A 409 from the user service is treated as success, not failure: it means a
   * previous hand-off committed there but its response never made it back
   * here. The profile exists, so the only thing missing is the pointer, and
   * that is recoverable by looking it up.
   */
  private async ensureProfile(
    authUser: AuthUser,
    meta: RequestMeta,
  ): Promise<{ authUser: AuthUser; error?: AppError }> {
    if (authUser.userId) return { authUser };

    const profile = readPendingProfile(authUser.pendingProfile);
    if (!profile) return { authUser };

    const context = { requestId: meta.requestId, actor: authUser.id };

    const [createError, created] = await this.userClient.createProfile(
      {
        authUserId: authUser.id,
        email: authUser.email,
        name: profile.name,
        address: profile.address,
        phone: profile.phone,
      },
      context,
    );

    if (createError) {
      if (!(createError instanceof ConflictError)) return { authUser, error: createError };

      // Already created by an earlier attempt whose response was lost.
      const [lookupError, existing] = await this.userClient.findByAuthUserId(
        authUser.id,
        context,
      );
      if (lookupError || !existing) return { authUser, error: lookupError ?? createError };

      const [attachError, attached] = await this.repository.attachProfile(
        authUser.id,
        existing.id,
      );
      return attachError ? { authUser, error: attachError } : { authUser: attached };
    }

    const [attachError, attached] = await this.repository.attachProfile(authUser.id, created.id);
    return attachError ? { authUser, error: attachError } : { authUser: attached };
  }

  /** Mints a token pair and opens a new refresh-token family. */
  private async startSession(
    authUser: AuthUser,
    meta: RequestMeta,
    now: Date,
  ): Promise<Result<AuthenticatedResult>> {
    // A fresh family per login, so revoking one compromised session leaves the
    // user's other devices alone.
    const familyId = randomUUID();
    const refresh = createRefreshToken(now);

    const [storeError] = await this.repository.createRefreshToken({
      authUserId: authUser.id,
      tokenHash: refresh.tokenHash,
      familyId,
      expiresAt: refresh.expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    if (storeError) return fail(storeError);

    const [accessError, access] = await signAccessToken(
      {
        sub: authUser.id,
        email: authUser.email,
        username: authUser.username,
        role: authUser.role,
        sid: familyId,
      },
      now,
    );
    if (accessError) return fail(accessError);

    return ok({
      user: toPublicAuthUser(authUser),
      tokens: {
        accessToken: access.token,
        refreshToken: refresh.token,
        tokenType: "Bearer",
        expiresIn: access.expiresIn,
      },
    });
  }

  private recordAttempt(
    authUserId: string | null,
    email: string,
    outcome: LoginOutcomeValue,
    attempt: number,
    meta: RequestMeta,
  ): Promise<Result<unknown>> {
    return this.repository.recordLoginAttempt({
      authUserId,
      email,
      success: outcome === "SUCCESS",
      outcome,
      attempt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  private withinCooldown(issuedAt: Date): boolean {
    const elapsedSeconds = (Date.now() - issuedAt.getTime()) / 1000;
    return elapsedSeconds < this.options.resendCooldownSeconds;
  }

  /** One message for every credential failure — see the class comment. */
  private invalidCredentialsError(): UnauthorizedError {
    return new UnauthorizedError("Invalid email or password");
  }

  private invalidCodeError(): UnauthorizedError {
    return new UnauthorizedError("The code is invalid or has expired");
  }

  private invalidSessionError(): UnauthorizedError {
    return new UnauthorizedError("Session is invalid or has expired. Please sign in again.");
  }
}
