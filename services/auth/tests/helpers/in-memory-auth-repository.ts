import { randomUUID } from "node:crypto";
import { ServiceUnavailableError } from "../../src/errors/app-error.js";
import type {
  AuthRepository,
  AuthUser,
  LoginHistory,
  LoginHistoryPage,
  NewAuthUserRecord,
  NewLoginHistoryRecord,
  NewRefreshTokenRecord,
  NewVerificationRecord,
  RefreshToken,
  Verification,
} from "../../src/modules/auth/auth.repository.js";
import type {
  LoginHistoryQuery,
  RevokeReasonValue,
  VerificationTypeValue,
} from "../../src/modules/auth/auth.schema.js";
import { fail, ok, type Result } from "../../src/utils/result.js";

type RepositoryMethod = keyof AuthRepository;

/**
 * Test double for `AuthRepository`. Because the service layer depends on the
 * interface rather than Prisma, the whole HTTP stack can be exercised with no
 * database — which matters more here than elsewhere, since the behaviour worth
 * testing in this service is policy (lockouts, rotation, what the response
 * reveals) and none of it needs a real Postgres to be wrong.
 *
 * It returns error-first tuples exactly as the real one does — including on
 * simulated outages, which is the only way to prove the service forwards a
 * repository failure instead of turning it into an empty success.
 */
export class InMemoryAuthRepository implements AuthRepository {
  private readonly authUsers = new Map<string, AuthUser>();
  private readonly verifications = new Map<string, Verification>();
  private readonly refreshTokens = new Map<string, RefreshToken>();
  private readonly logins: LoginHistory[] = [];
  private readonly failing = new Set<RepositoryMethod>();

  constructor(seed: AuthUser[] = []) {
    for (const user of seed) this.authUsers.set(user.id, user);
  }

  static buildAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: randomUUID(),
      email: `user-${randomUUID()}@example.com`,
      username: `user${randomUUID().slice(0, 8)}`,
      passwordHash: "$argon2id$placeholder",
      role: "USER",
      status: "ACTIVE",
      verified: true,
      verifiedAt: now,
      userId: null,
      pendingProfile: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      passwordChangedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  /** Makes one method behave as though the database were unreachable. */
  fail(method: RepositoryMethod): void {
    this.failing.add(method);
  }

  get userCount(): number {
    return this.authUsers.size;
  }

  get loginCount(): number {
    return this.logins.length;
  }

  /** Reaches past the service to inspect what was actually written. */
  peekAuthUser(id: string): AuthUser | undefined {
    return this.authUsers.get(id);
  }

  peekVerifications(authUserId: string): Verification[] {
    return [...this.verifications.values()].filter((v) => v.authUserId === authUserId);
  }

  peekRefreshTokens(authUserId: string): RefreshToken[] {
    return [...this.refreshTokens.values()].filter((t) => t.authUserId === authUserId);
  }

  peekLogins(): LoginHistory[] {
    return [...this.logins];
  }

  private outage<T>(method: RepositoryMethod): Result<T> | null {
    if (!this.failing.has(method)) return null;
    return fail(new ServiceUnavailableError(`Simulated outage in ${method}`));
  }

  // ---- Auth users -----------------------------------------------------------

  async createAuthUserWithVerification(
    user: NewAuthUserRecord,
    verification: Omit<NewVerificationRecord, "authUserId">,
  ): Promise<Result<{ authUser: AuthUser; verification: Verification }>> {
    const outage = this.outage<{ authUser: AuthUser; verification: Verification }>(
      "createAuthUserWithVerification",
    );
    if (outage) return outage;

    const authUser = InMemoryAuthRepository.buildAuthUser({
      email: user.email,
      username: user.username,
      passwordHash: user.passwordHash,
      pendingProfile: user.pendingProfile,
      verified: false,
      verifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    this.authUsers.set(authUser.id, authUser);

    const created = this.insertVerification({ ...verification, authUserId: authUser.id });
    return ok({ authUser, verification: created });
  }

  async findAuthUserById(id: string): Promise<Result<AuthUser | null>> {
    return this.outage<AuthUser | null>("findAuthUserById") ?? ok(this.authUsers.get(id) ?? null);
  }

  async findAuthUserByEmail(email: string): Promise<Result<AuthUser | null>> {
    const outage = this.outage<AuthUser | null>("findAuthUserByEmail");
    if (outage) return outage;
    return ok([...this.authUsers.values()].find((user) => user.email === email) ?? null);
  }

  async findAuthUserByUsername(username: string): Promise<Result<AuthUser | null>> {
    const outage = this.outage<AuthUser | null>("findAuthUserByUsername");
    if (outage) return outage;
    return ok([...this.authUsers.values()].find((user) => user.username === username) ?? null);
  }

  async attachProfile(id: string, userId: string): Promise<Result<AuthUser>> {
    const outage = this.outage<AuthUser>("attachProfile");
    if (outage) return outage;
    return this.mutateUser(id, { userId, pendingProfile: null });
  }

  // ---- Login accounting -----------------------------------------------------

  async recordLoginAttempt(input: NewLoginHistoryRecord): Promise<Result<LoginHistory>> {
    const outage = this.outage<LoginHistory>("recordLoginAttempt");
    if (outage) return outage;

    const row: LoginHistory = {
      id: randomUUID(),
      authUserId: input.authUserId,
      email: input.email,
      success: input.success,
      outcome: input.outcome,
      attempt: input.attempt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      loginAt: new Date(),
    };
    this.logins.push(row);
    return ok(row);
  }

  async registerFailedLogin(id: string, lockUntil: Date | null): Promise<Result<AuthUser>> {
    const outage = this.outage<AuthUser>("registerFailedLogin");
    if (outage) return outage;

    const current = this.authUsers.get(id);
    if (!current) return fail(new ServiceUnavailableError("Missing user"));

    return this.mutateUser(id, {
      failedLoginAttempts: current.failedLoginAttempts + 1,
      ...(lockUntil ? { lockedUntil: lockUntil } : {}),
    });
  }

  async registerSuccessfulLogin(id: string, at: Date): Promise<Result<AuthUser>> {
    const outage = this.outage<AuthUser>("registerSuccessfulLogin");
    if (outage) return outage;
    return this.mutateUser(id, { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: at });
  }

  async listLoginHistory(
    authUserId: string,
    query: LoginHistoryQuery,
  ): Promise<Result<LoginHistoryPage>> {
    const outage = this.outage<LoginHistoryPage>("listLoginHistory");
    if (outage) return outage;

    const matching = this.logins
      .filter((row) => row.authUserId === authUserId)
      .filter((row) => (query.success === undefined ? true : row.success === query.success))
      .filter((row) => (query.outcome ? row.outcome === query.outcome : true))
      .sort((a, b) => b.loginAt.getTime() - a.loginAt.getTime());

    const start = (query.page - 1) * query.limit;
    return ok({ items: matching.slice(start, start + query.limit), total: matching.length });
  }

  // ---- Verification ---------------------------------------------------------

  async findActiveVerification(
    authUserId: string,
    type: VerificationTypeValue,
  ): Promise<Result<Verification | null>> {
    const outage = this.outage<Verification | null>("findActiveVerification");
    if (outage) return outage;

    const matching = [...this.verifications.values()]
      .filter((v) => v.authUserId === authUserId && v.type === type && v.status === "PENDING")
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());

    return ok(matching[0] ?? null);
  }

  async replaceVerification(input: NewVerificationRecord): Promise<Result<Verification>> {
    const outage = this.outage<Verification>("replaceVerification");
    if (outage) return outage;

    for (const [id, existing] of this.verifications) {
      if (
        existing.authUserId === input.authUserId &&
        existing.type === input.type &&
        existing.status === "PENDING"
      ) {
        this.verifications.set(id, { ...existing, status: "REVOKED" });
      }
    }

    return ok(this.insertVerification(input));
  }

  async registerVerificationAttempt(
    id: string,
    exhausted: boolean,
  ): Promise<Result<Verification>> {
    const outage = this.outage<Verification>("registerVerificationAttempt");
    if (outage) return outage;

    const current = this.verifications.get(id);
    if (!current) return fail(new ServiceUnavailableError("Missing verification"));

    const updated: Verification = {
      ...current,
      attempts: current.attempts + 1,
      status: exhausted ? "EXPIRED" : current.status,
      updatedAt: new Date(),
    };
    this.verifications.set(id, updated);
    return ok(updated);
  }

  async attachVerificationEmail(id: string, emailMessageId: string): Promise<Result<void>> {
    const outage = this.outage<void>("attachVerificationEmail");
    if (outage) return outage;

    const current = this.verifications.get(id);
    if (current) this.verifications.set(id, { ...current, emailMessageId });
    return [null, undefined];
  }

  async consumeEmailVerification(
    verificationId: string,
    authUserId: string,
    at: Date,
  ): Promise<Result<AuthUser>> {
    const outage = this.outage<AuthUser>("consumeEmailVerification");
    if (outage) return outage;

    const verification = this.verifications.get(verificationId);
    // Mirrors the real repository's `status: "PENDING"` guard: a code that has
    // already been consumed matches nothing and the update fails.
    if (!verification || verification.status !== "PENDING") {
      return fail(new ServiceUnavailableError("Verification is no longer pending"));
    }

    this.verifications.set(verificationId, {
      ...verification,
      status: "VERIFIED",
      verifiedAt: at,
    });

    return this.mutateUser(authUserId, { verified: true, verifiedAt: at });
  }

  async consumePasswordReset(
    verificationId: string,
    authUserId: string,
    passwordHash: string,
    at: Date,
  ): Promise<Result<AuthUser>> {
    const outage = this.outage<AuthUser>("consumePasswordReset");
    if (outage) return outage;

    const verification = this.verifications.get(verificationId);
    if (!verification || verification.status !== "PENDING") {
      return fail(new ServiceUnavailableError("Verification is no longer pending"));
    }

    this.verifications.set(verificationId, {
      ...verification,
      status: "VERIFIED",
      verifiedAt: at,
    });
    this.revokeWhere((token) => token.authUserId === authUserId, "PASSWORD_CHANGED", at);

    return this.mutateUser(authUserId, {
      passwordHash,
      passwordChangedAt: at,
      verified: true,
      verifiedAt: at,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }

  // ---- Sessions -------------------------------------------------------------

  async createRefreshToken(input: NewRefreshTokenRecord): Promise<Result<RefreshToken>> {
    const outage = this.outage<RefreshToken>("createRefreshToken");
    if (outage) return outage;
    return ok(this.insertRefreshToken(input));
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<Result<RefreshToken | null>> {
    const outage = this.outage<RefreshToken | null>("findRefreshTokenByHash");
    if (outage) return outage;
    return ok([...this.refreshTokens.values()].find((t) => t.tokenHash === tokenHash) ?? null);
  }

  async rotateRefreshToken(
    currentId: string,
    next: NewRefreshTokenRecord,
  ): Promise<Result<RefreshToken>> {
    const outage = this.outage<RefreshToken>("rotateRefreshToken");
    if (outage) return outage;

    const current = this.refreshTokens.get(currentId);
    // Mirrors the real repository's `revokedAt: null` guard, which is what
    // makes a second concurrent rotation fail rather than mint a second token.
    if (!current || current.revokedAt) {
      return fail(new ServiceUnavailableError("Refresh token is no longer live"));
    }

    const created = this.insertRefreshToken(next);
    this.refreshTokens.set(currentId, {
      ...current,
      revokedAt: new Date(),
      revokedReason: "ROTATED",
      replacedById: created.id,
    });

    return ok(created);
  }

  async revokeRefreshToken(id: string, reason: RevokeReasonValue): Promise<Result<void>> {
    const outage = this.outage<void>("revokeRefreshToken");
    if (outage) return outage;

    this.revokeWhere((token) => token.id === id, reason, new Date());
    return [null, undefined];
  }

  async revokeFamily(familyId: string, reason: RevokeReasonValue): Promise<Result<number>> {
    const outage = this.outage<number>("revokeFamily");
    if (outage) return outage;
    return ok(this.revokeWhere((token) => token.familyId === familyId, reason, new Date()));
  }

  async revokeAllForUser(
    authUserId: string,
    reason: RevokeReasonValue,
  ): Promise<Result<number>> {
    const outage = this.outage<number>("revokeAllForUser");
    if (outage) return outage;
    return ok(this.revokeWhere((token) => token.authUserId === authUserId, reason, new Date()));
  }

  async listActiveSessions(authUserId: string, now: Date): Promise<Result<RefreshToken[]>> {
    const outage = this.outage<RefreshToken[]>("listActiveSessions");
    if (outage) return outage;

    return ok(
      [...this.refreshTokens.values()]
        .filter((t) => t.authUserId === authUserId && !t.revokedAt && t.expiresAt > now)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  // ---- Password -------------------------------------------------------------

  async updatePassword(
    authUserId: string,
    passwordHash: string,
    at: Date,
  ): Promise<Result<AuthUser>> {
    const outage = this.outage<AuthUser>("updatePassword");
    if (outage) return outage;

    this.revokeWhere((token) => token.authUserId === authUserId, "PASSWORD_CHANGED", at);
    return this.mutateUser(authUserId, { passwordHash, passwordChangedAt: at });
  }

  // ---- Internals ------------------------------------------------------------

  private insertVerification(input: NewVerificationRecord): Verification {
    const now = new Date();
    const created: Verification = {
      id: randomUUID(),
      authUserId: input.authUserId,
      codeHash: input.codeHash,
      type: input.type,
      status: "PENDING",
      newEmail: input.newEmail ?? null,
      attempts: 0,
      maxAttempts: input.maxAttempts,
      issuedAt: now,
      expiresAt: input.expiresAt,
      verifiedAt: null,
      emailMessageId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.verifications.set(created.id, created);
    return created;
  }

  private insertRefreshToken(input: NewRefreshTokenRecord): RefreshToken {
    const created: RefreshToken = {
      id: randomUUID(),
      authUserId: input.authUserId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: new Date(),
    };
    this.refreshTokens.set(created.id, created);
    return created;
  }

  private revokeWhere(
    predicate: (token: RefreshToken) => boolean,
    reason: RevokeReasonValue,
    at: Date,
  ): number {
    let revoked = 0;
    for (const [id, token] of this.refreshTokens) {
      if (token.revokedAt || !predicate(token)) continue;
      this.refreshTokens.set(id, { ...token, revokedAt: at, revokedReason: reason });
      revoked += 1;
    }
    return revoked;
  }

  private mutateUser(id: string, patch: Partial<AuthUser>): Result<AuthUser> {
    const current = this.authUsers.get(id);
    if (!current) return fail(new ServiceUnavailableError(`Missing auth user ${id}`));

    const updated: AuthUser = { ...current, ...patch, updatedAt: new Date() };
    this.authUsers.set(id, updated);
    return ok(updated);
  }
}
