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
   * The inventory service, called directly rather than through the gateway.
   * The gateway's stock-mutation policy is admin-only and exists to keep
   * end users off these endpoints; this is service-to-service traffic on the
   * internal network, the same way the product service reaches inventory.
   */
  INVENTORY_SERVICE_URL: z.url().default('http://localhost:4002'),
  /**
   * A cart creation blocks on this call, so the budget is a shopper's
   * patience, not a batch job's. Inventory answers from a single indexed
   * transaction; anything beyond this is a stall, not slowness.
   */
  INVENTORY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(30_000)
    .default(5_000),

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
  /**
   * Whether to issue `CONFIG SET notify-keyspace-events` at startup.
   *
   * Turn it off where the command is denied — managed Redis usually forbids
   * it — and set the flags on the server instead. The release path degrades
   * to the sweeper rather than breaking, so this is a latency knob, not a
   * correctness one.
   */
  REDIS_CONFIGURE_NOTIFICATIONS: booleanFlag.default(true),

  /**
   * How long a cart survives without being touched. The window slides: every
   * read or write of the session pushes it out again.
   *
   * This is also how long inventory holds the units, so it trades a shopper's
   * convenience against stock sitting unsellable in an abandoned cart.
   */
  CART_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(60),
  /**
   * How much longer the items hash outlives its session key.
   *
   * The expiry of the session is what triggers the release, and the hash is
   * the only record of what to hand back — so it has to still be there when
   * the event arrives. The grace window is the budget for that handover,
   * including a retry or two while inventory is unreachable.
   */
  CART_TTL_GRACE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(86_400)
    .default(300),
  /**
   * Lifetime of the per-cart write lock. It has to comfortably exceed the
   * worst-case run of a single update — a reserve, a release and a
   * compensating call, each bounded by INVENTORY_TIMEOUT_MS — or the lock
   * lapses mid-flight and a second writer starts from stale quantities.
   */
  CART_LOCK_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(15_000),
  /** Attempts to take the write lock before giving up with a 409. */
  CART_LOCK_RETRIES: z.coerce.number().int().nonnegative().max(200).default(25),
  CART_LOCK_RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000)
    .default(40),
  /**
   * How long one replica owns a cart's release. Every replica sees the same
   * expiry event, so this is what stops all of them releasing the same units.
   */
  CART_RELEASE_LOCK_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(300)
    .default(30),
  /** Whether to release reservations when a cart expires. */
  CART_RELEASE_ON_EXPIRY: booleanFlag.default(true),
  /**
   * How often the sweeper looks for carts whose expiry event never arrived.
   * Keyspace notifications are fire-and-forget: Redis does not redeliver one
   * that landed while this service was restarting, so without the sweep those
   * units stay reserved forever.
   */
  CART_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(15_000),
  /** Carts examined per sweep, so one pass cannot monopolise the loop. */
  CART_SWEEP_BATCH: z.coerce.number().int().positive().max(1_000).default(100),
  /** Backoff before a release that failed on a transport error is retried. */
  CART_RELEASE_RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(30_000),
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
