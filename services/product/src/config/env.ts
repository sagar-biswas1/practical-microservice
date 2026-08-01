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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  HOST: z.string().min(1).default("0.0.0.0"),
  SERVICE_NAME: z.string().min(1).default("product-service"),
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
  /** Comma-separated origin list, or `*` for all. */
  CORS_ORIGINS: z.string().default("*"),
  BODY_LIMIT: z.string().default("100kb"),
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

/** Parsed CORS origins: `true` means reflect any origin. */
export const corsOrigins: string[] | true =
  env.CORS_ORIGINS.trim() === "*"
    ? true
    : env.CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
