import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Compiled output lives in dist/config, sources in src/config — both are two
// levels below the service root, so the same resolution works either way.
const serviceRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(serviceRoot, '../..');

// Service-local .env wins; the repo-root .env is a fallback for shared values.
// dotenv never overwrites an already-defined variable, so load order == precedence.
dotenv.config({ path: path.join(serviceRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

/**
 * `.env` files routinely carry blanked-out keys (`REDIS_PASSWORD=`). Treat an
 * empty value as absent so a blank line means "unset" rather than "invalid".
 */
const optionalString = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4006),
  SERVICE_NAME: z.string().min(1).default('cart-service'),

  /**
   * Full connection string. When set it wins over the discrete REDIS_* fields
   * below, which then only serve as documentation of the same values.
   * `rediss://` selects TLS without needing REDIS_TLS.
   */
  REDIS_URL: optionalString.refine(
    (value) => value === undefined || /^rediss?:\/\//.test(value),
    'REDIS_URL must start with redis:// or rediss://',
  ),
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_USERNAME: optionalString,
  REDIS_PASSWORD: optionalString,
  REDIS_DB: z.coerce.number().int().min(0).default(0),
  /** Ignored when REDIS_URL already uses the rediss:// scheme. */
  REDIS_TLS: booleanFlag.default(false),
  /**
   * Namespaces every key this service touches so a shared Redis stays
   * readable. Applied to both clients so a stream written by one is read
   * under the same name by the other. Pub/sub channel names are never
   * prefixed by ioredis — see redis.constants.ts.
   */
  REDIS_KEY_PREFIX: z.string().default('cart:'),
  /**
   * Cap on the backoff between reconnect attempts. Reconnects are retried
   * forever; a cart that cannot reach Redis should recover on its own once
   * Redis comes back rather than needing a restart.
   */
  REDIS_MAX_RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(2_000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    // Nest's logger is not up yet at import time, so this one case uses console.
    console.error(`Invalid environment configuration:\n${details}`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';
