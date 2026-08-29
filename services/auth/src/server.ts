import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { buildContainer } from "./container.js";
import { logger } from "./lib/logger.js";
import { checkDatabaseConnection, prisma } from "./lib/prisma.js";
import type { AuthReaper } from "./modules/auth/auth.reaper.js";

const { service, reaper } = buildContainer();

function buildServer() {
  return createApp({
    authService: service,
    checkReadiness: () => checkDatabaseConnection(prisma),
  });
}

/**
 * Drains in-flight requests, stops the retention sweep, then closes the
 * database pool. If any of that stalls, the timeout forces exit so a stuck
 * connection can't block a rolling deploy.
 *
 * The reaper is stopped after the HTTP server, and awaited rather than killed,
 * so a bounded delete already in flight commits instead of being cut off — a
 * sweep interrupted mid-statement would roll back and repeat the same slice on
 * the next instance anyway.
 */
function registerShutdownHandlers(server: Server, worker: AuthReaper): void {
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
      { host: env.HOST, port: env.PORT },
      `${env.SERVICE_NAME} listening on http://${env.HOST}:${env.PORT}`,
    );
  });

  server.on("error", (error) => {
    logger.fatal({ err: error }, "server_start_failed");
    process.exit(1);
  });

  registerShutdownHandlers(server, reaper);

  // Off when a scheduler drives `runOnce` instead — see `reap.ts`.
  if (env.REAPER_ENABLED) reaper.start();
}

start();
