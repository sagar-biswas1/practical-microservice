import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(currentDir, "../..");
const repoRoot = path.resolve(serviceRoot, "../..");

// Service-local .env wins; the repo-root .env is a fallback for shared values.
// dotenv never overwrites an already-defined variable, so load order == precedence.
dotenv.config({ path: path.join(serviceRoot, ".env"), quiet: true });
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });

/**
 * `.env` files routinely carry blanked-out keys. Treat an empty value as
 * absent so a blank line means "unset" rather than "invalid".
 */
const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4002),
  HOST: z.string().min(1).default("0.0.0.0"),
  SERVICE_NAME: z.string().min(1).default("inventory-service"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),
  /**
   * Serves `/docs` (Swagger UI) and `/openapi.json`.
   *
   * On by default: the document is generated from the same Zod schemas the
   * routes validate with, so "the docs went stale" is not a failure mode worth
   * defending against. Turn it off where the service surface should not be
   * enumerable by anyone who can reach the port.
   */
  DOCS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /** Comma-separated origin list, or `*` for all. */
  CORS_ORIGINS: z.string().default("*"),
  BODY_LIMIT: z.string().default("100kb"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * Setting this starts the stock-event consumer: the service connects at
   * boot, declares the `inventory` topology, and consumes `inventory.stock`.
   * It refuses to start if the first connection fails. Unset, no consumer
   * runs and stock changes arrive over HTTP only.
   *
   * A `?heartbeat=` query on the URL overrides RABBITMQ_HEARTBEAT_SECONDS.
   */
  RABBITMQ_URL: optionalString.refine(
    (value) => value === undefined || /^amqps?:\/\//.test(value),
    "RABBITMQ_URL must start with amqp:// or amqps://",
  ),
  /**
   * Unacked deliveries the broker may hand this consumer at once. Each one is
   * a serializable transaction against the stock table, so this is also the
   * consumer's write concurrency; keep it modest.
   */
  RABBITMQ_PREFETCH: z.coerce.number().int().positive().max(1_000).default(10),
  /** `0` disables heartbeats; a consumer without them may never notice a dead socket. */
  RABBITMQ_HEARTBEAT_SECONDS: z.coerce.number().int().nonnegative().max(3_600).default(30),
  RABBITMQ_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
  /** Cap on the backoff between reconnect attempts; retried forever. */
  RABBITMQ_MAX_RETRY_DELAY_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
  /**
   * Pause before a delivery that failed on something transient is handed
   * back. Without it a down database is spun on at full speed, prefetch
   * messages at a time.
   */
  RABBITMQ_REQUEUE_DELAY_MS: z.coerce.number().int().nonnegative().max(60_000).default(1_000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    // The logger itself depends on env, so this one case has to use console.
    console.error(`Invalid environment configuration:\n${details}`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const isDevelopment = env.NODE_ENV === "development";

/** Parsed CORS origins: `true` means reflect any origin. */
export const corsOrigins: string[] | true =
  env.CORS_ORIGINS.trim() === "*"
    ? true
    : env.CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
