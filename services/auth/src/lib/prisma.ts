import { PrismaClient } from "../generated/prisma/client.js";
import { env, isProduction } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Single PrismaClient per process. In dev, `tsx watch` reloads the module
 * graph on every change, so the instance is cached on globalThis to avoid
 * exhausting the connection pool with orphaned clients.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    datasourceUrl: env.DATABASE_URL,
    log: isProduction
      ? [{ emit: "event", level: "error" }, { emit: "event", level: "warn" }]
      : [
          { emit: "event", level: "query" },
          { emit: "event", level: "info" },
          { emit: "event", level: "warn" },
          { emit: "event", level: "error" },
        ],
  });

  client.$on("error", (event) => logger.error({ prisma: event }, "prisma_error"));
  client.$on("warn", (event) => logger.warn({ prisma: event }, "prisma_warning"));

  if (!isProduction) {
    client.$on("query", (event) => {
      logger.debug(
        { query: event.query, params: event.params, durationMs: event.duration },
        "prisma_query",
      );
    });
  }

  return client;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) globalForPrisma.prisma = prisma;

/** Readiness probe: fails fast if the database is unreachable. */
export async function checkDatabaseConnection(client: PrismaClient = prisma): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}

export type { PrismaClient };
