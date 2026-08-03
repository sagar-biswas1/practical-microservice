import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { checkDatabaseConnection, prisma } from "./lib/prisma.js";
import { PrismaUserRepository } from "./modules/user/user.repository.js";
import { UserService } from "./modules/user/user.service.js";

/** Composition root: the one place where concrete implementations are wired. */
function buildServer() {
  const userRepository = new PrismaUserRepository(prisma);
  const userService = new UserService(userRepository);

  return createApp({
    userService,
    checkReadiness: () => checkDatabaseConnection(prisma),
  });
}

/**
 * Drains in-flight requests, then closes the database pool. If either stalls,
 * the timeout forces exit so a stuck connection can't block a rolling deploy.
 */
function registerShutdownHandlers(server: Server): void {
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
      { host: env.HOST, port: env.PORT },
      `${env.SERVICE_NAME} listening on http://${env.HOST}:${env.PORT}`,
    );
  });

  server.on("error", (error) => {
    logger.fatal({ err: error }, "server_start_failed");
    process.exit(1);
  });

  registerShutdownHandlers(server);
}

start();
