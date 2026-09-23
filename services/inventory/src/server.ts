import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { checkDatabaseConnection, prisma } from "./lib/prisma.js";
import { INVENTORY_STOCK_QUEUE, INVENTORY_TOPOLOGY } from "./messaging/inventory-events.js";
import { RabbitMqConsumer } from "./messaging/rabbitmq.consumer.js";
import { StockEventConsumer } from "./modules/inventory/inventory.consumer.js";
import { PrismaInventoryRepository } from "./modules/inventory/inventory.repository.js";
import { InventoryService } from "./modules/inventory/inventory.service.js";

/** Composition root: the one place where concrete implementations are wired. */
function buildServer() {
  const inventoryRepository = new PrismaInventoryRepository(prisma);
  const inventoryService = new InventoryService(inventoryRepository);
  const consumer = buildConsumer(inventoryService);

  const app = createApp({
    inventoryService,
    checkReadiness: () => checkDatabaseConnection(prisma),
    ...(consumer ? { brokerStatus: () => consumer.status() } : {}),
  });

  return { app, consumer };
}

/**
 * The broker-facing entry point, beside the HTTP one. Same service, same
 * transactions, same strictness; only the transport differs. Absent unless
 * RABBITMQ_URL is set.
 */
function buildConsumer(inventoryService: InventoryService): RabbitMqConsumer | null {
  if (!env.RABBITMQ_URL) return null;

  const events = new StockEventConsumer(inventoryService, logger);

  return new RabbitMqConsumer({
    url: env.RABBITMQ_URL,
    queue: INVENTORY_STOCK_QUEUE,
    topology: INVENTORY_TOPOLOGY,
    handler: (message) => events.handle(message),
    logger,
    connectionName: `${env.SERVICE_NAME}:consumer`,
    prefetch: env.RABBITMQ_PREFETCH,
    heartbeatSeconds: env.RABBITMQ_HEARTBEAT_SECONDS,
    connectTimeoutMs: env.RABBITMQ_CONNECT_TIMEOUT_MS,
    maxRetryDelayMs: env.RABBITMQ_MAX_RETRY_DELAY_MS,
    requeueDelayMs: env.RABBITMQ_REQUEUE_DELAY_MS,
  });
}

/**
 * Drains in-flight requests, stops taking deliveries and lets the handlers
 * already running settle, then closes the database pool — in that order,
 * because a handler mid-flight still needs the database. If any step stalls,
 * the timeout forces exit so a stuck connection can't block a rolling deploy.
 */
function registerShutdownHandlers(server: Server, consumer: RabbitMqConsumer | null): void {
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
      await consumer?.stop();
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

async function start(): Promise<void> {
  const { app, consumer } = buildServer();

  // Before listening, so a broker this service cannot reach fails the boot
  // with a clear error rather than a port that answers and a queue nobody
  // drains. Later losses reconnect on their own.
  if (consumer) {
    try {
      await consumer.start();
    } catch (error) {
      logger.fatal({ err: error }, "broker_consumer_start_failed");
      process.exit(1);
    }
  }

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

  registerShutdownHandlers(server, consumer);
}

void start();
