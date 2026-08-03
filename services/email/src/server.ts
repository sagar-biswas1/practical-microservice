import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { buildContainer } from "./container.js";
import { logger } from "./lib/logger.js";
import { checkDatabaseConnection, prisma } from "./lib/prisma.js";
import type { EmailDispatcher } from "./modules/email/email.dispatcher.js";

const { service, provider, dispatcher } = buildContainer();

function buildServer() {
  return createApp({
    emailService: service,
    dispatcher,
    checkReadiness: () => checkDatabaseConnection(prisma),
  });
}

/**
 * Drains in-flight requests, stops the dispatcher, then closes the database
 * pool. If any of that stalls, the timeout forces exit so a stuck connection
 * can't block a rolling deploy.
 *
 * The dispatcher is stopped *after* the HTTP server so a request accepted at
 * the last moment still has its row committed before the process goes; and it
 * is awaited rather than killed, so a send already in flight gets the chance
 * to record its outcome instead of being reclaimed and repeated later.
 */
function registerShutdownHandlers(server: Server, worker: EmailDispatcher): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "shutdown_started");

    const forceExit = setTimeout(() => {
      logger.fatal({ signal }, "shutdown_timed_out");
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await worker.stop();
      await prisma.$disconnect();
      logger.info("shutdown_complete");
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "shutdown_failed");
      process.exit(1);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // A rejection or exception that reaches here means state is unknown —
  // log it and let the orchestrator restart a clean process.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled_rejection");
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught_exception");
    void shutdown("uncaughtException");
  });
}

function start(): void {
  const app = buildServer();

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { host: env.HOST, port: env.PORT, provider: provider.name },
      `${env.SERVICE_NAME} listening on http://${env.HOST}:${env.PORT}`,
    );
  });

  server.on("error", (error) => {
    logger.fatal({ err: error }, "server_start_failed");
    process.exit(1);
  });

  if (env.DISPATCHER_ENABLED) {
    dispatcher.start();
  } else {
    logger.warn(
      "DISPATCHER_ENABLED=false — messages will be queued but not sent until " +
        "`pnpm dispatch` runs or POST /api/v1/emails/dispatch is called",
    );
  }

  registerShutdownHandlers(server, dispatcher);
}

start();
