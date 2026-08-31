import { beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
} from "../../src/errors/app-error.js";
import { AuthService } from "../../src/modules/auth/auth.service.js";
import type { RegisterInput } from "../../src/modules/auth/auth.schema.js";
import { InMemoryAuthRepository } from "../helpers/in-memory-auth-repository.js";
import { StubEmailClient, StubUserClient } from "../helpers/stub-clients.js";

const PASSWORD = "correct-horse-battery-staple";

const registration: RegisterInput = {
  email: "delivered@resend.dev",
  username: "ada",
  password: PASSWORD,
  profile: {
    name: "Ada Lovelace",
    address: "12 Analytical Engine Way",
    phone: "+15550001111",
  },
};

const options = {
  verificationTtlMinutes: 15,
  verificationMaxAttempts: 5,
  resendCooldownSeconds: 60,
  maxFailedLoginAttempts: 5,
  lockDurationMinutes: 15,
};

describe("AuthService", () => {
  let repository: InMemoryAuthRepository;
  let emailClient: StubEmailClient;
  let userClient: StubUserClient;
  let service: AuthService;

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
    emailClient = new StubEmailClient();
    userClient = new StubUserClient();
    service = new AuthService(repository, emailClient, userClient, options);
  });

  /** Registers and verifies an account, returning it ready to log in. */
  const registerAndVerify = async (input: RegisterInput = registration) => {
    const [registerError, registered] = await service.register(input);
    expect(registerError).toBeNull();

    const code = emailClient.codeFor(input.email);
    const [verifyError, verified] = await service.verifyEmail({ email: input.email, code });
    expect(verifyError).toBeNull();

    return { registered: registered!, verified: verified! };
  };

  // ---- Registration ---------------------------------------------------------

  describe("register", () => {
    it("creates an unverified account and mails a code", async () => {
      const [error, result] = await service.register(registration);

      expect(error).toBeNull();
      expect(result).toMatchObject({
        emailQueued: true,
        user: {
          email: "delivered@resend.dev",
          username: "ada",
          verified: false,
          userId: null,
        },
      });
      expect(emailClient.sent).toHaveLength(1);
      expect(emailClient.lastSource()).toBe("auth.email-verification");
    });

    it("never returns the password hash", async () => {
      const [, result] = await service.register(registration);

      expect(result!.user).not.toHaveProperty("passwordHash");
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    });

    it("parks the profile instead of calling the user service", async () => {
      await service.register(registration);

      // The profile is created at verification, not at registration — an
      // unverified account must not put a row in another service.
      expect(userClient.created).toHaveLength(0);
    });

    it("rejects a duplicate email", async () => {
      await service.register(registration);

      const [error] = await service.register({ ...registration, username: "different" });

      expect(error).toBeInstanceOf(ConflictError);
      expect(repository.userCount).toBe(1);
    });

    it("rejects a duplicate username", async () => {
      await service.register(registration);

      const [error] = await service.register({
        ...registration,
        email: "other@example.com",
      });

      expect(error).toBeInstanceOf(ConflictError);
      expect(repository.userCount).toBe(1);
    });

    it("keeps the account when the email service is down, and says so", async () => {
      emailClient.failNext();

      const [error, result] = await service.register(registration);

      // The account is committed; only the mail failed. Undoing a completed
      // registration because a *different* service is unavailable would be
      // worse than letting the user ask for a resend.
      expect(error).toBeNull();
      expect(result!.emailQueued).toBe(false);
      expect(repository.userCount).toBe(1);
    });

    it("forwards a repository outage instead of reporting success", async () => {
      repository.fail("createAuthUserWithVerification");

      const [error, result] = await service.register(registration);

      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(result).toBeNull();
    });
  });

  // ---- Verification ---------------------------------------------------------

  describe("verifyEmail", () => {
    it("verifies the account, creates the profile, and returns tokens", async () => {
      const { verified } = await registerAndVerify();

      expect(verified.user.verified).toBe(true);
      expect(verified.profileCreated).toBe(true);
      expect(verified.tokens.accessToken).toBeTruthy();
      expect(verified.tokens.refreshToken).toBeTruthy();
      expect(verified.tokens.tokenType).toBe("Bearer");

      expect(userClient.created).toHaveLength(1);
      expect(userClient.created[0]).toMatchObject({
        name: "Ada Lovelace",
        address: "12 Analytical Engine Way",
        phone: "+15550001111",
        email: "delivered@resend.dev",
      });
    });

    it("clears the parked profile once it has been handed over", async () => {
      const { registered } = await registerAndVerify();

      const stored = repository.peekAuthUser(registered.user.id);
      expect(stored?.pendingProfile).toBeNull();
      expect(stored?.userId).toBeTruthy();
    });

    it("rejects a wrong code and spends an attempt", async () => {
      const [, registered] = await service.register(registration);

      const [error] = await service.verifyEmail({ email: registration.email, code: "000000" });

      expect(error).toBeInstanceOf(UnauthorizedError);
      const [verification] = repository.peekVerifications(registered!.user.id);
      expect(verification?.attempts).toBe(1);
    });

    it("burns the code once the attempt ceiling is reached", async () => {
      const [, registered] = await service.register(registration);
      const realCode = emailClient.codeFor(registration.email);

      for (let i = 0; i < options.verificationMaxAttempts; i += 1) {
        await service.verifyEmail({ email: registration.email, code: "000000" });
      }

      // Even the correct code no longer works — which is what makes six digits
      // enough: guessing costs a fresh email round-trip every five tries.
      const [error] = await service.verifyEmail({ email: registration.email, code: realCode });
      expect(error).toBeInstanceOf(UnauthorizedError);

      const [verification] = repository.peekVerifications(registered!.user.id);
      expect(verification?.status).toBe("EXPIRED");
    });

    it("cannot consume the same code twice", async () => {
      const { registered } = await registerAndVerify();
      const code = emailClient.codeFor(registration.email);

      const [error] = await service.verifyEmail({ email: registration.email, code });

      expect(error).toBeInstanceOf(ConflictError);
      expect(repository.peekAuthUser(registered.user.id)?.verified).toBe(true);
    });

    it("answers an unknown address exactly as it answers a wrong code", async () => {
      await service.register(registration);

      const [unknownError] = await service.verifyEmail({
        email: "nobody@example.com",
        code: "123456",
      });
      const [wrongCodeError] = await service.verifyEmail({
        email: registration.email,
        code: "000000",
      });

      // Identical status *and* message: any difference makes this an oracle
      // for whether an address is registered.
      expect(unknownError?.statusCode).toBe(wrongCodeError?.statusCode);
      expect(unknownError?.message).toBe(wrongCodeError?.message);
    });

    it("still verifies and signs in when the user service is unreachable", async () => {
      await service.register(registration);
      userClient.setMode("unreachable");

      const code = emailClient.codeFor(registration.email);
      const [error, result] = await service.verifyEmail({ email: registration.email, code });

      // The account is verified and usable; only the profile is missing, and
      // the next login retries the hand-off.
      expect(error).toBeNull();
      expect(result!.user.verified).toBe(true);
      expect(result!.profileCreated).toBe(false);
      expect(result!.tokens.accessToken).toBeTruthy();
    });

    it("adopts an existing profile when the user service reports a conflict", async () => {
      const [, registered] = await service.register(registration);
      // As though a previous hand-off committed there but its response was lost.
      const existing = userClient.seedProfile(registered!.user.id);
      userClient.setMode("conflict");

      const code = emailClient.codeFor(registration.email);
      const [error, result] = await service.verifyEmail({ email: registration.email, code });

      expect(error).toBeNull();
      expect(result!.profileCreated).toBe(true);
      expect(repository.peekAuthUser(registered!.user.id)?.userId).toBe(existing.id);
    });
  });

  describe("resendVerification", () => {
    it("issues a new code and revokes the old one", async () => {
      const [, registered] = await service.register(registration);
      const firstCode = emailClient.codeFor(registration.email);

      // Cooldown disabled for this instance so the resend is not swallowed.
      const instant = new AuthService(repository, emailClient, userClient, {
        ...options,
        resendCooldownSeconds: 0,
      });
      const [error] = await instant.resendVerification(registration.email);
      expect(error).toBeNull();

      const secondCode = emailClient.codeFor(registration.email);
      const statuses = repository
        .peekVerifications(registered!.user.id)
        .map((v) => v.status)
        .sort();

      expect(statuses).toEqual(["PENDING", "REVOKED"]);
      // At most one live code per account per type — otherwise the attempt
      // ceiling is worth double.
      const [firstError] = await instant.verifyEmail({
        email: registration.email,
        code: firstCode,
      });
      expect(firstError).toBeInstanceOf(UnauthorizedError);

      const [secondError] = await instant.verifyEmail({
        email: registration.email,
        code: secondCode,
      });
      expect(secondError).toBeNull();
    });

    it("reports success for an unknown address without sending anything", async () => {
      const [error] = await service.resendVerification("nobody@example.com");

      expect(error).toBeNull();
      expect(emailClient.sent).toHaveLength(0);
    });

    it("silently swallows a resend inside the cooldown", async () => {
      await service.register(registration);
      expect(emailClient.sent).toHaveLength(1);

      const [error] = await service.resendVerification(registration.email);

      // Success is reported, but no second mail goes out — otherwise this
      // endpoint is a relay for mailing an address as fast as HTTP allows.
      expect(error).toBeNull();
      expect(emailClient.sent).toHaveLength(1);
    });
  });

  // ---- Login ----------------------------------------------------------------

  describe("login", () => {
    it("returns a token pair for correct credentials", async () => {
      await registerAndVerify();

      const [error, result] = await service.login({
        email: registration.email,
        password: PASSWORD,
      });

      expect(error).toBeNull();
      expect(result!.tokens.accessToken).toBeTruthy();
      expect(result!.user).not.toHaveProperty("passwordHash");
    });

    it("refuses an unverified account with a message that says why", async () => {
      await service.register(registration);

      const [error] = await service.login({ email: registration.email, password: PASSWORD });

      // Specific, because this is only reachable by someone who already proved
      // they know the password.
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error?.message).toMatch(/verify/i);
    });

    it("answers an unknown email exactly as it answers a wrong password", async () => {
      await registerAndVerify();

      const [unknownError] = await service.login({
        email: "nobody@example.com",
        password: PASSWORD,
      });
      const [wrongPasswordError] = await service.login({
        email: registration.email,
        password: "definitely-not-the-password",
      });

      expect(unknownError?.statusCode).toBe(401);
      expect(unknownError?.message).toBe(wrongPasswordError?.message);
    });

    it("records an unknown email in the audit trail with no account attached", async () => {
      await service.login({ email: "nobody@example.com", password: PASSWORD });

      const [row] = repository.peekLogins();
      // The response is vague; the audit trail is not. A burst of these from
      // one address is a credential-stuffing run.
      expect(row).toMatchObject({
        authUserId: null,
        outcome: "UNKNOWN_EMAIL",
        success: false,
        email: "nobody@example.com",
      });
    });

    it("records the real cause of every failure while reporting one message", async () => {
      await registerAndVerify();
      await service.login({ email: registration.email, password: "wrong-password-here" });

      const outcomes = repository.peekLogins().map((row) => row.outcome);
      expect(outcomes).toContain("SUCCESS");
      expect(outcomes).toContain("INVALID_CREDENTIALS");
    });

    it("locks the account after the configured number of failures", async () => {
      const { registered } = await registerAndVerify();

      for (let i = 0; i < options.maxFailedLoginAttempts; i += 1) {
        await service.login({ email: registration.email, password: "wrong-password-here" });
      }

      const locked = repository.peekAuthUser(registered.user.id);
      expect(locked?.failedLoginAttempts).toBe(options.maxFailedLoginAttempts);
      expect(locked?.lockedUntil).toBeInstanceOf(Date);

      // The correct password is now refused too — that is what a lock means.
      const [error] = await service.login({ email: registration.email, password: PASSWORD });
      expect(error).toBeInstanceOf(TooManyRequestsError);

      const outcomes = repository.peekLogins().map((row) => row.outcome);
      expect(outcomes).toContain("ACCOUNT_LOCKED");
    });

    it("clears the failure counter on a successful login", async () => {
      const { registered } = await registerAndVerify();
      await service.login({ email: registration.email, password: "wrong-password-here" });
      expect(repository.peekAuthUser(registered.user.id)?.failedLoginAttempts).toBe(1);

      await service.login({ email: registration.email, password: PASSWORD });

      expect(repository.peekAuthUser(registered.user.id)?.failedLoginAttempts).toBe(0);
    });

    it("refuses a suspended account", async () => {
      const { registered } = await registerAndVerify();
      const stored = repository.peekAuthUser(registered.user.id)!;
      await repository.attachProfile(stored.id, "profile-1");
      Object.assign(repository.peekAuthUser(stored.id)!, { status: "SUSPENDED" });

      const [error] = await service.login({ email: registration.email, password: PASSWORD });

      expect(error).toBeInstanceOf(ForbiddenError);
    });

    it("retries a profile hand-off that failed at verification time", async () => {
      await service.register(registration);
      userClient.setMode("unreachable");
      const code = emailClient.codeFor(registration.email);
      const [, verified] = await service.verifyEmail({ email: registration.email, code });
      expect(verified!.profileCreated).toBe(false);

      userClient.setMode("ok");
      const [error, result] = await service.login({
        email: registration.email,
        password: PASSWORD,
      });

      expect(error).toBeNull();
      expect(result!.user.userId).toBeTruthy();
      expect(userClient.created).toHaveLength(1);
    });

    it("gives each login its own session family", async () => {
      const { registered } = await registerAndVerify();
      await service.login({ email: registration.email, password: PASSWORD });
      await service.login({ email: registration.email, password: PASSWORD });

      const families = new Set(
        repository.peekRefreshTokens(registered.user.id).map((token) => token.familyId),
      );

      // Three logins (one from verification) => three families, so revoking a
      // compromised session leaves the other devices alone.
      expect(families.size).toBe(3);
    });
  });

  // ---- Sessions -------------------------------------------------------------

  describe("refresh", () => {
    it("rotates the token and invalidates the old one", async () => {
      const { verified } = await registerAndVerify();
      const original = verified.tokens.refreshToken;

      const [error, rotated] = await service.refresh(original);

      expect(error).toBeNull();
      expect(rotated!.refreshToken).not.toBe(original);

      // The old one is dead the moment its successor exists.
      const [reuseError] = await service.refresh(original);
      expect(reuseError).toBeInstanceOf(UnauthorizedError);
    });

    it("revokes the whole family when a rotated token is presented again", async () => {
      const { registered, verified } = await registerAndVerify();
      const original = verified.tokens.refreshToken;

      const [, rotated] = await service.refresh(original);
      // Two copies of `original` existed — the client's and, hypothetically, a
      // thief's. There is no way to tell which one just called.
      await service.refresh(original);

      const [error] = await service.refresh(rotated!.refreshToken);
      expect(error).toBeInstanceOf(UnauthorizedError);

      const reasons = repository
        .peekRefreshTokens(registered.user.id)
        .map((token) => token.revokedReason);
      expect(reasons).toContain("REUSE_DETECTED");
    });

    it("rejects an unknown token", async () => {
      const [error] = await service.refresh("not-a-real-refresh-token-value");

      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("refuses to renew a session whose account was suspended", async () => {
      const { registered, verified } = await registerAndVerify();
      Object.assign(repository.peekAuthUser(registered.user.id)!, { status: "SUSPENDED" });

      const [error] = await service.refresh(verified.tokens.refreshToken);

      // Without this check a suspended account keeps renewing itself for the
      // full life of its refresh token and "suspend" does nothing.
      expect(error).toBeInstanceOf(ForbiddenError);
    });
  });

  describe("logout", () => {
    it("revokes the presented session", async () => {
      const { verified } = await registerAndVerify();

      const [error] = await service.logout(verified.tokens.refreshToken);
      expect(error).toBeNull();

      const [refreshError] = await service.refresh(verified.tokens.refreshToken);
      expect(refreshError).toBeInstanceOf(UnauthorizedError);
    });

    it("treats an unknown token as already logged out", async () => {
      const [error] = await service.logout("some-token-that-was-never-issued");

      // Idempotent: the caller's goal is "this must not work", and it does not.
      expect(error).toBeNull();
    });
  });

  describe("logoutAll", () => {
    it("ends every session for the account", async () => {
      const { registered } = await registerAndVerify();
      await service.login({ email: registration.email, password: PASSWORD });
      await service.login({ email: registration.email, password: PASSWORD });

      const [error, result] = await service.logoutAll(registered.user.id);

      expect(error).toBeNull();
      expect(result!.revoked).toBe(3);

      const [, sessions] = await service.listSessions(registered.user.id);
      expect(sessions).toHaveLength(0);
    });
  });

  // ---- Passwords ------------------------------------------------------------

  describe("forgotPassword / resetPassword", () => {
    it("resets the password and signs every device out", async () => {
      const { registered, verified } = await registerAndVerify();

      const [forgotError] = await service.forgotPassword({ email: registration.email });
      expect(forgotError).toBeNull();
      expect(emailClient.lastSource()).toBe("auth.password-reset");

      const code = emailClient.codeFor(registration.email);
      const [resetError] = await service.resetPassword({
        email: registration.email,
        code,
        password: "an-entirely-different-passphrase",
      });
      expect(resetError).toBeNull();

      // The session that existed before the reset is gone. A reset is usually
      // done *because* the account is compromised.
      const [refreshError] = await service.refresh(verified.tokens.refreshToken);
      expect(refreshError).toBeInstanceOf(UnauthorizedError);

      const [oldPasswordError] = await service.login({
        email: registration.email,
        password: PASSWORD,
      });
      expect(oldPasswordError).toBeInstanceOf(UnauthorizedError);

      const [newPasswordError] = await service.login({
        email: registration.email,
        password: "an-entirely-different-passphrase",
      });
      expect(newPasswordError).toBeNull();
      expect(repository.peekAuthUser(registered.user.id)?.failedLoginAttempts).toBe(0);
    });

    it("reports success for an unknown address without sending anything", async () => {
      const [error] = await service.forgotPassword({ email: "nobody@example.com" });

      expect(error).toBeNull();
      expect(emailClient.sent).toHaveLength(0);
    });

    it("rejects a reset code that was never issued", async () => {
      await registerAndVerify();

      const [error] = await service.resetPassword({
        email: registration.email,
        code: "123456",
        password: "an-entirely-different-passphrase",
      });

      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("will not let a verification code be used as a reset code", async () => {
      const [, registered] = await service.register(registration);
      const verificationCode = emailClient.codeFor(registration.email);

      const [error] = await service.resetPassword({
        email: registration.email,
        code: verificationCode,
        password: "an-entirely-different-passphrase",
      });

      // Codes are scoped to a type. Otherwise a code mailed to confirm an
      // address would also authorise taking the account over.
      expect(error).toBeInstanceOf(UnauthorizedError);
      expect(repository.peekAuthUser(registered!.user.id)?.verified).toBe(false);
    });
  });

  describe("changePassword", () => {
    it("requires the current password even with a valid session", async () => {
      const { registered } = await registerAndVerify();

      const [error] = await service.changePassword(registered.user.id, {
        currentPassword: "not-the-current-password",
        password: "an-entirely-different-passphrase",
      });

      // A token can be stolen; re-proving the password is what stops a stolen
      // one from becoming permanent control of the account.
      expect(error).toBeInstanceOf(UnauthorizedError);
    });

    it("signs other devices out but keeps the caller signed in", async () => {
      const { registered, verified } = await registerAndVerify();
      const [, otherDevice] = await service.login({
        email: registration.email,
        password: PASSWORD,
      });

      const [error, tokens] = await service.changePassword(registered.user.id, {
        currentPassword: PASSWORD,
        password: "an-entirely-different-passphrase",
      });

      expect(error).toBeNull();

      // The caller got a fresh pair that works...
      const [freshError] = await service.refresh(tokens!.refreshToken);
      expect(freshError).toBeNull();

      // ...and every session that existed beforehand does not.
      const [oldError] = await service.refresh(verified.tokens.refreshToken);
      expect(oldError).toBeInstanceOf(UnauthorizedError);
      const [otherError] = await service.refresh(otherDevice!.tokens.refreshToken);
      expect(otherError).toBeInstanceOf(UnauthorizedError);
    });

    it("notifies the address on file", async () => {
      const { registered } = await registerAndVerify();
      emailClient.reset();

      await service.changePassword(registered.user.id, {
        currentPassword: PASSWORD,
        password: "an-entirely-different-passphrase",
      });

      // How someone whose account was taken over finds out.
      expect(emailClient.lastSource()).toBe("auth.password-changed");
    });
  });

  // ---- Reads ----------------------------------------------------------------

  describe("listSessions", () => {
    it("marks the caller's own session", async () => {
      const { registered, verified } = await registerAndVerify();
      await service.login({ email: registration.email, password: PASSWORD });

      // `sid` in the access token is the family id of the session that minted it.
      const [, claims] = await import("../../src/lib/tokens.js").then((m) =>
        m.verifyAccessToken(verified.tokens.accessToken),
      );

      const [error, sessions] = await service.listSessions(registered.user.id, claims!.sid);

      expect(error).toBeNull();
      expect(sessions).toHaveLength(2);
      expect(sessions!.filter((session) => session.current)).toHaveLength(1);
    });
  });

  describe("listLoginHistory", () => {
    it("returns every session-creating event, not just explicit logins", async () => {
      const { registered } = await registerAndVerify();
      await service.login({ email: registration.email, password: "wrong-password-here" });
      await service.login({ email: registration.email, password: PASSWORD });

      const [error, page] = await service.listLoginHistory(registered.user.id, {
        page: 1,
        limit: 20,
      });

      expect(error).toBeNull();
      // Three: the sign-in that verification performed, the failed attempt,
      // and the successful one. Verification counts — it hands out a session,
      // and a session with no row here is one the user cannot account for.
      expect(page!.total).toBe(3);
      expect(page!.items.map((row) => row.outcome).sort()).toEqual([
        "INVALID_CREDENTIALS",
        "SUCCESS",
        "SUCCESS",
      ]);
    });

    it("filters by outcome", async () => {
      const { registered } = await registerAndVerify();
      await service.login({ email: registration.email, password: "wrong-password-here" });

      const [, page] = await service.listLoginHistory(registered.user.id, {
        page: 1,
        limit: 20,
        outcome: "INVALID_CREDENTIALS",
      });

      expect(page!.total).toBe(1);
    });
  });
});
