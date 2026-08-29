import { buildContainer } from "./container.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

/**
 * Standalone retention sweep — one pass, then exit.
 *
 * Run as a scheduled job (`pnpm --filter @services/auth reap`) with
 * `REAPER_ENABLED=false` on the API instances, when a deployment would rather
 * its request-serving processes did no housekeeping. The policy is identical
 * either way: this calls the same `runOnce` the in-process loop does, so which
 * one is used is purely an operational choice.
 *
 * One pass, not a loop, because the point of running it under a scheduler is
 * that the scheduler owns the cadence. A sweep that is behind — the first few
 * against a table that has never been swept will be — catches up over
 * consecutive runs rather than by looping here, which keeps each invocation
 * bounded and lets the job be killed at any point without leaving anything
 * half-done.
 *
 * The exit code matters: a failed sweep exits non-zero so the scheduler
 * records the run as failed rather than silently succeeding while the table
 * keeps growing.
 */
const { reaper } = buildContainer();

async function main(): Promise<void> {
  logger.info("reap_started");

  const [error, summary] = await reaper.runOnce();

  await prisma.$disconnect();

  if (error) {
    logger.error({ err: error }, "reap_failed");
    process.exit(1);
  }

  logger.info(summary, "reap_complete");
  process.exit(0);
}

void main();
