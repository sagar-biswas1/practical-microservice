import { env } from "./config/env.js";
import { buildContainer } from "./container.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

/**
 * Standalone dispatcher process — the outbox relay with no HTTP server.
 *
 * Run this (`pnpm --filter @services/email dispatch`) with
 * `DISPATCHER_ENABLED=false` on the API instances to separate accepting mail
 * from sending it. Worth doing once traffic justifies it: the two have very
 * different shapes, since the API is a short database write and the relay is
 * dominated by waiting on a third party, and separating them lets each scale
 * on its own. Several of these can run at once; the claim query hands each row
 * to exactly one of them.
 */
const { provider, dispatcher } = buildContainer();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "dispatcher_shutdown_started");

  const forceExit = setTimeout(() => {
    logger.fatal({ signal }, "dispatcher_shutdown_timed_out");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Lets the cycle in flight record its outcome. Rows it never reaches stay
    // claimed until the lock goes stale, then another worker picks them up.
    await dispatcher.stop();
    await prisma.$disconnect();
    logger.info("dispatcher_shutdown_complete");
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "dispatcher_shutdown_failed");
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled_rejection");
  void shutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught_exception");
  void shutdown("uncaughtException");
});

logger.info(
  { workerId: dispatcher.id, provider: provider.name },
  "standalone dispatcher starting",
);

dispatcher.start();

// `start()` schedules with an unref'd timer so it never holds the loop open on
// its own. This process has nothing else keeping it alive, so it needs one
// handle that does — otherwise Node exits immediately with nothing to do.
const keepAlive = setInterval(() => {}, 1 << 30);
process.on("exit", () => clearInterval(keepAlive));
