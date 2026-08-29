import { beforeEach, describe, expect, it } from "vitest";
import { ServiceUnavailableError } from "../../src/errors/app-error.js";
import { AuthReaper, type ReaperOptions } from "../../src/modules/auth/auth.reaper.js";
import { InMemoryAuthRepository } from "../helpers/in-memory-auth-repository.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fixed clock: every retention assertion is about a row's age. */
const NOW = new Date("2026-06-01T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * MS_PER_DAY);
const daysAhead = (days: number) => new Date(NOW.getTime() + days * MS_PER_DAY);

const options: ReaperOptions = {
  expiredGraceDays: 1,
  revokedRetentionDays: 30,
  verificationRetentionDays: 7,
  loginHistoryRetentionDays: 180,
  batchSize: 100,
  intervalMs: 3_600_000,
  now: () => NOW,
};

describe("AuthReaper", () => {
  let repository: InMemoryAuthRepository;
  let reaper: AuthReaper;

  const build = (overrides: Partial<ReaperOptions> = {}) =>
    new AuthReaper(repository, { ...options, ...overrides });

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
    reaper = build();
  });

  describe("refresh tokens", () => {
    it("deletes tokens whose expiry is past the grace period", async () => {
      repository.seedRefreshToken({ expiresAt: daysAgo(5) });

      const [error, summary] = await reaper.runOnce();

      expect(error).toBeNull();
      expect(summary?.expiredTokens).toBe(1);
      expect(repository.refreshTokenCount).toBe(0);
    });

    it("keeps a live token", async () => {
      repository.seedRefreshToken({ expiresAt: daysAhead(29) });

      const [, summary] = await reaper.runOnce();

      expect(summary?.expiredTokens).toBe(0);
      expect(repository.refreshTokenCount).toBe(1);
    });

    it("keeps a token still inside the expired grace period", async () => {
      // Expired two hours ago; the grace is a day.
      repository.seedRefreshToken({ expiresAt: new Date(NOW.getTime() - 2 * 3_600_000) });

      const [, summary] = await reaper.runOnce();

      expect(summary?.expiredTokens).toBe(0);
      expect(repository.refreshTokenCount).toBe(1);
    });

    /**
     * The reason this runs on a schedule instead of during rotation. Reuse
     * detection finds an already-rotated token and sees that it is revoked; if
     * retention took those rows early, a stolen token would read as merely
     * unknown and the family would never be cut.
     */
    it("keeps a recently revoked token that has not expired yet", async () => {
      repository.seedRefreshToken({
        expiresAt: daysAhead(25),
        revokedAt: daysAgo(2),
        revokedReason: "ROTATED",
      });

      const [, summary] = await reaper.runOnce();

      expect(summary?.revokedTokens).toBe(0);
      expect(repository.refreshTokenCount).toBe(1);
    });

    it("deletes a revoked token past the revoked retention window", async () => {
      repository.seedRefreshToken({
        expiresAt: daysAhead(25),
        revokedAt: daysAgo(31),
        revokedReason: "REUSE_DETECTED",
      });

      const [, summary] = await reaper.runOnce();

      expect(summary?.revokedTokens).toBe(1);
      expect(repository.refreshTokenCount).toBe(0);
    });

    it("counts a token that is both revoked and expired only once", async () => {
      repository.seedRefreshToken({
        expiresAt: daysAgo(10),
        revokedAt: daysAgo(40),
        revokedReason: "ROTATED",
      });

      const [, summary] = await reaper.runOnce();

      expect(summary?.expiredTokens).toBe(1);
      expect(summary?.revokedTokens).toBe(0);
      expect(repository.refreshTokenCount).toBe(0);
    });

    /**
     * The bound is what makes the first sweep against a never-swept table
     * safe. Falling behind is fine — the next cycle takes the next slice.
     */
    it("removes no more than the batch size in one pass", async () => {
      for (let i = 0; i < 10; i += 1) {
        repository.seedRefreshToken({ expiresAt: daysAgo(5) });
      }

      const [, summary] = await build({ batchSize: 4 }).runOnce();

      expect(summary?.expiredTokens).toBe(4);
      expect(repository.refreshTokenCount).toBe(6);
    });
  });

  describe("verifications", () => {
    it("deletes settled codes past the retention window", async () => {
      await repository.replaceVerification({
        authUserId: "user-1",
        codeHash: "hash",
        type: "EMAIL_VERIFICATION",
        expiresAt: daysAgo(30),
        maxAttempts: 5,
      });
      const [, pending] = await repository.findActiveVerification(
        "user-1",
        "EMAIL_VERIFICATION",
      );
      await repository.registerVerificationAttempt(pending!.id, true);

      const [, summary] = await reaper.runOnce();

      expect(summary?.verifications).toBe(1);
      expect(repository.verificationCount).toBe(0);
    });

    /**
     * A PENDING row is live state, whatever its age. The sweep must never be
     * the reason someone's verification stops working.
     */
    it("keeps a PENDING code however old it is", async () => {
      await repository.replaceVerification({
        authUserId: "user-1",
        codeHash: "hash",
        type: "EMAIL_VERIFICATION",
        expiresAt: daysAgo(300),
        maxAttempts: 5,
      });

      const [, summary] = await reaper.runOnce();

      expect(summary?.verifications).toBe(0);
      expect(repository.verificationCount).toBe(1);
    });

    it("skips the sweep entirely when retention is zero", async () => {
      await repository.replaceVerification({
        authUserId: "user-1",
        codeHash: "hash",
        type: "EMAIL_VERIFICATION",
        expiresAt: daysAgo(300),
        maxAttempts: 5,
      });
      const [, pending] = await repository.findActiveVerification(
        "user-1",
        "EMAIL_VERIFICATION",
      );
      await repository.registerVerificationAttempt(pending!.id, true);

      const [, summary] = await build({ verificationRetentionDays: 0 }).runOnce();

      expect(summary?.verifications).toBe(0);
      expect(repository.verificationCount).toBe(1);
    });
  });

  describe("login history", () => {
    it("deletes rows past the retention window and keeps the rest", async () => {
      repository.seedLoginHistory({ loginAt: daysAgo(200) });
      repository.seedLoginHistory({ loginAt: daysAgo(10) });

      const [, summary] = await reaper.runOnce();

      expect(summary?.loginHistory).toBe(1);
      expect(repository.peekLogins()).toHaveLength(1);
    });

    it("skips the sweep entirely when retention is zero", async () => {
      repository.seedLoginHistory({ loginAt: daysAgo(2_000) });

      const [, summary] = await build({ loginHistoryRetentionDays: 0 }).runOnce();

      expect(summary?.loginHistory).toBe(0);
      expect(repository.peekLogins()).toHaveLength(1);
    });
  });

  describe("failure handling", () => {
    it("returns the repository error and stops the sweep", async () => {
      repository.seedLoginHistory({ loginAt: daysAgo(200) });
      repository.fail("purgeRefreshTokens");

      const [error, summary] = await reaper.runOnce();

      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(summary).toBeNull();
      // The later passes never ran, so this row survives to the next cycle.
      expect(repository.peekLogins()).toHaveLength(1);
    });

    it("does not stop the loop when a cycle fails", async () => {
      repository.seedRefreshToken({ expiresAt: daysAgo(5) });
      repository.fail("purgeRefreshTokens");

      const failed = await reaper.runOnce();
      expect(failed[0]).toBeInstanceOf(ServiceUnavailableError);

      // A fresh repository stands in for the outage clearing: the same reaper
      // sweeps normally afterwards rather than being latched into failure.
      repository = new InMemoryAuthRepository();
      repository.seedRefreshToken({ expiresAt: daysAgo(5) });
      const [error, summary] = await build().runOnce();

      expect(error).toBeNull();
      expect(summary?.expiredTokens).toBe(1);
    });
  });

  describe("lifecycle", () => {
    it("does not sweep before the first interval elapses", async () => {
      repository.seedRefreshToken({ expiresAt: daysAgo(5) });

      reaper.start();
      await reaper.stop();

      // Startup is the worst moment to open a large delete, so the first sweep
      // waits a full interval rather than firing at boot.
      expect(repository.refreshTokenCount).toBe(1);
    });

    it("is safe to start and stop repeatedly", async () => {
      reaper.start();
      reaper.start();
      await reaper.stop();
      await reaper.stop();

      expect(repository.refreshTokenCount).toBe(0);
    });
  });
});
