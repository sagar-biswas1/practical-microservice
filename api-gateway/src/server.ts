import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { serviceRegistry } from "./config/services.js";
import { logger } from "./lib/logger.js";

/**
 * Drains in-flight requests before exiting. The gateway holds no connection
 * pool of its own, so the only thing to wait for is proxied traffic finishing;
 * the timeout forces exit if an upstream never completes a response.
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
  const app = createApp();

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      {
        host: env.HOST,
        port: env.PORT,
        upstreams: serviceRegistry.map(({ name, prefix, target }) => ({
          name,
          prefix,
          target,
        })),
      },
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
