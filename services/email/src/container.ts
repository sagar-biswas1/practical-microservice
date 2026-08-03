import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { EmailDispatcher } from "./modules/email/email.dispatcher.js";
import { PrismaEmailRepository } from "./modules/email/email.repository.js";
import { EmailService } from "./modules/email/email.service.js";
import { createEmailProvider } from "./providers/index.js";
import type { EmailProvider } from "./providers/email-provider.js";

export interface Container {
  repository: PrismaEmailRepository;
  service: EmailService;
  provider: EmailProvider;
  dispatcher: EmailDispatcher;
}

/**
 * Composition root: the one place concrete implementations are chosen.
 *
 * Shared by both entrypoints. `server.ts` runs the API with the dispatcher
 * alongside it; `dispatch.ts` runs the dispatcher on its own. Because the two
 * are assembled identically, moving delivery out of the API process is a
 * deployment decision rather than a code change — and the claim query is safe
 * with any number of workers, so they can also run at the same time.
 */
export function buildContainer(): Container {
  const repository = new PrismaEmailRepository(prisma);
  const service = new EmailService(repository, { maxAttempts: env.EMAIL_MAX_ATTEMPTS });
  const provider = createEmailProvider();

  const dispatcher = new EmailDispatcher(repository, provider, {
    from: env.EMAIL_FROM,
    batchSize: env.DISPATCHER_BATCH_SIZE,
    concurrency: env.DISPATCHER_CONCURRENCY,
    pollIntervalMs: env.DISPATCHER_POLL_INTERVAL_MS,
    claimTimeoutMs: env.DISPATCHER_CLAIM_TIMEOUT_MS,
    backoffBaseMs: env.RETRY_BACKOFF_BASE_MS,
    backoffMaxMs: env.RETRY_BACKOFF_MAX_MS,
    retentionDays: env.EMAIL_RETENTION_DAYS,
  });

  return { repository, service, provider, dispatcher };
}
