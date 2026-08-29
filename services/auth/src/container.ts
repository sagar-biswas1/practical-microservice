import { HttpEmailClient } from "./clients/email.client.js";
import { HttpUserClient } from "./clients/user.client.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { AuthReaper } from "./modules/auth/auth.reaper.js";
import { PrismaAuthRepository } from "./modules/auth/auth.repository.js";
import { AuthService } from "./modules/auth/auth.service.js";
import type { EmailClient } from "./clients/email.client.js";
import type { UserClient } from "./clients/user.client.js";

export interface Container {
  repository: PrismaAuthRepository;
  service: AuthService;
  reaper: AuthReaper;
  emailClient: EmailClient;
  userClient: UserClient;
}

/**
 * Composition root: the one place concrete implementations are chosen.
 *
 * The service is handed interfaces — `AuthRepository`, `EmailClient`,
 * `UserClient` — and never learns which is which. That is what lets the tests
 * exercise the whole HTTP stack against in-memory doubles with no database and
 * no other service running, and it is why the policy above (lockouts, code
 * lifetimes, enumeration behaviour) can be tested at all without a Postgres
 * container in the loop.
 */
export function buildContainer(): Container {
  const repository = new PrismaAuthRepository(prisma);
  const emailClient = new HttpEmailClient();
  const userClient = new HttpUserClient();

  const service = new AuthService(repository, emailClient, userClient, {
    verificationTtlMinutes: env.VERIFICATION_CODE_TTL_MINUTES,
    verificationMaxAttempts: env.VERIFICATION_MAX_ATTEMPTS,
    resendCooldownSeconds: env.VERIFICATION_RESEND_COOLDOWN_SECONDS,
    maxFailedLoginAttempts: env.MAX_FAILED_LOGIN_ATTEMPTS,
    lockDurationMinutes: env.ACCOUNT_LOCK_DURATION_MINUTES,
  });

  // Handed the repository, not the service: retention is a property of the
  // storage this service owns, and none of it goes through auth policy.
  const reaper = new AuthReaper(repository, {
    expiredGraceDays: env.REFRESH_TOKEN_EXPIRED_GRACE_DAYS,
    revokedRetentionDays: env.REFRESH_TOKEN_REVOKED_RETENTION_DAYS,
    verificationRetentionDays: env.VERIFICATION_RETENTION_DAYS,
    loginHistoryRetentionDays: env.LOGIN_HISTORY_RETENTION_DAYS,
    batchSize: env.REAPER_BATCH_SIZE,
    intervalMs: env.REAPER_INTERVAL_MS,
  });

  return { repository, service, reaper, emailClient, userClient };
}
