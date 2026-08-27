import { HttpEmailClient } from "./clients/email.client.js";
import { HttpUserClient } from "./clients/user.client.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { PrismaAuthRepository } from "./modules/auth/auth.repository.js";
import { AuthService } from "./modules/auth/auth.service.js";
import type { EmailClient } from "./clients/email.client.js";
import type { UserClient } from "./clients/user.client.js";

export interface Container {
  repository: PrismaAuthRepository;
  service: AuthService;
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

  return { repository, service, emailClient, userClient };
}
