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

/** Strips trailing slashes so `${base}${path}` never produces a double slash. */
const upstreamUrl = (fallback: string) =>
  z
    .url("must be an absolute http(s) URL")
    .default(fallback)
    .transform((value) => value.replace(/\/+$/, ""));

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4005),
    HOST: z.string().min(1).default("0.0.0.0"),
    SERVICE_NAME: z.string().min(1).default("auth-service"),
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
    CORS_ORIGINS: z.string().default("*"),
    BODY_LIMIT: z.string().default("100kb"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    // ---- Access tokens -------------------------------------------------------

    /**
     * HS256 signing key for access tokens.
     *
     * Required, with no default, in every environment including development.
     * A fallback here would be the single most dangerous line in the repo: a
     * deploy that forgets to set it would come up healthy and sign real tokens
     * with a key published on GitHub. Failing to boot is the correct outcome.
     *
     * 32 bytes is the minimum for HS256 to actually deliver its nominal
     * strength — a shorter key is padded, not strengthened.
     */
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

    /**
     * Written to `iss`/`aud` and checked on every verification. They are what
     * stops a token minted by a *different* system that happens to share the
     * secret — a staging environment, another service reusing the key — from
     * being accepted here.
     */
    JWT_ISSUER: z.string().min(1).default("auth-service"),
    JWT_AUDIENCE: z.string().min(1).default("practical-microservice"),

    /**
     * Access tokens are not revocable — nothing checks a database when one is
     * verified, which is the entire reason they are fast. The window in which
     * a stolen one still works is therefore exactly this value, so it is kept
     * short and the refresh token carries the long-lived authority.
     */
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
    /** How long one session survives without a refresh before requiring login. */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    // ---- Password hashing ----------------------------------------------------

    /**
     * Argon2id cost parameters. The defaults are OWASP's second recommended
     * configuration (19 MiB, t=2, p=1), which is a deliberate middle ground:
     * high enough to make offline cracking expensive, low enough that a login
     * on a small container stays well under a second.
     *
     * Raising these later is safe and needs no migration — the parameters are
     * encoded in each stored digest, so old hashes keep verifying with the
     * settings they were made under.
     */
    ARGON2_MEMORY_COST_KIB: z.coerce.number().int().min(8_192).default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

    /**
     * NIST SP 800-63B: length is the control that matters, composition rules
     * ("must contain a symbol") mostly produce `Password1!` and a sticky note.
     * The schema enforces this floor and a common-password check, nothing more.
     */
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(10),
    PASSWORD_MAX_LENGTH: z.coerce.number().int().min(64).max(1_024).default(128),

    // ---- Verification codes --------------------------------------------------

    VERIFICATION_CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
    /** Wrong guesses before the code is burned and a new one must be requested. */
    VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /**
     * Minimum gap between resend requests. Without it, "resend code" is an
     * open relay for mailing an arbitrary address as fast as HTTP allows.
     */
    VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),

    // ---- Lockout -------------------------------------------------------------

    /** Consecutive failures before the account stops accepting logins. */
    MAX_FAILED_LOGIN_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
    /**
     * How long that lock lasts. Bounded rather than permanent on purpose: a
     * lock that only an operator can clear hands anyone who knows an email
     * address a way to lock its owner out on demand.
     */
    ACCOUNT_LOCK_DURATION_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),

    // ---- Retention sweep -----------------------------------------------------

    /**
     * Runs the background reaper inside this process.
     *
     * Set `false` on the API instances when the sweep is driven by a real
     * scheduler instead (`pnpm --filter @services/auth reap` as a CronJob).
     * Both paths call the same `runOnce`, so the retention policy does not
     * change with the deployment shape — only who triggers it.
     */
    REAPER_ENABLED: z
      .string()
      .default("true")
      .transform((value) => value.trim().toLowerCase() !== "false"),
    /** Gap between sweeps. Hourly is far more often than the growth requires. */
    REAPER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(3_600_000),
    /**
     * Rows deleted per table per sweep. Bounded so the first run against a
     * table that has never been swept cannot lock up the pool serving logins;
     * it simply takes several cycles to catch up.
     */
    REAPER_BATCH_SIZE: z.coerce.number().int().min(1).max(50_000).default(5_000),

    /**
     * Grace period before an *expired* refresh token is deleted. Past its
     * `expiresAt` the row can never be accepted again, so this only keeps the
     * recent past readable while debugging a session that ended.
     */
    REFRESH_TOKEN_EXPIRED_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(1),
    /**
     * How long a *revoked* refresh token is kept. Deliberately longer than the
     * expired grace: a `REUSE_DETECTED` family is the only record this service
     * keeps that a session was stolen.
     */
    REFRESH_TOKEN_REVOKED_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(0)
      .max(365)
      .default(30),
    /** How long a settled verification code is kept. `0` disables that sweep. */
    VERIFICATION_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(7),
    /**
     * How long login history is kept. `0` disables that sweep — the right
     * setting when retention is dictated by a policy that lives elsewhere.
     */
    LOGIN_HISTORY_RETENTION_DAYS: z.coerce.number().int().min(0).max(3_650).default(180),

    // ---- Downstream services -------------------------------------------------

    /** Sends verification and password-reset mail. */
    EMAIL_SERVICE_URL: upstreamUrl("http://localhost:4004"),
    EMAIL_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3_000),

    /** Holds the profile created once an account verifies. */
    USER_SERVICE_URL: upstreamUrl("http://localhost:4003"),
    USER_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3_000),

    // ---- Outbound mail content -----------------------------------------------

    /** Product name in the subject and body of the mail this service sends. */
    APP_NAME: z.string().min(1).max(100).default("Practical Microservice"),
  })
  .superRefine((value, ctx) => {
    if (value.PASSWORD_MIN_LENGTH > value.PASSWORD_MAX_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["PASSWORD_MIN_LENGTH"],
        message: "PASSWORD_MIN_LENGTH cannot exceed PASSWORD_MAX_LENGTH",
      });
    }

    // A refresh token that outlives its access token by less than one TTL
    // means a client can be logged out mid-session through no fault of its own.
    const accessDays = value.ACCESS_TOKEN_TTL_MINUTES / (60 * 24);
    if (value.REFRESH_TOKEN_TTL_DAYS <= accessDays) {
      ctx.addIssue({
        code: "custom",
        path: ["REFRESH_TOKEN_TTL_DAYS"],
        message:
          "REFRESH_TOKEN_TTL_DAYS must exceed ACCESS_TOKEN_TTL_MINUTES, otherwise a session " +
          "expires before the access token it issued does",
      });
    }

    // The reaper holds revoked tokens for one window and merely expired ones
    // for another. Set the revoked window shorter and the intent inverts: the
    // record of a stolen session becomes the *first* thing deleted, while rows
    // that were only ever going to time out harmlessly are kept longer.
    if (
      value.REFRESH_TOKEN_REVOKED_RETENTION_DAYS < value.REFRESH_TOKEN_EXPIRED_GRACE_DAYS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["REFRESH_TOKEN_REVOKED_RETENTION_DAYS"],
        message:
          "REFRESH_TOKEN_REVOKED_RETENTION_DAYS must be at least " +
          "REFRESH_TOKEN_EXPIRED_GRACE_DAYS — a revoked token is the audit record of a " +
          "session that was cut short, and should outlive one that merely timed out",
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
