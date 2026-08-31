import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(currentDir, "../..");
// The gateway sits at the repo root, one level up — unlike `services/*`.
const repoRoot = path.resolve(serviceRoot, "..");

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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),
  SERVICE_NAME: z.string().min(1).default("api-gateway"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  /** Upstreams. The gateway is stateless — it owns no database. */
  PRODUCT_SERVICE_URL: upstreamUrl("http://localhost:4001"),
  INVENTORY_SERVICE_URL: upstreamUrl("http://localhost:4002"),
  USER_SERVICE_URL: upstreamUrl("http://localhost:4003"),
  EMAIL_SERVICE_URL: upstreamUrl("http://localhost:4004"),
  AUTH_SERVICE_URL: upstreamUrl("http://localhost:4005"),

  /**
   * Verification key for the access tokens the auth service mints. It must be
   * byte-identical to that service's `JWT_SECRET`, and the issuer/audience
   * must match too — otherwise every token the gateway sees looks forged.
   *
   * Required rather than optional on purpose. An optional secret gives the
   * gateway a mode where the edge policies silently degrade to "let everything
   * through", and a security control that can be disabled by omission is not a
   * control. Verification is pure computation — no call to the auth service.
   */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().min(1).default("auth-service"),
  JWT_AUDIENCE: z.string().min(1).default("practical-microservice"),

  /**
   * How long an upstream has to respond before the gateway gives up and
   * returns 504. Must exceed the product service's own INVENTORY_TIMEOUT_MS
   * (3s by default), otherwise the gateway cuts off a request the product
   * service was still legitimately working on.
   */
  PROXY_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  /** Budget for a single upstream liveness probe on `/health/ready`. */
  HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(2_000),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  /**
   * A second, much tighter budget applied only to the credential endpoints —
   * login, registration, password reset, token refresh. Those are the routes
   * where a request is worth guessing at scale, and the general ceiling of 300
   * per minute is far too generous to slow an online password attack down.
   *
   * One bucket covers all of them together, so rotating between `/login` and
   * `/forgot-password` does not buy an attacker a fresh allowance.
   */
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  /**
   * When false (the default), an inbound `x-actor-id` is discarded before
   * proxying so a client cannot forge the identity that downstream audit logs
   * attribute writes to.
   *
   * On a route the edge authenticates, the header is set from the verified
   * token regardless of this flag — a proven identity always wins over a
   * claimed one. This only decides what happens on the unauthenticated routes,
   * and the honest answer there is "nothing you say about who you are".
   */
  TRUST_CLIENT_ACTOR: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * Express `trust proxy` setting, which decides whether `X-Forwarded-For` is
   * believed and therefore what `req.ip` — the rate limiter's key — resolves
   * to. Accepts `false`, a hop count (`1`), or an address list/preset
   * (`loopback`, `10.0.0.0/8`, ...).
   *
   * Defaults to `loopback` rather than `true`: trusting every hop lets any
   * client forge the header and hand itself a fresh rate-limit bucket. Set it
   * to the number of proxies actually in front of this process.
   */
  TRUST_PROXY: z.string().default("loopback"),
  /** Comma-separated origin list, or `*` for all. */
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
  /**
   * Largest request body the gateway will forward, in bytes. Sized above the
   * upstreams' own `BODY_LIMIT` (100kb) on purpose: this is a blunt edge
   * guard, and the service that understands the payload does the precise
   * rejecting. Default 1 MiB.
   */
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
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

/**
 * `TRUST_PROXY` in the shape Express expects. A bare `true` is honoured but
 * deliberately not the default — see the schema comment.
 */
export const trustProxy: boolean | number | string = (() => {
  const raw = env.TRUST_PROXY.trim();
  if (raw === "true") return true;
  if (raw === "false") return false;

  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : raw;
})();

/** Parsed CORS origins: `true` means reflect any origin. */
export const corsOrigins: string[] | true =
  env.CORS_ORIGINS.trim() === "*"
    ? true
    : env.CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
