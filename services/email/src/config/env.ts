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
 * Providers this build knows how to construct. Adding one means adding a
 * member here and a case in `providers/index.ts` — nothing else in the service
 * refers to a provider by name.
 */
export const EMAIL_PROVIDERS = ["resend", "console"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(4004),
    HOST: z.string().min(1).default("0.0.0.0"),
    SERVICE_NAME: z.string().min(1).default("email-service"),
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
    CORS_ORIGINS: z.string().default("*"),
    // Larger than the other services': an HTML email body is the payload here,
    // and 100kb would reject a fairly ordinary templated message.
    BODY_LIMIT: z.string().default("1mb"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    // ---- Provider ----------------------------------------------------------

    /**
     * `console` is the default because it is the only one that works with no
     * credentials. A production deploy that forgets to set this therefore
     * fails loudly in the logs rather than silently mailing real people from a
     * half-configured account.
     */
    EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default("console"),
    /** Sender address. Resend rejects any domain you have not verified. */
    EMAIL_FROM: z.string().min(3).max(320).default("onboarding@resend.dev"),
    EMAIL_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_BASE_URL: z.string().url().default("https://api.resend.com"),

    // ---- Message limits ----------------------------------------------------

    /**
     * Ceiling on the body, enforced in the request schema so an oversized
     * message is a 422 naming the field rather than a Postgres error.
     */
    EMAIL_MAX_BODY_CHARS: z.coerce.number().int().positive().default(100_000),
    /** Default attempt ceiling, copied onto each row as it is enqueued. */
    EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),

    // ---- Dispatcher --------------------------------------------------------

    /**
     * Set to `false` to run the dispatcher out of process (`pnpm dispatch`)
     * while the API stays a pure writer. Both modes use the same claim query,
     * so they can also run side by side.
     */
    DISPATCHER_ENABLED: z
      .string()
      .default("true")
      .transform((value) => value.trim().toLowerCase() !== "false"),
    DISPATCHER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
    /** Rows claimed per cycle. Bounded so one worker cannot starve the others. */
    DISPATCHER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
    /** Sends run concurrently within a batch, up to this many at a time. */
    DISPATCHER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    /**
     * How long a claim is honoured. A SENDING row still locked after this is
     * assumed to belong to a worker that died and is reclaimed. Must comfortably
     * exceed `EMAIL_PROVIDER_TIMEOUT_MS`, or a slow send gets sent twice.
     */
    DISPATCHER_CLAIM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

    /** First retry delay; each subsequent attempt doubles it, plus jitter. */
    RETRY_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(2_000),
    RETRY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(900_000),

    /**
     * Sent messages older than this are deleted. An outbox is a queue, not an
     * archive: left alone it accumulates millions of dead rows and the claim
     * index degrades with it. `0` disables the purge.
     */
    EMAIL_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  })
  .superRefine((value, ctx) => {
    if (value.EMAIL_PROVIDER === "resend" && !value.RESEND_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required when EMAIL_PROVIDER=resend",
      });
    }

    if (value.DISPATCHER_CLAIM_TIMEOUT_MS <= value.EMAIL_PROVIDER_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["DISPATCHER_CLAIM_TIMEOUT_MS"],
        message:
          "DISPATCHER_CLAIM_TIMEOUT_MS must exceed EMAIL_PROVIDER_TIMEOUT_MS, " +
          "otherwise an in-flight send can be reclaimed and delivered twice",
      });
    }
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
